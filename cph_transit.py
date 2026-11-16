"""Extract a city's transit network from its GTFS feed.

Copenhagen's feed (GTFS/) covers all of Denmark; Stockholm's (GTFS-stockholm/) covers the whole
county. This module keeps the routes the city's `classify_route` (cities.py) recognises, restricts
them to stops in or near the mapped municipalities, picks one representative weekday, and returns
a compact network description that both the site-data builder and the static SVG generator consume.

The result is cached in data/<prefix>_transit_network.json and rebuilt when the GTFS files change.
"""

from __future__ import annotations

import csv
import datetime as dt
import json
import math
import re
import statistics
import sys
from collections import Counter, defaultdict
from pathlib import Path
from typing import Dict, Iterable, List, Sequence, Tuple

from cities import COPENHAGEN, City, city_from_argv

CACHE_VERSION = 8

# Kept for the Copenhagen-only SVG generator.
MODE_DRAW_ORDER = COPENHAGEN.mode_draw_order
# Bus stops with the same name this close together (usually the two sides of the street) form one stop.
BUS_STOP_MERGE_RADIUS = 150.0

STATION_MERGE_RADIUS = 600.0
# Stations just outside the mapped municipalities still serve border neighbourhoods.
STATION_BOUNDARY_BUFFER = 400.0

SERVICE_WINDOW = (7 * 3600, 19 * 3600)
MIN_EDGE_SECONDS = 20
# Longer stops than this are layovers (e.g. a regional train waiting at København H), not dwell.
MAX_DWELL_SECONDS = 10 * 60
MAX_EDGE_SECONDS = 45 * 60
MAX_SHAPES_PER_ROUTE_DIRECTION = 2
SHAPE_CLIP_MARGIN_DEG = (0.03, 0.05)  # lat, lon
MIN_WAIT = 1.5
MAX_WAIT = 15.0
# Used when transfers.txt has no entry for a pair of platforms in the same station.
DEFAULT_SAME_STOP_TRANSFER_SECONDS = 120
DEFAULT_CROSS_STOP_TRANSFER_SECONDS = 240

LonLat = Tuple[float, float]


def read_csv(gtfs_dir: Path, name: str) -> Iterable[dict]:
    path = gtfs_dir / name
    if not path.exists():
        return
    with path.open(encoding="utf-8-sig", newline="") as handle:
        yield from csv.DictReader(handle)


def parse_gtfs_time(value: str) -> int:
    hours, minutes, seconds = map(int, value.split(":"))
    return hours * 3600 + minutes * 60 + seconds


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def meters_between(a: LonLat, b: LonLat) -> float:
    kx = 111_320.0 * math.cos(math.radians((a[1] + b[1]) / 2))
    return math.hypot((a[0] - b[0]) * kx, (a[1] - b[1]) * 111_320.0)


def point_in_ring(point: LonLat, ring: Sequence[LonLat]) -> bool:
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


class Area:
    """The mapped municipalities in lon/lat, for station filtering."""

    def __init__(self, city: City) -> None:
        payload = json.loads(city.municipalities_path.read_text(encoding="utf-8"))
        self.polygons: List[List[List[LonLat]]] = []
        for feature in payload["features"]:
            for polygon in feature["geometry"]["coordinates"]:
                self.polygons.append([[(lon, lat) for lon, lat in ring] for ring in polygon])
        lons = [lon for polygon in self.polygons for lon, _ in polygon[0]]
        lats = [lat for polygon in self.polygons for _, lat in polygon[0]]
        self.bbox = (min(lons), min(lats), max(lons), max(lats))

    def contains(self, point: LonLat) -> bool:
        for polygon in self.polygons:
            if point_in_ring(point, polygon[0]) and not any(point_in_ring(point, hole) for hole in polygon[1:]):
                return True
        return False

    def distance_to_boundary(self, point: LonLat) -> float:
        kx = 111_320.0 * math.cos(math.radians(point[1]))
        ky = 111_320.0
        px, py = point[0] * kx, point[1] * ky
        best = math.inf
        for polygon in self.polygons:
            ring = polygon[0]
            for (x1, y1), (x2, y2) in zip(ring, ring[1:]):
                ax, ay, bx, by = x1 * kx, y1 * ky, x2 * kx, y2 * ky
                dx, dy = bx - ax, by - ay
                length_sq = dx * dx + dy * dy
                t = 0.0 if length_sq == 0 else clamp(((px - ax) * dx + (py - ay) * dy) / length_sq, 0.0, 1.0)
                best = min(best, math.hypot(px - (ax + dx * t), py - (ay + dy * t)))
        return best

    def serves(self, point: LonLat) -> bool:
        min_lon, min_lat, max_lon, max_lat = self.bbox
        if not (min_lon - 0.02 <= point[0] <= max_lon + 0.02 and min_lat - 0.01 <= point[1] <= max_lat + 0.01):
            return False
        return self.contains(point) or self.distance_to_boundary(point) <= STATION_BOUNDARY_BUFFER


