#!/usr/bin/env python3
"""Build compact data assets for the interactive commute-time website."""

from __future__ import annotations

import csv
import json
import math
import statistics
import zipfile
from collections import Counter, defaultdict
from pathlib import Path
from typing import Dict, Iterable, List, Sequence, Tuple


ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"
SITE_DATA_PATH = ROOT / "site" / "data" / "commute_map_data.json"

BOROUGHS_PATH = DATA_DIR / "borough_boundaries.geojson"
PARKS_PATH = DATA_DIR / "parks_open_space.geojson"
STREETS_PATH = DATA_DIR / "osm_major_streets.json"
GTFS_PATH = DATA_DIR / "mta_gtfs_subway.zip"

GRID_COLS = 96
GRID_ROWS = 96
MIN_PARK_AREA = 70_000.0
WALK_METERS_PER_MINUTE = 75.0
CELL_NEAREST_STATIONS = 4
ORIGIN_NEAREST_STATIONS = 5
MAX_SHAPES_PER_ROUTE_DIRECTION = 2
INTER_COMPLEX_WALK_RADIUS = 260.0
INTER_COMPLEX_WALK_PENALTY = 2.0

Point = Tuple[float, float]
Ring = List[Point]
Polygon = List[Ring]
MultiPolygon = List[Polygon]


def round_point(point: Point) -> List[float]:
    return [round(point[0], 1), round(point[1], 1)]


def round_path(points: Sequence[Point]) -> List[List[float]]:
    return [round_point(point) for point in points]


def load_json(path: Path) -> dict | list:
    return json.loads(path.read_text(encoding="utf-8"))


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


def simplify_polyline(points: Sequence[Point], min_distance: float) -> List[Point]:
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


def bounds_of_ring(ring: Sequence[Point]) -> Tuple[float, float, float, float]:
    xs = [x for x, _ in ring]
    ys = [y for _, y in ring]
    return min(xs), min(ys), max(xs), max(ys)


def bounds_of_multipolygon(multipolygon: MultiPolygon) -> Tuple[float, float, float, float]:
    xs = [x for polygon in multipolygon for ring in polygon for x, _ in ring]
    ys = [y for polygon in multipolygon for ring in polygon for _, y in ring]
    return min(xs), min(ys), max(xs), max(ys)


def bounds_of_points(points: Sequence[Point]) -> Tuple[float, float, float, float]:
    xs = [x for x, _ in points]
    ys = [y for _, y in points]
    return min(xs), min(ys), max(xs), max(ys)


def bbox_intersects(a: Tuple[float, float, float, float], b: Tuple[float, float, float, float]) -> bool:
    return not (a[2] < b[0] or a[0] > b[2] or a[3] < b[1] or a[1] > b[3])


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


def extract_boroughs(payload: dict, lat0: float) -> Tuple[list, MultiPolygon]:
    boroughs = []
    all_polygons: MultiPolygon = []
    for feature in payload["features"]:
        geometry = feature["geometry"]
        if geometry["type"] != "MultiPolygon":
            continue
        multipolygon: MultiPolygon = []
        for polygon_coords in geometry["coordinates"]:
            polygon: Polygon = []
            for ring_coords in polygon_coords:
                ring = [lonlat_to_xy(lon, lat, lat0) for lon, lat in ring_coords]
                polygon.append(simplify_ring(ring, 120.0))
            multipolygon.append(polygon)
            all_polygons.append(polygon)
        largest_polygon = max(multipolygon, key=lambda polygon: abs(ring_area(polygon[0])))
        boroughs.append(
            {
                "name": feature["properties"]["boroname"],
                "label": round_point(polygon_centroid(largest_polygon[0])),
                "polygons": [[round_path(ring) for ring in polygon] for polygon in multipolygon],
            }
        )
    return boroughs, all_polygons


