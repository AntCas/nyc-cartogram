"""Build a routable walk/bike street graph from a city's raw OSM extract (data/<prefix>_street_network.json).

Every OSM way is classified for walking and cycling (per direction for cycling, since one-way
streets apply to bikes unless contraflow is allowed). Ways are split at junctions and each
stretch between junctions is resampled so that no edge is longer than MAX_EDGE_METERS. Only
the largest connected component is kept, so origins never snap onto an isolated fragment.
"""

from __future__ import annotations

import json
import math
from collections import Counter
from pathlib import Path
from typing import Callable, Dict, List, Tuple

MAX_EDGE_METERS = 20.0

WALK = 1
BIKE = 2

NO_ACCESS = {"no", "private", "use_sidepath"}
NO_BIKE = {"no", "private", "dismount", "use_sidepath"}
EXPLICIT_YES = {"yes", "designated", "permissive", "destination", "customers"}
BIKE_HIGHWAYS = {
    "cycleway", "residential", "living_street", "service", "unclassified", "road", "track", "path",
    "bridleway", "busway", "tertiary", "tertiary_link", "secondary", "secondary_link", "primary",
    "primary_link", "trunk", "trunk_link",
}
WALK_ONLY_HIGHWAYS = {"footway", "pedestrian", "steps", "corridor"}
MOTOR_ONLY_HIGHWAYS = {"motorway", "motorway_link"}

Point = Tuple[float, float]


def classify_way(tags: Dict[str, str]) -> Tuple[bool, bool, bool]:
    """Return (walkable, bikeable forward, bikeable backward)."""
    highway = tags.get("highway", "")
    if highway in MOTOR_ONLY_HIGHWAYS or tags.get("motorroad") == "yes":
        return False, False, False
    access = tags.get("access")
    foot = tags.get("foot")
    bicycle = tags.get("bicycle")

    walk = highway in BIKE_HIGHWAYS or highway in WALK_ONLY_HIGHWAYS
    if foot in NO_ACCESS or (access in NO_ACCESS and foot not in EXPLICIT_YES):
        walk = False

    if highway in BIKE_HIGHWAYS:
        bike = bicycle not in NO_BIKE
        if access in NO_ACCESS and bicycle not in EXPLICIT_YES:
            bike = False
    else:
        bike = bicycle in EXPLICIT_YES

    forward = backward = bike
    if bike:
        oneway = tags.get("oneway")
        contraflow = tags.get("oneway:bicycle") == "no" or "opposite" in tags.get("cycleway", "")
        if tags.get("oneway:bicycle") == "yes" or (
            (oneway in ("yes", "true", "1") or tags.get("junction") in ("roundabout", "circular")) and not contraflow
        ):
            backward = False
        elif oneway == "-1" and not contraflow:
            forward = False
    return walk, forward, backward


