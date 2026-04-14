#!/usr/bin/env python3
"""Generate an NYC subway-access weighted map with streets, parks, and subway lines."""

from __future__ import annotations

import csv
import json
import math
import urllib.request
import zipfile
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterable, List, Sequence, Tuple


ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"
OUTPUT_DIR = ROOT / "output"

BOROUGHS_URL = "https://data.cityofnewyork.us/resource/gthc-hcne.geojson?$limit=100"
BOROUGHS_PATH = DATA_DIR / "borough_boundaries.geojson"
PARKS_PATH = DATA_DIR / "parks_open_space.geojson"
STREETS_PATH = DATA_DIR / "osm_major_streets.json"
GTFS_PATH = DATA_DIR / "mta_gtfs_subway.zip"
OUTPUT_PATH = OUTPUT_DIR / "nyc_subway_weighted_projection.svg"

SVG_WIDTH = 1500
SVG_HEIGHT = 920
PANEL_GAP = 80
PADDING = 36

GRID_COLS = 170
GRID_ROWS = 170
DECAY_METERS = 850.0
BASE_WEIGHT = 0.2
SHARPNESS = 1.4
CIRCUITY_FACTOR = 1.25

MIN_PARK_AREA = 50_000.0
MAX_SHAPES_PER_ROUTE_DIRECTION = 3

Point = Tuple[float, float]
Ring = List[Point]
Polygon = List[Ring]
MultiPolygon = List[Polygon]
PolygonBox = Tuple[float, float, float, float]
Polyline = List[Point]


@dataclass
class Borough:
    name: str
    geometry: MultiPolygon
    label_point: Point


@dataclass
class RouteShape:
    route_id: str
    color: str
    text_color: str
    points: Polyline


@dataclass
class StreetLine:
    kind: str
    points: Polyline


def ensure_dirs() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)


def download_if_missing(url: str, target: Path) -> None:
    if target.exists():
        return
    with urllib.request.urlopen(url) as response:
        target.write_bytes(response.read())


def load_json(path: Path) -> dict | list:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def lonlat_to_xy(lon: float, lat: float, lat0: float) -> Point:
    meters_per_deg_lat = 111_320.0
    meters_per_deg_lon = meters_per_deg_lat * math.cos(math.radians(lat0))
    return lon * meters_per_deg_lon, lat * meters_per_deg_lat


def average_borough_latitude(payload: dict) -> float:
    total = 0.0
    count = 0
    for feature in payload["features"]:
        geometry = feature["geometry"]
        if geometry["type"] != "MultiPolygon":
            continue
        for polygon in geometry["coordinates"]:
            for ring in polygon:
                for _, lat in ring:
                    total += lat
                    count += 1
    return total / max(count, 1)


def ring_area(ring: Sequence[Point]) -> float:
    area = 0.0
    for i in range(len(ring)):
        x1, y1 = ring[i]
        x2, y2 = ring[(i + 1) % len(ring)]
        area += x1 * y2 - x2 * y1
    return area / 2.0


def polygon_centroid(ring: Sequence[Point]) -> Point:
    area = ring_area(ring) or 1.0
    factor = 1.0 / (6.0 * area)
    cx = 0.0
    cy = 0.0
    for i in range(len(ring)):
        x1, y1 = ring[i]
        x2, y2 = ring[(i + 1) % len(ring)]
        cross = x1 * y2 - x2 * y1
        cx += (x1 + x2) * cross
        cy += (y1 + y2) * cross
    return cx * factor, cy * factor


def largest_polygon_label_point(multipolygon: MultiPolygon) -> Point:
    largest_polygon = max(multipolygon, key=lambda polygon: abs(ring_area(polygon[0])))
    return polygon_centroid(largest_polygon[0])


def simplify_polyline(points: Sequence[Point], min_distance: float) -> Polyline:
    if len(points) <= 2:
        return list(points)
    simplified = [points[0]]
    for point in points[1:-1]:
        if math.hypot(point[0] - simplified[-1][0], point[1] - simplified[-1][1]) >= min_distance:
            simplified.append(point)
    if points[-1] != simplified[-1]:
        simplified.append(points[-1])
    return simplified


