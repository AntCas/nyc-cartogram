const DATA_URL = "./data/commute_map_data.json";
const ENTRY_WAIT_MINUTES = 2.5;
const TIME_DECAY_MINUTES = 18;
const TIME_SHARPNESS = 1.35;
const BASE_WEIGHT = 0.08;
const WARP_EXAGGERATION = 1.5;
const MAX_TIME_MINUTES = 80;
const PANEL_PADDING = 18;
const ROUTE_LINE_WIDTH = 2.2;
const WEIGHT_BLUR_PASSES = 2;
const WEIGHT_BLUR_RADIUS = 2;

const state = {
  data: null,
  ready: false,
  cursorPoint: null,
  cursorScreen: null,
  originPoint: null,
  pinnedPoint: null,
  pinned: false,
  transform: null,
  currentRender: null,
  dirty: true,
};

const mapCanvas = document.getElementById("mapCanvas");
const statusText = document.getElementById("statusText");
const pinButton = document.getElementById("pinButton");
const searchForm = document.getElementById("searchForm");
const addressInput = document.getElementById("addressInput");
const searchButton = document.getElementById("searchButton");
const searchMeta = document.getElementById("searchMeta");
const searchResults = document.getElementById("searchResults");
const ctx = mapCanvas.getContext("2d");

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function distance(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function formatMinutes(minutes) {
  if (!Number.isFinite(minutes)) return "unreachable";
  if (minutes < 1) return "<1 min";
  return `${Math.round(minutes)} min`;
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function timeToWeight(minutes) {
  const capped = Math.min(MAX_TIME_MINUTES, Math.max(0, minutes));
  const access = Math.exp(-Math.pow(capped / TIME_DECAY_MINUTES, TIME_SHARPNESS));
  return BASE_WEIGHT + access * WARP_EXAGGERATION;
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

function drawPolygonPath(drawCtx, polygon, projectPoint) {
  drawCtx.beginPath();
  for (const ring of polygon) {
    ring.forEach((point, index) => {
      const [sx, sy] = projectPoint(point);
      if (index === 0) drawCtx.moveTo(sx, sy);
      else drawCtx.lineTo(sx, sy);
    });
    drawCtx.closePath();
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
      walkMinutes: distance(point, station.point) / state.data.meta.walkMetersPerMinute,
    }))
    .sort((a, b) => a.walkMinutes - b.walkMinutes)
    .slice(0, count);
}

function runDijkstra(originPoint) {
  const stationCount = state.data.stations.length;
  const distances = new Array(stationCount).fill(Infinity);
  const visited = new Array(stationCount).fill(false);
  const seeds = nearestStations(originPoint, state.data.meta.originStationCount);

  for (const seed of seeds) {
    distances[seed.index] = seed.walkMinutes + ENTRY_WAIT_MINUTES;
  }

  for (let step = 0; step < stationCount; step += 1) {
    let current = -1;
    let best = Infinity;
    for (let index = 0; index < stationCount; index += 1) {
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
    bestMinutes = Math.min(bestMinutes, originDistances[station.index] + station.walkMinutes);
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
  const weights = Array.from({ length: gridRows }, () => new Array(gridCols).fill(0));
  const validMask = Array.from({ length: gridRows }, () => new Array(gridCols).fill(false));
  const columnMass = new Array(gridCols).fill(0);
  const rowMass = new Array(gridRows).fill(0);

  for (let maskIndex = 0; maskIndex < state.data.mask.length; maskIndex += 1) {
    const cellIndex = state.data.mask[maskIndex];
    if (cellIndex === -1) continue;
    const cell = state.data.cells[cellIndex];
    let bestMinutes = distance(originPoint, cell.point) / state.data.meta.walkMetersPerMinute;
    for (const [stationIndex, egressMinutes] of cell.access) {
      bestMinutes = Math.min(bestMinutes, distances[stationIndex] + egressMinutes);
    }
    weights[cell.row][cell.col] = timeToWeight(bestMinutes);
    validMask[cell.row][cell.col] = true;
  }

  let smoothed = weights.map((row) => row.slice());
  for (let pass = 0; pass < WEIGHT_BLUR_PASSES; pass += 1) {
    const next = Array.from({ length: gridRows }, () => new Array(gridCols).fill(0));
    for (let row = 0; row < gridRows; row += 1) {
      for (let col = 0; col < gridCols; col += 1) {
        if (!validMask[row][col]) continue;
        let total = 0;
        let count = 0;
        for (let y = Math.max(0, row - WEIGHT_BLUR_RADIUS); y <= Math.min(gridRows - 1, row + WEIGHT_BLUR_RADIUS); y += 1) {
          for (let x = Math.max(0, col - WEIGHT_BLUR_RADIUS); x <= Math.min(gridCols - 1, col + WEIGHT_BLUR_RADIUS); x += 1) {
            if (!validMask[y][x]) continue;
            total += smoothed[y][x];
            count += 1;
          }
        }
        next[row][col] = count ? total / count : smoothed[row][col];
      }
    }
    smoothed = next;
  }

  for (let row = 0; row < gridRows; row += 1) {
    for (let col = 0; col < gridCols; col += 1) {
      if (!validMask[row][col]) continue;
      columnMass[col] += smoothed[row][col];
      rowMass[row] += smoothed[row][col];
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

  return { distances, seeds, warpPoint, inverseWarpPoint, warpedBounds };
}

function drawMap(drawCtx, width, height) {
  drawPanelBackground(drawCtx, width, height);
  if (!state.originPoint) return;

  const warp = computeWarp(state.originPoint);
  const transform = buildTransform(warp.warpedBounds, width, height, PANEL_PADDING);
  const projectPoint = (point) => transform.toScreen(warp.warpPoint(point));
  state.currentRender = { warp, transform };

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

  const nearest = warp.seeds[0];
  const station = state.data.stations[nearest.index];
  if (state.pinned && state.cursorPoint) {
    const probeMinutes = estimateTravelMinutes(warp.distances, state.cursorPoint);
    statusText.textContent = `Pinned near ${station.name}. Hover anywhere to inspect commute time back to this origin.`;
    if (state.cursorScreen) {
      drawHoverTooltip(drawCtx, state.cursorScreen, `${formatMinutes(probeMinutes)} away`);
    }
  } else {
    statusText.textContent = `Warped from near ${station.name}. Click to pin this origin, then hover to probe commute time back to it.`;
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
  const warpedWorld = state.currentRender.transform.toWorld(x, y);
  const worldPoint = state.currentRender.warp.inverseWarpPoint(warpedWorld);
  return { screenPoint, worldPoint };
}

function withinBounds(point) {
  const [minX, minY, maxX, maxY] = state.data.meta.bounds;
  return point[0] >= minX && point[0] <= maxX && point[1] >= minY && point[1] <= maxY;
}

function syncPinButton() {
  pinButton.textContent = state.pinned ? "Click to Unpin" : "Click to Pin";
  pinButton.classList.toggle("active", state.pinned);
}

function clearSearchResults() {
  searchResults.innerHTML = "";
}

function setPinnedOrigin(worldPoint) {
  state.originPoint = worldPoint;
  state.pinnedPoint = worldPoint;
  state.pinned = true;
  state.cursorPoint = worldPoint;
  syncPinButton();
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

  const manhattan = state.data.boroughs.find((borough) => borough.name === "Manhattan");
  state.cursorPoint = manhattan ? manhattan.label : state.data.stations[0].point;
  state.originPoint = state.cursorPoint;
  syncPinButton();

  resize();
  window.addEventListener("resize", resize);

  mapCanvas.addEventListener("pointermove", (event) => {
    const { screenPoint, worldPoint } = pointerToWorld(event);
    if (!withinBounds(worldPoint)) return;
    state.cursorScreen = screenPoint;
    state.cursorPoint = worldPoint;
    if (!state.pinned) {
      state.originPoint = worldPoint;
    }
    state.dirty = true;
    requestDraw();
  });

  mapCanvas.addEventListener("click", (event) => {
    const { screenPoint, worldPoint } = pointerToWorld(event);
    if (!withinBounds(worldPoint)) return;
    state.cursorScreen = screenPoint;
    state.cursorPoint = worldPoint;
    if (!state.pinned) {
      state.originPoint = worldPoint;
      state.pinnedPoint = worldPoint;
      state.pinned = true;
    } else {
      state.pinned = false;
      state.pinnedPoint = null;
      state.originPoint = worldPoint;
    }
    syncPinButton();
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

  pinButton.addEventListener("click", () => {
    if (state.pinned) {
      state.pinned = false;
      state.pinnedPoint = null;
      if (state.cursorPoint) {
        state.originPoint = state.cursorPoint;
      }
    } else if (state.cursorPoint) {
      state.pinned = true;
      state.originPoint = state.cursorPoint;
      state.pinnedPoint = state.cursorPoint;
    }
    syncPinButton();
    state.dirty = true;
    requestDraw();
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
}

init().catch((error) => {
  console.error(error);
  statusText.textContent = "Failed to load transit map data.";
});
