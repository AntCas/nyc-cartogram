const DATA_URL = "./data/commute_map_data.json";
const ENTRY_WAIT_MINUTES = 2.5;
const MAX_TIME_MINUTES = 80;
const MIN_AREA_WEIGHT = 0.24;
const MAX_AREA_WEIGHT = 2.67;
const PANEL_PADDING = 18;
const ROUTE_LINE_WIDTH = 2.2;
const WEIGHT_BLUR_PASSES = 2;
const WEIGHT_BLUR_RADIUS = 2;
const HOVER_DEADBAND = 14;
const HEATMAP_RESOLUTION_SCALE = 2;
const HEATMAP_BLUR_PX = 7;
const HEATMAP_ALPHA = 0.8;

const state = {
  data: null,
  ready: false,
  showWarp: true,
  showHeatmap: true,
  showPinHint: true,
  cursorPoint: null,
  cursorScreen: null,
  originPoint: null,
  originLabel: null,
  pinnedPoint: null,
  pinnedScreen: null,
  pinned: false,
  transform: null,
  currentRender: null,
  dirty: true,
};

const mapCanvas = document.getElementById("mapCanvas");
const statusText = document.getElementById("statusText");
const warpToggle = document.getElementById("warpToggle");
const heatmapToggle = document.getElementById("heatmapToggle");
const heatmapLegend = document.getElementById("heatmapLegend");
const heatmapLegendMin = document.getElementById("heatmapLegendMin");
const heatmapLegendMax = document.getElementById("heatmapLegendMax");
const fullscreenButton = document.getElementById("fullscreenButton");
const searchForm = document.getElementById("searchForm");
const addressInput = document.getElementById("addressInput");
const searchButton = document.getElementById("searchButton");
const shareButton = document.getElementById("shareButton");
const searchMeta = document.getElementById("searchMeta");
const searchResults = document.getElementById("searchResults");
const ctx = mapCanvas.getContext("2d");
const panelCard = document.querySelector(".panel-card");
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function clampToRange(value, min, max) {
  if (min > max) {
    return (min + max) / 2;
  }
  return clamp(value, min, max);
}

