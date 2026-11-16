#!/usr/bin/env python3
"""Build the data bundle for one city of the interactive commute-time website.

  python3 build_commute_site_data.py [--city copenhagen|stockholm]

Outputs, under site/data/<city>/:
  commute_map_data.json  basemap layers, stations, transit graph, and metadata
  street_graph.bin       the walk/bike street graph (≤20 m edges) and the heatmap grid, as
                         typed arrays; byte offsets are listed in meta.binary
and site/data/cities.json, the list of built cities for the app's city selector.
"""

from __future__ import annotations

import json
import math
import struct
import sys
from array import array
from collections import defaultdict
from pathlib import Path
from typing import Dict, List, Sequence, Tuple

import coastline
import cph_streets
import cph_transit
from cities import CITIES, SITE_DATA_DIR, City, city_from_argv

CITIES_MANIFEST_PATH = SITE_DATA_DIR / "cities.json"
SITE_DATA_NAME = "commute_map_data.json"
SITE_GRAPH_NAME = "street_graph.bin"

# Context beyond the mapped municipalities (neighbouring land, and the sea where it's cut out).
CONTEXT_MARGIN_METERS = 15_000.0
# Islands smaller than this are only drawn inside the mapped area.
MIN_CONTEXT_ISLAND_AREA = 20_000.0
CELL_METERS = 50.0
# Cloudflare's static assets are limited to 25 MiB per file, so a larger street graph is split.
MAX_GRAPH_FILE_BYTES = 24 * 1024 * 1024
MIN_DRAWN_WATER_AREA = 2_000.0
WALK_METERS_PER_MINUTE = 80.0
BIKE_METERS_PER_MINUTE = 16_000.0 / 60.0
MAX_STATION_LINK_METERS = 400.0
MAX_CELL_SNAP_METERS = 6_000.0

BIKE_MODE = {"id": "bike", "label": "Bike", "color": "#2E8B57"}

Point = Tuple[float, float]
Ring = List[Point]
Polygon = List[Ring]
MultiPolygon = List[Polygon]
BBox = Tuple[float, float, float, float]


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


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


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


def distance_to_rings(point: Point, rings: Sequence[Ring]) -> float:
    px, py = point
    best = math.inf
    for ring in rings:
        for (x1, y1), (x2, y2) in zip(ring, ring[1:]):
            dx, dy = x2 - x1, y2 - y1
            length_sq = dx * dx + dy * dy
            t = 0.0 if length_sq == 0 else clamp(((px - x1) * dx + (py - y1) * dy) / length_sq, 0.0, 1.0)
            best = min(best, math.hypot(px - (x1 + dx * t), py - (y1 + dy * t)))
    return best


def label_point(polygon: Polygon, clip: BBox, samples: int = 36, is_land=None) -> Point | None:
    """Interior point (inside the map bounds) far from the polygon's edges and the map edge.
    `is_land(point, clearance)` additionally keeps the label off open water."""
    min_x, min_y, max_x, max_y = bounds_of_ring(polygon[0])
    min_x, min_y = max(min_x, clip[0]), max(min_y, clip[1])
    max_x, max_y = min(max_x, clip[2]), min(max_y, clip[3])
    if min_x >= max_x or min_y >= max_y:
        return None
    best, best_distance = None, -1.0
    for i in range(samples):
        for j in range(samples):
            point = (min_x + (i + 0.5) * (max_x - min_x) / samples, min_y + (j + 0.5) * (max_y - min_y) / samples)
            if not point_in_polygon(point, polygon) or (is_land and not is_land(point, 350.0)):
                continue
            edge = min(point[0] - clip[0], clip[2] - point[0], point[1] - clip[1], clip[3] - point[1])
            distance = min(distance_to_rings(point, polygon), edge)
            if distance > best_distance:
                best, best_distance = point, distance
    return best if best_distance > 300.0 else None


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


def bounds_of_ring(ring: Sequence[Point]) -> BBox:
    xs = [x for x, _ in ring]
    ys = [y for _, y in ring]
    return min(xs), min(ys), max(xs), max(ys)


