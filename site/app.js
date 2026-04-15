const DATA_URL = new URL("./data/commute_map_data.json", import.meta.url).toString();
const ENTRY_WAIT_MINUTES = 2.5;
const MAX_TIME_MINUTES = 80;
const MIN_AREA_WEIGHT = 1;
const MAX_AREA_WEIGHT = 2.67;
const PANEL_PADDING = 18;
const ROUTE_LINE_WIDTH = 2.2;
const WEIGHT_BLUR_PASSES = 2;
const WEIGHT_BLUR_RADIUS = 2;
const HOVER_DEADBAND = 14;
const HEATMAP_RESOLUTION_SCALE = 2;
const HEATMAP_BLUR_PX = 7;
const HEATMAP_ALPHA = 0.8;
const WARP_INFLUENCE_RADIUS = 8;
const WARP_SIGMA_CELLS = 3.4;
const WARP_DISPLACEMENT_SCALE = 1.0;
const WARP_MAX_SHIFT_CELLS = 6.6;
const WARP_NODE_SMOOTHING_PASSES = 3;
const WARP_EDGE_FADE_CELLS = 10;
const IMAGE_WARP_BLOCK_CELLS = 4;
const IMAGE_WARP_OVERDRAW_PX = 0.35;
const WARP_LINE_CURVE_TOLERANCE_PX = 1.1;
const WARP_LINE_MAX_SUBDIVISION_DEPTH = 7;
const SWIM_METERS_PER_MINUTE = 28;

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
  baseMapCache: null,
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

function smoothstep(edge0, edge1, value) {
  const t = clamp((value - edge0) / ((edge1 - edge0) || 1), 0, 1);
  return t * t * (3 - 2 * t);
}

function distance(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function pointInRing(point, ring) {
  const [x, y] = point;
  let inside = false;
  let j = ring.length - 1;
  for (let i = 0; i < ring.length; i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersects = (yi > y) !== (yj > y);
    if (intersects) {
      const xHit = ((xj - xi) * (y - yi)) / ((yj - yi) || 1e-12) + xi;
      if (x < xHit) inside = !inside;
    }
    j = i;
  }
  return inside;
}

function pointInPolygon(point, polygon) {
  if (!polygon.length || !pointInRing(point, polygon[0])) return false;
  for (let index = 1; index < polygon.length; index += 1) {
    if (pointInRing(point, polygon[index])) return false;
  }
  return true;
}

function pointToSegmentProjection(point, start, end) {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) {
    return { point: start.slice(), distance: distance(point, start) };
  }
  const t = clamp(((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / lengthSquared, 0, 1);
  const projectedPoint = [start[0] + dx * t, start[1] + dy * t];
  return { point: projectedPoint, distance: distance(point, projectedPoint) };
}

function locateNearestBoroughBorder(point) {
  let best = { point: point.slice(), distance: Infinity };
  for (const borough of state.data.boroughs) {
    for (const polygon of borough.polygons) {
      for (const ring of polygon) {
        for (let index = 0; index < ring.length - 1; index += 1) {
          const candidate = pointToSegmentProjection(point, ring[index], ring[index + 1]);
          if (candidate.distance < best.distance) best = candidate;
        }
      }
    }
  }
  return best;
}

function pointInBoroughs(point) {
  for (const borough of state.data.boroughs) {
    for (const polygon of borough.polygons) {
      if (pointInPolygon(point, polygon)) return true;
    }
  }
  return false;
}

function pointInExternalLand(point) {
  for (const polygon of state.data.externalLand || []) {
    if (pointInPolygon(point, polygon)) return true;
  }
  return false;
}

function classifySurface(point) {
  if (pointInBoroughs(point)) return "borough";
  return pointInExternalLand(point) ? "land" : "water";
}

function normalizeTravelPoint(point) {
  const surface = classifySurface(point);
  if (surface !== "water") {
    return {
      surface,
      point,
      swimMinutes: 0,
      swimDistance: 0,
    };
  }
  const border = locateNearestBoroughBorder(point);
  return {
    surface,
    point: border.point,
    swimMinutes: border.distance / SWIM_METERS_PER_MINUTE,
    swimDistance: border.distance,
  };
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function bilerpPoint(p00, p10, p01, p11, tx, ty) {
  return [
    lerp(lerp(p00[0], p10[0], tx), lerp(p01[0], p11[0], tx), ty),
    lerp(lerp(p00[1], p10[1], tx), lerp(p01[1], p11[1], tx), ty),
  ];
}

function triangleArea(a, b, c) {
  return Math.abs((a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1])) / 2);
}

function quadArea(p00, p10, p11, p01) {
  return triangleArea(p00, p10, p11) + triangleArea(p00, p11, p01);
}

function barycentricWeights(point, a, b, c) {
  const denominator = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
  if (Math.abs(denominator) < 1e-9) return null;
  const w1 = ((b[1] - c[1]) * (point[0] - c[0]) + (c[0] - b[0]) * (point[1] - c[1])) / denominator;
  const w2 = ((c[1] - a[1]) * (point[0] - c[0]) + (a[0] - c[0]) * (point[1] - c[1])) / denominator;
  const w3 = 1 - w1 - w2;
  const epsilon = 1e-5;
  if (w1 < -epsilon || w2 < -epsilon || w3 < -epsilon) return null;
  return [w1, w2, w3];
}

function interpolateTriangle(weights, a, b, c) {
  return [
    weights[0] * a[0] + weights[1] * b[0] + weights[2] * c[0],
    weights[0] * a[1] + weights[1] * b[1] + weights[2] * c[1],
  ];
}

function formatMinutes(minutes) {
  if (!Number.isFinite(minutes)) return "unreachable";
  if (minutes < 1) return "<1 min";
  return `${Math.round(minutes)} min`;
}

function formatTravelBreakdown(baseMinutes, swimMinutes) {
  if (!Number.isFinite(baseMinutes)) return "unreachable";
  if (swimMinutes < 0.5) return formatMinutes(baseMinutes);
  return `${Math.round(baseMinutes)} min + ${Math.round(swimMinutes)} min swim 🌊`;
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

function createCanvasSurface(width, height) {
  const dpr = window.devicePixelRatio || 1;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * dpr));
  canvas.height = Math.max(1, Math.round(height * dpr));
  const context = canvas.getContext("2d");
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { canvas, context, width, height };
}