def extract_parks(lat0: float, bbox: Tuple[float, float, float, float]) -> list:
    if not PARKS_PATH.exists():
        return []
    payload = load_json(PARKS_PATH)
    parks = []
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
        polygons = []
        if geometry["type"] == "Polygon":
            polygons = [geometry["coordinates"]]
        elif geometry["type"] == "MultiPolygon":
            polygons = geometry["coordinates"]
        for polygon_coords in polygons:
            polygon: Polygon = []
            for ring_coords in polygon_coords:
                ring = [lonlat_to_xy(lon, lat, lat0) for lon, lat in ring_coords]
                polygon.append(simplify_ring(ring, 90.0))
            if polygon and bbox_intersects(bounds_of_ring(polygon[0]), bbox):
                parks.append([round_path(ring) for ring in polygon])
    return parks


def extract_streets(lat0: float, bbox: Tuple[float, float, float, float]) -> list:
    if not STREETS_PATH.exists():
        return []
    payload = load_json(STREETS_PATH)
    allowed = {"motorway", "trunk", "primary"}
    streets = []
    for element in payload.get("elements", []):
        if element.get("type") != "way":
            continue
        tags = element.get("tags", {})
        kind = tags.get("highway")
        if kind not in allowed or "geometry" not in element or "name" not in tags:
            continue
        points = [lonlat_to_xy(node["lon"], node["lat"], lat0) for node in element["geometry"]]
        if len(points) < 2:
            continue
        length = sum(distance for distance in (
            math.hypot(points[i + 1][0] - points[i][0], points[i + 1][1] - points[i][1])
            for i in range(len(points) - 1)
        ))
        if kind == "primary" and length < 900.0:
            continue
        simplified = simplify_polyline(points, 220.0)
        if len(simplified) < 2 or not bbox_intersects(bounds_of_points(simplified), bbox):
            continue
        streets.append({"kind": kind, "name": tags["name"], "points": round_path(simplified)})
    return streets


def read_csv_from_zip(gtfs_path: Path, member: str) -> Iterable[dict]:
    with zipfile.ZipFile(gtfs_path) as archive:
        with archive.open(member) as handle:
            reader = csv.DictReader(line.decode("utf-8-sig") for line in handle)
            yield from reader


def parse_gtfs_time(value: str) -> int:
    hours, minutes, seconds = map(int, value.split(":"))
    return hours * 3600 + minutes * 60 + seconds


def build_station_data(lat0: float) -> Tuple[list, Dict[str, int], Dict[str, str]]:
    complex_info: Dict[str, dict] = {}
    stop_to_complex: Dict[str, str] = {}

    for row in load_json(DATA_DIR / "subway_stations.json"):
        complex_id = row["complex_id"]
        stop_code = row["gtfs_stop_id"]
        stop_to_complex[stop_code] = complex_id
        stop_to_complex[f"{stop_code}N"] = complex_id
        stop_to_complex[f"{stop_code}S"] = complex_id
        info = complex_info.setdefault(
            complex_id,
            {
                "id": complex_id,
                "name": row["stop_name"],
                "point": lonlat_to_xy(float(row["gtfs_longitude"]), float(row["gtfs_latitude"]), lat0),
                "routes": set(),
            },
        )
        routes = (row.get("daytime_routes") or "").split()
        info["routes"].update(route for route in routes if route)

    stations = []
    station_index_by_id: Dict[str, int] = {}
    for complex_id, info in sorted(complex_info.items(), key=lambda item: int(item[0])):
        station_index_by_id[complex_id] = len(stations)
        stations.append(info)

    for row in read_csv_from_zip(GTFS_PATH, "stops.txt"):
        stop_id = row["stop_id"]
        parent_station = row.get("parent_station") or ""
        if stop_id not in stop_to_complex and parent_station and parent_station in stop_to_complex:
            stop_to_complex[stop_id] = stop_to_complex[parent_station]

    return stations, station_index_by_id, stop_to_complex