def bounds_of_points(points: Sequence[Point]) -> BBox:
    xs = [x for x, _ in points]
    ys = [y for _, y in points]
    return min(xs), min(ys), max(xs), max(ys)


def expand_bbox(bbox: BBox, margin: float) -> BBox:
    return bbox[0] - margin, bbox[1] - margin, bbox[2] + margin, bbox[3] + margin


def bbox_intersects(a: BBox, b: BBox) -> bool:
    return not (a[2] < b[0] or a[0] > b[2] or a[3] < b[1] or a[1] > b[3])


def point_in_ring(point: Point, ring: Sequence[Point]) -> bool:
    x, y = point
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if (yi > y) != (yj > y):
            x_hit = (xj - xi) * (y - yi) / ((yj - yi) or 1e-12) + xi
            if x < x_hit:
                inside = not inside
        j = i
    return inside


def point_in_polygon(point: Point, polygon: Polygon) -> bool:
    if not polygon or not point_in_ring(point, polygon[0]):
        return False
    return not any(point_in_ring(point, hole) for hole in polygon[1:])


def point_in_multipolygon(point: Point, multipolygon: MultiPolygon) -> bool:
    return any(point_in_polygon(point, polygon) for polygon in multipolygon)


def geojson_polygons(geometry: dict) -> list:
    if geometry["type"] == "Polygon":
        return [geometry["coordinates"]]
    if geometry["type"] == "MultiPolygon":
        return geometry["coordinates"]
    return []


def project_polygon(polygon_coords: list, lat0: float, min_distance: float) -> Polygon:
    return [simplify_ring([lonlat_to_xy(lon, lat, lat0) for lon, lat in ring], min_distance) for ring in polygon_coords]


def extract_municipalities(payload: dict, lat0: float, bounds: BBox, is_land=None) -> Tuple[list, MultiPolygon]:
    """Returns the drawable municipalities and the unsimplified land polygons (for rasterizing,
    where independently simplified shared borders would leave slivers)."""
    municipalities = []
    all_polygons: MultiPolygon = []
    for feature in payload["features"]:
        coords_list = geojson_polygons(feature["geometry"])
        all_polygons.extend(project_polygon(coords, lat0, 0.0) for coords in coords_list)
        multipolygon = [project_polygon(coords, lat0, 8.0) for coords in coords_list]
        visible = [polygon for polygon in multipolygon if bbox_intersects(bounds_of_ring(polygon[0]), bounds)]
        if not visible:
            continue
        largest = max(visible, key=lambda polygon: abs(ring_area(polygon[0])))
        label = label_point(largest, bounds, is_land=is_land)
        municipalities.append(
            {
                "name": feature["properties"]["name"],
                "label": round_point(label) if label else None,
                "polygons": [[round_path(ring) for ring in polygon] for polygon in visible],
            }
        )
    return municipalities, all_polygons


def extract_parks(city: City, lat0: float, bounds: BBox) -> list:
    if not city.parks_path.exists():
        return []
    parks = []
    for feature in load_json(city.parks_path)["features"]:
        try:
            area = float(feature["properties"].get("shape_area") or 0.0)
        except (TypeError, ValueError):
            area = 0.0
        if area < city.min_park_area:
            continue
        for polygon_coords in geojson_polygons(feature["geometry"]):
            polygon = project_polygon(polygon_coords, lat0, 25.0)
            if polygon and bbox_intersects(bounds_of_ring(polygon[0]), bounds):
                parks.append([round_path(ring) for ring in polygon])
    return parks


def extract_water(city: City, lat0: float, bounds: BBox) -> Tuple[list, MultiPolygon]:
    """Lakes, canals, and harbour basins: drawn on the map and cut out of the land grid, so the
    heatmap and pin snapping never treat open water (e.g. Søerne) as walkable."""
    if not city.water_path.exists():
        return [], []
    drawn, raster = [], []
    for feature in load_json(city.water_path)["features"]:
        area = float(feature["properties"].get("shape_area") or 0.0)
        for polygon_coords in geojson_polygons(feature["geometry"]):
            polygon = project_polygon(polygon_coords, lat0, 0.0)
            if not bbox_intersects(bounds_of_ring(polygon[0]), bounds):
                continue
            raster.append(polygon)
            if area >= MIN_DRAWN_WATER_AREA:
                rings = [simplify_ring(ring, 6.0) for ring in polygon]
                if city.sea_from_coastline:
                    # Lake Mälaren runs 100 km west of Stockholm; keep what the app can show.
                    visible = expand_bbox(bounds, CONTEXT_MARGIN_METERS)
                    rings = [clipped for clipped in (clip_ring_to_bbox(ring, visible) for ring in rings) if clipped]
                if rings:
                    drawn.append([round_path(ring) for ring in rings])
    return drawn, raster


