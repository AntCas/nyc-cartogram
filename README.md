# Copenhagen & Stockholm Travel Time Map

A door-to-door travel-time map of Copenhagen and Stockholm, adapted from Anthony Castrio's
[NYC Commute POV](https://github.com/AntCas/nyc-cartogram). It produces:

- a full-screen interactive web app (desktop): pick a city, drop a start pin, and see a heatmap of how
  long it takes to get everywhere else on foot, by bike, and by transit, measure the time to any spot,
  switch modes on and off, and share links to a view
- a static SVG cartogram (the original warp idea, Copenhagen only) that expands places with good rail
  access

The city is chosen with the selector in the title of the top-left panel. Each city is a separate data set
under `site/data/<city>/`, described by one entry in `cities.py`; switching reloads the app on the other
city. Links remember the city: Copenhagen links are unchanged (`/@55.68,12.57`), Stockholm links carry
`?city=stockholm`, and a shared pin always opens the city it lies in.

## Coverage

Travel times are computed on a 50 m grid. The app opens framed on the central city (`initial_view_bbox`
in `cities.py`); pan and zoom to see the rest.

### Copenhagen

The 17 municipalities of Byen København and Københavns omegn (København, Frederiksberg, Tårnby, Dragør,
Gentofte, Gladsaxe, Lyngby-Taarbæk, Herlev, Ballerup, Rødovre, Hvidovre, Glostrup, Brøndby, Albertslund,
Vallensbæk, Ishøj, Høje-Taastrup).

Modes (each can be switched on/off in the options box):

| Mode | Lines | Default |
| --- | --- | --- |
| Bike | the OSM cycling network; the bike comes along on trains, Metro, Letbane, and harbour buses (not on Movia buses) | off |
| Metro | M1, M2, M3, M4 | on |
| S-tog | A, B, Bx, C, E, F, H | on |
| Letbane | Ring 3 light rail (L) | on |
| Regional trains | DSB (IC, ICL, RE, …), Øresundståg, Lokaltog (Nærumbanen), Snälltåget | on |
| Harbour bus | Movia 991/992/993 | on |
| Bus | Movia buses and S-buses with daytime service (~96 routes, ~2,000 stops); night buses and rail-replacement buses are left out | on |

### Stockholm

Nine municipalities: Stockholm (including Kista, Vällingby, Farsta, and the rest of the city), Solna,
Sundbyberg, Danderyd, Lidingö, Nacka, Sollentuna, Järfälla, and Huddinge. Timetables are SL's (Storstockholms
Lokaltrafik) GTFS Regional feed; only SL's own lines are modelled.

| Mode | Lines | Default |
| --- | --- | --- |
| Bike | the OSM cycling network; the bike comes along on the pendeltåg and commuter boats only | off |
| Tunnelbana | T10, T11 (blue), T13, T14 (red), T17, T18, T19 (green) | on |
| Pendeltåg | SL commuter trains (40, 41, 43, …) | on |
| Tram & local rail | Tvärbanan (30, 31), Spårväg City (7), Nockebybanan (12), Lidingöbanan (21), Saltsjöbanan (25, 26), Roslagsbanan (27, 28, 29) | on |
| Commuter boat | SL pendelbåtar (80, 82, 84, 89) | on |
| Bus | SL buses with daytime service; night buses and Närtrafiken are left out | on |

Not modelled in Stockholm: long-distance and regional trains (SJ, Mälartåg), Arlanda Express, and the
Waxholmsbolaget archipelago boats, which aren't SL lines. Swedish municipal boundaries run across open
water, so the sea is cut out along OpenStreetMap's coastline (`coastline.py`) and Lake Mälaren along its
lake polygons.

Walking is always available. Bus times are scheduled times, so rush-hour traffic isn't reflected.

## Quick Start (fresh clone)

```bash
python3 setup_data.py      # both cities: downloads GTFS + OSM street networks, builds site/data (~30–40 min)
python3 serve.py 8080      # then open http://localhost:8080/
```

`python3 setup_data.py --city copenhagen` (or `--city stockholm`) sets up just one city; the selector
only lists cities whose data has been built.

The large inputs (the GTFS feed and the OSM street network) and the generated site data are not in git;
`setup_data.py` recreates them and can simply be re-run if a download fails. `CLAUDE.md` has detailed
setup, verification, and troubleshooting notes (written so a Claude agent can do the setup).

## Requirements

- Python 3.10+ (standard library only)
- Internet access for the first setup (the Rejseplanen and SL GTFS feeds and the OpenStreetMap Overpass
  API). The SL feed is downloaded from the Mobility Database's daily mirror, so no Trafiklab API key is
  needed.
- `pnpm` and Node.js only if you want to run or deploy the Cloudflare Worker

## Build (step by step)

`setup_data.py` runs these for you. Each takes `--city copenhagen` (the default) or `--city stockholm`:

```bash
# 1. OpenStreetMap layers via Overpass: municipalities, parks, water, major streets, the full
#    walk/bike street network (fetched in tiles), and for Stockholm the coastline. Cached in data/
#    as cph_* / sto_*; add --force to refresh.
python3 fetch_cph_basemap.py --city stockholm

# 2. Site data -> site/data/<city>/commute_map_data.json + street_graph.bin, and site/data/cities.json
#    (the selector's list). --all builds every city.
python3 build_commute_site_data.py --city stockholm

# 3. (optional, Copenhagen only) Static SVG -> output/cph_transit_weighted_projection.svg
python3 generate_cph_transit_weighted_projection.py
```