def simplify_ring(ring: Sequence[Point], min_distance: float) -> Ring:
    if len(ring) <= 4:
        return list(ring)
    core = list(ring[:-1]) if ring[0] == ring[-1] else list(ring)
    simplified = [core[0]]
    for point in core[1:]:
        if math.hypot(point[0] - simplified[-1][0], point[1] - simplified[-1][1]) >= min_distance:
            simplified.append(point)
    if len(simplified) < 3:
        simplified = core[:3]
    simplified.append(simplified[0])
    return simplified


def extract_boroughs(payload: dict, lat0: float) -> List[Borough]:
    boroughs: List[Borough] = []
    for feature in payload["features"]:
        geometry = feature["geometry"]
        if geometry["type"] != "MultiPolygon":
            continue
        multipolygon: MultiPolygon = []
        for polygon_coords in geometry["coordinates"]:
            polygon: Polygon = []
            for ring_coords in polygon_coords:
                ring = [lonlat_to_xy(lon, lat, lat0) for lon, lat in ring_coords]
                polygon.append(simplify_ring(ring, 80.0))
            multipolygon.append(polygon)
        boroughs.append(
            Borough(
                name=feature["properties"]["boroname"],
                geometry=multipolygon,
                label_point=largest_polygon_label_point(multipolygon),
            )
        )
    return boroughs


def point_in_ring(point: Point, ring: Sequence[Point]) -> bool:
    x, y = point
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i]
        xj, yj = ring[j]
        intersects = (yi > y) != (yj > y)
        if intersects:
            x_hit = (xj - xi) * (y - yi) / ((yj - yi) or 1e-12) + xi
            if x < x_hit:
                inside = not inside
        j = i
    return inside


def point_in_polygon(point: Point, polygon: Polygon) -> bool:
    if not polygon:
        return False
    if not point_in_ring(point, polygon[0]):
        return False
    for hole in polygon[1:]:
        if point_in_ring(point, hole):
            return False
    return True


def point_in_multipolygon(point: Point, multipolygon: MultiPolygon) -> bool:
    return any(point_in_polygon(point, polygon) for polygon in multipolygon)


def bounds_of_ring(ring: Sequence[Point]) -> PolygonBox:
    xs = [x for x, _ in ring]
    ys = [y for _, y in ring]
    return min(xs), min(ys), max(xs), max(ys)


def build_polygon_boxes(multipolygon: MultiPolygon) -> List[PolygonBox]:
    return [bounds_of_ring(polygon[0]) for polygon in multipolygon if polygon and polygon[0]]


def bounds_of_multipolygon(multipolygon: MultiPolygon) -> PolygonBox:
    xs = [x for polygon in multipolygon for ring in polygon for x, _ in ring]
    ys = [y for polygon in multipolygon for ring in polygon for _, y in ring]
    return min(xs), min(ys), max(xs), max(ys)


def bbox_intersects(a: PolygonBox, b: PolygonBox) -> bool:
    return not (a[2] < b[0] or a[0] > b[2] or a[3] < b[1] or a[1] > b[3])


def bounds_of_points(points: Sequence[Point]) -> PolygonBox:
    xs = [x for x, _ in points]
    ys = [y for _, y in points]
    return min(xs), min(ys), max(xs), max(ys)


def extract_parks(lat0: float, bbox: PolygonBox) -> MultiPolygon:
    if not PARKS_PATH.exists():
        return []
    payload = load_json(PARKS_PATH)
    parks: MultiPolygon = []
    for feature in payload["features"]:
        try:
            area = float(feature["properties"].get("shape_area") or 0.0)
        except (TypeError, ValueError):
            area = 0.0
        if area < MIN_PARK_AREA:
            continue
        geometry = feature.get("geometry")
        if not geometry:
            continue
        if geometry["type"] == "Polygon":
            polygons = [geometry["coordinates"]]
        elif geometry["type"] == "MultiPolygon":
            polygons = geometry["coordinates"]
        else:
            continue
        for polygon_coords in polygons:
            polygon: Polygon = []
            for ring_coords in polygon_coords:
                ring = [lonlat_to_xy(lon, lat, lat0) for lon, lat in ring_coords]
                polygon.append(simplify_ring(ring, 50.0))
            if polygon and bbox_intersects(bounds_of_ring(polygon[0]), bbox):
                parks.append(polygon)
    return parks


