const DATA_URL = new URL("./data/commute_map_data.json", import.meta.url).toString();
const ENTRY_WAIT_MINUTES = 2.5;
const MAX_TIME_MINUTES = 100;
const MIN_AREA_WEIGHT = 1;
const MAX_AREA_WEIGHT = 2.67;
const MIN_VIEWPORT_SCALE = 1;
const MAX_VIEWPORT_SCALE = 4;
const VIEWPORT_ZOOM_STEP = 1.35;
const PANEL_PADDING = 18;
const ROUTE_LINE_WIDTH = 2.2;
const WEIGHT_BLUR_PASSES = 2;
const WEIGHT_BLUR_RADIUS = 2;
const HOVER_DEADBAND = 14;
const MOBILE_PIN_TAP_SLOP = 10;
const MOBILE_PIN_HIT_RADIUS = 26;
const DESKTOP_PIN_TAP_SLOP = 6;
const DESKTOP_PIN_HIT_RADIUS = 18;
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
const REACHABILITY_THRESHOLD_MINUTES = 60;
const SHARE_COORDINATE_DECIMALS = 5;

const state = {
  data: null,
  ready: false,
  showWarp: true,
  showHeatmap: true,
  showPinHint: true,
  isMobile: false,
  drawerCollapsed: false,
  mobileHelpCollapsed: false,
  viewportScale: 1,
  viewportCenter: null,
  cursorPoint: null,
  cursorScreen: null,
  originPoint: null,
  originLabel: null,
  pinnedPoint: null,
  pinnedScreen: null,
  pinned: false,
  probePoint: null,
  probePinned: false,
  mobilePointerId: null,
  mobileDragTarget: null,
  mobileGestureStartScreen: null,
  mobileGestureMoved: false,
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
const zoomInButton = document.getElementById("zoomInButton");
const zoomOutButton = document.getElementById("zoomOutButton");
const fullscreenButton = document.getElementById("fullscreenButton");
const searchForm = document.getElementById("searchForm");
const addressInput = document.getElementById("addressInput");
const searchButton = document.getElementById("searchButton");
const shareButton = document.getElementById("shareButton");
const sharePanel = document.getElementById("sharePanel");
const shareNativeRow = document.getElementById("shareNativeRow");
const nativeShareAction = document.getElementById("nativeShareAction");
const shareXAction = document.getElementById("shareXAction");
const shareFacebookAction = document.getElementById("shareFacebookAction");
const shareInstagramAction = document.getElementById("shareInstagramAction");
const shareLinkedInAction = document.getElementById("shareLinkedInAction");
const downloadImageAction = document.getElementById("downloadImageAction");
const shareXIcon = document.getElementById("shareXIcon");
const shareFacebookIcon = document.getElementById("shareFacebookIcon");
const shareInstagramIcon = document.getElementById("shareInstagramIcon");
const shareLinkedInIcon = document.getElementById("shareLinkedInIcon");
const searchMeta = document.getElementById("searchMeta");
const searchResults = document.getElementById("searchResults");
const reachScoreCard = document.getElementById("reachScoreCard");
const reachScoreValue = document.getElementById("reachScoreValue");
const reachScoreMeta = document.getElementById("reachScoreMeta");
const mobileOriginTitle = document.getElementById("mobileOriginTitle");
const mobileStatusText = document.getElementById("mobileStatusText");
const mobileClearButton = document.getElementById("mobileClearButton");
const mobileSheet = document.getElementById("mobileSheet");
const mobileSheetToggle = document.getElementById("mobileSheetToggle");
const mobileSheetBody = document.getElementById("mobileSheetBody");
const mobileReachValue = document.getElementById("mobileReachValue");
const mobileReachMeta = document.getElementById("mobileReachMeta");
const mobileWarpToggle = document.getElementById("mobileWarpToggle");
const mobileHeatmapToggle = document.getElementById("mobileHeatmapToggle");
const mobileSearchForm = document.getElementById("mobileSearchForm");
const mobileAddressInput = document.getElementById("mobileAddressInput");
const mobileSearchButton = document.getElementById("mobileSearchButton");
const mobileSearchMeta = document.getElementById("mobileSearchMeta");
const mobileSearchResults = document.getElementById("mobileSearchResults");
const mobileLocateButton = document.getElementById("mobileLocateButton");
const mobileShareButton = document.getElementById("mobileShareButton");
const mobileMapHelp = document.getElementById("mobileMapHelp");
const mobileMapInstructions = document.getElementById("mobileMapInstructions");
const mobileInstructionsLocateButton = document.getElementById("mobileInstructionsLocateButton");
const mobileHelpBubble = document.getElementById("mobileHelpBubble");
const ctx = mapCanvas.getContext("2d");
const panelCard = document.querySelector(".panel-card");

const searchUis = [
  {
    form: searchForm,
    input: addressInput,
    button: searchButton,
    meta: searchMeta,
    results: searchResults,
  },
  {
    form: mobileSearchForm,
    input: mobileAddressInput,
    button: mobileSearchButton,
    meta: mobileSearchMeta,
    results: mobileSearchResults,
  },
];

shareXIcon.src = new URL("./x.png", import.meta.url).toString();
shareFacebookIcon.src = new URL("./Facebook.png", import.meta.url).toString();
shareInstagramIcon.src = new URL("./Instagram.png", import.meta.url).toString();
shareLinkedInIcon.src = new URL("./LinkedIn.png", import.meta.url).toString();

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

function isMobileLayout() {
  return window.matchMedia("(max-width: 640px)").matches;
}

function setDrawerCollapsed(collapsed) {
  state.drawerCollapsed = collapsed;
  if (!mobileSheet || !mobileSheetToggle || !mobileSheetBody) return;
  mobileSheet.classList.toggle("is-collapsed", collapsed);
  mobileSheet.setAttribute("aria-expanded", String(!collapsed));
  mobileSheetToggle.setAttribute("aria-expanded", String(!collapsed));
  mobileSheetBody.hidden = collapsed;
}

function syncMobileHelp() {
  if (!mobileMapHelp || !mobileMapInstructions || !mobileHelpBubble) return;
  const collapsed = state.mobileHelpCollapsed;
  mobileMapHelp.classList.toggle("is-collapsed", collapsed);
  mobileMapInstructions.setAttribute("aria-hidden", String(collapsed));
  mobileHelpBubble.hidden = !collapsed;
  mobileHelpBubble.setAttribute("aria-expanded", String(!collapsed));
}

function collapseMobileHelp() {
  if (state.mobileHelpCollapsed) return;
  state.mobileHelpCollapsed = true;
  syncMobileHelp();
}

function expandMobileHelp() {
  state.mobileHelpCollapsed = false;
  syncMobileHelp();
}

function worldToLonLat(point) {
  const metersPerDegLat = 111_320.0;
  const metersPerDegLon = metersPerDegLat * Math.cos((state.data.meta.lat0 * Math.PI) / 180);
  return {
    lon: point[0] / metersPerDegLon,
    lat: point[1] / metersPerDegLat,
  };
}

function formatCoordinate(value) {
  return Number(value).toFixed(SHARE_COORDINATE_DECIMALS);
}

function formatCoordinatePair(point) {
  const { lat, lon } = worldToLonLat(point);
  return `${formatCoordinate(lat)},${formatCoordinate(lon)}`;
}

function originPathForPoint(point) {
  return `@${formatCoordinatePair(point)}`;
}

function originQueryForPoint(point) {
  return `?origin=${formatCoordinatePair(point)}`;
}

function parseCoordinatePair(value) {
  if (!value) return null;
  const match = value.match(/^@?(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/);
  if (!match) return null;
  const lat = Number(match[1]);
  const lon = Number(match[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon };
}

function parseOriginPath(pathname = window.location.pathname) {
  const match = pathname.match(/\/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)\/?$/);
  return match ? parseCoordinatePair(`${match[1]},${match[2]}`) : null;
}

function getBasePath() {
  return window.__ASSET_BASE__ || "/";
}

function isLocalStaticDev() {
  return (
    ["localhost", "127.0.0.1"].includes(window.location.hostname) &&
    getBasePath().startsWith("/site/")
  );
}

function getCoordinateUrlFragment(point) {
  return isLocalStaticDev() ? originQueryForPoint(point) : originPathForPoint(point);
}

function buildViewUrlFragment(
  originPoint = state.pinnedPoint || state.originPoint,
  probePoint = state.probePoint,
  zoomLevel = state.viewportScale,
) {
  const params = new URLSearchParams();
  if (isLocalStaticDev() && originPoint) {
    params.set("origin", formatCoordinatePair(originPoint));
  }
  if (probePoint) {
    params.set("distance", formatCoordinatePair(probePoint));
  }
  if (zoomLevel > MIN_VIEWPORT_SCALE) {
    params.set("zoom", zoomLevel.toFixed(2));
  }
  if (!state.showWarp) {
    params.set("warp", "0");
  }
  if (!state.showHeatmap) {
    params.set("heatmap", "0");
  }

  const query = params.toString();
  if (isLocalStaticDev()) {
    return query ? `?${query}` : "";
  }

  const path = originPoint ? originPathForPoint(originPoint) : "";
  return query ? `${path}?${query}` : path;
}

function parseSharedView() {
  const searchParams = new URLSearchParams(window.location.search);
  const origin =
    parseOriginPath() ||
    parseCoordinatePair(searchParams.get("origin")) ||
    parseCoordinatePair(window.location.hash.replace(/^#/, ""));
  const probe = parseCoordinatePair(searchParams.get("distance"));
  const zoomRaw = Number(searchParams.get("zoom"));
  const zoom = Number.isFinite(zoomRaw) ? clamp(zoomRaw, MIN_VIEWPORT_SCALE, MAX_VIEWPORT_SCALE) : null;
  const warp = searchParams.has("warp") ? searchParams.get("warp") !== "0" : null;
  const heatmap = searchParams.has("heatmap") ? searchParams.get("heatmap") !== "0" : null;
  return { origin, probe, zoom, warp, heatmap };
}

function replaceBrowserUrl(pathOrQuery = "") {
  const nextUrl = new URL(pathOrQuery, window.location.origin + getBasePath());
  window.history.replaceState(null, "", nextUrl);
}

function syncBrowserUrl() {
  replaceBrowserUrl(buildViewUrlFragment());
}

function getShareUrl() {
  const pathOrQuery = buildViewUrlFragment();
  return new URL(pathOrQuery, window.location.origin + getBasePath()).toString();
}

function getShareText() {
  return "Explore New York City by subway commute time with this interactive transit cartogram.";
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function shortOriginLabel(label) {
  if (!label) return "";
  if (label === "My location") return label;
  const primary = label.split(",")[0].trim();
  if (/^\d/.test(primary)) return primary;
  return primary.toLowerCase().startsWith("near ") ? primary : `Near ${primary}`;
}

function heatmapColor(minutes, alpha = 0.56) {
  const t = clamp(minutes / MAX_TIME_MINUTES, 0, 1);
  const stops = [
    { t: 0, color: [220, 69, 37] },
    { t: 0.2, color: [244, 127, 46] },
    { t: 0.4, color: [255, 196, 79] },
    { t: 0.62, color: [248, 232, 156] },
    { t: 0.8, color: [149, 188, 211] },
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

function defaultMapCenter(bounds = state.data?.meta?.bounds) {
  if (!bounds) return [0, 0];
  const [minX, minY, maxX, maxY] = bounds;
  return [(minX + maxX) / 2, (minY + maxY) / 2];
}

function pinMidpoint(a, b) {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

function currentZoomFocusPoint() {
  if (state.originPoint && state.probePoint) return pinMidpoint(state.originPoint, state.probePoint);
  if (state.originPoint) return state.originPoint.slice();
  return defaultMapCenter();
}

function activeViewportCenter() {
  if (state.viewportScale <= MIN_VIEWPORT_SCALE) return null;
  return currentZoomFocusPoint();
}

function buildTransform(bounds, width, height, padding = PANEL_PADDING, zoom = 1, centerPoint = null) {
  const [minX, minY, maxX, maxY] = bounds;
  const spanX = maxX - minX;
  const spanY = maxY - minY;
  const baseScale = Math.min((width - padding * 2) / spanX, (height - padding * 2) / spanY);
  const scale = baseScale * zoom;
  const [rawCenterX, rawCenterY] = centerPoint || defaultMapCenter(bounds);
  const centerX = clamp(rawCenterX, minX, maxX);
  const centerY = clamp(rawCenterY, minY, maxY);
  const offsetX = width / 2;
  const offsetY = height / 2;

  return {
    scale,
    baseScale,
    center: [centerX, centerY],
    cacheKey: `${width}:${height}:${scale}:${centerX}:${centerY}`,
    toScreen(point) {
      const [x, y] = point;
      return [offsetX + (x - centerX) * scale, offsetY - (y - centerY) * scale];
    },
    toWorld(x, y) {
      return [centerX + (x - offsetX) / scale, centerY - (y - offsetY) / scale];
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
  surface.cacheKey = sourceTransform.cacheKey;
  return surface;
}

function getBaseMapCache(width, height, sourceTransform) {
  const cache = state.baseMapCache;
  if (cache && cache.width === width && cache.height === height && cache.cacheKey === sourceTransform.cacheKey) {
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

function summarizeReachability(origin, originDistances) {
  const totalStations = state.data.stations.length;
  let reachableStations = 0;

  for (const station of state.data.stations) {
    const trip = estimateTravel(origin, originDistances, station.point);
    if (trip.minutes <= REACHABILITY_THRESHOLD_MINUTES) {
      reachableStations += 1;
    }
  }

  return {
    reachableStations,
    totalStations,
    ratio: totalStations ? reachableStations / totalStations : 0,
  };
}

function syncReachabilityScore(summary = null) {
  if (!summary) {
    reachScoreCard.hidden = true;
    reachScoreValue.textContent = "-- / --";
    reachScoreMeta.textContent = "Choose an origin to see how much of the subway you can reach in an hour.";
    if (mobileReachValue && mobileReachMeta) {
      mobileReachValue.textContent = "-- / --";
      mobileReachMeta.textContent = "Choose an origin to see how much of the subway you can reach in an hour.";
    }
    return;
  }

  reachScoreCard.hidden = false;
  const percent = Math.round(summary.ratio * 100);
  reachScoreValue.textContent = `${summary.reachableStations} / ${summary.totalStations}`;
  reachScoreMeta.textContent = `${percent}% of stations are reachable within ${REACHABILITY_THRESHOLD_MINUTES} minutes.`;
  if (mobileReachValue && mobileReachMeta) {
    mobileReachValue.textContent = `${summary.reachableStations} / ${summary.totalStations}`;
    mobileReachMeta.textContent = `${percent}% of stations are reachable within ${REACHABILITY_THRESHOLD_MINUTES} minutes.`;
  }
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

  const reachability = summarizeReachability(origin, distances);

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
    reachability,
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
    if (state.cursorScreen) {
      drawMarker(drawCtx, state.cursorScreen, "#d75c2e", 24, 5.5);
    }

    statusText.textContent = state.cursorScreen
      ? "Release to pin the origin."
      : "Drag on the map to place an origin.";
    state.currentRender = {
      warp: {
        inverseWarpPoint: (point) => point,
        distances: null,
        reachability: null,
        seeds: [],
      },
      transform: state.transform,
      anchorOffset: [0, 0],
      projectPoint,
    };
    syncReachabilityScore();
    syncMobileSheet();
    return;
  }

  const normalizedOrigin = normalizeTravelPoint(state.originPoint);
  const warp = computeWarp(normalizedOrigin);
  const baseTransform = state.transform;
  const warpPoint = state.showWarp && warp ? warp.warpPoint : (point) => point;
  const inverseWarpPoint = warp ? warp.inverseWarpPoint : (point) => point;
  const warpedBounds = state.showWarp && warp ? warp.warpedBounds : state.data.meta.bounds;
  const zoomFocusPoint = state.viewportScale > MIN_VIEWPORT_SCALE ? currentZoomFocusPoint() : null;
  const anchorScreen = zoomFocusPoint
    ? [width / 2, height / 2]
    : state.showWarp && state.pinned && !state.isMobile
      ? state.pinnedScreen
      : null;
  const anchorWorldPoint = zoomFocusPoint || state.originPoint;
  const anchoredOrigin = baseTransform.toScreen(warpPoint(anchorWorldPoint));
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
  const dx = zoomFocusPoint ? desiredDx : clampToRange(desiredDx, minDx, maxDx);
  const dy = zoomFocusPoint ? desiredDy : clampToRange(desiredDy, minDy, maxDy);
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
      reachability: warp?.reachability ?? null,
      seeds: warp?.seeds ?? [],
      origin: normalizedOrigin,
    },
    transform,
    anchorOffset: [dx, dy],
    projectPoint,
  };
  syncReachabilityScore(warp?.reachability ?? null);

  drawExternalLand(drawCtx, externalLandProjectPoint);
  drawCityBasemap(drawCtx, projectPoint, {
    includeBoroughBorders: !state.showWarp,
    ...lineCurveOptions,
  });

  if (state.showHeatmap && warp) {
    drawHeatmap(drawCtx, warp, transform, state.showWarp);
  }

  const nearest = warp?.seeds?.[0] ?? null;
  const station = nearest ? state.data.stations[nearest.index] : null;

  drawStations(drawCtx, projectPoint);
  drawBoroughLabels(drawCtx, projectPoint);

  if (state.originPoint) {
    const originScreen = projectPoint(state.originPoint);
    drawMarker(drawCtx, originScreen, "#d75c2e", 24, 5.5);
    drawPinnedLabel(drawCtx, originScreen, currentOriginSummary(station?.name ?? "NYC subway"));
  } else if (state.cursorScreen) {
    drawMarker(drawCtx, state.cursorScreen, "#d75c2e", 24, 5.5);
  }

  if (state.probePoint) {
    drawMarker(drawCtx, projectPoint(state.probePoint), "#17304d", 18, 4.3, 0.18);
  } else if (state.pinned && state.cursorScreen) {
    drawMarker(drawCtx, state.cursorScreen, "#17304d", 18, 4.3, 0.18);
  }

  const activeProbePoint = state.probePoint || (state.isMobile ? null : state.cursorPoint);
  const activeProbeScreen = state.probePoint
    ? projectPoint(state.probePoint)
    : state.isMobile
      ? null
      : state.cursorScreen;
  if (state.originPoint && activeProbePoint) {
    const probe = measureProbeFromWarp(normalizedOrigin, warp, activeProbePoint);
    statusText.textContent = station ? `Pinned near ${station.name}` : "Pinned origin";
    if (probe && activeProbeScreen) {
      drawHoverTooltip(drawCtx, activeProbeScreen, `${formatTravelBreakdown(probe.baseMinutes, probe.swimMinutes)} away`);
    }
  } else {
    statusText.textContent = station
      ? `${state.showWarp ? "Warped" : "Shown"} from near ${station.name}`
      : state.showWarp
        ? "Warped commute-time view"
        : "Geographic commute-time view";
  }
  syncMobileSheet();
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

function drawPinnedLabel(drawCtx, screenPoint, label, options = {}) {
  const {
    offsetX = 18,
    offsetY = -20,
    align = "left",
  } = options;
  const [sx, sy] = screenPoint;
  drawCtx.save();
  drawCtx.font = '700 13px "Avenir Next", "Helvetica Neue", Helvetica, sans-serif';
  drawCtx.textAlign = "left";
  drawCtx.textBaseline = "middle";

  const metrics = drawCtx.measureText(label);
  const paddingX = 10;
  const boxWidth = metrics.width + paddingX * 2;
  const boxHeight = 28;
  const desiredX = align === "right" ? sx - offsetX - boxWidth : sx + offsetX;
  const boxX = clamp(desiredX, 12, drawCtx.canvas.clientWidth - boxWidth - 12);
  const boxY = clamp(sy + offsetY, 12, drawCtx.canvas.clientHeight - boxHeight - 12);

  drawCtx.fillStyle = "rgba(255, 248, 239, 0.96)";
  drawCtx.beginPath();
  drawCtx.roundRect(boxX, boxY, boxWidth, boxHeight, 10);
  drawCtx.fill();
  drawCtx.strokeStyle = "rgba(23, 48, 77, 0.14)";
  drawCtx.lineWidth = 1;
  drawCtx.stroke();

  drawCtx.fillStyle = "#17304d";
  drawCtx.fillText(label, boxX + paddingX, boxY + boxHeight / 2 + 0.5);
  drawCtx.restore();
}

function measureProbeFromWarp(normalizedOrigin, warp, probePoint) {
  if (!normalizedOrigin || !probePoint) return null;
  if (warp?.distances) {
    return estimateTravel(normalizedOrigin, warp.distances, probePoint);
  }
  const destination = normalizeTravelPoint(probePoint);
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
}

function roundRectPath(drawCtx, x, y, width, height, radius) {
  drawCtx.beginPath();
  drawCtx.roundRect(x, y, width, height, radius);
}

function currentOriginSummary(fallbackStationName = "NYC subway") {
  if (state.originLabel) return shortOriginLabel(state.originLabel);
  return `Near ${fallbackStationName}`;
}

function exportShareImage() {
  const exportCanvas = document.createElement("canvas");
  exportCanvas.width = 1080;
  exportCanvas.height = 1240;
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
  exportCtx.fillText("New York City", 72, 146);

  const nearestSeed = state.currentRender?.warp?.seeds?.[0];
  const nearestStationName = nearestSeed ? state.data.stations[nearestSeed.index].name : "NYC subway";
  const normalizedOrigin = state.originPoint ? normalizeTravelPoint(state.originPoint) : null;
  const probeMeasurement = state.probePoint
    ? measureProbeFromWarp(normalizedOrigin, state.currentRender?.warp ?? null, state.probePoint)
    : null;

  const cardX = 50;
  const cardY = 198;
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
  const sourceWidthCss = mapCanvas.clientWidth;
  const sourceHeightCss = mapCanvas.clientHeight;
  const sourceSquareCss = Math.min(sourceWidthCss, sourceHeightCss);
  const sourceXCss = (sourceWidthCss - sourceSquareCss) / 2;
  const sourceYCss = (sourceHeightCss - sourceSquareCss) / 2;
  const sourceScaleX = mapCanvas.width / Math.max(sourceWidthCss, 1);
  const sourceScaleY = mapCanvas.height / Math.max(sourceHeightCss, 1);
  roundRectPath(exportCtx, mapX, mapY, mapSize, mapSize, 28);
  exportCtx.save();
  exportCtx.clip();
  exportCtx.drawImage(
    mapCanvas,
    sourceXCss * sourceScaleX,
    sourceYCss * sourceScaleY,
    sourceSquareCss * sourceScaleX,
    sourceSquareCss * sourceScaleY,
    mapX,
    mapY,
    mapSize,
    mapSize,
  );
  if (state.originPoint && state.currentRender?.projectPoint) {
    const originScreen = state.currentRender.projectPoint(state.originPoint);
    drawPinnedLabel(
      exportCtx,
      [
        mapX + ((originScreen[0] - sourceXCss) / sourceSquareCss) * mapSize,
        mapY + ((originScreen[1] - sourceYCss) / sourceSquareCss) * mapSize,
      ],
      currentOriginSummary(nearestStationName),
    );
  }
  if (probeMeasurement && state.currentRender?.projectPoint && state.probePoint) {
    const probeScreen = state.currentRender.projectPoint(state.probePoint);
    drawHoverTooltip(
      exportCtx,
      [
        mapX + ((probeScreen[0] - sourceXCss) / sourceSquareCss) * mapSize,
        mapY + ((probeScreen[1] - sourceYCss) / sourceSquareCss) * mapSize,
      ],
      `${formatTravelBreakdown(probeMeasurement.baseMinutes, probeMeasurement.swimMinutes)} away`,
    );
  }

  const reachability = state.currentRender?.warp?.reachability ?? null;
  if (reachability) {
    const badgeX = mapX + 26;
    const badgeY = mapY + 24;
    const badgeWidth = 310;
    const badgeHeight = 110;
    const percent = Math.round(reachability.ratio * 100);

    exportCtx.fillStyle = "rgba(255, 252, 247, 0.9)";
    exportCtx.beginPath();
    exportCtx.roundRect(badgeX, badgeY, badgeWidth, badgeHeight, 22);
    exportCtx.fill();

    exportCtx.strokeStyle = "rgba(23, 48, 77, 0.12)";
    exportCtx.lineWidth = 1.5;
    exportCtx.stroke();

    exportCtx.fillStyle = "#5f6f7f";
    exportCtx.font = '700 17px "Avenir Next", "Helvetica Neue", Helvetica, sans-serif';
    exportCtx.fillText("60-MINUTE REACH", badgeX + 20, badgeY + 26);

    exportCtx.fillStyle = "#17304d";
    exportCtx.font = '700 42px "Avenir Next", "Helvetica Neue", Helvetica, sans-serif';
    exportCtx.fillText(
      `${reachability.reachableStations} / ${reachability.totalStations}`,
      badgeX + 20,
      badgeY + 68,
    );

    exportCtx.fillStyle = "#5f6f7f";
    exportCtx.font = '500 18px "Avenir Next", "Helvetica Neue", Helvetica, sans-serif';
    exportCtx.fillText(`${percent}% of stations within 60 min`, badgeX + 20, badgeY + 94);
  }
  exportCtx.restore();

  if (state.showHeatmap) {
    const legendWidth = 360;
    const leftLabelWidth = 50;
    const rightLabelWidth = 80;
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
  exportCtx.fillText("castrio.me/nyc", 72, 1202);

  exportCtx.textAlign = "right";
  exportCtx.fillStyle = "#5f6f7f";
  exportCtx.font = '500 12px "Avenir Next", "Helvetica Neue", Helvetica, sans-serif';
  exportCtx.fillText("Data: MTA GTFS, NYC Open Data, OpenStreetMap", 1008, 1202);
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

function closeSharePanel() {
  sharePanel.hidden = true;
  shareButton.setAttribute("aria-expanded", "false");
}

function setSearchMetaText(text) {
  for (const ui of searchUis) {
    ui.meta.textContent = text;
  }
}

function setSearchBusy(isBusy) {
  for (const ui of searchUis) {
    ui.button.disabled = isBusy;
    ui.button.textContent = isBusy ? "Searching" : "Search";
  }
}

function setAddressInputs(value) {
  for (const ui of searchUis) {
    ui.input.value = value;
  }
}

function openSharePanel() {
  const shareUrl = getShareUrl();
  const shareTitle = document.title;
  const shareText = getShareText();
  const encodedUrl = encodeURIComponent(shareUrl);
  const encodedText = encodeURIComponent(`${shareTitle} — ${shareText}`);

  shareXAction.href = `https://x.com/intent/post?url=${encodedUrl}&text=${encodedText}`;
  shareFacebookAction.href = `https://www.facebook.com/sharer/sharer.php?u=${encodedUrl}`;
  shareLinkedInAction.href = `https://www.linkedin.com/sharing/share-offsite/?url=${encodedUrl}`;
  shareNativeRow.hidden = !navigator.share;
  sharePanel.hidden = false;
  shareButton.setAttribute("aria-expanded", "true");
}

function toggleSharePanel() {
  if (sharePanel.hidden) {
    openSharePanel();
    return;
  }
  closeSharePanel();
}

function requestDraw() {
  if (!state.ready || !state.dirty) return;
  state.dirty = false;
  window.requestAnimationFrame(() => {
    const { width, height } = mapCanvas.getBoundingClientRect();
    drawMap(ctx, width, height);
  });
}

function syncZoomControls() {
  if (!zoomInButton || !zoomOutButton) return;
  zoomInButton.disabled = state.viewportScale >= MAX_VIEWPORT_SCALE;
  zoomOutButton.disabled = state.viewportScale <= MIN_VIEWPORT_SCALE;
}

function updateViewportTransform() {
  if (!state.data) return;
  const size = createCanvasBacking(mapCanvas);
  state.transform = buildTransform(
    state.data.meta.bounds,
    size.width,
    size.height,
    PANEL_PADDING,
    state.viewportScale,
    activeViewportCenter(),
  );
  state.baseMapCache = null;
  state.dirty = true;
  syncZoomControls();
  syncMobileSheet();
  syncMobileHelp();
  requestDraw();
}

function setViewportScale(nextScale) {
  const clampedScale = clamp(nextScale, MIN_VIEWPORT_SCALE, MAX_VIEWPORT_SCALE);
  state.viewportScale = clampedScale;
  state.viewportCenter = clampedScale > MIN_VIEWPORT_SCALE ? currentZoomFocusPoint() : null;
  state.pinnedScreen = null;
  syncBrowserUrl();
  updateViewportTransform();
}

function resize() {
  state.isMobile = isMobileLayout();
  updateViewportTransform();
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

function screenDistance(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function currentProjectedPinPositions() {
  if (!state.currentRender?.projectPoint) {
    return { originScreen: null, probeScreen: null };
  }
  const originScreen = state.originPoint ? state.currentRender.projectPoint(state.originPoint) : null;
  const probeScreen = state.probePoint ? state.currentRender.projectPoint(state.probePoint) : null;
  return { originScreen, probeScreen };
}

function hitPinTarget(screenPoint, hitRadius = MOBILE_PIN_HIT_RADIUS) {
  const { originScreen, probeScreen } = currentProjectedPinPositions();
  if (probeScreen && screenDistance(screenPoint, probeScreen) <= hitRadius) {
    return "probe";
  }
  if (originScreen && screenDistance(screenPoint, originScreen) <= hitRadius) {
    return "origin";
  }
  return null;
}

function setProbePoint(worldPoint) {
  state.probePoint = worldPoint;
  state.probePinned = Boolean(worldPoint);
}

function clearProbePoint() {
  state.probePoint = null;
  state.probePinned = false;
  syncBrowserUrl();
}

function beginPinGesture(pointerId, screenPoint, worldPoint, hitRadius) {
  state.mobilePointerId = pointerId;
  state.mobileGestureStartScreen = screenPoint;
  state.mobileGestureMoved = false;
  state.mobileDragTarget = hitPinTarget(screenPoint, hitRadius) || (!state.originPoint ? "new-origin" : "new-probe");

  if (state.mobileDragTarget === "origin" || state.mobileDragTarget === "new-origin") {
    state.originLabel = null;
    state.originPoint = worldPoint;
    state.pinned = state.mobileDragTarget === "origin" ? true : false;
    if (state.mobileDragTarget === "new-origin") {
      clearProbePoint();
    }
  } else if (state.mobileDragTarget === "probe" || state.mobileDragTarget === "new-probe") {
    setProbePoint(worldPoint);
  }

  state.cursorScreen = screenPoint;
  state.cursorPoint = worldPoint;
  state.showPinHint = false;
  state.dirty = true;
}

function updatePinGesture(screenPoint, worldPoint, tapSlop) {
  state.mobileGestureMoved =
    state.mobileGestureMoved ||
    screenDistance(state.mobileGestureStartScreen || screenPoint, screenPoint) > tapSlop;
  state.cursorScreen = screenPoint;
  state.cursorPoint = worldPoint;

  if (state.mobileDragTarget === "origin" || state.mobileDragTarget === "new-origin") {
    state.originLabel = null;
    state.originPoint = worldPoint;
  } else if (state.mobileDragTarget === "probe" || state.mobileDragTarget === "new-probe") {
    setProbePoint(worldPoint);
  }

  state.dirty = true;
  requestDraw();
}

function handleMobilePointerDown(event) {
  if (!state.isMobile) return;
  closeSharePanel();
  collapseMobileHelp();
  const { screenPoint, worldPoint } = pointerToWorld(event);
  if (!withinBounds(worldPoint)) return;
  beginPinGesture(event.pointerId, screenPoint, worldPoint, MOBILE_PIN_HIT_RADIUS);
  mapCanvas.setPointerCapture(event.pointerId);
  requestDraw();
}

function handleMobilePointerMove(event) {
  if (!state.isMobile || state.mobilePointerId !== event.pointerId || !state.mobileDragTarget) return;
  const { screenPoint, worldPoint } = pointerToWorld(event);
  if (!withinBounds(worldPoint)) return;
  updatePinGesture(screenPoint, worldPoint, MOBILE_PIN_TAP_SLOP);
}

function resetMobileGestureState() {
  state.mobilePointerId = null;
  state.mobileDragTarget = null;
  state.mobileGestureStartScreen = null;
  state.mobileGestureMoved = false;
}

function handleMobilePointerUp(event) {
  if (!state.isMobile || state.mobilePointerId !== event.pointerId || !state.mobileDragTarget) return;

  const dragTarget = state.mobileDragTarget;
  const moved = state.mobileGestureMoved;

  if (dragTarget === "origin" && !moved) {
    clearPinnedOrigin();
  } else if (dragTarget === "probe" && !moved) {
    clearProbePoint();
    state.dirty = true;
    requestDraw();
  } else {
    if (dragTarget === "origin" || dragTarget === "new-origin") {
      state.pinned = true;
      state.pinnedPoint = state.originPoint ? state.originPoint.slice() : null;
      state.pinnedScreen = state.cursorScreen ? state.cursorScreen.slice() : null;
      syncBrowserUrl();
    } else if (dragTarget === "probe" || dragTarget === "new-probe") {
      state.probePinned = true;
      syncBrowserUrl();
    }
    state.dirty = true;
    syncMobileSheet();
    requestDraw();
  }

  state.cursorScreen = null;
  state.cursorPoint = null;
  try {
    mapCanvas.releasePointerCapture(event.pointerId);
  } catch (error) {
    console.error(error);
  }
  resetMobileGestureState();
}

function handleMobilePointerCancel(event) {
  if (!state.isMobile || state.mobilePointerId !== event.pointerId) return;
  state.cursorScreen = null;
  state.cursorPoint = null;
  resetMobileGestureState();
  state.dirty = true;
  requestDraw();
}

function handleDesktopPointerDown(event) {
  if (state.isMobile) return;
  closeSharePanel();
  collapseMobileHelp();
  const { screenPoint, worldPoint } = pointerToWorld(event);
  if (!withinBounds(worldPoint)) return;
  beginPinGesture(event.pointerId, screenPoint, worldPoint, DESKTOP_PIN_HIT_RADIUS);
  mapCanvas.setPointerCapture(event.pointerId);
  requestDraw();
}

function handleDesktopPointerMove(event) {
  if (state.isMobile) return;
  if (state.mobilePointerId !== event.pointerId || !state.mobileDragTarget) return;
  const { screenPoint, worldPoint } = pointerToWorld(event);
  if (!withinBounds(worldPoint)) return;
  updatePinGesture(screenPoint, worldPoint, DESKTOP_PIN_TAP_SLOP);
}

function handleDesktopPointerUp(event) {
  if (state.isMobile || state.mobilePointerId !== event.pointerId || !state.mobileDragTarget) return;

  const dragTarget = state.mobileDragTarget;
  const moved = state.mobileGestureMoved;

  if (dragTarget === "origin" && !moved) {
    clearPinnedOrigin();
  } else if (dragTarget === "probe" && !moved) {
    clearProbePoint();
    state.dirty = true;
    requestDraw();
  } else {
    if (dragTarget === "origin" || dragTarget === "new-origin") {
      state.pinned = true;
      state.pinnedPoint = state.originPoint ? state.originPoint.slice() : null;
      state.pinnedScreen = null;
      syncBrowserUrl();
    } else if (dragTarget === "probe" || dragTarget === "new-probe") {
      state.probePinned = true;
      syncBrowserUrl();
    }
    state.dirty = true;
    syncMobileSheet();
    requestDraw();
  }

  state.cursorScreen = null;
  state.cursorPoint = null;
  try {
    mapCanvas.releasePointerCapture(event.pointerId);
  } catch (error) {
    console.error(error);
  }
  resetMobileGestureState();
}

function handleDesktopPointerCancel(event) {
  if (state.isMobile || state.mobilePointerId !== event.pointerId) return;
  state.cursorScreen = null;
  state.cursorPoint = null;
  resetMobileGestureState();
  state.dirty = true;
  requestDraw();
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
  for (const ui of searchUis) {
    ui.results.innerHTML = "";
  }
}

function setPinnedOrigin(worldPoint) {
  state.originPoint = worldPoint;
  state.pinnedPoint = worldPoint;
  state.pinnedScreen = null;
  state.pinned = true;
  state.cursorPoint = worldPoint;
  syncBrowserUrl();
  state.dirty = true;
  syncMobileSheet();
  requestDraw();
}

function clearPinnedOrigin() {
  state.pinned = false;
  state.pinnedPoint = null;
  state.pinnedScreen = null;
  clearProbePoint();
  state.cursorScreen = null;
  state.cursorPoint = null;
  state.originPoint = null;
  state.originLabel = null;
  syncBrowserUrl();
  state.dirty = true;
  syncMobileSheet();
  requestDraw();
}

function syncMobileSheet() {
  if (!mobileOriginTitle || !mobileStatusText || !mobileClearButton) return;

  const nearestSeed = state.currentRender?.warp?.seeds?.[0] ?? null;
  const nearestStation = nearestSeed ? state.data?.stations?.[nearestSeed.index] : null;

  if (!state.pinned || !state.originPoint) {
    mobileOriginTitle.textContent = state.cursorScreen ? "Release to pin the origin" : "Drag to preview an origin";
    mobileStatusText.textContent =
      "Touch and drag on the map to preview your starting point. Release to pin it, then drag again to measure commute times elsewhere.";
    mobileClearButton.hidden = true;
    return;
  }

  mobileOriginTitle.textContent = state.originLabel || (nearestStation ? `Pinned near ${nearestStation.name}` : "Pinned origin");
  mobileStatusText.textContent = state.probePoint
    ? "Drag either pin to reposition it. Tap a pin without dragging to remove it."
    : nearestStation
      ? `Commute times are anchored near ${nearestStation.name}. Drag on the map to place a "distance to here" pin.`
      : 'Commute times are anchored to this origin. Drag on the map to place a "distance to here" pin.';
  mobileClearButton.hidden = false;
}

function renderSearchResults(results) {
  clearSearchResults();
  if (!results.length) {
    setSearchMetaText("No NYC address matches found.");
    return;
  }
  setSearchMetaText("Choose a result to pin the origin there.");
  const markup = results
    .map(
      (result, index) => `
        <button class="search-result" type="button" data-result-index="${index}">
          <strong>${escapeHtml(result.title)}</strong>
          <span>${escapeHtml(result.subtitle)}</span>
        </button>
      `,
    )
    .join("");

  for (const ui of searchUis) {
    ui.results.innerHTML = markup;
    for (const button of ui.results.querySelectorAll(".search-result")) {
      button.addEventListener("click", () => {
        const result = results[Number(button.dataset.resultIndex)];
        const worldPoint = lonLatToWorld(result.lon, result.lat);
        if (!withinBounds(worldPoint)) {
          setSearchMetaText("That result fell outside the current NYC map bounds.");
          return;
        }
        setAddressInputs(result.title);
        setSearchMetaText(`Pinned origin to ${result.title}.`);
        clearSearchResults();
        state.originLabel = shortOriginLabel(result.title);
        setPinnedOrigin(worldPoint);
      });
    }
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

function setLocateButtonsBusy(isBusy) {
  const label = isBusy ? "Locating…" : "Use My Location";
  for (const button of [mobileLocateButton, mobileInstructionsLocateButton]) {
    if (!button) continue;
    button.disabled = isBusy;
    button.textContent = label;
  }
}

function useCurrentLocation() {
  if (!navigator.geolocation) {
    setSearchMetaText("Location access is not available on this device.");
    return;
  }

  setLocateButtonsBusy(true);
  navigator.geolocation.getCurrentPosition(
    (position) => {
      setLocateButtonsBusy(false);
      const worldPoint = lonLatToWorld(position.coords.longitude, position.coords.latitude);
      if (!withinBounds(worldPoint)) {
        setSearchMetaText("That location falls outside the current NYC map bounds.");
        return;
      }
      state.originLabel = "My location";
      setPinnedOrigin(worldPoint);
      setSearchMetaText("Pinned origin to your current location.");
    },
    (error) => {
      console.error(error);
      setLocateButtonsBusy(false);
      setSearchMetaText("Could not access your location. Check permissions and try again.");
    },
    {
      enableHighAccuracy: true,
      timeout: 10000,
      maximumAge: 300000,
    },
  );
}

async function init() {
  const response = await fetch(DATA_URL);
  state.data = await response.json();
  state.isMobile = isMobileLayout();
  state.baseMapCache = null;
  state.ready = true;

  const manhattan = state.data.boroughs.find((borough) => borough.name === "Manhattan");
  state.cursorPoint = null;
  state.originPoint = null;

  const sharedView = parseSharedView();
  const hasSharedViewParams =
    Boolean(sharedView.origin) ||
    Boolean(sharedView.probe) ||
    sharedView.warp !== null ||
    sharedView.heatmap !== null;
  state.mobileHelpCollapsed = hasSharedViewParams;
  if (sharedView.zoom) {
    state.viewportScale = sharedView.zoom;
  }
  if (sharedView.warp !== null) {
    state.showWarp = sharedView.warp;
  }
  if (sharedView.heatmap !== null) {
    state.showHeatmap = sharedView.heatmap;
  }
  if (sharedView.origin) {
    const restoredPoint = lonLatToWorld(sharedView.origin.lon, sharedView.origin.lat);
    if (withinBounds(restoredPoint)) {
      state.originPoint = restoredPoint;
      state.pinnedPoint = restoredPoint;
      state.cursorPoint = restoredPoint;
      state.pinned = true;
      if (sharedView.probe) {
        const restoredProbe = lonLatToWorld(sharedView.probe.lon, sharedView.probe.lat);
        if (withinBounds(restoredProbe)) {
          state.probePoint = restoredProbe;
          state.probePinned = true;
        }
      }
    }
  }

  warpToggle.checked = state.showWarp;
  heatmapToggle.checked = state.showHeatmap;
  syncHeatmapLegend();
  syncZoomControls();

  resize();
  window.addEventListener("resize", resize);

  mobileWarpToggle.checked = state.showWarp;
  mobileHeatmapToggle.checked = state.showHeatmap;

  mapCanvas.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    if (state.isMobile) {
      handleMobilePointerDown(event);
      return;
    }
    handleDesktopPointerDown(event);
  });

  mapCanvas.addEventListener("pointermove", (event) => {
    if (state.isMobile) {
      handleMobilePointerMove(event);
      return;
    }
    handleDesktopPointerMove(event);
  });

  mapCanvas.addEventListener("pointerup", (event) => {
    event.preventDefault();
    if (state.isMobile) {
      handleMobilePointerUp(event);
      return;
    }
    handleDesktopPointerUp(event);
  });

  mapCanvas.addEventListener("pointercancel", (event) => {
    if (state.isMobile) {
      handleMobilePointerCancel(event);
      return;
    }
    handleDesktopPointerCancel(event);
  });

  mapCanvas.addEventListener("pointerleave", () => {
    closeSharePanel();
    if (state.isMobile || state.mobileDragTarget) return;
    state.cursorScreen = null;
    state.cursorPoint = null;
    state.dirty = true;
    requestDraw();
  });

  heatmapToggle.addEventListener("change", () => {
    closeSharePanel();
    state.showHeatmap = heatmapToggle.checked;
    mobileHeatmapToggle.checked = state.showHeatmap;
    syncHeatmapLegend();
    syncBrowserUrl();
    state.dirty = true;
    requestDraw();
  });

  warpToggle.addEventListener("change", () => {
    closeSharePanel();
    state.showWarp = warpToggle.checked;
    mobileWarpToggle.checked = state.showWarp;
    syncBrowserUrl();
    state.dirty = true;
    requestDraw();
  });

  mobileHeatmapToggle.addEventListener("change", () => {
    state.showHeatmap = mobileHeatmapToggle.checked;
    heatmapToggle.checked = state.showHeatmap;
    syncHeatmapLegend();
    syncBrowserUrl();
    state.dirty = true;
    requestDraw();
  });

  mobileWarpToggle.addEventListener("change", () => {
    state.showWarp = mobileWarpToggle.checked;
    warpToggle.checked = state.showWarp;
    syncBrowserUrl();
    state.dirty = true;
    requestDraw();
  });

  zoomOutButton.addEventListener("click", () => {
    closeSharePanel();
    setViewportScale(state.viewportScale / VIEWPORT_ZOOM_STEP);
  });

  zoomInButton.addEventListener("click", () => {
    closeSharePanel();
    setViewportScale(state.viewportScale * VIEWPORT_ZOOM_STEP);
  });

  fullscreenButton.addEventListener("click", async () => {
    closeSharePanel();
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

  shareButton.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleSharePanel();
  });

  nativeShareAction.addEventListener("click", async () => {
    try {
      await navigator.share({
        title: document.title,
        text: getShareText(),
        url: getShareUrl(),
      });
      closeSharePanel();
    } catch (error) {
      if (error?.name !== "AbortError") {
        console.error(error);
        setSearchMetaText("Could not open the share sheet. Try another option.");
      }
    }
  });

  downloadImageAction.addEventListener("click", () => {
    closeSharePanel();
    downloadShareImage().catch((error) => {
      console.error(error);
      setSearchMetaText("Could not save the image. Try again.");
      shareButton.disabled = false;
    });
  });

  shareInstagramAction.addEventListener("click", async () => {
    closeSharePanel();
    try {
      await navigator.clipboard.writeText(getShareUrl());
      await downloadShareImage();
      setSearchMetaText("Image downloaded and link copied for Instagram.");
    } catch (error) {
      console.error(error);
      setSearchMetaText("Could not prep the Instagram share. Try again.");
      shareButton.disabled = false;
    }
  });

  for (const link of [shareXAction, shareFacebookAction, shareLinkedInAction]) {
    link.addEventListener("click", () => {
      closeSharePanel();
    });
  }

  document.addEventListener("click", (event) => {
    if (sharePanel.hidden) return;
    if (sharePanel.contains(event.target) || shareButton.contains(event.target)) return;
    closeSharePanel();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !sharePanel.hidden) {
      closeSharePanel();
    }
  });

  for (const ui of searchUis) {
    ui.form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const query = ui.input.value.trim();
      if (!query) {
        setSearchMetaText("Enter an NYC address to search.");
        clearSearchResults();
        return;
      }

      setSearchBusy(true);
      setSearchMetaText("Looking up NYC address matches…");
      clearSearchResults();

      try {
        const results = await searchAddress(query);
        renderSearchResults(results);
      } catch (error) {
        console.error(error);
        setSearchMetaText("Address lookup failed. Try a more specific NYC address.");
      } finally {
        setSearchBusy(false);
      }
    });
  }

  mobileClearButton.addEventListener("click", () => {
    clearPinnedOrigin();
    setSearchMetaText("Origin cleared. Tap the map or search for a new starting point.");
  });

  mobileLocateButton.addEventListener("click", () => {
    collapseMobileHelp();
    useCurrentLocation();
  });

  mobileShareButton.addEventListener("click", async () => {
    if (navigator.share) {
      try {
        await navigator.share({
          title: document.title,
          text: getShareText(),
          url: getShareUrl(),
        });
      } catch (error) {
        if (error?.name !== "AbortError") {
          console.error(error);
          setSearchMetaText("Could not open the share sheet. Try the share icon instead.");
        }
      }
      return;
    }
    try {
      await navigator.clipboard.writeText(getShareUrl());
      setSearchMetaText("Share link copied to your clipboard.");
    } catch (error) {
      console.error(error);
      setSearchMetaText("Could not copy the share link. Try again.");
    }
  });

  mobileSheetToggle.addEventListener("click", () => {
    setDrawerCollapsed(!state.drawerCollapsed);
  });

  mobileInstructionsLocateButton.addEventListener("click", () => {
    collapseMobileHelp();
    useCurrentLocation();
  });

  mobileMapInstructions.addEventListener("click", (event) => {
    if (event.target instanceof Element && event.target.closest("#mobileInstructionsLocateButton")) {
      return;
    }
    collapseMobileHelp();
  });

  mobileHelpBubble.addEventListener("click", () => {
    expandMobileHelp();
  });

  syncFullscreenButton();
  syncMobileSheet();
  syncMobileHelp();
  setDrawerCollapsed(true);
}

init().catch((error) => {
  console.error(error);
  statusText.textContent = "Failed to load transit map data.";
});
