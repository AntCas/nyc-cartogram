#!/usr/bin/env python3
"""Download a city's basemap layers from OpenStreetMap (Overpass API).

  python3 fetch_cph_basemap.py [--city copenhagen|stockholm] [--force]

Writes, under data/ (shown with Copenhagen's "cph" prefix; see cities.py):
  cph_municipalities.geojson  the municipalities that make up the mapped area
  cph_external_land.geojson   neighbouring municipalities (context land outside the map area)
  cph_parks.geojson           parks, forests, and other large green space
  osm_major_streets.json      motorway / trunk / primary roads (raw Overpass JSON)
  cph_street_network.json     every walkable/bikeable way in the area (raw Overpass JSON)
  cph_water.geojson           lakes, ponds, and canals inside the land area (e.g. Søerne)
  sto_coastline.json          natural=coastline ways (only for cities whose municipal boundaries
                              extend over the sea, i.e. Stockholm)

Existing files are kept; pass --force to re-download.
"""

from __future__ import annotations

import json
import math
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Dict, List, Sequence, Tuple

from cities import DATA_DIR, City, city_from_argv

# How far beyond the mapped municipalities the app draws context (neighbouring land and the sea).
CONTEXT_MARGIN_METERS = 15_000.0

OVERPASS_ENDPOINTS = (
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
)
USER_AGENT = "osm-basemap-build/1.0"

Point = Tuple[float, float]
Ring = List[Point]


def overpass(query: str) -> dict:
    body = urllib.parse.urlencode({"data": query}).encode("utf-8")
    last_error: Exception | None = None
    for attempt in range(5):
        for endpoint in OVERPASS_ENDPOINTS:
            request = urllib.request.Request(endpoint, data=body, headers={"User-Agent": USER_AGENT})
            try:
                with urllib.request.urlopen(request, timeout=300) as response:
                    payload = response.read()
                if not payload.lstrip().startswith(b"{"):
                    raise RuntimeError(f"non-JSON response from {endpoint}")
                return json.loads(payload)
            except Exception as error:  # noqa: BLE001 - retry on any network/server failure
                last_error = error
                print(f"  {endpoint} failed: {error}", file=sys.stderr)
        time.sleep(10 * (attempt + 1))
    raise RuntimeError(f"Overpass query failed: {last_error}")


def bbox_clause(bbox: Tuple[float, float, float, float]) -> str:
    return "({},{},{},{})".format(*bbox)


def ring_area_m2(ring: Sequence[Point]) -> float:
    lat0 = sum(lat for _, lat in ring) / max(len(ring), 1)
    kx = 111_320.0 * math.cos(math.radians(lat0))
    ky = 111_320.0
    area = 0.0
    for i in range(len(ring)):
        x1, y1 = ring[i]
        x2, y2 = ring[(i + 1) % len(ring)]
        area += (x1 * kx) * (y2 * ky) - (x2 * kx) * (y1 * ky)
    return abs(area) / 2.0


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


def assemble_rings(ways: List[List[Point]]) -> List[Ring]:
    """Join way geometries end-to-end into closed rings."""
    pending = [list(way) for way in ways if len(way) >= 2]
    rings: List[Ring] = []
    while pending:
        ring = pending.pop(0)
        while ring[0] != ring[-1]:
            for index, way in enumerate(pending):
                if way[0] == ring[-1]:
                    ring.extend(way[1:])
                elif way[-1] == ring[-1]:
                    ring.extend(reversed(way[:-1]))
                elif way[-1] == ring[0]:
                    ring[:0] = way[:-1]
                elif way[0] == ring[0]:
                    ring[:0] = list(reversed(way[1:]))
                else:
                    continue
                pending.pop(index)
                break
            else:
                break
        if ring[0] == ring[-1] and len(ring) >= 4:
            rings.append(ring)
    return rings


def way_points(member: dict) -> List[Point]:
    return [(node["lon"], node["lat"]) for node in member.get("geometry") or [] if node]


def relation_to_polygons(element: dict) -> List[List[Ring]]:
    outers = assemble_rings(
        [way_points(m) for m in element.get("members", []) if m.get("type") == "way" and m.get("role") in ("outer", "")]
    )
    inners = assemble_rings(
        [way_points(m) for m in element.get("members", []) if m.get("type") == "way" and m.get("role") == "inner"]
    )
    polygons: List[List[Ring]] = [[outer] for outer in outers]
    for inner in inners:
        for polygon in polygons:
            if point_in_ring(inner[0], polygon[0]):
                polygon.append(inner)
                break
    return polygons


