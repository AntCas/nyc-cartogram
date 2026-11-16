# Copenhagen & Stockholm travel-time map: notes for Claude

A static web app (`site/`) that shows door-to-door travel times across greater Copenhagen and Stockholm
on foot, by bike, and by transit, routed in the browser over an OpenStreetMap street graph plus a GTFS
transit graph. Python build scripts (standard library only, Python 3.10+) turn raw data into the files
the app loads. See README.md for the user-facing description and the routing model.

Everything that differs between cities (data sources, municipalities, bounding boxes, modes, line
colours, how GTFS routes map to modes) is one `City` entry in `cities.py`. Every build script takes
`--city copenhagen|stockholm` (default `copenhagen`); `setup_data.py` without `--city` does every city.
Data files are prefixed per city (`data/cph_*`, `data/sto_*`) and the app's files live in
`site/data/<city>/`. `site/data/cities.json` lists the built cities; the app's city selector (the title
of the top-left panel) is filled from it.

## Setting up a fresh clone

The large inputs and all generated files are git-ignored, so a fresh clone does not run until you
recreate them. Do this:

```bash
python3 setup_data.py
```

It is idempotent: each step skips work whose output already exists, so just re-run it after a failure.
What it does:

1. **GTFS feed → `GTFS/` (Copenhagen) and `GTFS-stockholm/`** (each ~55 MB download, ~350 MB
   unzipped). Copenhagen uses Rejseplanen's national feed from
   `https://www.rejseplanen.info/labs/GTFS.zip`; Stockholm uses SL's "GTFS Regional" feed via the
   Mobility Database's daily mirror, `https://files.mobilitydatabase.org/mdb-3237/latest.zip` (no
   API key needed). The `.txt` files are unzipped flat into the folder.
2. **OpenStreetMap → `data/`** via the Overpass API (`fetch_cph_basemap.py`). Copenhagen's small
   layers (municipalities, external land, parks, water, major streets) are committed, so only
   `data/cph_street_network.json` (~73 MB, 12 tiles, 5–15 minutes) has to be fetched. For Stockholm
   every layer is fetched: the same ones as `data/sto_*`, plus `data/sto_coastline.json` and the
   street network in 16 tiles (15–30 minutes in all).