def build_routes_and_shapes(lat0: float, bbox: Tuple[float, float, float, float]) -> Tuple[dict, list, dict]:
    route_styles = {}
    for row in read_csv_from_zip(GTFS_PATH, "routes.txt"):
        if row.get("route_type") != "1":
            continue
        route_styles[row["route_id"]] = {
            "color": f"#{row['route_color'] or '808183'}",
            "textColor": f"#{row['route_text_color'] or 'FFFFFF'}",
            "label": row["route_short_name"] or row["route_id"],
        }

    trips_by_id = {}
    shape_counts: Dict[Tuple[str, str], Counter[str]] = {}
    for row in read_csv_from_zip(GTFS_PATH, "trips.txt"):
        route_id = row["route_id"]
        if route_id not in route_styles:
            continue
        trips_by_id[row["trip_id"]] = {"route_id": route_id, "direction_id": row.get("direction_id", "0")}
        shape_counts.setdefault((route_id, row.get("direction_id", "0")), Counter())[row["shape_id"]] += 1

    selected_shape_ids = {}
    for (route_id, _direction), counter in shape_counts.items():
        for shape_id, _count in counter.most_common(MAX_SHAPES_PER_ROUTE_DIRECTION):
            selected_shape_ids[shape_id] = route_id

    points_by_shape = defaultdict(list)
    for row in read_csv_from_zip(GTFS_PATH, "shapes.txt"):
        shape_id = row["shape_id"]
        if shape_id not in selected_shape_ids:
            continue
        point = lonlat_to_xy(float(row["shape_pt_lon"]), float(row["shape_pt_lat"]), lat0)
        points_by_shape[shape_id].append((int(row["shape_pt_sequence"]), point))

    shapes = []
    for shape_id, route_id in selected_shape_ids.items():
        points = [point for _, point in sorted(points_by_shape.get(shape_id, []))]
        points = simplify_polyline(points, 90.0)
        if len(points) < 2 or not bbox_intersects(bounds_of_points(points), bbox):
            continue
        shapes.append(
            {
                "routeId": route_id,
                "color": route_styles[route_id]["color"],
                "textColor": route_styles[route_id]["textColor"],
                "label": route_styles[route_id]["label"],
                "points": round_path(points),
            }
        )
    return route_styles, shapes, trips_by_id


def build_graph(stations: list, station_index_by_id: Dict[str, int], stop_to_complex: Dict[str, str], trips_by_id: dict) -> list:
    durations_by_edge: Dict[Tuple[int, int], List[float]] = defaultdict(list)
    current_trip_id = None
    current_rows: List[dict] = []

    def process_trip(trip_id: str, rows: List[dict]) -> None:
        trip = trips_by_id.get(trip_id)
        if not trip or len(rows) < 2:
            return
        route_id = trip["route_id"]
        ordered = sorted(rows, key=lambda row: int(row["stop_sequence"]))
        for row in ordered:
            stop_id = row["stop_id"]
            complex_id = stop_to_complex.get(stop_id)
            if complex_id in station_index_by_id:
                stations[station_index_by_id[complex_id]]["routes"].add(route_id)
        for prev, nxt in zip(ordered, ordered[1:]):
            from_complex = stop_to_complex.get(prev["stop_id"])
            to_complex = stop_to_complex.get(nxt["stop_id"])
            if not from_complex or not to_complex or from_complex == to_complex:
                continue
            if from_complex not in station_index_by_id or to_complex not in station_index_by_id:
                continue
            duration_seconds = parse_gtfs_time(nxt["arrival_time"]) - parse_gtfs_time(prev["departure_time"])
            if 20 <= duration_seconds <= 1800:
                from_index = station_index_by_id[from_complex]
                to_index = station_index_by_id[to_complex]
                durations_by_edge[(from_index, to_index)].append(duration_seconds / 60.0)

    for row in read_csv_from_zip(GTFS_PATH, "stop_times.txt"):
        trip_id = row["trip_id"]
        if current_trip_id is None:
            current_trip_id = trip_id
        if trip_id != current_trip_id:
            process_trip(current_trip_id, current_rows)
            current_trip_id = trip_id
            current_rows = []
        current_rows.append(row)
    if current_trip_id and current_rows:
        process_trip(current_trip_id, current_rows)

    adjacency = [dict() for _ in stations]
    for (from_index, to_index), durations in durations_by_edge.items():
        weight = round(statistics.median(durations), 2)
        existing = adjacency[from_index].get(to_index)
        if existing is None or weight < existing:
            adjacency[from_index][to_index] = weight

    for i, source in enumerate(stations):
        sx, sy = source["point"]
        for j in range(i + 1, len(stations)):
            tx, ty = stations[j]["point"]
            distance = math.hypot(tx - sx, ty - sy)
            if distance > INTER_COMPLEX_WALK_RADIUS:
                continue
            walk_minutes = round(distance / WALK_METERS_PER_MINUTE + INTER_COMPLEX_WALK_PENALTY, 2)
            current_ij = adjacency[i].get(j)
            current_ji = adjacency[j].get(i)
            if current_ij is None or walk_minutes < current_ij:
                adjacency[i][j] = walk_minutes
            if current_ji is None or walk_minutes < current_ji:
                adjacency[j][i] = walk_minutes

    return [
        [[to_index, weight] for to_index, weight in sorted(edges.items())]
        for edges in adjacency
    ]