def extract_sea(city: City, lat0: float, bounds: BBox) -> Tuple[list, MultiPolygon]:
    """The sea, from OSM's coastline, for cities whose municipal boundaries run across the water.
    Like extract_water: one polygon to draw (out to the context margin, small far-off islands
    dropped) and one to cut out of the land grid. Each is a single even-odd polygon whose rings
    are the stretches of sea plus every island."""
    if not city.sea_from_coastline:
        return [], []
    if not city.coastline_path.exists():
        raise SystemExit(f"{city.coastline_path} is missing; run `python3 fetch_cph_basemap.py --city {city.id}`.")
    box = expand_bbox(bounds, CONTEXT_MARGIN_METERS)
    sea, islands = coastline.load_sea(city.coastline_path, lambda lon, lat: lonlat_to_xy(lon, lat, lat0), box)
    if not sea:
        return [], []
    near = expand_bbox(bounds, 1_000.0)
    in_area = [ring for ring in islands if bbox_intersects(bounds_of_ring(ring), bounds)]
    drawn_islands = [
        ring
        for ring in islands
        if bbox_intersects(bounds_of_ring(ring), near) or abs(ring_area(ring)) >= MIN_CONTEXT_ISLAND_AREA
    ]
    drawn = [round_path(simplify_ring(ring, 12.0)) for ring in sea + drawn_islands]
    print(f"  sea: {len(sea)} stretches, {len(islands)} islands ({len(drawn_islands)} drawn)")
    return [drawn], [sea + in_area]


def clip_ring_to_bbox(ring: Sequence[Point], box: BBox) -> Ring:
    """Sutherland–Hodgman clip of a closed ring to a rectangle (good enough for filling)."""
    points = list(ring[:-1]) if ring and ring[0] == ring[-1] else list(ring)
    for axis, limit, keep_below in ((0, box[0], False), (0, box[2], True), (1, box[1], False), (1, box[3], True)):
        if not points:
            break
        clipped: Ring = []
        previous = points[-1]
        for point in points:
            inside = point[axis] <= limit if keep_below else point[axis] >= limit
            was_inside = previous[axis] <= limit if keep_below else previous[axis] >= limit
            if inside != was_inside:
                t = (limit - previous[axis]) / (point[axis] - previous[axis])
                clipped.append((previous[0] + (point[0] - previous[0]) * t, previous[1] + (point[1] - previous[1]) * t))
            if inside:
                clipped.append(point)
            previous = point
        points = clipped
    if len(points) < 3:
        return []
    return points + [points[0]]


def extract_major_streets(city: City, lat0: float, bounds: BBox) -> list:
    if not city.major_streets_path.exists():
        return []
    streets = []
    for element in load_json(city.major_streets_path).get("elements", []):
        tags = element.get("tags", {})
        kind = tags.get("highway")
        if element.get("type") != "way" or kind not in {"motorway", "trunk", "primary"} or "geometry" not in element:
            continue
        points = simplify_polyline([lonlat_to_xy(node["lon"], node["lat"], lat0) for node in element["geometry"]], 40.0)
        if len(points) < 2 or not bbox_intersects(bounds_of_points(points), bounds):
            continue
        streets.append({"kind": kind, "name": tags.get("name") or tags.get("ref") or "", "points": round_path(points)})
    return streets