function expandTriangle(points, amount) {
  if (!amount) return points.map((point) => point.slice());
  const centroid = [
    (points[0][0] + points[1][0] + points[2][0]) / 3,
    (points[0][1] + points[1][1] + points[2][1]) / 3,
  ];
  return points.map((point) => {
    const dx = point[0] - centroid[0];
    const dy = point[1] - centroid[1];
    const length = Math.hypot(dx, dy) || 1;
    return [point[0] + (dx / length) * amount, point[1] + (dy / length) * amount];
  });
}

function trianglePath(drawCtx, a, b, c) {
  drawCtx.beginPath();
  drawCtx.moveTo(a[0], a[1]);
  drawCtx.lineTo(b[0], b[1]);
  drawCtx.lineTo(c[0], c[1]);
  drawCtx.closePath();
}

function affineTransformBetweenTriangles(srcA, srcB, srcC, dstA, dstB, dstC) {
  const srcUx = srcB[0] - srcA[0];
  const srcUy = srcB[1] - srcA[1];
  const srcVx = srcC[0] - srcA[0];
  const srcVy = srcC[1] - srcA[1];
  const determinant = srcUx * srcVy - srcVx * srcUy;
  if (Math.abs(determinant) < 1e-9) return null;

  const inv00 = srcVy / determinant;
  const inv01 = -srcVx / determinant;
  const inv10 = -srcUy / determinant;
  const inv11 = srcUx / determinant;

  const dstUx = dstB[0] - dstA[0];
  const dstUy = dstB[1] - dstA[1];
  const dstVx = dstC[0] - dstA[0];
  const dstVy = dstC[1] - dstA[1];

  const a = dstUx * inv00 + dstVx * inv10;
  const c = dstUx * inv01 + dstVx * inv11;
  const b = dstUy * inv00 + dstVy * inv10;
  const d = dstUy * inv01 + dstVy * inv11;
  const e = dstA[0] - a * srcA[0] - c * srcA[1];
  const f = dstA[1] - b * srcA[0] - d * srcA[1];

  return [a, b, c, d, e, f];
}