def build_grid_cells(polygons: MultiPolygon, stations: list, bbox: Tuple[float, float, float, float]) -> Tuple[list, list]:
    min_x, min_y, max_x, max_y = bbox
    cell_w = (max_x - min_x) / GRID_COLS
    cell_h = (max_y - min_y) / GRID_ROWS
    mask = []
    cells = []
    station_points = [station["point"] for station in stations]
    for row in range(GRID_ROWS):
        for col in range(GRID_COLS):
            x = min_x + (col + 0.5) * cell_w
            y = min_y + (row + 0.5) * cell_h
            point = (x, y)
            if not point_in_multipolygon(point, polygons):
                mask.append(-1)
                continue
            ranked = sorted(
                (
                    (
                        station_index,
                        round(math.hypot(station_point[0] - x, station_point[1] - y) / WALK_METERS_PER_MINUTE, 2),
                    )
                    for station_index, station_point in enumerate(station_points)
                ),
                key=lambda item: item[1],
            )[:CELL_NEAREST_STATIONS]
            cells.append(
                {
                    "col": col,
                    "row": row,
                    "point": round_point(point),
                    "access": [[station_index, walk_minutes] for station_index, walk_minutes in ranked],
                }
            )
            mask.append(len(cells) - 1)
    return cells, mask


def main() -> None:
    borough_payload = load_json(BOROUGHS_PATH)
    lat0 = average_borough_latitude(borough_payload)
    boroughs, all_polygons = extract_boroughs(borough_payload, lat0)
    bbox = bounds_of_multipolygon(all_polygons)
    parks = extract_parks(lat0, bbox)
    streets = extract_streets(lat0, bbox)
    stations, station_index_by_id, child_to_parent = build_station_data(lat0)
    route_styles, route_shapes, trips_by_id = build_routes_and_shapes(lat0, bbox)
    adjacency = build_graph(stations, station_index_by_id, child_to_parent, trips_by_id)
    cells, mask = build_grid_cells(all_polygons, stations, bbox)

    output = {
        "meta": {
            "lat0": round(lat0, 6),
            "bounds": [round(value, 1) for value in bbox],
            "gridCols": GRID_COLS,
            "gridRows": GRID_ROWS,
            "walkMetersPerMinute": WALK_METERS_PER_MINUTE,
            "originStationCount": ORIGIN_NEAREST_STATIONS,
            "cellNearestStations": CELL_NEAREST_STATIONS,
        },
        "boroughs": boroughs,
        "parks": parks,
        "streets": streets,
        "routes": route_shapes,
        "stations": [
            {
                "id": station["id"],
                "name": station["name"],
                "point": round_point(station["point"]),
                "routes": sorted(station["routes"]),
            }
            for station in stations
        ],
        "adjacency": adjacency,
        "cells": cells,
        "mask": mask,
        "routeStyles": route_styles,
    }

    SITE_DATA_PATH.write_text(json.dumps(output, separators=(",", ":")), encoding="utf-8")
    print(f"Wrote {SITE_DATA_PATH}")


if __name__ == "__main__":
    main()