def element_to_polygons(element: dict) -> List[List[Ring]]:
    if element["type"] == "way":
        ring = [(node["lon"], node["lat"]) for node in element.get("geometry") or []]
        if len(ring) >= 4 and ring[0] == ring[-1]:
            return [[ring]]
        return []
    if element["type"] == "relation":
        return relation_to_polygons(element)
    return []


def feature(properties: dict, polygons: List[List[Ring]]) -> dict:
    return {
        "type": "Feature",
        "properties": properties,
        "geometry": {
            "type": "MultiPolygon",
            "coordinates": [[[[round(lon, 6), round(lat, 6)] for lon, lat in ring] for ring in polygon] for polygon in polygons],
        },
    }


def write_geojson(path: Path, features: List[dict]) -> None:
    path.write_text(json.dumps({"type": "FeatureCollection", "features": features}), encoding="utf-8")
    print(f"Wrote {path} ({len(features)} features)")


def fetch_municipalities(city: City, force: bool) -> None:
    if city.municipalities_path.exists() and city.external_land_path.exists() and not force:
        return
    print("Fetching municipality boundaries…")
    payload = overpass(
        f'[out:json][timeout:180];relation["boundary"="administrative"]["admin_level"="7"]{bbox_clause(city.boundary_bbox)};out geom;'
    )
    inside, outside = [], []
    for element in payload["elements"]:
        name = element.get("tags", {}).get("name", "")
        polygons = element_to_polygons(element)
        if name in city.municipalities:
            polygons = [
                polygon
                for polygon in polygons
                if ring_area_m2(polygon[0]) >= city.min_municipality_polygon_m2
                and (city.max_polygon_lon is None or min(lon for lon, _ in polygon[0]) < city.max_polygon_lon)
            ]
            inside.append(feature({"name": city.municipalities[name], "osm_name": name}, polygons))
        elif polygons:
            outside.append(feature({"name": name}, polygons))
    missing = set(city.municipalities) - {f["properties"]["osm_name"] for f in inside}
    if missing:
        raise RuntimeError(f"Missing municipalities in Overpass response: {sorted(missing)}")
    write_geojson(city.municipalities_path, inside)
    write_geojson(city.external_land_path, outside)


def fetch_parks(city: City, force: bool) -> None:
    if city.parks_path.exists() and not force:
        return
    print("Fetching parks and green space…")
    bbox = bbox_clause(city.detail_bbox)
    selectors = [
        '["leisure"="park"]',
        '["leisure"="nature_reserve"]',
        '["leisure"="golf_course"]',
        '["landuse"="forest"]',
        '["landuse"="recreation_ground"]',
        '["landuse"="cemetery"]',
        '["natural"="wood"]',
    ]
    parts = "".join(f"way{s}{bbox};relation{s}{bbox};" for s in selectors)
    payload = overpass(f"[out:json][timeout:180];({parts});out geom;")
    features = []
    for element in payload["elements"]:
        polygons = element_to_polygons(element)
        if not polygons:
            continue
        area = sum(ring_area_m2(polygon[0]) for polygon in polygons)
        tags = element.get("tags", {})
        features.append(feature({"name": tags.get("name", ""), "shape_area": round(area, 1)}, polygons))
    write_geojson(city.parks_path, features)


def fetch_streets(city: City, force: bool) -> None:
    path = city.major_streets_path
    if path.exists() and not force:
        return
    print("Fetching major streets…")
    payload = overpass(
        f'[out:json][timeout:180];way["highway"~"^(motorway|trunk|primary)$"]{bbox_clause(city.detail_bbox)};out geom;'
    )
    path.write_text(json.dumps(payload), encoding="utf-8")
    print(f"Wrote {path} ({len(payload.get('elements', []))} ways)")


def fetch_water(city: City, force: bool) -> None:
    if city.water_path.exists() and not force:
        return
    print("Fetching lakes and inland water…")
    bbox = bbox_clause(city.detail_bbox)
    parts = "".join(
        f"way{s}{bbox};relation{s}{bbox};"
        for s in ('["natural"="water"]', '["landuse"="reservoir"]', '["landuse"="basin"]', '["waterway"="riverbank"]')
    )
    payload = overpass(f"[out:json][timeout:180];({parts});out geom;")
    features = []
    for element in payload["elements"]:
        polygons = element_to_polygons(element)
        if not polygons:
            continue
        tags = element.get("tags", {})
        area = sum(ring_area_m2(polygon[0]) for polygon in polygons)
        features.append(feature({"name": tags.get("name", ""), "water": tags.get("water", ""), "shape_area": round(area, 1)}, polygons))
    write_geojson(city.water_path, features)