function drawWarpedTriangle(drawCtx, sourceCanvas, sourceWidth, sourceHeight, srcA, srcB, srcC, dstA, dstB, dstC) {
  const matrix = affineTransformBetweenTriangles(srcA, srcB, srcC, dstA, dstB, dstC);
  if (!matrix) return;
  const [a, b, c, d, e, f] = matrix;
  const [clipA, clipB, clipC] = expandTriangle([dstA, dstB, dstC], IMAGE_WARP_OVERDRAW_PX);
  drawCtx.save();
  trianglePath(drawCtx, clipA, clipB, clipC);
  drawCtx.clip();
  drawCtx.transform(a, b, c, d, e, f);
  drawCtx.drawImage(sourceCanvas, 0, 0, sourceWidth, sourceHeight);
  drawCtx.restore();
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

function landMaskPolygons() {
  if (state.data.landMask?.length) return state.data.landMask;
  return state.data.boroughs.flatMap((borough) => borough.polygons);
}

function traceBoroughMaskPath(drawCtx, projectPoint) {
  drawCtx.beginPath();
  for (const borough of state.data.boroughs) {
    for (const polygon of borough.polygons) {
      tracePolygonPath(drawCtx, polygon, projectPoint);
    }
  }
}

function traceLandMaskPath(drawCtx, projectPoint) {
  drawCtx.beginPath();
  for (const polygon of landMaskPolygons()) {
    tracePolygonPath(drawCtx, polygon, projectPoint);
  }
}

function fillLandMask(drawCtx, projectPoint) {
  traceLandMaskPath(drawCtx, projectPoint);
  drawCtx.fillStyle = "#f3f6fa";
  drawCtx.fill("evenodd");
}

function drawExternalLand(drawCtx, projectPoint) {
  const polygons = state.data.externalLand || [];
  if (!polygons.length) return;
  drawCtx.save();
  drawCtx.globalAlpha = 0.3;
  drawCtx.fillStyle = "#f3f6fa";
  drawCtx.strokeStyle = "rgba(79, 105, 135, 0.42)";
  drawCtx.lineWidth = 0.75;
  drawCtx.lineJoin = "round";
  for (const polygon of polygons) {
    drawPolygonPath(drawCtx, polygon, projectPoint);
    drawCtx.fill();
    drawCtx.stroke();
  }
  drawCtx.restore();
}

function midpoint(a, b) {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

function distanceToChord(point, start, end) {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const length = Math.hypot(dx, dy);
  if (length < 1e-6) return distance(point, start);
  return Math.abs(dx * (start[1] - point[1]) - (start[0] - point[0]) * dy) / length;
}

function traceAdaptiveSegment(drawCtx, start, end, startScreen, endScreen, projectPoint, tolerance, depth) {
  if (depth <= 0) {
    drawCtx.lineTo(endScreen[0], endScreen[1]);
    return;
  }
  const worldMid = midpoint(start, end);
  const screenMid = projectPoint(worldMid);
  const deviation = distanceToChord(screenMid, startScreen, endScreen);
  if (deviation <= tolerance) {
    drawCtx.lineTo(endScreen[0], endScreen[1]);
    return;
  }
  traceAdaptiveSegment(drawCtx, start, worldMid, startScreen, screenMid, projectPoint, tolerance, depth - 1);
  traceAdaptiveSegment(drawCtx, worldMid, end, screenMid, endScreen, projectPoint, tolerance, depth - 1);
}

function drawPolyline(drawCtx, points, projectPoint, { tolerance = 0, maxDepth = 0 } = {}) {
  if (!points.length) return;
  drawCtx.beginPath();
  let previousPoint = points[0];
  let previousScreen = projectPoint(previousPoint);
  drawCtx.moveTo(previousScreen[0], previousScreen[1]);
  for (let index = 1; index < points.length; index += 1) {
    const nextPoint = points[index];
    const nextScreen = projectPoint(nextPoint);
    if (tolerance > 0 && maxDepth > 0) {
      traceAdaptiveSegment(
        drawCtx,
        previousPoint,
        nextPoint,
        previousScreen,
        nextScreen,
        projectPoint,
        tolerance,
        maxDepth,
      );
    } else {
      drawCtx.lineTo(nextScreen[0], nextScreen[1]);
    }
    previousPoint = nextPoint;
    previousScreen = nextScreen;
  }
  drawCtx.stroke();
}

function drawCityBasemap(
  drawCtx,
  projectPoint,
  {
    includeBoroughBorders = true,
    streetCurveTolerance = 0,
    routeCurveTolerance = 0,
    curveMaxDepth = 0,
  } = {},
) {
  fillLandMask(drawCtx, projectPoint);

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
    drawPolyline(drawCtx, street.points, projectPoint, {
      tolerance: streetCurveTolerance,
      maxDepth: curveMaxDepth,
    });
  }

  for (const route of state.data.routes) {
    drawCtx.strokeStyle = route.color;
    drawCtx.lineWidth = ROUTE_LINE_WIDTH;
    drawCtx.lineCap = "round";
    drawCtx.lineJoin = "round";
    drawPolyline(drawCtx, route.points, projectPoint, {
      tolerance: routeCurveTolerance,
      maxDepth: curveMaxDepth,
    });
  }

  if (includeBoroughBorders) {
    for (const borough of state.data.boroughs) {
      for (const polygon of borough.polygons) {
        drawPolygonPath(drawCtx, polygon, projectPoint);
        drawCtx.strokeStyle = "#4f6987";
        drawCtx.lineWidth = 1.05;
        drawCtx.stroke();
      }
    }
  }
}

function drawStations(drawCtx, projectPoint) {
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
}

function drawBoroughLabels(drawCtx, projectPoint) {
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
}

function streetWidth(kind) {
  if (kind === "motorway") return 1.8;
  if (kind === "trunk") return 1.5;
  return 1.1;
}

function buildBaseMapCache(width, height, sourceTransform) {
  const surface = createCanvasSurface(width, height);
  surface.context.clearRect(0, 0, width, height);
  drawCityBasemap(surface.context, (point) => sourceTransform.toScreen(point), { includeBoroughBorders: false });
  return surface;
}

function getBaseMapCache(width, height, sourceTransform) {
  const cache = state.baseMapCache;
  if (cache && cache.width === width && cache.height === height) {
    return cache;
  }
  const nextCache = buildBaseMapCache(width, height, sourceTransform);
  state.baseMapCache = nextCache;
  return nextCache;
}

function drawWarpedBaseMap(drawCtx, width, height, warp, sourceTransform, destinationTransform) {
  const surface = getBaseMapCache(width, height, sourceTransform);
  const { gridCols, gridRows, bounds } = state.data.meta;
  const [minX, minY, maxX, maxY] = bounds;
  const cellW = (maxX - minX) / gridCols;
  const cellH = (maxY - minY) / gridRows;

  drawCtx.save();
  drawCtx.imageSmoothingEnabled = true;
  for (let row = 0; row < gridRows; row += IMAGE_WARP_BLOCK_CELLS) {
    const rowEnd = Math.min(gridRows, row + IMAGE_WARP_BLOCK_CELLS);
    for (let col = 0; col < gridCols; col += IMAGE_WARP_BLOCK_CELLS) {
      const colEnd = Math.min(gridCols, col + IMAGE_WARP_BLOCK_CELLS);
      const worldP00 = [minX + col * cellW, minY + row * cellH];
      const worldP10 = [minX + colEnd * cellW, minY + row * cellH];
      const worldP11 = [minX + colEnd * cellW, minY + rowEnd * cellH];
      const worldP01 = [minX + col * cellW, minY + rowEnd * cellH];

      const srcP00 = sourceTransform.toScreen(worldP00);
      const srcP10 = sourceTransform.toScreen(worldP10);
      const srcP11 = sourceTransform.toScreen(worldP11);
      const srcP01 = sourceTransform.toScreen(worldP01);
      const dstP00 = destinationTransform.toScreen(warp.warpNodes[row][col]);
      const dstP10 = destinationTransform.toScreen(warp.warpNodes[row][colEnd]);
      const dstP11 = destinationTransform.toScreen(warp.warpNodes[rowEnd][colEnd]);
      const dstP01 = destinationTransform.toScreen(warp.warpNodes[rowEnd][col]);

      drawWarpedTriangle(drawCtx, surface.canvas, width, height, srcP00, srcP10, srcP11, dstP00, dstP10, dstP11);
      drawWarpedTriangle(drawCtx, surface.canvas, width, height, srcP00, srcP11, srcP01, dstP00, dstP11, dstP01);
    }
  }
  drawCtx.restore();
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

function runDijkstra(origin) {
  const stateCount = state.data.routeStates.length;
  const distances = new Array(stateCount).fill(Infinity);
  const visited = new Array(stateCount).fill(false);
  const seeds = nearestStations(origin.point, state.data.meta.originStationCount);

  for (const seed of seeds) {
    for (const routeStateIndex of state.data.stationStates[seed.index] || []) {
      const routeId = state.data.routeStates[routeStateIndex].routeId;
      const boardWait = state.data.routeWaits[routeId] ?? state.data.meta.defaultBoardWait ?? ENTRY_WAIT_MINUTES;
      distances[routeStateIndex] = Math.min(
        distances[routeStateIndex],
        origin.swimMinutes + seed.walkMinutes + boardWait,
      );
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

function estimateTravel(origin, originDistances, destinationPoint) {
  const destination = normalizeTravelPoint(destinationPoint);
  const swimMinutes = origin.swimMinutes + destination.swimMinutes;
  let bestMinutes =
    distance(origin.point, destination.point) / state.data.meta.walkMetersPerMinute +
    swimMinutes;
  const nearby = nearestStations(destination.point, state.data.meta.cellNearestStations);
  for (const station of nearby) {
    for (const routeStateIndex of state.data.stationStates[station.index] || []) {
      bestMinutes = Math.min(
        bestMinutes,
        originDistances[routeStateIndex] + station.walkMinutes + destination.swimMinutes,
      );
    }
  }
  return {
    minutes: bestMinutes,
    baseMinutes: bestMinutes - swimMinutes,
    swimMinutes,
    destination,
  };
}

function computeWarp(origin) {
  const { distances, seeds } = runDijkstra(origin);
  const { gridCols, gridRows, bounds } = state.data.meta;
  const [minX, minY, maxX, maxY] = bounds;
  const spanX = maxX - minX;
  const spanY = maxY - minY;
  const cellW = spanX / gridCols;
  const cellH = spanY / gridRows;
  const minuteGrid = Array.from({ length: gridRows }, () => new Array(gridCols).fill(Infinity));
  const validMask = Array.from({ length: gridRows }, () => new Array(gridCols).fill(false));

  for (let maskIndex = 0; maskIndex < state.data.mask.length; maskIndex += 1) {
    const cellIndex = state.data.mask[maskIndex];
    if (cellIndex === -1) continue;
    const cell = state.data.cells[cellIndex];
    let bestMinutes =
      distance(origin.point, cell.point) / state.data.meta.walkMetersPerMinute + origin.swimMinutes;
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
  const anomalyGrid = Array.from({ length: gridRows }, () => new Array(gridCols).fill(0));

  for (let row = 0; row < gridRows; row += 1) {
    for (let col = 0; col < gridCols; col += 1) {
      if (!validMask[row][col]) continue;
      const areaWeight = minuteToAreaWeight(smoothedMinutes[row][col]);
      areaWeights[row][col] = areaWeight;
      anomalyGrid[row][col] = areaWeight - 1;
    }
  }

  const warpNodes = Array.from({ length: gridRows + 1 }, () => new Array(gridCols + 1).fill(null));
  const sigmaSq = WARP_SIGMA_CELLS * WARP_SIGMA_CELLS;
  const maxShiftX = cellW * WARP_MAX_SHIFT_CELLS;
  const maxShiftY = cellH * WARP_MAX_SHIFT_CELLS;

  for (let nodeRow = 0; nodeRow <= gridRows; nodeRow += 1) {
    for (let nodeCol = 0; nodeCol <= gridCols; nodeCol += 1) {
      const baseX = minX + nodeCol * cellW;
      const baseY = minY + nodeRow * cellH;
      let offsetX = 0;
      let offsetY = 0;

      const rowStart = Math.max(0, nodeRow - WARP_INFLUENCE_RADIUS);
      const rowEnd = Math.min(gridRows - 1, nodeRow + WARP_INFLUENCE_RADIUS - 1);
      const colStart = Math.max(0, nodeCol - WARP_INFLUENCE_RADIUS);
      const colEnd = Math.min(gridCols - 1, nodeCol + WARP_INFLUENCE_RADIUS - 1);

      for (let row = rowStart; row <= rowEnd; row += 1) {
        for (let col = colStart; col <= colEnd; col += 1) {
          if (!validMask[row][col]) continue;
          const anomaly = anomalyGrid[row][col];
          if (Math.abs(anomaly) < 1e-6) continue;
          const centerX = minX + (col + 0.5) * cellW;
          const centerY = minY + (row + 0.5) * cellH;
          const dxCells = (baseX - centerX) / cellW;
          const dyCells = (baseY - centerY) / cellH;
          const distSqCells = dxCells * dxCells + dyCells * dyCells;
          const distCells = Math.sqrt(distSqCells + 1e-9);
          const gaussian = Math.exp(-distSqCells / (2 * sigmaSq));
          const strength = anomaly * gaussian * WARP_DISPLACEMENT_SCALE;
          offsetX += (dxCells / distCells) * strength * cellW;
          offsetY += (dyCells / distCells) * strength * cellH;
        }
      }

      offsetX = clamp(offsetX, -maxShiftX, maxShiftX);
      offsetY = clamp(offsetY, -maxShiftY, maxShiftY);

      const edgeDistance = Math.min(nodeCol, gridCols - nodeCol, nodeRow, gridRows - nodeRow);
      const edgeFade = smoothstep(0, WARP_EDGE_FADE_CELLS, edgeDistance);
      warpNodes[nodeRow][nodeCol] = [baseX + offsetX * edgeFade, baseY + offsetY * edgeFade];
    }
  }

  for (let pass = 0; pass < WARP_NODE_SMOOTHING_PASSES; pass += 1) {
    const nextNodes = warpNodes.map((row) => row.map((point) => point.slice()));
    for (let nodeRow = 1; nodeRow < gridRows; nodeRow += 1) {
      for (let nodeCol = 1; nodeCol < gridCols; nodeCol += 1) {
        let totalX = 0;
        let totalY = 0;
        let count = 0;
        for (let y = nodeRow - 1; y <= nodeRow + 1; y += 1) {
          for (let x = nodeCol - 1; x <= nodeCol + 1; x += 1) {
            totalX += warpNodes[y][x][0];
            totalY += warpNodes[y][x][1];
            count += 1;
          }
        }
        const edgeDistance = Math.min(nodeCol, gridCols - nodeCol, nodeRow, gridRows - nodeRow);
        const edgeFade = smoothstep(0, WARP_EDGE_FADE_CELLS, edgeDistance);
        const smoothedX = totalX / count;
        const smoothedY = totalY / count;
        nextNodes[nodeRow][nodeCol] = [
          lerp(minX + nodeCol * cellW, smoothedX, 0.72 * edgeFade),
          lerp(minY + nodeRow * cellH, smoothedY, 0.72 * edgeFade),
        ];
      }
    }
    for (let nodeRow = 0; nodeRow <= gridRows; nodeRow += 1) {
      for (let nodeCol = 0; nodeCol <= gridCols; nodeCol += 1) {
        warpNodes[nodeRow][nodeCol] = nextNodes[nodeRow][nodeCol];
      }
    }
  }

  function warpPoint(point) {
    const clampedX = clamp(point[0], minX, maxX);
    const clampedY = clamp(point[1], minY, maxY);
    const rawCol = clamp((clampedX - minX) / cellW, 0, gridCols - 1e-9);
    const rawRow = clamp((clampedY - minY) / cellH, 0, gridRows - 1e-9);
    const col = clamp(Math.floor(rawCol), 0, gridCols - 1);
    const row = clamp(Math.floor(rawRow), 0, gridRows - 1);
    const tx = rawCol - col;
    const ty = rawRow - row;
    return bilerpPoint(
      warpNodes[row][col],
      warpNodes[row][col + 1],
      warpNodes[row + 1][col],
      warpNodes[row + 1][col + 1],
      tx,
      ty,
    );
  }

  function inverseWarpPoint(point) {
    const approximate = (() => {
      let guess = [point[0], point[1]];
      for (let iteration = 0; iteration < 6; iteration += 1) {
        const projected = warpPoint(guess);
        guess = [
          clamp(guess[0] + (point[0] - projected[0]), minX, maxX),
          clamp(guess[1] + (point[1] - projected[1]), minY, maxY),
        ];
      }
      return guess;
    })();

    const approxCol = clamp(Math.floor((approximate[0] - minX) / cellW), 0, gridCols - 1);
    const approxRow = clamp(Math.floor((approximate[1] - minY) / cellH), 0, gridRows - 1);

    function solveCell(row, col) {
      if (row < 0 || row >= gridRows || col < 0 || col >= gridCols) return null;
      const p00 = warpNodes[row][col];
      const p10 = warpNodes[row][col + 1];
      const p11 = warpNodes[row + 1][col + 1];
      const p01 = warpNodes[row + 1][col];

      const upperWeights = barycentricWeights(point, p00, p10, p11);
      if (upperWeights) {
        return interpolateTriangle(
          upperWeights,
          [minX + col * cellW, minY + row * cellH],
          [minX + (col + 1) * cellW, minY + row * cellH],
          [minX + (col + 1) * cellW, minY + (row + 1) * cellH],
        );
      }

      const lowerWeights = barycentricWeights(point, p00, p11, p01);
      if (lowerWeights) {
        return interpolateTriangle(
          lowerWeights,
          [minX + col * cellW, minY + row * cellH],
          [minX + (col + 1) * cellW, minY + (row + 1) * cellH],
          [minX + col * cellW, minY + (row + 1) * cellH],
        );
      }

      return null;
    }

    for (let radius = 0; radius <= 8; radius += 1) {
      for (let row = approxRow - radius; row <= approxRow + radius; row += 1) {
        for (let col = approxCol - radius; col <= approxCol + radius; col += 1) {
          if (radius > 0 && row > approxRow - radius && row < approxRow + radius && col > approxCol - radius && col < approxCol + radius) {
            continue;
          }
          const solved = solveCell(row, col);
          if (solved) return solved;
        }
      }
    }

    for (let row = 0; row < gridRows; row += 1) {
      for (let col = 0; col < gridCols; col += 1) {
        const solved = solveCell(row, col);
        if (solved) return solved;
      }
    }

    return approximate;
  }

  const allWarpedNodes = warpNodes.flat();
  const xs = allWarpedNodes.map((point) => point[0]);
  const ys = allWarpedNodes.map((point) => point[1]);
  const warpedBounds = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  const expansion = Array.from({ length: gridRows }, () => new Array(gridCols).fill(0));
  for (let row = 0; row < gridRows; row += 1) {
    for (let col = 0; col < gridCols; col += 1) {
      if (!validMask[row][col]) continue;
      expansion[row][col] =
        quadArea(
          warpNodes[row][col],
          warpNodes[row][col + 1],
          warpNodes[row + 1][col + 1],
          warpNodes[row + 1][col],
        ) / (cellW * cellH);
    }
  }

  return {
    distances,
    seeds,
    warpPoint,
    inverseWarpPoint,
    warpedBounds,
    warpNodes,
    minutes: smoothedMinutes,
    expansion,
    areaWeights,
    validMask,
  };
}

function drawHeatmap(drawCtx, warp, transform, useWarpGeometry = true) {
  const { gridCols, gridRows, bounds } = state.data.meta;
  const { width, height } = mapCanvas.getBoundingClientRect();
  const scale = HEATMAP_RESOLUTION_SCALE;
  const rawCanvas = document.createElement("canvas");
  rawCanvas.width = Math.max(1, Math.round(width * scale));
  rawCanvas.height = Math.max(1, Math.round(height * scale));
  const rawCtx = rawCanvas.getContext("2d");
  rawCtx.setTransform(scale, 0, 0, scale, 0, 0);
  rawCtx.imageSmoothingEnabled = true;
  const [minX, minY, maxX, maxY] = bounds;
  const cellW = (maxX - minX) / gridCols;
  const cellH = (maxY - minY) / gridRows;

  for (let row = 0; row < gridRows; row += 1) {
    for (let col = 0; col < gridCols; col += 1) {
      if (!warp.validMask[row][col]) continue;
      rawCtx.fillStyle = heatmapColor(warp.minutes[row][col], 1);
      if (useWarpGeometry) {
        const p00 = transform.toScreen(warp.warpNodes[row][col]);
        const p10 = transform.toScreen(warp.warpNodes[row][col + 1]);
        const p11 = transform.toScreen(warp.warpNodes[row + 1][col + 1]);
        const p01 = transform.toScreen(warp.warpNodes[row + 1][col]);
        rawCtx.beginPath();
        rawCtx.moveTo(p00[0], p00[1]);
        rawCtx.lineTo(p10[0], p10[1]);
        rawCtx.lineTo(p11[0], p11[1]);
        rawCtx.lineTo(p01[0], p01[1]);
        rawCtx.closePath();
        rawCtx.fill();
      } else {
        const x0 = minX + col * cellW;
        const y0 = minY + row * cellH;
        const x1 = x0 + cellW;
        const y1 = y0 + cellH;
        const left = transform.toScreen([x0, y0])[0];
        const right = transform.toScreen([x1, y0])[0];
        const top = transform.toScreen([x0, y1])[1];
        const bottom = transform.toScreen([x0, y0])[1];
        rawCtx.fillRect(left, top, Math.max(1, right - left), Math.max(1, bottom - top));
      }
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
  traceLandMaskPath(maskedCtx, (point) => transform.toScreen(useWarpGeometry ? warp.warpPoint(point) : point));
  maskedCtx.clip("evenodd");
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
  if (!state.transform) return;

  if (!state.originPoint) {
    const projectPoint = (point) => state.transform.toScreen(point);
    drawExternalLand(drawCtx, projectPoint);
    drawCityBasemap(drawCtx, projectPoint);
    drawStations(drawCtx, projectPoint);
    drawBoroughLabels(drawCtx, projectPoint);

    statusText.textContent = "Hover to preview an origin, then click to pin it.";
    state.currentRender = {
      warp: {
        inverseWarpPoint: (point) => point,
        distances: null,
        seeds: [],
      },
      transform: state.transform,
      anchorOffset: [0, 0],
    };
    return;
  }

  const normalizedOrigin = normalizeTravelPoint(state.originPoint);
  const warp = state.showWarp || state.showHeatmap ? computeWarp(normalizedOrigin) : null;
  const baseTransform = state.transform;
  const warpPoint = state.showWarp && warp ? warp.warpPoint : (point) => point;
  const inverseWarpPoint = warp ? warp.inverseWarpPoint : (point) => point;
  const warpedBounds = state.showWarp && warp ? warp.warpedBounds : state.data.meta.bounds;
  const anchorScreen = state.showWarp && state.pinned ? state.pinnedScreen : null;
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
  const externalLandProjectPoint = (point) => transform.toScreen(point);
  const lineCurveOptions = state.showWarp
    ? {
        streetCurveTolerance: WARP_LINE_CURVE_TOLERANCE_PX,
        routeCurveTolerance: WARP_LINE_CURVE_TOLERANCE_PX,
        curveMaxDepth: WARP_LINE_MAX_SUBDIVISION_DEPTH,
      }
    : {};
  state.currentRender = {
    warp: {
      inverseWarpPoint: state.showWarp ? inverseWarpPoint : (point) => point,
      distances: warp?.distances ?? null,
      seeds: warp?.seeds ?? [],
      origin: normalizedOrigin,
    },
    transform,
    anchorOffset: [dx, dy],
  };

  drawExternalLand(drawCtx, externalLandProjectPoint);
  drawCityBasemap(drawCtx, projectPoint, {
    includeBoroughBorders: !state.showWarp,
    ...lineCurveOptions,
  });

  if (state.showHeatmap && warp) {
    const heatmapTransform = state.showWarp ? transform : baseTransform;
    drawHeatmap(drawCtx, warp, heatmapTransform, state.showWarp);
  }

  drawStations(drawCtx, projectPoint);
  drawBoroughLabels(drawCtx, projectPoint);

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
    const probe = warp
      ? estimateTravel(normalizedOrigin, warp.distances, state.cursorPoint)
      : (() => {
          const destination = normalizeTravelPoint(state.cursorPoint);
          const swimMinutes = normalizedOrigin.swimMinutes + destination.swimMinutes;
          const minutes =
            distance(normalizedOrigin.point, destination.point) / state.data.meta.walkMetersPerMinute +
            swimMinutes;
          return {
            minutes,
            baseMinutes: minutes - swimMinutes,
            swimMinutes,
            destination,
          };
        })();
    statusText.textContent = station ? `Pinned near ${station.name}` : "Pinned origin";
    if (state.cursorScreen) {
      drawHoverTooltip(drawCtx, state.cursorScreen, `${formatTravelBreakdown(probe.baseMinutes, probe.swimMinutes)} away`);
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
  state.baseMapCache = null;
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
  state.baseMapCache = null;
  state.ready = true;
  warpToggle.checked = state.showWarp;
  heatmapToggle.checked = state.showHeatmap;
  syncHeatmapLegend();

  const manhattan = state.data.boroughs.find((borough) => borough.name === "Manhattan");
  state.cursorPoint = null;
  state.originPoint = null;

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
    const hovered = state.cursorScreen && state.cursorPoint;
    const { screenPoint, worldPoint } = hovered
      ? { screenPoint: state.cursorScreen.slice(), worldPoint: state.cursorPoint.slice() }
      : pointerToWorld(event);
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
      state.cursorPoint = null;
      state.originPoint = null;
      state.originLabel = null;
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