3. **Build → `site/data/<city>/`** (`build_commute_site_data.py --city <id>`, 10–30 s):
   `commute_map_data.json` (~4 MB Copenhagen, ~12 MB Stockholm) and `street_graph.bin` (~23 MB;
   Stockholm's ~32 MB is split into `street_graph.bin` + `street_graph.1.bin` to stay under
   Cloudflare's 25 MiB asset limit, and the app joins the parts listed in `cities.json`), plus
   `site/data/cities.json`. The first build
   also extracts and caches the transit network from GTFS in `data/<prefix>_transit_network.json`
   (up to a minute).

Then serve and check it:

```bash
python3 serve.py 8080      # all interfaces; handles /@lat,lon share links
```

### Verifying the setup

- The Copenhagen build ends with lines like `805080 nodes, 1766865 directed edges` and
  `grid 676x576 (50 m), 196639 land cells`; Stockholm's with
  `1131141 nodes, 2457905 directed edges` and `grid 755x827 (50 m), 266639 land cells`. Node and edge counts
  drift a little as OSM changes.
- `curl -s -o /dev/null -w "%{http_code}" http://localhost:8080/data/copenhagen/street_graph.bin`
  returns `200` (likewise `data/stockholm/…` and `data/cities.json`).
- If Chrome is installed, a headless screenshot of a pinned view should show a coloured heatmap
  around central Copenhagen and the route itinerary in the top-left panel:
  ```bash
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --hide-scrollbars \
    --window-size=1440,900 --virtual-time-budget=20000 --screenshot=/tmp/check.png \
    "http://localhost:8080/@55.68330,12.57170?distance=55.63040,12.64940&route=1"
  ```
  Expect roughly "Fastest route · 24 min" via M2 from Nørreport to the airport.
- The same for Stockholm (T-Centralen to Kista):
  ```bash
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --hide-scrollbars \
    --window-size=1440,900 --virtual-time-budget=20000 --screenshot=/tmp/check-sto.png \
    "http://localhost:8080/@59.33100,18.06000?city=stockholm&distance=59.40300,17.94400&route=1"
  ```
  Expect roughly "Fastest route · 31 min" via T11 from T-Centralen to Kista. The title should read "Stockholm" and the sea
  east of the city (Saltsjön) and Lake Mälaren to the west should be water, not heatmap.

### Troubleshooting

- **Overpass errors (HTTP 429/500/504, "server is probably too busy")** are common. `overpass()` in
  `fetch_cph_basemap.py` already cycles through three public endpoints with back-off. If it still
  fails, wait a few minutes and re-run `python3 setup_data.py`; tiles are fetched again from scratch,
  but other finished files are kept. Keep the `[timeout:180]` query header; bigger declared
  timeouts or `maxsize` make busy servers reject the query outright.
- **The Copenhagen GTFS URL moved or 404s:** find the current link on Rejseplanen Labs
  (rejseplanen.info/labs), update `gtfs_url` for `COPENHAGEN` in `cities.py`, and run
  `python3 setup_data.py --city copenhagen --refresh-gtfs`. Any GTFS feed covering Copenhagen with
  Rejseplanen's route types should work. `classify_cph_route` in `cities.py` relies on:
  - `route_type` 1 = Metro, 109 = S-tog, 0 = light rail, 2 = regional rail, 4 = ferry, and 3/700 = bus
    (only agency "Movia", see `CPH_BUS_AGENCIES`);
  - the agency names in `CPH_REGIONAL_ROUTE_NAMES` for merging regional operators;
  - stop names like "Nørreport St." / "Nørreport St. (Metro)" for merging rail platforms into stations
    (bus stops keep their own names and only merge with a same-named stop across the street).
- **The Stockholm GTFS URL 404s or is stale:** the mirror is the Mobility Database's copy of feed
  `mdb-3237` ("GTFS Regional SL"). The original is
  `https://opendata.samtrafiken.se/gtfs/sl/sl.zip?key=<key>` with a free Trafiklab key
  (developer.trafiklab.se); put either URL in `gtfs_url` for `STOCKHOLM` in `cities.py`, or unzip the
  feed into `GTFS-stockholm/` by hand, then run `python3 setup_data.py --city stockholm`.
  `classify_sto_route` relies on agency "AB Storstockholms Lokaltrafik" and `route_type` 401 =
  tunnelbana, 100 = pendeltåg, 900 = tram/local rail, 1000 = boat, 700 = bus. The feed's
  `calendar.txt` is all zeros; service days come from `calendar_dates.txt`.
- **Stockholm's sea shows as land (or land as sea):** the sea is built from `natural=coastline` ways
  in `data/sto_coastline.json` by `coastline.py` (land is on the left of each way; stretches are
  closed clockwise along the edge of the context box). Delete that file and re-run
  `python3 fetch_cph_basemap.py --city stockholm` if a tile came back incomplete. Lake Mälaren comes
  from the `natural=water` polygons in `data/sto_water.geojson` instead.
- **Few or no trips** (empty heatmap, "0 / 0 stations"): the feed's calendar may not overlap. The
  service date is picked automatically as the busiest weekday in the feed; check the
  `service date …` line printed while extracting the transit network.
- **Stale transit data after changing code in `cph_transit.py` or a classifier in `cities.py`:** bump
  `CACHE_VERSION` in `cph_transit.py` or delete `data/<prefix>_transit_network.json`.

## Updating data later

- New timetables: `python3 setup_data.py --refresh-gtfs` (the transit cache rebuilds automatically).
- New OSM data: `python3 setup_data.py --refresh-osm` (re-fetches every layer, 15–30 minutes per city).
- Add `--city <id>` to either to update just one city.
- A new city: add a `City` to `cities.py` (and to `CITIES`), then `python3 setup_data.py --city <id>`.
  Set `sea_from_coastline=True` if its municipal boundaries extend over the sea.

## Project map

- `cities.py`: per-city configuration (the only place city names, URLs, and modes are defined)
- `setup_data.py`: fresh-clone setup (download + fetch + build), for every city or `--city <id>`
- `fetch_cph_basemap.py`: Overpass downloads into `data/`
- `cph_transit.py`: GTFS → stations, lines, ride times, waits, and transfer times (cached)
- `cph_streets.py`: OSM ways → walk/bike street graph resampled to ≤20 m edges
- `coastline.py`: OSM coastline ways → sea polygons (Stockholm)
- `build_commute_site_data.py`: assembles `site/data/<city>/` (grid, land/water mask, station links,
  binary graph) and `site/data/cities.json`
- `generate_cph_transit_weighted_projection.py`: optional static SVG cartogram (Copenhagen only)
- `serve.py`: local server; `src/worker.js` + `wrangler.jsonc`: optional Cloudflare Worker
- `site/app.js`: the whole front end (city selector, routing, heatmap, route drawing, UI); no build
  step. It has no city-specific code: names, modes, and bike rules come from each city's
  `commute_map_data.json` (`meta` and `modes`).

## Conventions

- Python scripts use only the standard library; don't add dependencies.
- Never commit `GTFS/`, `GTFS-stockholm/`, `site/data/`, `data/*_street_network.json`, or
  `data/*_transit_network.json`; they're in `.gitignore` because they're large or regenerated.
  GitHub rejects files over 100 MB.
- Copenhagen links have no `city` parameter and must keep working; other cities add `?city=<id>`.
- The app targets desktop browsers. Routing runs client-side (~70 ms per origin), so keep
  `site/data/` changes in mind for load size.