def extract_major_streets(lat0: float, bbox: PolygonBox) -> List[StreetLine]:
    if not STREETS_PATH.exists():
        return []
    payload = load_json(STREETS_PATH)
    allowed = {"motorway", "trunk", "primary"}
    streets: List[StreetLine] = []
    for element in payload.get("elements", []):
        if element.get("type") != "way":
            continue
        tags = element.get("tags", {})
        kind = tags.get("highway")
        if kind not in allowed or "geometry" not in element:
            continue
        if "name" not in tags:
            continue
        points = [lonlat_to_xy(node["lon"], node["lat"], lat0) for node in element["geometry"]]
        if len(points) < 2:
            continue
        simplified = simplify_polyline(points, 140.0)
        if len(simplified) < 2 or not bbox_intersects(bounds_of_points(simplified), bbox):
            continue
        streets.append(StreetLine(kind=kind, points=simplified))
    return streets


def read_csv_from_zip(gtfs_path: Path, member: str) -> Iterable[dict]:
    with zipfile.ZipFile(gtfs_path) as archive:
        with archive.open(member) as handle:
            reader = csv.DictReader(line.decode("utf-8-sig") for line in handle)
            yield from reader


def extract_station_points(gtfs_path: Path, lat0: float) -> List[Point]:
    stations: List[Point] = []
    for row in read_csv_from_zip(gtfs_path, "stops.txt"):
        if row.get("location_type") != "1":
            continue
        lat = float(row["stop_lat"])
        lon = float(row["stop_lon"])
        stations.append(lonlat_to_xy(lon, lat, lat0))
    return stations


def extract_route_shapes(gtfs_path: Path, lat0: float, bbox: PolygonBox) -> List[RouteShape]:
    route_styles: Dict[str, Tuple[str, str]] = {}
    for row in read_csv_from_zip(gtfs_path, "routes.txt"):
        if row.get("route_type") != "1":
            continue
        route_styles[row["route_id"]] = (
            f"#{row['route_color'] or '808183'}",
            f"#{row['route_text_color'] or 'FFFFFF'}",
        )

    shape_counts: Dict[Tuple[str, str], Counter[str]] = {}
    for row in read_csv_from_zip(gtfs_path, "trips.txt"):
        route_id = row["route_id"]
        if route_id not in route_styles:
            continue
        direction = row.get("direction_id", "0")
        shape_counts.setdefault((route_id, direction), Counter())[row["shape_id"]] += 1

    selected_shape_ids: Dict[str, Tuple[str, str, str]] = {}
    for (route_id, _direction), counter in shape_counts.items():
        for shape_id, _count in counter.most_common(MAX_SHAPES_PER_ROUTE_DIRECTION):
            color, text_color = route_styles[route_id]
            selected_shape_ids[shape_id] = (route_id, color, text_color)

    points_by_shape: Dict[str, List[Tuple[int, Point]]] = {}
    for row in read_csv_from_zip(gtfs_path, "shapes.txt"):
        shape_id = row["shape_id"]
        if shape_id not in selected_shape_ids:
            continue
        point = lonlat_to_xy(float(row["shape_pt_lon"]), float(row["shape_pt_lat"]), lat0)
        sequence = int(row["shape_pt_sequence"])
        points_by_shape.setdefault(shape_id, []).append((sequence, point))

    route_shapes: List[RouteShape] = []
    for shape_id, route_info in selected_shape_ids.items():
        entries = points_by_shape.get(shape_id, [])
        if not entries:
            continue
        route_id, color, text_color = route_info
        polyline = [point for _, point in sorted(entries)]
        polyline = simplify_polyline(polyline, 65.0)
        if len(polyline) < 2 or not bbox_intersects(bounds_of_points(polyline), bbox):
            continue
        route_shapes.append(RouteShape(route_id=route_id, color=color, text_color=text_color, points=polyline))
    return route_shapes


