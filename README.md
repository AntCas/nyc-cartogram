# NYC Cartogram

This project generates a subway-access weighted map of New York City as an SVG and interactive web app.

You can check it out here: https://castrio.me/nyc

<img width="1080" height="1350" alt="nyc-commute-cartogram-1776285343768" src="https://github.com/user-attachments/assets/e5324236-2a0e-48cd-b504-143b4cedc457" />


The script:
- uses official borough boundaries from NYC Open Data
- uses official MTA GTFS subway route shapes and station locations
- draws official subway route colors from the GTFS `route_color` field
- adds major streets and larger parks/open spaces to the basemap
- approximates walking distance as straight-line distance times a circuity factor
- expands the map where subway access is stronger and compresses it where access is weaker

Run:

```bash
python3 generate_nyc_subway_weighted_projection.py
```

Output:

```text
output/nyc_subway_weighted_projection.svg
```

Interactive website:

```bash
python3 build_commute_site_data.py
python3 -m http.server 8000
```

Then open:

```text
http://localhost:8000/site/
```

Website files:
- [site/index.html](/Users/primaryuser/Desktop/nyc-projection/site/index.html)
- [site/app.js](/Users/primaryuser/Desktop/nyc-projection/site/app.js)
- [site/styles.css](/Users/primaryuser/Desktop/nyc-projection/site/styles.css)
- [site/data/commute_map_data.json](/Users/primaryuser/Desktop/nyc-projection/site/data/commute_map_data.json)

Cloudflare deploy:

```bash
pnpm add -D wrangler@latest
pnpm run deploy
```

This repo includes:
- [wrangler.jsonc](/Users/primaryuser/Desktop/nyc-projection/wrangler.jsonc) to upload the `site/` directory as static assets
- [src/worker.js](/Users/primaryuser/Desktop/nyc-projection/src/worker.js) to serve the site from the `/nyc/` path prefix on `castrio.me`

Deploy notes:
- The Worker serves the app at `https://castrio.me/nyc/`.
- `src/worker.js` redirects `/nyc` to `/nyc/` and strips the `/nyc` prefix before fetching bundled assets.
- Static assets are bundled from `site/`, so requests like `/nyc/styles.css`, `/nyc/app.js`, `/nyc/favicon.svg`, and `/nyc/data/commute_map_data.json` are all handled by the Worker deployment.
- Disable any older Cloudflare URL Rewrite Rules or Cloud Connector routes for this app path. They can conflict with the Worker and cause 404s.
- If this is your first local `pnpm` install and Wrangler dependencies were blocked, run `pnpm approve-builds` and approve the relevant packages before deploying again.
- For local development, open `http://localhost:8000/site/`. For production, use `https://castrio.me/nyc/`.

Notes:
- The map now uses a single shared geographic projection for boroughs, stations, route shapes, parks, and streets so transit layers stay aligned to the basemap.
- Because people enter the subway at stations, the weighting is based on distance to the nearest station complex rather than track geometry alone.
- The warp is a lightweight cumulative-density transform, not a formal cartogram solver.
- The interactive prototype estimates commute time using MTA GTFS subway travel times plus short walking access to and from stations.
- Borough labels are placed from each borough's largest polygon so the output stays stable for fragmented multi-island geometries.
- You can tune the static SVG warp in [generate_nyc_subway_weighted_projection.py](/Users/primaryuser/Desktop/nyc-projection/generate_nyc_subway_weighted_projection.py) and the website data build in [build_commute_site_data.py](/Users/primaryuser/Desktop/nyc-projection/build_commute_site_data.py).