def active_services_by_date(gtfs_dir: Path) -> Dict[str, set]:
    weekdays = ("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday")
    active: Dict[str, set] = defaultdict(set)
    for row in read_csv(gtfs_dir, "calendar.txt"):
        start = dt.datetime.strptime(row["start_date"], "%Y%m%d").date()
        end = dt.datetime.strptime(row["end_date"], "%Y%m%d").date()
        day = start
        while day <= end:
            if row[weekdays[day.weekday()]] == "1":
                active[day.strftime("%Y%m%d")].add(row["service_id"])
            day += dt.timedelta(days=1)
    for row in read_csv(gtfs_dir, "calendar_dates.txt"):
        if row["exception_type"] == "1":
            active[row["date"]].add(row["service_id"])
        elif row["exception_type"] == "2":
            active[row["date"]].discard(row["service_id"])
    return active


def pick_service_date(trips: Dict[str, dict], active: Dict[str, set]) -> str:
    """Use the Monday–Friday date with the most modelled trips (avoids holidays and gaps)."""
    trips_per_service = Counter(trip["service_id"] for trip in trips.values())
    best_date, best_count = None, -1
    for date, services in active.items():
        if dt.datetime.strptime(date, "%Y%m%d").weekday() >= 5:
            continue
        count = sum(trips_per_service.get(service, 0) for service in services)
        if count > best_count:
            best_date, best_count = date, count
    if best_date is None:
        raise RuntimeError("No weekday service found in GTFS calendar")
    return best_date


def gtfs_signature(gtfs_dir: Path) -> List[List]:
    return [[path.name, path.stat().st_size, int(path.stat().st_mtime)] for path in sorted(gtfs_dir.glob("*.txt"))]


