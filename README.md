# NYC Cartogram

This project generates two related artifacts for New York City:

- a static SVG cartogram that expands places with stronger subway access and compresses places with weaker access
- an interactive commute-time web app that lets you pin an origin, inspect travel times, toggle the warp and heatmap layers, and share deep links to a view

Live site: [castrio.me/nyc](https://castrio.me/nyc/)

<img width="1080" height="1350" alt="nyc-commute-cartogram-1776285343768" src="https://github.com/user-attachments/assets/e5324236-2a0e-48cd-b504-143b4cedc457" />

## What The Project Uses

- NYC borough boundaries
- MTA GTFS subway data for stations, routes, and travel times
- major streets and park/open-space overlays for the basemap
- a distance-based warp for the static SVG
- a station-to-station network plus walking access model for the interactive commute map

The interactive app includes the Staten Island Ferry connection, but it does not model buses, regional rail, or real-time schedules.

## Requirements

- Python 3
- `pnpm` and Node.js only if you want to run or deploy the Cloudflare Worker

Both Python scripts use the standard library only, so there is no Python dependency install step.

## Generate The Static SVG

Run:

```bash
python3 generate_nyc_subway_weighted_projection.py
```

Output:

```text
output/nyc_subway_weighted_projection.svg
```

Notes:

- If `data/borough_boundaries.geojson` is missing, the script can fetch borough boundaries automatically.
- The other source files are expected under `data/`.

## Build The Interactive Site Data

Run:

```bash
python3 build_commute_site_data.py
```

Output:

```text
site/data/commute_map_data.json
```

This produces the compact data bundle consumed by the front-end app in `site/`.

## Local Preview

For a simple static preview:

```bash
python3 -m http.server 8000
```

Then open:

```text
http://localhost:8000/site/
```

Useful local-preview notes:

- The site loads its data from `site/data/commute_map_data.json`.
- Address search uses OpenStreetMap Nominatim at runtime, so that feature needs internet access.
- On plain static localhost, production-style URLs like `/nyc/@40.71267,-73.92366` are not available. Use query-string sharing there instead.

## Cloudflare Worker Dev And Deploy

Install the Worker tooling:

```bash
pnpm install
```

Run the Worker locally:

```bash
pnpm run dev
```

Deploy:

```bash
pnpm run deploy
```

This repo includes:

- [wrangler.jsonc](/Users/primaryuser/Desktop/nyc-projection/wrangler.jsonc) to bundle the `site/` directory as Worker assets
- [src/worker.js](/Users/primaryuser/Desktop/nyc-projection/src/worker.js) to serve the app from the `/nyc` path prefix on `castrio.me`

Deployment behavior:

- The Worker serves the app at `https://castrio.me/nyc/`.
- Requests to `/nyc` are normalized to `/nyc/`.
- Asset requests under `/nyc/...` are rewritten to bundled assets from `site/`.
- Pretty origin routes like `https://castrio.me/nyc/@40.71267,-73.92366` are handled by the Worker because route-like paths fall back to `site/index.html`.

If this is your first local `pnpm` install and Wrangler postinstall steps were blocked, run `pnpm approve-builds` and approve the relevant packages before deploying again.

## Project Layout

- [generate_nyc_subway_weighted_projection.py](/Users/primaryuser/Desktop/nyc-projection/generate_nyc_subway_weighted_projection.py): builds the static SVG cartogram
- [build_commute_site_data.py](/Users/primaryuser/Desktop/nyc-projection/build_commute_site_data.py): builds the interactive site data bundle
- [site/index.html](/Users/primaryuser/Desktop/nyc-projection/site/index.html): app shell and metadata
- [site/app.js](/Users/primaryuser/Desktop/nyc-projection/site/app.js): interactive map, search, sharing, and rendering logic
- [site/styles.css](/Users/primaryuser/Desktop/nyc-projection/site/styles.css): site styles
- [site/data/commute_map_data.json](/Users/primaryuser/Desktop/nyc-projection/site/data/commute_map_data.json): generated site dataset
- [src/worker.js](/Users/primaryuser/Desktop/nyc-projection/src/worker.js): Cloudflare Worker entrypoint

## Current App Behavior

- hover or tap to choose an origin
- pin an origin and inspect commute times back to that point
- toggle warp and heatmap layers
- zoom and full-screen the map
- search for NYC addresses
- use browser geolocation when available
- export and share views, including deep links
- display a 60-minute reachability score

## Notes

- The map uses a shared geographic projection across boroughs, stations, route shapes, parks, and streets so layers stay aligned.
- For the interactive app, travel times are based on subway travel plus walking access to and from stations.
- Borough labels are placed from each borough's largest polygon to keep labels stable for fragmented geometries.
- Some UI/share icons are from [Iconmonstr](https://iconmonstr.com/).