def municipality_bbox(city: City) -> Tuple[float, float, float, float]:
    """(south, west, north, east) of the mapped municipalities."""
    payload = json.loads(city.municipalities_path.read_text(encoding="utf-8"))
    points = [point for f in payload["features"] for polygon in f["geometry"]["coordinates"] for point in polygon[0]]
    lons = [lon for lon, _ in points]
    lats = [lat for _, lat in points]
    return min(lats), min(lons), max(lats), max(lons)


def fetch_coastline(city: City, force: bool) -> None:
    """Coastline ways around the mapped area, as far out as the app draws context. Overpass returns
    each way that touches a tile whole, so the joined coastline only ever ends outside the area."""
    if not city.sea_from_coastline or (city.coastline_path.exists() and not force):
        return
    print("Fetching the coastline…")
    south, west, north, east = municipality_bbox(city)
    lat_margin = (CONTEXT_MARGIN_METERS + 3_000.0) / 111_320.0
    lon_margin = lat_margin / math.cos(math.radians((south + north) / 2))
    south, west, north, east = south - lat_margin, west - lon_margin, north + lat_margin, east + lon_margin
    rows = cols = 2
    ways: Dict[int, dict] = {}
    for row in range(rows):
        for col in range(cols):
            tile = (
                south + (north - south) * row / rows,
                west + (east - west) * col / cols,
                south + (north - south) * (row + 1) / rows,
                west + (east - west) * (col + 1) / cols,
            )
            print(f"  tile {row * cols + col + 1}/{rows * cols}")
            payload = overpass(f'[out:json][timeout:180];way["natural"="coastline"]{bbox_clause(tile)};out geom;')
            for element in payload["elements"]:
                if element["type"] == "way" and element.get("geometry"):
                    ways[element["id"]] = {
                        "id": element["id"],
                        "points": [[round(node["lon"], 6), round(node["lat"], 6)] for node in element["geometry"]],
                    }
    city.coastline_path.write_text(json.dumps({"ways": list(ways.values())}, separators=(",", ":")), encoding="utf-8")
    print(f"Wrote {city.coastline_path} ({len(ways)} ways)")


def fetch_street_network(city: City, force: bool) -> None:
    path = city.street_network_path
    if path.exists() and not force:
        return
    print("Fetching full street and path network (large; can take several minutes)…")
    excluded = "proposed|construction|abandoned|disused|platform|raceway|bus_guideway|elevator|rest_area|services"
    south, west, north, east = city.street_bbox
    rows, cols = city.street_tiles
    elements: Dict[Tuple[str, int], dict] = {}
    for row in range(rows):
        for col in range(cols):
            tile = (
                south + (north - south) * row / rows,
                west + (east - west) * col / cols,
                south + (north - south) * (row + 1) / rows,
                west + (east - west) * (col + 1) / cols,
            )
            print(f"  tile {row * cols + col + 1}/{rows * cols}")
            payload = overpass(
                "[out:json][timeout:180];"
                f'way["highway"]["highway"!~"^({excluded})$"]["area"!="yes"]{bbox_clause(tile)};'
                "(._;>;);out body qt;"
            )
            for element in payload["elements"]:
                elements[(element["type"], element["id"])] = element
    merged = {"elements": list(elements.values())}
    path.write_text(json.dumps(merged, separators=(",", ":")), encoding="utf-8")
    ways = sum(1 for element in merged["elements"] if element["type"] == "way")
    print(f"Wrote {path} ({ways} ways)")


def main(argv: List[str] | None = None) -> None:
    argv = list(sys.argv[1:] if argv is None else argv)
    city = city_from_argv(argv)
    force = "--force" in argv
    print(f"OpenStreetMap layers for {city.name}")
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    fetch_municipalities(city, force)
    fetch_coastline(city, force)
    fetch_parks(city, force)
    fetch_streets(city, force)
    fetch_water(city, force)
    fetch_street_network(city, force)


if __name__ == "__main__":
    main()
