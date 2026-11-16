"""Turn OSM natural=coastline ways into sea polygons inside a rectangle.

Swedish municipal boundaries extend over the sea, so for Stockholm the sea has to be cut out of the
land along the coastline. OSM coastline ways always run with land on their left and water on their
right, so a water area is bounded clockwise: follow a stretch of coast through the rectangle, and
where it leaves, continue clockwise along the rectangle's edge to the next stretch that enters.
Coastlines that close inside the rectangle are islands (counter-clockwise) and become holes.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Callable, Dict, List, Sequence, Tuple

Point = Tuple[float, float]
Ring = List[Point]
BBox = Tuple[float, float, float, float]


def join_ways(ways: Sequence[Sequence[Point]]) -> List[List[Point]]:
    """Join ways head-to-tail (they all run the same direction) into chains; closed chains repeat
    their first point at the end."""
    by_start: Dict[Point, int] = {}
    ends = set()
    for index, way in enumerate(ways):
        by_start.setdefault(way[0], index)
        ends.add(way[-1])
    used = [False] * len(ways)

    def follow(index: int) -> List[Point]:
        chain = list(ways[index])
        used[index] = True
        while chain[-1] != chain[0]:
            following = by_start.get(chain[-1])
            if following is None or used[following]:
                break
            used[following] = True
            chain.extend(ways[following][1:])
        return chain

    # Open chains first, from the ways nothing leads into; whatever is left are closed loops.
    chains = [follow(index) for index, way in enumerate(ways) if way[0] not in ends]
    chains.extend(follow(index) for index in range(len(ways)) if not used[index])
    return chains


def clip_segment(p: Point, q: Point, box: BBox) -> Tuple[float, float] | None:
    """Liang–Barsky: the (t0, t1) stretch of p→q inside the box, or None."""
    t0, t1 = 0.0, 1.0
    dx, dy = q[0] - p[0], q[1] - p[1]
    for delta, low, high, start in ((dx, box[0], box[2], p[0]), (dy, box[1], box[3], p[1])):
        if delta == 0:
            if start < low or start > high:
                return None
            continue
        ta, tb = (low - start) / delta, (high - start) / delta
        if ta > tb:
            ta, tb = tb, ta
        t0, t1 = max(t0, ta), min(t1, tb)
        if t0 > t1:
            return None
    return t0, t1


def clip_chain(chain: Sequence[Point], box: BBox) -> List[List[Point]]:
    """The pieces of a polyline that lie inside the box, in order."""
    pieces: List[List[Point]] = []
    current: List[Point] | None = None
    for p, q in zip(chain, chain[1:]):
        clipped = clip_segment(p, q, box)
        if clipped is None:
            current = None
            continue
        t0, t1 = clipped
        start = p if t0 == 0.0 else (p[0] + (q[0] - p[0]) * t0, p[1] + (q[1] - p[1]) * t0)
        end = q if t1 == 1.0 else (p[0] + (q[0] - p[0]) * t1, p[1] + (q[1] - p[1]) * t1)
        if current is None or t0 > 0.0:
            current = [start]
            pieces.append(current)
        if end != current[-1]:
            current.append(end)
        if t1 < 1.0:
            current = None
    return [piece for piece in pieces if len(piece) >= 2]


def ring_area(ring: Sequence[Point]) -> float:
    area = 0.0
    for (x1, y1), (x2, y2) in zip(ring, ring[1:]):
        area += x1 * y2 - x2 * y1
    return area / 2.0


def sea_rings(ways: Sequence[Sequence[Point]], box: BBox) -> Tuple[List[Ring], List[Ring]]:
    """Returns (sea, islands): closed rings (first point repeated) inside the box, in the ways'
    coordinates. Filled together with the even-odd rule they cover exactly the sea."""
    min_x, min_y, max_x, max_y = box
    width, height = max_x - min_x, max_y - min_y
    tolerance = 1e-6 * max(width, height)

    def on_edge(point: Point) -> bool:
        return (
            abs(point[0] - min_x) <= tolerance
            or abs(point[0] - max_x) <= tolerance
            or abs(point[1] - min_y) <= tolerance
            or abs(point[1] - max_y) <= tolerance
        )

    def perimeter(point: Point) -> float:
        """Distance clockwise along the box edge from its top-left corner."""
        x, y = point
        if abs(y - max_y) <= tolerance:
            return x - min_x
        if abs(x - max_x) <= tolerance:
            return width + (max_y - y)
        if abs(y - min_y) <= tolerance:
            return width + height + (max_x - x)
        return 2 * width + height + (y - min_y)

    corners = [(0.0, (min_x, max_y)), (width, (max_x, max_y)), (width + height, (max_x, min_y)), (2 * width + height, (min_x, min_y))]
    total = 2 * (width + height)

    sea: List[Ring] = []
    islands: List[Ring] = []
    crossing: List[List[Point]] = []
    for chain in join_ways(ways):
        pieces = clip_chain(chain, box)
        closed = chain[0] == chain[-1]
        if closed and len(pieces) >= 2 and pieces[0][0] == chain[0] and pieces[-1][-1] == chain[0] and not on_edge(chain[0]):
            # The loop's arbitrary start point split one stretch in two.
            pieces = [pieces[-1] + pieces[0][1:]] + pieces[1:-1]
        for piece in pieces:
            if piece[0] == piece[-1] and len(piece) >= 4:
                (islands if ring_area(piece) > 0 else sea).append(piece)
            elif on_edge(piece[0]) and on_edge(piece[-1]):
                crossing.append(piece)
            # else: a coastline that just stops inside the box (broken data); nothing to follow.

    entries = sorted((perimeter(piece[0]), index) for index, piece in enumerate(crossing))
    used = [False] * len(crossing)
    for first in range(len(crossing)):
        if used[first]:
            continue
        ring: Ring = []
        index = first
        while not used[index]:
            used[index] = True
            ring.extend(crossing[index])
            leave = perimeter(crossing[index][-1])
            # Next stretch of coast entering the box, clockwise from where this one left.
            ahead = [(position, other) for position, other in entries if position > leave]
            position, index = ahead[0] if ahead else entries[0]
            travelled = (position - leave) % total
            for corner_position, corner in sorted(corners, key=lambda item: (item[0] - leave) % total):
                if 0 < (corner_position - leave) % total < travelled:
                    ring.append(corner)
        ring.append(ring[0])
        sea.append(ring)

    if not crossing and islands and not sea:
        # No coast reaches the edge but there are islands: the box is open sea.
        sea.append([(min_x, max_y), (max_x, max_y), (max_x, min_y), (min_x, min_y), (min_x, max_y)])
    return sea, islands


def load_sea(path: Path, project: Callable[[float, float], Point], box: BBox) -> Tuple[List[Ring], List[Ring]]:
    """Sea and island rings inside `box` (projected coordinates) from a fetched coastline file."""
    payload = json.loads(path.read_text(encoding="utf-8"))
    # Join on the raw lon/lat (exact node matches), then project.
    ways = [[(lon, lat) for lon, lat in way["points"]] for way in payload["ways"] if len(way["points"]) >= 2]
    chains = [[project(lon, lat) for lon, lat in chain] for chain in join_ways(ways)]
    return sea_rings(chains, box)