def build_external_land(city: City, lat0: float, bounds: BBox, land: MultiPolygon) -> list:
    if not city.external_land_path.exists():
        return []
    visible = expand_bbox(bounds, CONTEXT_MARGIN_METERS)
    polygons = []
    for feature in load_json(city.external_land_path)["features"]:
        for polygon_coords in geojson_polygons(feature["geometry"]):
            polygon = project_polygon(polygon_coords, lat0, 40.0)
            if bbox_intersects(bounds_of_ring(polygon[0]), visible) and not point_in_multipolygon(
                polygon_centroid(polygon[0]), land
            ):
                if city.sea_from_coastline:
                    # These boundaries include open sea, which is only cut out as far as `visible`.
                    polygon = [clipped for clipped in (clip_ring_to_bbox(ring, visible) for ring in polygon) if clipped]
                    if not polygon:
                        continue
                polygons.append([round_path(ring) for ring in polygon])
    return polygons


def build_route_shapes(city: City, network: dict, lat0: float, bounds: BBox) -> list:
    draw_rank = {mode: rank for rank, mode in enumerate(city.mode_draw_order)}
    visible = expand_bbox(bounds, 2_000.0)
    shapes = []
    for shape in network["shapes"]:
        route = network["routes"][shape["route"]]
        tolerance = 45.0 if route["mode"] == "bus" else 30.0
        points = simplify_polyline([lonlat_to_xy(lon, lat, lat0) for lon, lat in shape["lonlat"]], tolerance)
        if len(points) < 2 or not bbox_intersects(bounds_of_points(points), visible):
            continue
        shapes.append(
            {
                "routeId": shape["route"],
                "mode": route["mode"],
                "color": route["color"],
                "textColor": route["textColor"],
                "label": route["label"],
                "points": round_path(points),
            }
        )
    shapes.sort(key=lambda shape: (draw_rank.get(shape["mode"], 0), shape["routeId"]))
    return shapes


def rasterize_land(land: MultiPolygon, bounds: BBox, cols: int, rows: int) -> List[bytearray]:
    """Scanline fill: even-odd within each polygon (outer ring + holes), OR-ed across polygons."""
    min_x, min_y, max_x, max_y = bounds
    cell_w = (max_x - min_x) / cols
    cell_h = (max_y - min_y) / rows
    grid = [bytearray(cols) for _ in range(rows)]
    for polygon in land:
        poly_min_x, poly_min_y, poly_max_x, poly_max_y = bounds_of_ring(polygon[0])
        if not bbox_intersects((poly_min_x, poly_min_y, poly_max_x, poly_max_y), bounds):
            continue
        first_row = max(0, math.floor((poly_min_y - min_y) / cell_h))
        last_row = min(rows - 1, math.ceil((poly_max_y - min_y) / cell_h))
        # Where each row's centre line crosses the polygon's edges (each edge only visits the rows it spans).
        row_crossings: Dict[int, List[float]] = defaultdict(list)
        for ring in polygon:
            for (x1, y1), (x2, y2) in zip(ring, ring[1:]):
                if y1 == y2:
                    continue
                low, high = (y1, y2) if y1 < y2 else (y2, y1)
                for row in range(
                    max(first_row, math.floor((low - min_y) / cell_h - 0.5)),
                    min(last_row, math.ceil((high - min_y) / cell_h - 0.5)) + 1,
                ):
                    y = min_y + (row + 0.5) * cell_h
                    if (y1 > y) != (y2 > y):
                        row_crossings[row].append(x1 + (y - y1) * (x2 - x1) / (y2 - y1))
        for row, crossings in row_crossings.items():
            crossings.sort()
            line = grid[row]
            for start, end in zip(crossings[0::2], crossings[1::2]):
                first = max(0, math.ceil((start - min_x) / cell_w - 0.5))
                last = min(cols - 1, math.floor((end - min_x) / cell_w - 0.5))
                for col in range(first, last + 1):
                    line[col] = 1
    return grid