function distance(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function formatMinutes(minutes) {
  if (!Number.isFinite(minutes)) return "unreachable";
  if (minutes < 1) return "<1 min";
  return `${Math.round(minutes)} min`;
}

function formatShareTime(date = new Date()) {
  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function heatmapColor(minutes, alpha = 0.56) {
  const t = clamp(minutes / MAX_TIME_MINUTES, 0, 1);
  const stops = [
    { t: 0, color: [220, 69, 37] },
    { t: 0.18, color: [244, 127, 46] },
    { t: 0.36, color: [255, 196, 79] },
    { t: 0.58, color: [248, 232, 156] },
    { t: 0.78, color: [149, 188, 211] },
    { t: 1, color: [74, 103, 141] },
  ];
  let left = stops[0];
  let right = stops[stops.length - 1];
  for (let index = 0; index < stops.length - 1; index += 1) {
    if (t >= stops[index].t && t <= stops[index + 1].t) {
      left = stops[index];
      right = stops[index + 1];
      break;
    }
  }
  const mix = (t - left.t) / ((right.t - left.t) || 1);
  const rgb = left.color.map((value, index) => Math.round(value + (right.color[index] - value) * mix));
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`;
}

function minuteToAreaWeight(minutes) {
  const t = clamp(minutes / MAX_TIME_MINUTES, 0, 1);
  return MIN_AREA_WEIGHT + (1 - t) * (MAX_AREA_WEIGHT - MIN_AREA_WEIGHT);
}

function buildTransform(bounds, width, height, padding = PANEL_PADDING) {
  const [minX, minY, maxX, maxY] = bounds;
  const spanX = maxX - minX;
  const spanY = maxY - minY;
  const scale = Math.min((width - padding * 2) / spanX, (height - padding * 2) / spanY);
  const drawWidth = spanX * scale;
  const drawHeight = spanY * scale;
  const offsetX = (width - drawWidth) / 2;
  const offsetY = (height - drawHeight) / 2;

  return {
    scale,
    toScreen(point) {
      const [x, y] = point;
      return [offsetX + (x - minX) * scale, offsetY + drawHeight - (y - minY) * scale];
    },
    toWorld(x, y) {
      return [minX + (x - offsetX) / scale, minY + (drawHeight - (y - offsetY)) / scale];
    },
  };
}

function offsetTransform(baseTransform, dx, dy) {
  return {
    scale: baseTransform.scale,
    toScreen(point) {
      const [sx, sy] = baseTransform.toScreen(point);
      return [sx + dx, sy + dy];
    },
    toWorld(x, y) {
      return baseTransform.toWorld(x - dx, y - dy);
    },
  };
}

function createCanvasBacking(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.round(rect.width * dpr));
  canvas.height = Math.max(1, Math.round(rect.height * dpr));
  const context = canvas.getContext("2d");
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { width: rect.width, height: rect.height };
}

function drawPanelBackground(drawCtx, width, height) {
  drawCtx.clearRect(0, 0, width, height);
  const bg = drawCtx.createLinearGradient(0, 0, 0, height);
  bg.addColorStop(0, "rgba(255,255,255,0.72)");
  bg.addColorStop(1, "rgba(241,232,217,0.84)");
  drawCtx.fillStyle = bg;
  drawCtx.fillRect(0, 0, width, height);

  drawCtx.strokeStyle = "rgba(23, 48, 77, 0.08)";
  drawCtx.lineWidth = 1;
  for (let x = 18; x < width; x += 38) {
    drawCtx.beginPath();
    drawCtx.moveTo(x, 0);
    drawCtx.lineTo(x, height);
    drawCtx.stroke();
  }
}

function tracePolygonPath(drawCtx, polygon, projectPoint) {
  for (const ring of polygon) {
    ring.forEach((point, index) => {
      const [sx, sy] = projectPoint(point);
      if (index === 0) drawCtx.moveTo(sx, sy);
      else drawCtx.lineTo(sx, sy);
    });
    drawCtx.closePath();
  }
}

function drawPolygonPath(drawCtx, polygon, projectPoint) {
  drawCtx.beginPath();
  tracePolygonPath(drawCtx, polygon, projectPoint);
}

function traceBoroughMaskPath(drawCtx, projectPoint) {
  drawCtx.beginPath();
  for (const borough of state.data.boroughs) {
    for (const polygon of borough.polygons) {
      tracePolygonPath(drawCtx, polygon, projectPoint);
    }
  }
}

function drawPolyline(drawCtx, points, projectPoint) {
  drawCtx.beginPath();
  points.forEach((point, index) => {
    const [sx, sy] = projectPoint(point);
    if (index === 0) drawCtx.moveTo(sx, sy);
    else drawCtx.lineTo(sx, sy);
  });
  drawCtx.stroke();
}

function streetWidth(kind) {
  if (kind === "motorway") return 1.8;
  if (kind === "trunk") return 1.5;
  return 1.1;
}

function nearestStations(point, count) {
  return state.data.stations
    .map((station, index) => ({
      index,
      name: station.name,
      walkMinutes:
        distance(point, station.point) / state.data.meta.accessWalkMetersPerMinute +
        state.data.meta.stationAccessPenalty,
    }))
    .sort((a, b) => a.walkMinutes - b.walkMinutes)
    .slice(0, count);
}

function runDijkstra(originPoint) {
  const stateCount = state.data.routeStates.length;
  const distances = new Array(stateCount).fill(Infinity);
  const visited = new Array(stateCount).fill(false);
  const seeds = nearestStations(originPoint, state.data.meta.originStationCount);

  for (const seed of seeds) {
    for (const routeStateIndex of state.data.stationStates[seed.index] || []) {
      const routeId = state.data.routeStates[routeStateIndex].routeId;
      const boardWait = state.data.routeWaits[routeId] ?? state.data.meta.defaultBoardWait ?? ENTRY_WAIT_MINUTES;
      distances[routeStateIndex] = Math.min(distances[routeStateIndex], seed.walkMinutes + boardWait);
    }
  }

  for (let step = 0; step < stateCount; step += 1) {
    let current = -1;
    let best = Infinity;
    for (let index = 0; index < stateCount; index += 1) {
      if (!visited[index] && distances[index] < best) {
        best = distances[index];
        current = index;
      }
    }
    if (current === -1) break;
    visited[current] = true;
    for (const [nextIndex, weight] of state.data.adjacency[current]) {
      const candidate = distances[current] + weight;
      if (candidate < distances[nextIndex]) distances[nextIndex] = candidate;
    }
  }

  return { distances, seeds };
}

function estimateTravelMinutes(originDistances, destinationPoint) {
  let bestMinutes = distance(state.originPoint, destinationPoint) / state.data.meta.walkMetersPerMinute;
  const nearby = nearestStations(destinationPoint, state.data.meta.cellNearestStations);
  for (const station of nearby) {
    for (const routeStateIndex of state.data.stationStates[station.index] || []) {
      bestMinutes = Math.min(bestMinutes, originDistances[routeStateIndex] + station.walkMinutes);
    }
  }
  return bestMinutes;
}

function computeWarp(originPoint) {
  const { distances, seeds } = runDijkstra(originPoint);
  const { gridCols, gridRows, bounds } = state.data.meta;
  const [minX, minY, maxX, maxY] = bounds;
  const spanX = maxX - minX;
  const spanY = maxY - minY;
  const cellW = spanX / gridCols;
  const cellH = spanY / gridRows;
  const minuteGrid = Array.from({ length: gridRows }, () => new Array(gridCols).fill(Infinity));
  const validMask = Array.from({ length: gridRows }, () => new Array(gridCols).fill(false));
  const columnMass = new Array(gridCols).fill(0);
  const rowMass = new Array(gridRows).fill(0);

  for (let maskIndex = 0; maskIndex < state.data.mask.length; maskIndex += 1) {
    const cellIndex = state.data.mask[maskIndex];
    if (cellIndex === -1) continue;
    const cell = state.data.cells[cellIndex];
    let bestMinutes = distance(originPoint, cell.point) / state.data.meta.walkMetersPerMinute;
    for (const [stationIndex, egressMinutes] of cell.access) {
      for (const routeStateIndex of state.data.stationStates[stationIndex] || []) {
        bestMinutes = Math.min(bestMinutes, distances[routeStateIndex] + egressMinutes);
      }
    }
    minuteGrid[cell.row][cell.col] = bestMinutes;
    validMask[cell.row][cell.col] = true;
  }

  let smoothedMinutes = minuteGrid.map((row) => row.slice());
  for (let pass = 0; pass < WEIGHT_BLUR_PASSES; pass += 1) {
    const nextMinutes = Array.from({ length: gridRows }, () => new Array(gridCols).fill(Infinity));
    for (let row = 0; row < gridRows; row += 1) {
      for (let col = 0; col < gridCols; col += 1) {
        if (!validMask[row][col]) continue;
        let totalMinutes = 0;
        let count = 0;
        for (let y = Math.max(0, row - WEIGHT_BLUR_RADIUS); y <= Math.min(gridRows - 1, row + WEIGHT_BLUR_RADIUS); y += 1) {
          for (let x = Math.max(0, col - WEIGHT_BLUR_RADIUS); x <= Math.min(gridCols - 1, col + WEIGHT_BLUR_RADIUS); x += 1) {
            if (!validMask[y][x]) continue;
            totalMinutes += smoothedMinutes[y][x];
            count += 1;
          }
        }
        nextMinutes[row][col] = count ? totalMinutes / count : smoothedMinutes[row][col];
      }
    }
    smoothedMinutes = nextMinutes;
  }

  const areaWeights = Array.from({ length: gridRows }, () => new Array(gridCols).fill(0));

  for (let row = 0; row < gridRows; row += 1) {
    for (let col = 0; col < gridCols; col += 1) {
      if (!validMask[row][col]) continue;
      const areaWeight = minuteToAreaWeight(smoothedMinutes[row][col]);
      areaWeights[row][col] = areaWeight;
      columnMass[col] += areaWeight;
      rowMass[row] += areaWeight;
    }
  }

  function normalize(values) {
    const minimum = 1e-9;
    const adjusted = values.map((value) => Math.max(value, minimum));
    const total = adjusted.reduce((sum, value) => sum + value, 0);
    return adjusted.map((value) => value / total);
  }

  function cumulativeEdges(masses, start, span) {
    const edges = [start];
    let cursor = start;
    for (const mass of masses) {
      cursor += mass * span;
      edges.push(cursor);
    }
    edges[edges.length - 1] = start + span;
    return edges;
  }

  const xEdges = cumulativeEdges(normalize(columnMass), minX, spanX);
  const yEdges = cumulativeEdges(normalize(rowMass), minY, spanY);

  function interpolateWarp(value, start, cellSize, edges, count) {
    if (value <= start) return edges[0];
    const end = start + cellSize * count;
    if (value >= end) return edges[edges.length - 1];
    const rawIndex = (value - start) / cellSize;
    const index = clamp(Math.floor(rawIndex), 0, count - 1);
    const fraction = rawIndex - index;
    return edges[index] + (edges[index + 1] - edges[index]) * fraction;
  }

  function warpPoint(point) {
    return [
      interpolateWarp(point[0], minX, cellW, xEdges, gridCols),
      interpolateWarp(point[1], minY, cellH, yEdges, gridRows),
    ];
  }

  function inverseInterpolateWarp(value, start, cellSize, edges, count) {
    if (value <= edges[0]) return start;
    if (value >= edges[edges.length - 1]) return start + cellSize * count;
    let low = 0;
    let high = edges.length - 1;
    while (low + 1 < high) {
      const mid = Math.floor((low + high) / 2);
      if (edges[mid] <= value) low = mid;
      else high = mid;
    }
    const edgeSpan = edges[low + 1] - edges[low] || 1e-9;
    const fraction = (value - edges[low]) / edgeSpan;
    return start + (low + fraction) * cellSize;
  }

  function inverseWarpPoint(point) {
    return [
      inverseInterpolateWarp(point[0], minX, cellW, xEdges, gridCols),
      inverseInterpolateWarp(point[1], minY, cellH, yEdges, gridRows),
    ];
  }

  const warpedCorners = [
    warpPoint([minX, minY]),
    warpPoint([minX, maxY]),
    warpPoint([maxX, minY]),
    warpPoint([maxX, maxY]),
  ];
  const xs = warpedCorners.map((point) => point[0]);
  const ys = warpedCorners.map((point) => point[1]);
  const warpedBounds = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  const expansion = Array.from({ length: gridRows }, () => new Array(gridCols).fill(0));
  for (let row = 0; row < gridRows; row += 1) {
    const scaleY = (yEdges[row + 1] - yEdges[row]) / cellH;
    for (let col = 0; col < gridCols; col += 1) {
      if (!validMask[row][col]) continue;
      const scaleX = (xEdges[col + 1] - xEdges[col]) / cellW;
      expansion[row][col] = scaleX * scaleY;
    }
  }

  return {
    distances,
    seeds,
    warpPoint,
    inverseWarpPoint,
    warpedBounds,
    xEdges,
    yEdges,
    minutes: smoothedMinutes,
    expansion,
    areaWeights,
    validMask,
  };
}

function drawHeatmap(drawCtx, warp, transform) {
  const { gridCols, gridRows } = state.data.meta;
  const { width, height } = mapCanvas.getBoundingClientRect();
  const scale = HEATMAP_RESOLUTION_SCALE;
  const rawCanvas = document.createElement("canvas");
  rawCanvas.width = Math.max(1, Math.round(width * scale));
  rawCanvas.height = Math.max(1, Math.round(height * scale));
  const rawCtx = rawCanvas.getContext("2d");
  rawCtx.setTransform(scale, 0, 0, scale, 0, 0);
  rawCtx.imageSmoothingEnabled = true;

  for (let row = 0; row < gridRows; row += 1) {
    for (let col = 0; col < gridCols; col += 1) {
      if (!warp.validMask[row][col]) continue;
      const left = transform.toScreen([warp.xEdges[col], warp.yEdges[row]])[0];
      const right = transform.toScreen([warp.xEdges[col + 1], warp.yEdges[row]])[0];
      const top = transform.toScreen([warp.xEdges[col], warp.yEdges[row + 1]])[1];
      const bottom = transform.toScreen([warp.xEdges[col], warp.yEdges[row]])[1];
      rawCtx.fillStyle = heatmapColor(warp.minutes[row][col], 1);
      rawCtx.fillRect(left, top, Math.max(1, right - left), Math.max(1, bottom - top));
    }
  }

  const blurredCanvas = document.createElement("canvas");
  blurredCanvas.width = rawCanvas.width;
  blurredCanvas.height = rawCanvas.height;
  const blurredCtx = blurredCanvas.getContext("2d");
  blurredCtx.setTransform(scale, 0, 0, scale, 0, 0);
  blurredCtx.imageSmoothingEnabled = true;
  blurredCtx.filter = `blur(${HEATMAP_BLUR_PX}px)`;
  blurredCtx.drawImage(rawCanvas, 0, 0, width, height);
  blurredCtx.filter = "none";

  const maskedCanvas = document.createElement("canvas");
  maskedCanvas.width = rawCanvas.width;
  maskedCanvas.height = rawCanvas.height;
  const maskedCtx = maskedCanvas.getContext("2d");
  maskedCtx.setTransform(scale, 0, 0, scale, 0, 0);
  maskedCtx.imageSmoothingEnabled = true;
  maskedCtx.save();
  traceBoroughMaskPath(maskedCtx, (point) => transform.toScreen(warp.warpPoint(point)));
  maskedCtx.clip();
  maskedCtx.drawImage(blurredCanvas, 0, 0, width, height);
  maskedCtx.restore();

  drawCtx.save();
  drawCtx.globalCompositeOperation = "multiply";
  drawCtx.globalAlpha = HEATMAP_ALPHA;
  drawCtx.imageSmoothingEnabled = true;
  drawCtx.drawImage(maskedCanvas, 0, 0, width, height);
  drawCtx.restore();
}

function drawMap(drawCtx, width, height) {
  drawPanelBackground(drawCtx, width, height);
  if (!state.originPoint || !state.transform) return;

  const warp = state.showWarp ? computeWarp(state.originPoint) : null;
  // Keep hover-mode geography fixed in the frame. We only lock the warped map
  // to a chosen screen point once the user pins an origin.
  const anchorScreen = state.pinned ? state.pinnedScreen : null;
  const baseTransform = state.transform;
  const warpPoint = warp ? warp.warpPoint : (point) => point;
  const inverseWarpPoint = warp ? warp.inverseWarpPoint : (point) => point;
  const warpedBounds = warp ? warp.warpedBounds : state.data.meta.bounds;
  const anchoredOrigin = baseTransform.toScreen(warpPoint(state.originPoint));
  const [warpMinX, warpMinY, warpMaxX, warpMaxY] = warpedBounds;
  const topLeft = baseTransform.toScreen([warpMinX, warpMaxY]);
  const bottomRight = baseTransform.toScreen([warpMaxX, warpMinY]);
  const leftBound = topLeft[0];
  const topBound = topLeft[1];
  const rightBound = bottomRight[0];
  const bottomBound = bottomRight[1];
  const desiredDx = anchorScreen ? anchorScreen[0] - anchoredOrigin[0] : 0;
  const desiredDy = anchorScreen ? anchorScreen[1] - anchoredOrigin[1] : 0;
  const minDx = PANEL_PADDING - leftBound;
  const maxDx = width - PANEL_PADDING - rightBound;
  const minDy = PANEL_PADDING - topBound;
  const maxDy = height - PANEL_PADDING - bottomBound;
  const dx = clampToRange(desiredDx, minDx, maxDx);
  const dy = clampToRange(desiredDy, minDy, maxDy);
  const transform = offsetTransform(baseTransform, dx, dy);
  const projectPoint = (point) => transform.toScreen(warpPoint(point));
  state.currentRender = {
    warp: {
      inverseWarpPoint,
      distances: warp?.distances ?? null,
      seeds: warp?.seeds ?? [],
    },
    transform,
    anchorOffset: [dx, dy],
  };

  for (const borough of state.data.boroughs) {
    for (const polygon of borough.polygons) {
      drawPolygonPath(drawCtx, polygon, projectPoint);
      drawCtx.fillStyle = "#f3f6fa";
      drawCtx.fill();
    }
  }

  for (const polygon of state.data.parks) {
    drawPolygonPath(drawCtx, polygon, projectPoint);
    drawCtx.fillStyle = "#dbeacd";
    drawCtx.strokeStyle = "#a7c39b";
    drawCtx.lineWidth = 0.45;
    drawCtx.fill();
    drawCtx.stroke();
  }

  for (const street of state.data.streets) {
    drawCtx.strokeStyle = "rgba(193, 202, 212, 0.92)";
    drawCtx.lineWidth = streetWidth(street.kind);
    drawCtx.lineCap = "round";
    drawCtx.lineJoin = "round";
    drawPolyline(drawCtx, street.points, projectPoint);
  }

  for (const route of state.data.routes) {
    drawCtx.strokeStyle = route.color;
    drawCtx.lineWidth = ROUTE_LINE_WIDTH;
    drawCtx.lineCap = "round";
    drawCtx.lineJoin = "round";
    drawPolyline(drawCtx, route.points, projectPoint);
  }

  for (const borough of state.data.boroughs) {
    for (const polygon of borough.polygons) {
      drawPolygonPath(drawCtx, polygon, projectPoint);
      drawCtx.strokeStyle = "#4f6987";
      drawCtx.lineWidth = 1.05;
      drawCtx.stroke();
    }
  }

  if (state.showHeatmap && warp) {
    drawHeatmap(drawCtx, warp, transform);
  }

  for (const station of state.data.stations) {
    const [sx, sy] = projectPoint(station.point);
    drawCtx.beginPath();
    drawCtx.arc(sx, sy, 1.35, 0, Math.PI * 2);
    drawCtx.fillStyle = "#ffffff";
    drawCtx.fill();
    drawCtx.lineWidth = 0.55;
    drawCtx.strokeStyle = "#5a6e84";
    drawCtx.stroke();
  }

  drawCtx.font = '700 15px "Avenir Next", "Helvetica Neue", Helvetica, sans-serif';
  drawCtx.textAlign = "center";
  drawCtx.textBaseline = "middle";
  drawCtx.fillStyle = "#17304d";
  drawCtx.strokeStyle = "rgba(255,252,247,0.95)";
  drawCtx.lineWidth = 6;
  drawCtx.lineJoin = "round";
  for (const borough of state.data.boroughs) {
    const [lx, ly] = projectPoint(borough.label);
    drawCtx.strokeText(borough.name, lx, ly);
    drawCtx.fillText(borough.name, lx, ly);
  }

  if (state.pinned) {
    drawMarker(drawCtx, projectPoint(state.originPoint), "#d75c2e", 24, 5.5);
  } else if (state.cursorScreen) {
    drawMarker(drawCtx, state.cursorScreen, "#d75c2e", 24, 5.5);
  }

  if (state.pinned && state.cursorScreen) {
    drawMarker(drawCtx, state.cursorScreen, "#17304d", 18, 4.3, 0.18);
  }

  const nearest = warp?.seeds?.[0] ?? null;
  const station = nearest ? state.data.stations[nearest.index] : null;
  if (state.pinned && state.cursorPoint) {
    const probeMinutes = warp
      ? estimateTravelMinutes(warp.distances, state.cursorPoint)
      : distance(state.originPoint, state.cursorPoint) / state.data.meta.walkMetersPerMinute;
    statusText.textContent = station ? `Pinned near ${station.name}` : "Pinned origin";
    if (state.cursorScreen) {
      drawHoverTooltip(drawCtx, state.cursorScreen, `${formatMinutes(probeMinutes)} away`);
    }
  } else {
    statusText.textContent = station
      ? `${state.showWarp ? "Warped" : "Shown"} from near ${station.name}`
      : state.showWarp
        ? "Warped commute-time view"
        : "Geographic commute-time view";
    if (state.showPinHint && state.cursorScreen) {
      drawHoverTooltip(drawCtx, state.cursorScreen, "Click to pin");
    }
  }
}

function drawMarker(drawCtx, screenPoint, color, glowRadius, radius, glowAlpha = 0.5) {
  const [sx, sy] = screenPoint;
  const r = parseInt(color.slice(1, 3), 16);
  const g = parseInt(color.slice(3, 5), 16);
  const b = parseInt(color.slice(5, 7), 16);
  const halo = drawCtx.createRadialGradient(sx, sy, 2, sx, sy, glowRadius);
  halo.addColorStop(0, `rgba(${r}, ${g}, ${b}, ${glowAlpha})`);
  halo.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);
  drawCtx.fillStyle = halo;
  drawCtx.beginPath();
  drawCtx.arc(sx, sy, glowRadius, 0, Math.PI * 2);
  drawCtx.fill();

  drawCtx.beginPath();
  drawCtx.arc(sx, sy, radius, 0, Math.PI * 2);
  drawCtx.fillStyle = "#fff7ef";
  drawCtx.fill();
  drawCtx.lineWidth = 2;
  drawCtx.strokeStyle = color;
  drawCtx.stroke();
}

function drawHoverTooltip(drawCtx, screenPoint, label) {
  const [sx, sy] = screenPoint;
  drawCtx.save();
  drawCtx.font = '700 13px "Avenir Next", "Helvetica Neue", Helvetica, sans-serif';
  drawCtx.textAlign = "center";
  drawCtx.textBaseline = "middle";

  const metrics = drawCtx.measureText(label);
  const paddingX = 10;
  const boxWidth = metrics.width + paddingX * 2;
  const boxHeight = 28;
  const boxX = clamp(sx - boxWidth / 2, 12, drawCtx.canvas.clientWidth - boxWidth - 12);
  const boxY = clamp(sy + 16, 12, drawCtx.canvas.clientHeight - boxHeight - 12);

  drawCtx.fillStyle = "rgba(23, 48, 77, 0.92)";
  drawCtx.beginPath();
  drawCtx.roundRect(boxX, boxY, boxWidth, boxHeight, 10);
  drawCtx.fill();

  drawCtx.fillStyle = "#fff8ef";
  drawCtx.fillText(label, boxX + boxWidth / 2, boxY + boxHeight / 2 + 0.5);
  drawCtx.restore();
}

function roundRectPath(drawCtx, x, y, width, height, radius) {
  drawCtx.beginPath();
  drawCtx.roundRect(x, y, width, height, radius);
}

function currentOriginSummary(fallbackStationName = "NYC subway") {
  if (state.originLabel) return state.originLabel;
  return `Near ${fallbackStationName}`;
}

function exportShareImage() {
  const exportCanvas = document.createElement("canvas");
  exportCanvas.width = 1080;
  exportCanvas.height = 1350;
  const exportCtx = exportCanvas.getContext("2d");

  const bg = exportCtx.createLinearGradient(0, 0, 0, exportCanvas.height);
  bg.addColorStop(0, "#fbf5ea");
  bg.addColorStop(1, "#f2eadb");
  exportCtx.fillStyle = bg;
  exportCtx.fillRect(0, 0, exportCanvas.width, exportCanvas.height);

  exportCtx.fillStyle = "rgba(215, 92, 46, 0.1)";
  exportCtx.beginPath();
  exportCtx.arc(180, 150, 180, 0, Math.PI * 2);
  exportCtx.fill();
  exportCtx.fillStyle = "rgba(40, 112, 129, 0.08)";
  exportCtx.beginPath();
  exportCtx.arc(930, 190, 210, 0, Math.PI * 2);
  exportCtx.fill();

  exportCtx.fillStyle = "#d75c2e";
  exportCtx.font = '700 28px "Avenir Next", "Helvetica Neue", Helvetica, sans-serif';
  exportCtx.fillText("TRANSIT TIME CARTOGRAM", 72, 86);

  exportCtx.fillStyle = "#17304d";
  exportCtx.font = '700 58px "Avenir Next", "Helvetica Neue", Helvetica, sans-serif';
  exportCtx.fillText("New York by commute time", 72, 150);

  const nearestSeed = state.currentRender?.warp?.seeds?.[0];
  const nearestStationName = nearestSeed ? state.data.stations[nearestSeed.index].name : "NYC subway";
  const originSummary = currentOriginSummary(nearestStationName);
  const modeSummary = state.pinned ? "Pinned origin" : "Live hover origin";
  const heatmapSummary = state.showHeatmap ? "Heatmap on" : "Heatmap off";

  exportCtx.fillStyle = "#5f6f7f";
  exportCtx.font = '500 27px "Avenir Next", "Helvetica Neue", Helvetica, sans-serif';
  exportCtx.fillText(`${modeSummary}: ${originSummary}`, 72, 198);
  exportCtx.fillText(`${heatmapSummary} • Subway + walking access • ${formatShareTime()}`, 72, 236);

  const cardX = 50;
  const cardY = 280;
  const cardSize = 980;
  roundRectPath(exportCtx, cardX, cardY, cardSize, cardSize, 38);
  exportCtx.fillStyle = "rgba(255, 252, 247, 0.92)";
  exportCtx.fill();
  exportCtx.strokeStyle = "rgba(23, 48, 77, 0.1)";
  exportCtx.lineWidth = 2;
  exportCtx.stroke();

  const inset = 28;
  const mapX = cardX + inset;
  const mapY = cardY + inset;
  const mapSize = cardSize - inset * 2;
  roundRectPath(exportCtx, mapX, mapY, mapSize, mapSize, 28);
  exportCtx.save();
  exportCtx.clip();
  exportCtx.drawImage(mapCanvas, mapX, mapY, mapSize, mapSize);
  exportCtx.restore();

  if (state.showHeatmap) {
    const legendWidth = 360;
    const leftLabelWidth = 50;
    const rightLabelWidth = 64;
    const legendX = cardX + cardSize - inset - legendWidth - 10;
    const legendY = cardY + cardSize - inset - 30;
    const legendLineX = legendX + leftLabelWidth;
    const legendLineY = legendY;
    const legendLineWidth = legendWidth - leftLabelWidth - rightLabelWidth;

    exportCtx.font = '600 23px "Avenir Next", "Helvetica Neue", Helvetica, sans-serif';
    exportCtx.textBaseline = "middle";
    exportCtx.fillStyle = "#17304d";
    exportCtx.fillText("0m", legendX, legendY);

    const legendGradient = exportCtx.createLinearGradient(legendLineX, legendLineY, legendLineX + legendLineWidth, legendLineY);
    legendGradient.addColorStop(0, "#dc4525");
    legendGradient.addColorStop(0.18, "#f47f2e");
    legendGradient.addColorStop(0.36, "#ffc44f");
    legendGradient.addColorStop(0.58, "#f8e89c");
    legendGradient.addColorStop(0.78, "#95bcd3");
    legendGradient.addColorStop(1, "#4a678d");
    exportCtx.strokeStyle = legendGradient;
    exportCtx.lineWidth = 16;
    exportCtx.lineCap = "round";
    exportCtx.beginPath();
    exportCtx.moveTo(legendLineX, legendLineY);
    exportCtx.lineTo(legendLineX + legendLineWidth, legendLineY);
    exportCtx.stroke();

    exportCtx.textAlign = "right";
    exportCtx.fillText(`${MAX_TIME_MINUTES}m`, legendX + legendWidth, legendY);
    exportCtx.textAlign = "left";
  }

  exportCtx.fillStyle = "#17304d";
  exportCtx.font = '700 24px "Avenir Next", "Helvetica Neue", Helvetica, sans-serif';
  exportCtx.fillText("castrio.me/nyc-cartogram", 72, 1300);

  exportCtx.textAlign = "right";
  exportCtx.fillStyle = "#5f6f7f";
  exportCtx.font = '500 12px "Avenir Next", "Helvetica Neue", Helvetica, sans-serif';
  exportCtx.fillText("Data: MTA GTFS, NYC Open Data, OpenStreetMap", 1008, 1300);
  exportCtx.textAlign = "left";

  return exportCanvas;
}

async function downloadShareImage() {
  shareButton.disabled = true;
  try {
    requestDraw();
    await new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
    const exportCanvas = exportShareImage();
    const blob = await new Promise((resolve) => exportCanvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("Failed to create share image.");
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `nyc-commute-cartogram-${Date.now()}.png`;
    link.click();
    URL.revokeObjectURL(url);
  } finally {
    shareButton.disabled = false;
  }
}

function requestDraw() {
  if (!state.ready || !state.dirty) return;
  state.dirty = false;
  window.requestAnimationFrame(() => {
    const { width, height } = mapCanvas.getBoundingClientRect();
    drawMap(ctx, width, height);
  });
}

function resize() {
  const size = createCanvasBacking(mapCanvas);
  state.transform = buildTransform(state.data.meta.bounds, size.width, size.height);
  state.dirty = true;
  requestDraw();
}

function pointerToWorld(event) {
  const rect = mapCanvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  const screenPoint = [x, y];
  if (!state.currentRender) {
    return { screenPoint, worldPoint: state.transform.toWorld(x, y) };
  }
  // Screen space is fixed, but the visible geography is warped. To recover the
  // geographic point under the cursor, invert the warp currently on screen.
  const warpedWorld = state.currentRender.transform.toWorld(x, y);
  const worldPoint = state.currentRender.warp.inverseWarpPoint(warpedWorld);
  return { screenPoint, worldPoint };
}

function withinBounds(point) {
  const [minX, minY, maxX, maxY] = state.data.meta.bounds;
  return point[0] >= minX && point[0] <= maxX && point[1] >= minY && point[1] <= maxY;
}

function syncHeatmapLegend() {
  heatmapLegend.hidden = !state.showHeatmap;
  heatmapLegendMin.textContent = "0m";
  heatmapLegendMax.textContent = `${MAX_TIME_MINUTES}m`;
}

function syncFullscreenButton() {
  const isFullscreen = document.fullscreenElement === panelCard;
  panelCard.classList.toggle("is-immersive", isFullscreen);
  const label = isFullscreen ? "Exit full screen" : "Enter full screen";
  fullscreenButton.setAttribute("aria-label", label);
  fullscreenButton.setAttribute("title", label);
}

function clearSearchResults() {
  searchResults.innerHTML = "";
}

function setPinnedOrigin(worldPoint) {
  state.originPoint = worldPoint;
  state.pinnedPoint = worldPoint;
  state.pinnedScreen = null;
  state.pinned = true;
  state.cursorPoint = worldPoint;
  state.dirty = true;
  requestDraw();
}

function renderSearchResults(results) {
  clearSearchResults();
  if (!results.length) {
    searchMeta.textContent = "No NYC address matches found.";
    return;
  }
  searchMeta.textContent = "Choose a result to pin the origin there.";
  searchResults.innerHTML = results
    .map(
      (result, index) => `
        <button class="search-result" type="button" data-result-index="${index}">
          <strong>${escapeHtml(result.title)}</strong>
          <span>${escapeHtml(result.subtitle)}</span>
        </button>
      `,
    )
    .join("");

  for (const button of searchResults.querySelectorAll(".search-result")) {
    button.addEventListener("click", () => {
      const result = results[Number(button.dataset.resultIndex)];
      const worldPoint = lonLatToWorld(result.lon, result.lat);
      if (!withinBounds(worldPoint)) {
        searchMeta.textContent = "That result fell outside the current NYC map bounds.";
        return;
      }
      addressInput.value = result.title;
      searchMeta.textContent = `Pinned origin to ${result.title}.`;
      clearSearchResults();
      state.originLabel = result.title;
      setPinnedOrigin(worldPoint);
    });
  }
}

function lonLatToWorld(lon, lat) {
  const metersPerDegLat = 111_320.0;
  const metersPerDegLon = metersPerDegLat * Math.cos((state.data.meta.lat0 * Math.PI) / 180);
  return [lon * metersPerDegLon, lat * metersPerDegLat];
}

async function searchAddress(query) {
  const params = new URLSearchParams({
    q: `${query}, New York City`,
    format: "jsonv2",
    addressdetails: "1",
    countrycodes: "us",
    limit: "5",
    bounded: "1",
    viewbox: "-74.30,40.95,-73.65,40.45",
  });
  const response = await fetch(`https://nominatim.openstreetmap.org/search?${params.toString()}`, {
    headers: {
      Accept: "application/json",
    },
  });
  if (!response.ok) {
    throw new Error(`Search failed with status ${response.status}`);
  }
  const payload = await response.json();
  return payload.map((item) => ({
    title: item.display_name.split(",").slice(0, 2).join(",").trim(),
    subtitle: item.display_name,
    lat: Number(item.lat),
    lon: Number(item.lon),
  }));
}