def build_network(city: City = COPENHAGEN) -> dict:
    gtfs_dir = city.gtfs_dir
    area = Area(city)
    agency_names = {row["agency_id"]: row["agency_name"] for row in read_csv(gtfs_dir, "agency.txt")}

    route_info: Dict[str, Tuple[str, str]] = {}
    route_labels: Dict[str, str] = {}
    for row in read_csv(gtfs_dir, "routes.txt"):
        classified = city.classify_route(row, agency_names.get(row.get("agency_id", ""), ""))
        if classified:
            mode, route_key, label = classified
            route_info[row["route_id"]] = (mode, route_key)
            route_labels[route_key] = label

    trips: Dict[str, dict] = {}
    for row in read_csv(gtfs_dir, "trips.txt"):
        if row["route_id"] not in route_info:
            continue
        mode, route_key = route_info[row["route_id"]]
        trips[row["trip_id"]] = {
            "mode": mode,
            "route": route_key,
            "service_id": row["service_id"],
            "direction": row.get("direction_id") or "0",
            "shape_id": row.get("shape_id") or "",
        }

    active = active_services_by_date(gtfs_dir)
    service_date = pick_service_date(trips, active)
    services = active[service_date]
    trips = {trip_id: trip for trip_id, trip in trips.items() if trip["service_id"] in services}
    print(f"  service date {service_date}: {len(trips)} trips")

    stop_times: Dict[str, List[Tuple[int, str, int, int]]] = defaultdict(list)
    for row in read_csv(gtfs_dir, "stop_times.txt"):
        trip_id = row["trip_id"]
        if trip_id not in trips:
            continue
        arrival, departure = row["arrival_time"] or row["departure_time"], row["departure_time"] or row["arrival_time"]
        if not arrival:
            continue  # untimed stop between timepoints
        stop_times[trip_id].append(
            (int(row["stop_sequence"]), row["stop_id"], parse_gtfs_time(arrival), parse_gtfs_time(departure))
        )
    stop_modes: Dict[str, set] = defaultdict(set)
    for trip_id, rows in stop_times.items():
        for _, stop_id, _, _ in rows:
            stop_modes[stop_id].add(trips[trip_id]["mode"])

    stops: Dict[str, dict] = {}
    for row in read_csv(gtfs_dir, "stops.txt"):
        if row["stop_id"] not in stop_modes:
            continue
        point = (float(row["stop_lon"]), float(row["stop_lat"]))
        if area.serves(point):
            bus_only = stop_modes[row["stop_id"]] == {"bus"}
            # Bus stops keep their full name ("Nørreport St. (Nørre Voldgade)") and are never merged
            # into a rail station; rail platforms merge by their normalized name.
            name = re.sub(r"\s+", " ", row["stop_name"]).strip() if bus_only else city.normalize_station_name(row["stop_name"])
            stops[row["stop_id"]] = {"name": name, "point": point, "bus": bus_only}

    # Group stops into station complexes: same name, close together.
    complexes: List[dict] = []
    stop_to_station: Dict[str, int] = {}
    by_name: Dict[Tuple[bool, str], List[int]] = defaultdict(list)
    for stop_id, stop in sorted(stops.items()):
        group = (stop["bus"], stop["name"])
        radius = BUS_STOP_MERGE_RADIUS if stop["bus"] else STATION_MERGE_RADIUS
        match = next(
            (
                index
                for index in by_name[group]
                if meters_between(complexes[index]["points"][0], stop["point"]) <= radius
            ),
            None,
        )
        if match is None:
            match = len(complexes)
            complexes.append(
                {"name": stop["name"], "points": [], "stops": {}, "routes": set(), "modes": set(), "routeStops": defaultdict(Counter)}
            )
            by_name[group].append(match)
        complexes[match]["points"].append(stop["point"])
        complexes[match]["stops"][stop_id] = stop["point"]
        stop_to_station[stop_id] = match

    # Ride times are arrival-to-arrival, so time standing at stations a train passes through is
    # included; the dwell at each (station, line) is kept so a ride is timed from its departure
    # where you board (see "dwell" in the output and how the app subtracts it when boarding).
    durations: Dict[Tuple[int, int, str], List[float]] = defaultdict(list)
    dwells: Dict[Tuple[int, str], List[float]] = defaultdict(list)
    departures: Dict[Tuple[str, int, int], int] = Counter()
    route_modes: Dict[str, str] = {}
    shape_counts: Dict[Tuple[str, str], Counter] = defaultdict(Counter)
    for trip_id, rows in stop_times.items():
        trip = trips[trip_id]
        route_key = trip["route"]
        rows.sort()
        in_area = [row for row in rows if row[1] in stop_to_station]
        if len(in_area) < 2:
            continue
        route_modes[route_key] = trip["mode"]
        if trip["shape_id"]:
            shape_counts[(route_key, trip["direction"])][trip["shape_id"]] += 1
        for _, stop_id, arrival, departure in in_area:
            station = stop_to_station[stop_id]
            complexes[station]["routes"].add(route_key)
            complexes[station]["modes"].add(trip["mode"])
            complexes[station]["routeStops"][route_key][stop_id] += 1
            if 0 <= departure - arrival <= MAX_DWELL_SECONDS:
                dwells[(station, route_key)].append((departure - arrival) / 60.0)
        for prev, nxt in zip(in_area, in_area[1:]):
            from_station = stop_to_station[prev[1]]
            to_station = stop_to_station[nxt[1]]
            if from_station == to_station:
                continue
            if SERVICE_WINDOW[0] <= prev[3] < SERVICE_WINDOW[1]:
                departures[(route_key, from_station, to_station)] += 1
            seconds = nxt[2] - prev[2]
            if MIN_EDGE_SECONDS <= seconds <= MAX_EDGE_SECONDS:
                durations[(from_station, to_station, route_key)].append(seconds / 60.0)

    # Typical wait = half the daytime headway between consecutive stations (so merged routes
    # and branches count per direction), taken as the median over all station pairs served.
    window_minutes = (SERVICE_WINDOW[1] - SERVICE_WINDOW[0]) / 60.0
    headways: Dict[str, List[float]] = defaultdict(list)
    for (route_key, _from_station, _to_station), count in departures.items():
        if count >= 2:
            headways[route_key].append(window_minutes / count)
    route_waits = {
        route_key: round(clamp(statistics.median(values) / 2.0, MIN_WAIT, MAX_WAIT), 2)
        for route_key, values in headways.items()
    }

    # Routes with no regular daytime service (night buses, a few peak-only extras) would otherwise
    # look available all day with a guessed wait; leave them out.
    for station in complexes:
        station["routes"] &= route_waits.keys()
        station["modes"] = {route_modes[route] for route in station["routes"]}
        station["routeStops"] = {route: stops_ for route, stops_ in station["routeStops"].items() if route in route_waits}
    durations = {key: values for key, values in durations.items() if key[2] in route_waits}
    route_modes = {route: mode for route, mode in route_modes.items() if route in route_waits}
    shape_counts = {key: counter for key, counter in shape_counts.items() if key[0] in route_waits}

    # Minimum platform-to-platform transfer times from transfers.txt (seconds). Line-specific
    # rows (e.g. cross-platform S-tog changes) take precedence over stop-level ones.
    route_key_by_id = {route_id: info[1] for route_id, info in route_info.items()}
    stop_transfers: Dict[Tuple[str, str], int] = {}
    route_transfers: Dict[Tuple[str, str, str, str], int] = {}
    for row in read_csv(gtfs_dir, "transfers.txt"):
        from_stop, to_stop = row["from_stop_id"], row["to_stop_id"]
        if from_stop not in stop_to_station or stop_to_station.get(to_stop) != stop_to_station[from_stop]:
            continue
        if row.get("from_trip_id") or row.get("to_trip_id") or row.get("transfer_type") != "2":
            continue
        seconds = int(row.get("min_transfer_time") or 0)
        if row.get("from_route_id") and row.get("to_route_id"):
            key = (
                from_stop,
                to_stop,
                route_key_by_id.get(row["from_route_id"], ""),
                route_key_by_id.get(row["to_route_id"], ""),
            )
            route_transfers[key] = min(seconds, route_transfers.get(key, seconds))
        else:
            stop_transfers[(from_stop, to_stop)] = min(seconds, stop_transfers.get((from_stop, to_stop), seconds))

    def transfer_seconds(from_stop: str, to_stop: str, from_route: str, to_route: str) -> int:
        if (from_stop, to_stop, from_route, to_route) in route_transfers:
            return route_transfers[(from_stop, to_stop, from_route, to_route)]
        if (from_stop, to_stop) in stop_transfers:
            return stop_transfers[(from_stop, to_stop)]
        return DEFAULT_SAME_STOP_TRANSFER_SECONDS if from_stop == to_stop else DEFAULT_CROSS_STOP_TRANSFER_SECONDS

    # Drop complexes no modelled route actually stops at, then re-index.
    keep = [index for index, station in enumerate(complexes) if station["routes"]]
    remap = {old: new for new, old in enumerate(keep)}
    stations = []
    for old in keep:
        station = complexes[old]
        lon = sum(p[0] for p in station["points"]) / len(station["points"])
        lat = sum(p[1] for p in station["points"]) / len(station["points"])
        route_stops = {route: counter.most_common(1)[0][0] for route, counter in station["routeStops"].items()}
        transfers = [
            [a, b, transfer_seconds(route_stops[a], route_stops[b], a, b)]
            for a in sorted(route_stops)
            for b in sorted(route_stops)
            if a != b
        ]
        stations.append(
            {
                "id": str(len(stations)),
                "name": station["name"],
                "lonlat": [round(lon, 6), round(lat, 6)],
                "routes": sorted(station["routes"]),
                "modes": sorted(station["modes"]),
                "stops": {
                    stop_id: [round(point[0], 6), round(point[1], 6)]
                    for stop_id, point in station["stops"].items()
                    if stop_id in route_stops.values()
                },
                "routeStops": route_stops,
                "transfers": transfers,
                "dwell": {
                    route: round(statistics.median(dwells[(old, route)]), 2) if dwells.get((old, route)) else 0.0
                    for route in route_stops
                },
            }
        )
    edges = [
        [remap[a], remap[b], route_key, round(statistics.median(values), 2)]
        for (a, b, route_key), values in sorted(durations.items())
        if a in remap and b in remap
    ]

    selected_shapes: Dict[str, str] = {}
    for (route_key, _direction), counter in shape_counts.items():
        for shape_id, _ in counter.most_common(MAX_SHAPES_PER_ROUTE_DIRECTION):
            selected_shapes[shape_id] = route_key
    shape_points: Dict[str, List[Tuple[int, LonLat]]] = defaultdict(list)
    for row in read_csv(gtfs_dir, "shapes.txt"):
        if row["shape_id"] in selected_shapes:
            shape_points[row["shape_id"]].append(
                (int(row["shape_pt_sequence"]), (float(row["shape_pt_lon"]), float(row["shape_pt_lat"])))
            )

    min_lon, min_lat, max_lon, max_lat = area.bbox
    lat_margin, lon_margin = SHAPE_CLIP_MARGIN_DEG

    def in_clip(point: LonLat) -> bool:
        return (
            min_lon - lon_margin <= point[0] <= max_lon + lon_margin
            and min_lat - lat_margin <= point[1] <= max_lat + lat_margin
        )

    shapes = []
    for shape_id, route_key in sorted(selected_shapes.items()):
        points = [point for _, point in sorted(shape_points.get(shape_id, []))]
        run: List[LonLat] = []
        for point in points + [None]:
            if point is not None and in_clip(point):
                run.append(point)
                continue
            if len(run) >= 2:
                shapes.append({"route": route_key, "lonlat": [[round(x, 6), round(y, 6)] for x, y in run]})
            run = []

    routes = {}
    for route_key, mode in sorted(route_modes.items()):
        mode_color = next(m["color"] for m in city.modes if m["id"] == mode)
        routes[route_key] = {
            "mode": mode,
            "label": route_labels[route_key],
            "color": city.route_colors.get(route_key, mode_color),
            "textColor": city.route_text_colors.get(route_key, "#FFFFFF"),
        }

    return {
        "version": CACHE_VERSION,
        "gtfs": gtfs_signature(gtfs_dir),
        "serviceDate": service_date,
        "modes": list(city.modes),
        "routes": routes,
        "routeWaits": route_waits,
        "stations": stations,
        "edges": edges,
        "shapes": shapes,
    }