def build_station_index(
    stations: Sequence[Point], cell_size: float
) -> Tuple[Dict[Tuple[int, int], List[Point]], float]:
    buckets: Dict[Tuple[int, int], List[Point]] = {}
    for x, y in stations:
        key = (int(x // cell_size), int(y // cell_size))
        buckets.setdefault(key, []).append((x, y))
    return buckets, cell_size


def nearest_distance(
    point: Point,
    stations: Sequence[Point],
    station_buckets: Dict[Tuple[int, int], List[Point]],
    bucket_size: float,
) -> float:
    px, py = point
    best = float("inf")
    bx = int(px // bucket_size)
    by = int(py // bucket_size)
    search_radius = 0

    while best == float("inf") or (search_radius * bucket_size) < best:
        found_any = False
        for ix in range(bx - search_radius, bx + search_radius + 1):
            for iy in range(by - search_radius, by + search_radius + 1):
                bucket = station_buckets.get((ix, iy))
                if not bucket:
                    continue
                found_any = True
                for sx, sy in bucket:
                    dist = math.hypot(sx - px, sy - py)
                    if dist < best:
                        best = dist
        if found_any and best < float("inf"):
            break
        search_radius += 1

    if best == float("inf"):
        for sx, sy in stations:
            dist = math.hypot(sx - px, sy - py)
            if dist < best:
                best = dist
    return best


def build_weight_grid(
    multipolygon: MultiPolygon,
    polygon_boxes: Sequence[PolygonBox],
    stations: Sequence[Point],
    bbox: PolygonBox,
) -> Tuple[List[List[float]], float, float]:
    min_x, min_y, max_x, max_y = bbox
    cell_w = (max_x - min_x) / GRID_COLS
    cell_h = (max_y - min_y) / GRID_ROWS
    station_buckets, bucket_size = build_station_index(stations, DECAY_METERS * 2.5)
    grid: List[List[float]] = []
    for row in range(GRID_ROWS):
        row_values: List[float] = []
        y = min_y + (row + 0.5) * cell_h
        for col in range(GRID_COLS):
            x = min_x + (col + 0.5) * cell_w
            point = (x, y)
            candidate_polygons = [
                multipolygon[i]
                for i, (bx0, by0, bx1, by1) in enumerate(polygon_boxes)
                if bx0 <= x <= bx1 and by0 <= y <= by1
            ]
            if not candidate_polygons or not point_in_multipolygon(point, candidate_polygons):
                row_values.append(0.0)
                continue
            walk_distance = (
                nearest_distance(point, stations, station_buckets, bucket_size) * CIRCUITY_FACTOR
            )
            weight = BASE_WEIGHT + math.exp(-((walk_distance / DECAY_METERS) ** SHARPNESS))
            row_values.append(weight)
        grid.append(row_values)
    return grid, cell_w, cell_h


def normalize_mass(values: Iterable[float], minimum: float = 1e-9) -> List[float]:
    normalized = [max(value, minimum) for value in values]
    total = sum(normalized) or 1.0
    return [value / total for value in normalized]


def cumulative_edges(masses: Sequence[float], start: float, span: float) -> List[float]:
    edges = [start]
    cursor = start
    for mass in masses:
        cursor += mass * span
        edges.append(cursor)
    edges[-1] = start + span
    return edges


def interpolate_warp(value: float, start: float, cell_size: float, edges: Sequence[float], count: int) -> float:
    if value <= start:
        return edges[0]
    end = start + cell_size * count
    if value >= end:
        return edges[-1]
    raw_index = (value - start) / cell_size
    index = min(count - 1, max(0, int(raw_index)))
    fraction = raw_index - index
    return edges[index] + (edges[index + 1] - edges[index]) * fraction


def warp_point(
    point: Point,
    min_x: float,
    min_y: float,
    cell_w: float,
    cell_h: float,
    x_edges: Sequence[float],
    y_edges: Sequence[float],
) -> Point:
    x, y = point
    return (
        interpolate_warp(x, min_x, cell_w, x_edges, GRID_COLS),
        interpolate_warp(y, min_y, cell_h, y_edges, GRID_ROWS),
    )


def warp_multipolygon(
    multipolygon: MultiPolygon,
    min_x: float,
    min_y: float,
    cell_w: float,
    cell_h: float,
    x_edges: Sequence[float],
    y_edges: Sequence[float],
) -> MultiPolygon:
    warped: MultiPolygon = []
    for polygon in multipolygon:
        warped_polygon: Polygon = []
        for ring in polygon:
            warped_polygon.append(
                [warp_point(point, min_x, min_y, cell_w, cell_h, x_edges, y_edges) for point in ring]
            )
        warped.append(warped_polygon)
    return warped


def warp_lines(
    lines: Sequence[Polyline],
    min_x: float,
    min_y: float,
    cell_w: float,
    cell_h: float,
    x_edges: Sequence[float],
    y_edges: Sequence[float],
) -> List[Polyline]:
    return [
        [warp_point(point, min_x, min_y, cell_w, cell_h, x_edges, y_edges) for point in line]
        for line in lines
    ]


def warp_points(
    points: Sequence[Point],
    min_x: float,
    min_y: float,
    cell_w: float,
    cell_h: float,
    x_edges: Sequence[float],
    y_edges: Sequence[float],
) -> List[Point]:
    return [warp_point(point, min_x, min_y, cell_w, cell_h, x_edges, y_edges) for point in points]


def fit_transform(
    bbox: PolygonBox,
    panel_x: float,
    panel_y: float,
    panel_width: float,
    panel_height: float,
):
    min_x, min_y, max_x, max_y = bbox
    span_x = max_x - min_x
    span_y = max_y - min_y
    scale = min(panel_width / span_x, panel_height / span_y)

    def transform(point: Point) -> Point:
        x, y = point
        tx = panel_x + (x - min_x) * scale
        ty = panel_y + panel_height - (y - min_y) * scale
        return tx, ty

    return transform


def svg_path_for_polygon(polygon: Polygon, transform) -> str:
    commands = []
    for ring in polygon:
        if not ring:
            continue
        transformed = [transform(point) for point in ring]
        commands.append(f"M {transformed[0][0]:.2f} {transformed[0][1]:.2f}")
        commands.extend(f"L {x:.2f} {y:.2f}" for x, y in transformed[1:])
        commands.append("Z")
    return " ".join(commands)


def svg_path_for_polyline(points: Sequence[Point], transform) -> str:
    transformed = [transform(point) for point in points]
    return " ".join(
        [f"M {transformed[0][0]:.2f} {transformed[0][1]:.2f}"]
        + [f"L {x:.2f} {y:.2f}" for x, y in transformed[1:]]
    )


def street_width(kind: str) -> float:
    if kind.startswith("motorway"):
        return 1.8
    if kind.startswith("trunk"):
        return 1.5
    if kind.startswith("primary"):
        return 1.2
    return 0.9


def draw_panel_layers(
    svg_parts: List[str],
    borough_shapes: MultiPolygon,
    parks: MultiPolygon,
    streets: Sequence[StreetLine],
    route_shapes: Sequence[RouteShape],
    station_points: Sequence[Point],
    label_points: Sequence[Point],
    borough_names: Sequence[str],
    transform,
) -> None:
    for polygon in borough_shapes:
        svg_parts.append(f'<path d="{svg_path_for_polygon(polygon, transform)}" class="borough-fill" />')

    for polygon in parks:
        svg_parts.append(f'<path d="{svg_path_for_polygon(polygon, transform)}" class="park-fill" />')

    for street in streets:
        svg_parts.append(
            f'<path d="{svg_path_for_polyline(street.points, transform)}" '
            f'class="street-line" style="stroke-width:{street_width(street.kind):.2f}px" />'
        )

    for route_shape in route_shapes:
        svg_parts.append(
            f'<path d="{svg_path_for_polyline(route_shape.points, transform)}" '
            f'class="route-line" style="stroke:{route_shape.color}" />'
        )

    for polygon in borough_shapes:
        svg_parts.append(f'<path d="{svg_path_for_polygon(polygon, transform)}" class="borough-outline" />')

    for x, y in station_points:
        tx, ty = transform((x, y))
        svg_parts.append(f'<circle cx="{tx:.2f}" cy="{ty:.2f}" r="1.3" class="station-dot" />')

    for name, point in zip(borough_names, label_points):
        tx, ty = transform(point)
        svg_parts.append(f'<text x="{tx:.2f}" y="{ty:.2f}" class="label">{name}</text>')


def write_svg(
    boroughs: Sequence[Borough],
    borough_shapes: MultiPolygon,
    warped_borough_shapes: MultiPolygon,
    parks: MultiPolygon,
    warped_parks: MultiPolygon,
    streets: Sequence[StreetLine],
    warped_streets: Sequence[StreetLine],
    route_shapes: Sequence[RouteShape],
    warped_route_shapes: Sequence[RouteShape],
    stations: Sequence[Point],
    warped_stations: Sequence[Point],
    warped_label_points: Sequence[Point],
    output_path: Path,
) -> None:
    original_bbox = bounds_of_multipolygon(borough_shapes)
    warped_bbox = bounds_of_multipolygon(warped_borough_shapes)

    panel_width = (SVG_WIDTH - PANEL_GAP - (2 * PADDING)) / 2
    panel_height = SVG_HEIGHT - (2 * PADDING) - 76

    left_transform = fit_transform(original_bbox, PADDING, PADDING + 52, panel_width, panel_height)
    right_transform = fit_transform(
        warped_bbox, PADDING + panel_width + PANEL_GAP, PADDING + 52, panel_width, panel_height
    )

    svg_parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{SVG_WIDTH}" height="{SVG_HEIGHT}" viewBox="0 0 {SVG_WIDTH} {SVG_HEIGHT}">',
        "<style>",
        "text { font-family: Helvetica, Arial, sans-serif; }",
        ".title { font-size: 28px; font-weight: 700; fill: #10233f; }",
        ".subtitle { font-size: 14px; fill: #4b5b73; }",
        ".panel-title { font-size: 18px; font-weight: 700; fill: #17304d; }",
        ".borough-fill { fill: #f4f7fb; stroke: none; }",
        ".borough-outline { fill: none; stroke: #4c6a8f; stroke-width: 1.2; }",
        ".park-fill { fill: #d8ead0; stroke: #a8c79a; stroke-width: 0.4; }",
        ".street-line { fill: none; stroke: #d6dde6; stroke-linecap: round; stroke-linejoin: round; opacity: 0.9; }",
        ".route-line { fill: none; stroke-width: 2.3; stroke-linecap: round; stroke-linejoin: round; opacity: 0.92; }",
        ".station-dot { fill: #ffffff; stroke: #56697f; stroke-width: 0.6; }",
        ".label { font-size: 15px; font-weight: 700; fill: #17304d; text-anchor: middle; paint-order: stroke; stroke: #fcfdff; stroke-width: 4px; stroke-linejoin: round; }",
        ".note { font-size: 13px; fill: #425466; }",
        ".frame { fill: none; stroke: #d8e2ea; stroke-width: 1; }",
        "</style>",
        '<rect width="100%" height="100%" fill="#fcfdff" />',
        f'<text x="{PADDING}" y="34" class="title">NYC subway-access weighted projection</text>',
        (
            f'<text x="{PADDING}" y="58" class="subtitle">'
            "Shared projection, official route colors, and added streets and parks keep the subway network aligned with the map."
            "</text>"
        ),
        f'<text x="{PADDING}" y="90" class="panel-title">Reference geography</text>',
        f'<text x="{PADDING + panel_width + PANEL_GAP}" y="90" class="panel-title">Warped by subway access</text>',
        f'<rect x="{PADDING}" y="{PADDING + 52}" width="{panel_width}" height="{panel_height}" class="frame" rx="10" />',
        (
            f'<rect x="{PADDING + panel_width + PANEL_GAP}" y="{PADDING + 52}" '
            f'width="{panel_width}" height="{panel_height}" class="frame" rx="10" />'
        ),
    ]

    draw_panel_layers(
        svg_parts=svg_parts,
        borough_shapes=borough_shapes,
        parks=parks,
        streets=streets,
        route_shapes=route_shapes,
        station_points=stations,
        label_points=[borough.label_point for borough in boroughs],
        borough_names=[borough.name for borough in boroughs],
        transform=left_transform,
    )
    draw_panel_layers(
        svg_parts=svg_parts,
        borough_shapes=warped_borough_shapes,
        parks=warped_parks,
        streets=warped_streets,
        route_shapes=warped_route_shapes,
        station_points=warped_stations,
        label_points=warped_label_points,
        borough_names=[borough.name for borough in boroughs],
        transform=right_transform,
    )

    svg_parts.extend(
        [
            f'<text x="{PADDING}" y="{SVG_HEIGHT - 42}" class="note">Data: NYC Open Data borough boundaries, NYC Parks open space, OSM major streets, and MTA GTFS subway routes.</text>',
            (
                f'<text x="{PADDING}" y="{SVG_HEIGHT - 22}" class="note">'
                f"Parameters: decay={int(DECAY_METERS)}m, circuity={CIRCUITY_FACTOR:.2f}, grid={GRID_COLS}x{GRID_ROWS}."
                "</text>"
            ),
            "</svg>",
        ]
    )

    output_path.write_text("\n".join(svg_parts), encoding="utf-8")


def main() -> None:
    ensure_dirs()
    download_if_missing(BOROUGHS_URL, BOROUGHS_PATH)

    borough_payload = load_json(BOROUGHS_PATH)
    lat0 = average_borough_latitude(borough_payload)

    boroughs = extract_boroughs(borough_payload, lat0)
    borough_shapes = [polygon for borough in boroughs for polygon in borough.geometry]
    bbox = bounds_of_multipolygon(borough_shapes)
    min_x, min_y, max_x, max_y = bbox

    parks = extract_parks(lat0, bbox)
    streets = extract_major_streets(lat0, bbox)
    stations = extract_station_points(GTFS_PATH, lat0)
    route_shapes = extract_route_shapes(GTFS_PATH, lat0, bbox)

    polygon_boxes = build_polygon_boxes(borough_shapes)
    grid, cell_w, cell_h = build_weight_grid(borough_shapes, polygon_boxes, stations, bbox)
    column_masses = normalize_mass(sum(grid[row][col] for row in range(GRID_ROWS)) for col in range(GRID_COLS))
    row_masses = normalize_mass(sum(grid[row]) for row in range(GRID_ROWS))

    x_edges = cumulative_edges(column_masses, min_x, max_x - min_x)
    y_edges = cumulative_edges(row_masses, min_y, max_y - min_y)

    warped_borough_shapes = warp_multipolygon(
        borough_shapes, min_x, min_y, cell_w, cell_h, x_edges, y_edges
    )
    warped_parks = warp_multipolygon(parks, min_x, min_y, cell_w, cell_h, x_edges, y_edges)
    warped_street_points = warp_lines(
        [street.points for street in streets], min_x, min_y, cell_w, cell_h, x_edges, y_edges
    )
    warped_route_points = warp_lines(
        [route_shape.points for route_shape in route_shapes],
        min_x,
        min_y,
        cell_w,
        cell_h,
        x_edges,
        y_edges,
    )
    warped_streets = [
        StreetLine(kind=street.kind, points=points)
        for street, points in zip(streets, warped_street_points)
    ]
    warped_route_shapes = [
        RouteShape(
            route_id=route_shape.route_id,
            color=route_shape.color,
            text_color=route_shape.text_color,
            points=points,
        )
        for route_shape, points in zip(route_shapes, warped_route_points)
    ]
    warped_stations = warp_points(stations, min_x, min_y, cell_w, cell_h, x_edges, y_edges)
    warped_label_points = warp_points(
        [borough.label_point for borough in boroughs],
        min_x,
        min_y,
        cell_w,
        cell_h,
        x_edges,
        y_edges,
    )

    write_svg(
        boroughs=boroughs,
        borough_shapes=borough_shapes,
        warped_borough_shapes=warped_borough_shapes,
        parks=parks,
        warped_parks=warped_parks,
        streets=streets,
        warped_streets=warped_streets,
        route_shapes=route_shapes,
        warped_route_shapes=warped_route_shapes,
        stations=stations,
        warped_stations=warped_stations,
        warped_label_points=warped_label_points,
        output_path=OUTPUT_PATH,
    )
    print(f"Wrote {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