def build_street_graph(path: Path, project: Callable[[float, float], Point]) -> dict:
    payload = json.loads(path.read_text(encoding="utf-8"))
    coords: Dict[int, Point] = {}
    ways = []
    for element in payload["elements"]:
        if element["type"] == "node":
            coords[element["id"]] = project(element["lon"], element["lat"])
        elif element["type"] == "way":
            ways.append(element)

    classified = []
    usage: Counter = Counter()
    for way in ways:
        walk, forward, backward = classify_way(way.get("tags", {}))
        refs = [ref for ref in way.get("nodes", []) if ref in coords]
        if not (walk or forward or backward) or len(refs) < 2:
            continue
        classified.append((refs, walk, forward, backward))
        usage.update(refs)
        usage[refs[0]] += 1
        usage[refs[-1]] += 1

    node_index: Dict[int, int] = {}
    xs: List[float] = []
    ys: List[float] = []

    def junction(ref: int) -> int:
        index = node_index.get(ref)
        if index is None:
            index = node_index[ref] = len(xs)
            xs.append(coords[ref][0])
            ys.append(coords[ref][1])
        return index

    def new_node(point: Point) -> int:
        xs.append(point[0])
        ys.append(point[1])
        return len(xs) - 1

    # Undirected edges: (u, v, length_m, flags u->v, flags v->u)
    edges: List[Tuple[int, int, float, int, int]] = []
    for refs, walk, forward, backward in classified:
        flags_forward = (WALK if walk else 0) | (BIKE if forward else 0)
        flags_backward = (WALK if walk else 0) | (BIKE if backward else 0)
        chain = [coords[refs[0]]]
        start = junction(refs[0])
        for ref in refs[1:]:
            chain.append(coords[ref])
            if usage[ref] < 2:
                continue
            end = junction(ref)
            seg_lengths = [math.dist(chain[i], chain[i + 1]) for i in range(len(chain) - 1)]
            total = sum(seg_lengths)
            pieces = max(1, math.ceil(total / MAX_EDGE_METERS))
            step = total / pieces
            prev = start
            # Walk along the polyline dropping a node every `step` metres.
            seg, travelled = 0, 0.0
            for piece in range(1, pieces):
                target = piece * step
                while seg < len(seg_lengths) - 1 and travelled + seg_lengths[seg] < target:
                    travelled += seg_lengths[seg]
                    seg += 1
                t = (target - travelled) / (seg_lengths[seg] or 1.0)
                (x1, y1), (x2, y2) = chain[seg], chain[seg + 1]
                node = new_node((x1 + (x2 - x1) * t, y1 + (y2 - y1) * t))
                edges.append((prev, node, step, flags_forward, flags_backward))
                prev = node
            if prev != end:
                edges.append((prev, end, step, flags_forward, flags_backward))
            chain = [coords[ref]]
            start = end

    # Keep the largest connected component.
    parent = list(range(len(xs)))

    def find(a: int) -> int:
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    for u, v, _, _, _ in edges:
        ru, rv = find(u), find(v)
        if ru != rv:
            parent[ru] = rv
    sizes = Counter(find(i) for i in range(len(xs)))
    main_root = sizes.most_common(1)[0][0]
    keep = [i for i in range(len(xs)) if find(i) == main_root]
    remap = {old: new for new, old in enumerate(keep)}

    adjacency: List[List[Tuple[int, float, int]]] = [[] for _ in keep]
    for u, v, length, forward, backward in edges:
        if u not in remap:
            continue
        a, b = remap[u], remap[v]
        if forward:
            adjacency[a].append((b, length, forward))
        if backward:
            adjacency[b].append((a, length, backward))

    return {
        "xs": [xs[i] for i in keep],
        "ys": [ys[i] for i in keep],
        "adjacency": adjacency,
        "droppedNodes": len(xs) - len(keep),
    }


def walkable_nodes(adjacency: List[List[Tuple[int, float, int]]]) -> List[int]:
    """Nodes in the largest component connected on foot (walk edges are always two-way).
    Snapping origins, grid cells, and stations only to these keeps every point reachable
    without a bike; the rest of the graph is still used for cycling."""
    seen = bytearray(len(adjacency))
    best: List[int] = []
    for start in range(len(adjacency)):
        if seen[start] or not any(flag & WALK for _, _, flag in adjacency[start]):
            continue
        seen[start] = 1
        component, stack = [], [start]
        while stack:
            node = stack.pop()
            component.append(node)
            for target, _, flag in adjacency[node]:
                if flag & WALK and not seen[target]:
                    seen[target] = 1
                    stack.append(target)
        if len(component) > len(best):
            best = component
    return sorted(best)


class NodeIndex:
    """Bucketed nearest-node lookup over a subset of nodes."""

    def __init__(self, xs: List[float], ys: List[float], nodes: List[int], bucket: float = 100.0) -> None:
        self.xs, self.ys, self.bucket = xs, ys, bucket
        self.buckets: Dict[Tuple[int, int], List[int]] = {}
        for index in nodes:
            self.buckets.setdefault((int(xs[index] // bucket), int(ys[index] // bucket)), []).append(index)

    def nearest(self, point: Point, max_radius: float = 2_000.0) -> Tuple[int, float]:
        px, py = point
        bx, by = int(px // self.bucket), int(py // self.bucket)
        best, best_distance = -1, math.inf
        ring = 0
        while ring * self.bucket <= max_radius:
            for ix in range(bx - ring, bx + ring + 1):
                for iy in range(by - ring, by + ring + 1):
                    if max(abs(ix - bx), abs(iy - by)) != ring:
                        continue
                    for index in self.buckets.get((ix, iy), ()):
                        d = math.hypot(self.xs[index] - px, self.ys[index] - py)
                        if d < best_distance:
                            best, best_distance = index, d
            # Anything in a further ring is at least ring * bucket away.
            if best >= 0 and best_distance <= ring * self.bucket:
                break
            ring += 1
        return best, best_distance