`cph_transit.py` filters a city's GTFS feed (`GTFS/` for Copenhagen, `GTFS-stockholm/` for Stockholm) down
to the modelled network and caches it in `data/<prefix>_transit_network.json`; the cache is rebuilt
automatically when the feed changes. `cph_streets.py` turns the raw OSM extract into the routable street
graph. `cities.py` holds everything that differs between the cities: data sources, municipalities,
bounding boxes, modes and line colours, and how GTFS routes map to modes.

## Run Locally

```bash
python3 serve.py 8080     # or: pnpm run serve (port 8000)
```

This serves `site/` on all interfaces (reachable over Tailscale at `http://<machine-name>:8080/`) and
handles pretty share links like `/@55.67594,12.56553`. Address search uses OpenStreetMap Nominatim at
runtime, so that feature needs internet access.

Using the map (shown in the hint bar at the bottom of the app):

- the first click sets the **start pin**; after that it only moves when you drag it (or search an address)
- any other click drops the **measure pin** there (or jumps it), showing the travel time to that spot;
  drag it to explore, click it or press Esc to remove it
- drag the map to pan; scroll to zoom
- modes, the colour scale's maximum time (10–120 min), and the heatmap/outline layers are in the
  top-right box
- the route (on by default; **Hide route** next to Reset options turns it off) draws the fastest path
  from the start pin to the measure pin: walking dashed, cycling in green, and each transit ride along
  that line's GTFS shape in its colour, with a step-by-step itinerary in the top-left panel;
  **Trip details** there expands it to time per activity and every stop with its elapsed time

## Cloudflare Worker (optional)

`wrangler.jsonc` and `src/worker.js` serve `site/` from the root of a Worker, with `/@lat,lon` routes
falling back to the app shell. Add a route to `wrangler.jsonc` to deploy on your own domain.

```bash
pnpm install
pnpm run dev
pnpm run deploy
```

## How Travel Times Are Computed

All routing happens in the browser (about 70 ms per origin) as a single Dijkstra search over two kinds of
node:

1. **Street nodes**: every walkable/bikeable OSM way in the area, split at junctions and resampled so no
   edge is longer than 20 m (about 800k nodes). Each edge records whether you may walk it and whether
   you may cycle it in each direction (one-way streets apply to bikes unless `oneway:bicycle=no`).
   Footways, pedestrian streets, and steps are walk-only; `bicycle=use_sidepath` roads defer to the
   separately mapped cycle tracks.
2. **Transit states**: one per (station, line), connected by median scheduled arrival-to-arrival times
   between consecutive stations on a representative weekday, so time standing at stations a train passes
   through is included. Each state also records the line's median dwell there, so a ride you board is
   timed from its departure; rides match the timetable's departure-to-arrival times.

Moves between them:

- **Street legs** are walked at 4.8 km/h or, with Bike on, ridden at 16 km/h (the usual journey-planner
  assumptions, as used by Google Maps). On walk-only edges you push the bike at walking speed.
- **Boarding** from a station's street node costs the walk/ride to the platform, a per-mode platform access
  time (Copenhagen: Metro/regional 2 min, S-tog 1.5, Letbane/harbour bus 0.5, bus 0.3; Stockholm:
  tunnelbana/pendeltåg 2.5, tram/boat 0.5, bus 0.3; +0.5–1 min with a bike), and the
  line's expected wait for a departure (half its 07:00–19:00 headway, 1.5–15 min). **Alighting** costs the
  same minus the wait.
- **Transfers** inside a station use the minimum platform-to-platform times from GTFS `transfers.txt`
  (line-specific where given, e.g. 60 s cross-platform S-tog changes at København H), plus the wait
  for the next line. Transfers between nearby stations simply happen on the street network.
- The **itinerary** splits a route into walk/bike legs (including getting to and from platforms), waits,
  changes, and rides; ride rows are in-vehicle time only.
- **Grid cells** (50 m) take the time of their nearest street node plus the walk from it. Only nodes in
  the main walkable network are used for snapping, so every point is reachable on foot.
- **Water** (OSM lakes, ponds, canals, and harbour basins, e.g. Søerne) is cut out of the grid and the
  heatmap, so you can only cross it where the street network has a bridge.

With Bike on, the bike comes along on every transit leg that takes bikes (`no_bike_modes` in `cities.py`
lists the modes that don't). In reality bikes are not allowed on the Copenhagen Metro on weekdays 07–09
and 15:30–17:30 and need a ticket on regional trains, and Stockholm's pendeltåg only takes them outside
rush hours.

Some UI/share icons are from [Iconmonstr](https://iconmonstr.com/).

## Project Layout

- [fetch_cph_basemap.py](fetch_cph_basemap.py): downloads the OSM layers
- [cph_transit.py](cph_transit.py): stations, line shapes, ride times, waits, and transfer times from GTFS
- [cph_streets.py](cph_streets.py): walk/bike classification and the 20 m street graph
- [build_commute_site_data.py](build_commute_site_data.py): builds the site data bundle
- [generate_cph_transit_weighted_projection.py](generate_cph_transit_weighted_projection.py): builds the static SVG
- [serve.py](serve.py): local static server with share-link support
- [site/index.html](site/index.html), [site/app.js](site/app.js), [site/styles.css](site/styles.css): the app
- [src/worker.js](src/worker.js): Cloudflare Worker entrypoint