async function init() {
  const response = await fetch(DATA_URL);
  state.data = await response.json();
  state.ready = true;
  warpToggle.checked = state.showWarp;
  heatmapToggle.checked = state.showHeatmap;
  syncHeatmapLegend();

  const manhattan = state.data.boroughs.find((borough) => borough.name === "Manhattan");
  state.cursorPoint = manhattan ? manhattan.label : state.data.stations[0].point;
  state.originPoint = state.cursorPoint;

  resize();
  window.addEventListener("resize", resize);

  mapCanvas.addEventListener("pointermove", (event) => {
    const { screenPoint, worldPoint } = pointerToWorld(event);
    if (!withinBounds(worldPoint)) return;
    state.cursorScreen = screenPoint;
    state.cursorPoint = worldPoint;
    if (!state.pinned && (!state.originPoint || distance(state.originPoint, worldPoint) >= HOVER_DEADBAND)) {
      state.originPoint = worldPoint;
      state.originLabel = null;
    }
    state.dirty = true;
    requestDraw();
  });

  mapCanvas.addEventListener("click", (event) => {
    const { screenPoint, worldPoint } = pointerToWorld(event);
    if (!withinBounds(worldPoint)) return;
    state.cursorScreen = screenPoint;
    state.cursorPoint = worldPoint;
    state.showPinHint = false;
    if (!state.pinned) {
      state.originPoint = worldPoint;
      state.originLabel = null;
      state.pinnedPoint = worldPoint;
      state.pinnedScreen = screenPoint;
      state.pinned = true;
    } else {
      state.pinned = false;
      state.pinnedPoint = null;
      state.pinnedScreen = null;
      state.originPoint = worldPoint;
      state.originLabel = null;
    }
    state.dirty = true;
    requestDraw();
  });

  mapCanvas.addEventListener("pointerleave", () => {
    state.cursorScreen = null;
    if (!state.pinned) {
      state.cursorPoint = state.originPoint;
    }
    state.dirty = true;
    requestDraw();
  });

  heatmapToggle.addEventListener("change", () => {
    state.showHeatmap = heatmapToggle.checked;
    syncHeatmapLegend();
    state.dirty = true;
    requestDraw();
  });

  warpToggle.addEventListener("change", () => {
    state.showWarp = warpToggle.checked;
    state.dirty = true;
    requestDraw();
  });

  fullscreenButton.addEventListener("click", async () => {
    try {
      if (document.fullscreenElement === panelCard) {
        await document.exitFullscreen();
      } else {
        await panelCard.requestFullscreen();
      }
    } catch (error) {
      console.error(error);
    } finally {
      syncFullscreenButton();
      resize();
    }
  });

  document.addEventListener("fullscreenchange", () => {
    syncFullscreenButton();
    resize();
  });

  shareButton.addEventListener("click", () => {
    downloadShareImage().catch((error) => {
      console.error(error);
      shareButton.disabled = false;
    });
  });

  searchForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const query = addressInput.value.trim();
    if (!query) {
      searchMeta.textContent = "Enter an NYC address to search.";
      clearSearchResults();
      return;
    }

    searchButton.disabled = true;
    searchButton.textContent = "Searching";
    searchMeta.textContent = "Looking up NYC address matches…";
    clearSearchResults();

    try {
      const results = await searchAddress(query);
      renderSearchResults(results);
    } catch (error) {
      console.error(error);
      searchMeta.textContent = "Address lookup failed. Try a more specific NYC address.";
    } finally {
      searchButton.disabled = false;
      searchButton.textContent = "Search";
    }
  });

  syncFullscreenButton();
}

init().catch((error) => {
  console.error(error);
  statusText.textContent = "Failed to load transit map data.";
});