def load_network(force: bool = False, city: City = COPENHAGEN) -> dict:
    cache_path = city.transit_cache_path
    if not force and cache_path.exists():
        cached = json.loads(cache_path.read_text(encoding="utf-8"))
        if cached.get("version") == CACHE_VERSION and cached.get("gtfs") == gtfs_signature(city.gtfs_dir):
            return cached
    if not (city.gtfs_dir / "stop_times.txt").exists():
        raise SystemExit(f"{city.gtfs_dir} has no GTFS feed; run `python3 setup_data.py --city {city.id}` first.")
    print(f"Extracting the {city.name} network from GTFS (takes a minute)…")
    network = build_network(city)
    cache_path.write_text(json.dumps(network, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"  cached to {cache_path}")
    return network


if __name__ == "__main__":
    net = load_network(force=True, city=city_from_argv(sys.argv))
    print(f"{len(net['stations'])} stations, {len(net['edges'])} edges, {len(net['shapes'])} shape runs")
    by_mode = Counter(info["mode"] for info in net["routes"].values())
    print("  routes per mode:", dict(by_mode))
    for route_key, info in net["routes"].items():
        if info["mode"] != "bus":
            print(f"  {info['mode']:9s} {route_key:12s} wait {net['routeWaits'].get(route_key)}")