def build_transit(
    network: dict, lat0: float, node_index: cph_streets.NodeIndex, bounds: BBox
) -> Tuple[list, list, list, list]:
    linkable = expand_bbox(bounds, 1_000.0)
    stations = []
    route_states = []
    station_states: List[List[int]] = []
    state_index: Dict[Tuple[int, str], int] = {}
    for station_index, station in enumerate(network["stations"]):
        point = lonlat_to_xy(station["lonlat"][0], station["lonlat"][1], lat0)
        stop_links = {}
        for stop_id, (lon, lat) in station["stops"].items():
            stop_point = lonlat_to_xy(lon, lat, lat0)
            node, meters = -1, 0.0
            if linkable[0] <= stop_point[0] <= linkable[2] and linkable[1] <= stop_point[1] <= linkable[3]:
                node, meters = node_index.nearest(stop_point, MAX_STATION_LINK_METERS)
                if meters > MAX_STATION_LINK_METERS:
                    node, meters = -1, 0.0
            stop_links[stop_id] = (node, meters)
        states = []
        for route_id in sorted(station["routes"]):
            node, meters = stop_links[station["routeStops"][route_id]]
            state_index[(station_index, route_id)] = len(route_states)
            states.append(len(route_states))
            route_states.append(
                {
                    "stationIndex": station_index,
                    "routeId": route_id,
                    "mode": network["routes"][route_id]["mode"],
                    "node": node,
                    "linkMeters": round(meters, 1),
                    "dwell": station["dwell"].get(route_id, 0.0),
                }
            )
        station_states.append(states)
        stations.append(
            {
                "id": station["id"],
                "name": station["name"],
                "point": round_point(point),
                "routes": station["routes"],
                "modes": station["modes"],
            }
        )

    waits = network["routeWaits"]
    adjacency: List[Dict[int, float]] = [dict() for _ in route_states]
    for from_station, to_station, route_id, minutes in network["edges"]:
        a = state_index.get((from_station, route_id))
        b = state_index.get((to_station, route_id))
        if a is not None and b is not None and minutes < adjacency[a].get(b, math.inf):
            adjacency[a][b] = minutes
    # In-station transfers: GTFS minimum transfer time plus the expected wait for the next line's
    # departure. Rides are timed from arrival, so the next line's dwell there is taken back off.
    for station_index, station in enumerate(network["stations"]):
        for from_route, to_route, seconds in station["transfers"]:
            a = state_index[(station_index, from_route)]
            b = state_index[(station_index, to_route)]
            wait = max(0.0, waits.get(to_route, 4.0) - station["dwell"].get(to_route, 0.0))
            adjacency[a][b] = round(seconds / 60.0 + wait, 2)

    return (
        stations,
        route_states,
        station_states,
        [[[target, round(weight, 2)] for target, weight in sorted(edges.items())] for edges in adjacency],
    )


def graph_file_names(directory: Path) -> List[str]:
    """street_graph.bin, then street_graph.1.bin, … for as many parts as exist."""
    names = [SITE_GRAPH_NAME]
    while (directory / part_name(len(names))).exists():
        names.append(part_name(len(names)))
    return names


def part_name(index: int) -> str:
    return SITE_GRAPH_NAME if index == 0 else SITE_GRAPH_NAME.replace(".bin", f".{index}.bin")


def write_binary(path: Path, arrays: List[Tuple[str, array]]) -> Dict[str, list]:
    """Concatenate typed arrays (little-endian), 4-byte aligned. Returns {name: [type, offset, length]}.
    Offsets are into the whole blob; it is written as `path` plus numbered parts (see
    MAX_GRAPH_FILE_BYTES) that the app joins back together."""
    layout = {}
    blob = bytearray()
    for name, values in arrays:
        while len(blob) % 4:
            blob.append(0)
        layout[name] = [values.typecode, len(blob), len(values)]
        blob.extend(values.tobytes())
    for stale in path.parent.glob(SITE_GRAPH_NAME.replace(".bin", ".*.bin")):
        stale.unlink()
    for index, start in enumerate(range(0, len(blob), MAX_GRAPH_FILE_BYTES)):
        (path.parent / part_name(index)).write_bytes(bytes(blob[start : start + MAX_GRAPH_FILE_BYTES]))
    return layout


def write_cities_manifest() -> None:
    """site/data/cities.json: every city whose data has been built, for the app's city selector."""
    built = []
    for city in CITIES.values():
        data_path = city.site_data_dir / SITE_DATA_NAME
        if not data_path.exists() or not (city.site_data_dir / SITE_GRAPH_NAME).exists():
            continue
        built.append(
            {
                "id": city.id,
                "name": city.name,
                "lonLatBounds": load_json(data_path)["meta"]["lonLatBounds"],
                "graphFiles": graph_file_names(city.site_data_dir),
            }
        )
    CITIES_MANIFEST_PATH.write_text(json.dumps({"cities": built}, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"Wrote {CITIES_MANIFEST_PATH} ({', '.join(entry['id'] for entry in built)})")


def build_city(city: City) -> None:
    print(f"Building site data for {city.name}…")
    if not city.municipalities_path.exists() or not city.street_network_path.exists():
        raise SystemExit(f"OpenStreetMap layers for {city.name} are missing; run `python3 setup_data.py --city {city.id}`.")
    network = cph_transit.load_network(city=city)
    municipality_payload = load_json(city.municipalities_path)
    lats = [lat for f in municipality_payload["features"] for poly in f["geometry"]["coordinates"] for _, lat in poly[0]]
    lat0 = (min(lats) + max(lats)) / 2.0
    full_bounds = expand_bbox(
        bounds_of_points(
            [lonlat_to_xy(lon, lat, lat0) for f in municipality_payload["features"] for poly in f["geometry"]["coordinates"] for lon, lat in poly[0]]
        ),
        200.0,
    )
    cols = math.ceil((full_bounds[2] - full_bounds[0]) / CELL_METERS)
    rows = math.ceil((full_bounds[3] - full_bounds[1]) / CELL_METERS)
    min_x, min_y = full_bounds[0], full_bounds[1]
    max_x, max_y = min_x + cols * CELL_METERS, min_y + rows * CELL_METERS
    bounds = (min_x, min_y, max_x, max_y)
    view_west, view_south, view_east, view_north = city.initial_view_bbox
    initial_view = lonlat_to_xy(view_west, view_south, lat0) + lonlat_to_xy(view_east, view_north, lat0)

    _, land = extract_municipalities(municipality_payload, lat0, bounds)
    external_land = build_external_land(city, lat0, bounds, land)
    parks = extract_parks(city, lat0, bounds)
    water, water_raster = extract_water(city, lat0, bounds)
    sea, sea_raster = extract_sea(city, lat0, bounds)
    # The sea goes first so lakes and canals are drawn over it where the two meet.
    water = sea + water
    water_raster = sea_raster + water_raster
    streets = extract_major_streets(city, lat0, bounds)
    route_shapes = build_route_shapes(city, network, lat0, bounds)

    print("Building street graph…")
    graph = cph_streets.build_street_graph(city.street_network_path, lambda lon, lat: lonlat_to_xy(lon, lat, lat0))
    xs, ys, street_adjacency = graph["xs"], graph["ys"], graph["adjacency"]
    snappable = cph_streets.walkable_nodes(street_adjacency)
    node_index = cph_streets.NodeIndex(xs, ys, snappable)
    node_snappable = array("B", [0]) * len(xs)
    for node in snappable:
        node_snappable[node] = 1
    print(f"  {len(xs)} nodes, {sum(len(a) for a in street_adjacency)} directed edges")

    stations, route_states, station_states, transit_adjacency = build_transit(network, lat0, node_index, bounds)

    print("Rasterizing grid…")
    land_grid = rasterize_land(land, bounds, cols, rows)
    for row, line in enumerate(rasterize_land(water_raster, bounds, cols, rows)):
        for col, is_water in enumerate(line):
            if is_water:
                land_grid[row][col] = 0
    cell_w = (max_x - min_x) / cols
    cell_h = (max_y - min_y) / rows

    def is_land(point: Point, clearance: float) -> bool:
        """True where `point` and the cells `clearance` metres around it are all land."""
        for dx in (-clearance, 0.0, clearance):
            for dy in (-clearance, 0.0, clearance):
                col = math.floor((point[0] + dx - min_x) / cell_w)
                row = math.floor((point[1] + dy - min_y) / cell_h)
                if not (0 <= col < cols and 0 <= row < rows and land_grid[row][col]):
                    return False
        return True

    # Where the boundaries include open sea, keep the municipality labels on dry land.
    municipalities, _ = extract_municipalities(
        municipality_payload, lat0, bounds, is_land if city.sea_from_coastline else None
    )

    cell_node = array("i", [-1]) * (cols * rows)
    cell_snap = array("H", [0]) * (cols * rows)
    for row in range(rows):
        for col in range(cols):
            if not land_grid[row][col]:
                continue
            point = (min_x + (col + 0.5) * cell_w, min_y + (row + 0.5) * cell_h)
            node, meters = node_index.nearest(point, MAX_CELL_SNAP_METERS)
            if node >= 0:
                cell_node[row * cols + col] = node
                cell_snap[row * cols + col] = min(65535, round(meters * 10))

    site_dir = city.site_data_dir
    site_dir.mkdir(parents=True, exist_ok=True)
    site_data_path, site_graph_path = site_dir / SITE_DATA_NAME, site_dir / SITE_GRAPH_NAME
    offsets = array("I", [0])
    targets = array("I")
    lengths = array("B")
    flags = array("B")
    for edges in street_adjacency:
        for target, length, flag in edges:
            targets.append(target)
            lengths.append(max(1, min(255, round(length * 10))))
            flags.append(flag)
        offsets.append(len(targets))
    layout = write_binary(
        site_graph_path,
        [
            ("nodeX", array("f", (x - min_x for x in xs))),
            ("nodeY", array("f", (y - min_y for y in ys))),
            ("edgeOffsets", offsets),
            ("edgeTargets", targets),
            ("cellNode", cell_node),
            ("cellSnapDm", cell_snap),
            ("edgeLengthDm", lengths),
            ("edgeFlags", flags),
            ("nodeSnappable", node_snappable),
        ],
    )
    assert struct.pack("<I", 1) == array("I", [1]).tobytes(), "binary output assumes a little-endian machine"

    land_cells = sum(1 for value in cell_node if value >= 0)
    meters_per_deg_lon = 111_320.0 * math.cos(math.radians(lat0))
    output = {
        "meta": {
            "city": city.id,
            "cityName": city.name,
            "transitSource": city.transit_source,
            "countryCodes": city.country_codes,
            "searchLanguages": city.search_languages,
            # west, south, east, north
            "lonLatBounds": [
                round(min_x / meters_per_deg_lon, 5),
                round(min_y / 111_320.0, 5),
                round(max_x / meters_per_deg_lon, 5),
                round(max_y / 111_320.0, 5),
            ],
            "noBikeModes": list(city.no_bike_modes),
            "landmarkStations": list(city.landmark_stations),
            "lat0": round(lat0, 6),
            "bounds": [round(value, 1) for value in bounds],
            "initialView": [round(value, 1) for value in initial_view],
            "gridCols": cols,
            "gridRows": rows,
            "landCells": land_cells,
            "nodeCount": len(xs),
            "walkMetersPerMinute": WALK_METERS_PER_MINUTE,
            "bikeMetersPerMinute": round(BIKE_METERS_PER_MINUTE, 2),
            "stationAccessMinutes": city.station_access_minutes,
            "bikeStationExtraMinutes": city.bike_station_extra_minutes,
            "walkFlag": cph_streets.WALK,
            "bikeFlag": cph_streets.BIKE,
            "serviceDate": network["serviceDate"],
            "binary": layout,
        },
        "municipalities": municipalities,
        "externalLand": external_land,
        "parks": parks,
        "water": water,
        "streets": streets,
        "routes": route_shapes,
        "stations": stations,
        "routeStates": route_states,
        "stationStates": station_states,
        "routeWaits": network["routeWaits"],
        "adjacency": transit_adjacency,
        "modes": [BIKE_MODE] + network["modes"],
        "routeStyles": network["routes"],
    }

    site_data_path.write_text(json.dumps(output, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"Wrote {site_data_path} and {site_graph_path}")
    print(f"  grid {cols}x{rows} ({CELL_METERS:.0f} m), {land_cells} land cells")
    write_cities_manifest()


def main(argv: List[str] | None = None) -> None:
    argv = list(sys.argv[1:] if argv is None else argv)
    cities = list(CITIES.values()) if "--all" in argv else [city_from_argv(argv)]
    for city in cities:
        build_city(city)


if __name__ == "__main__":
    main()
