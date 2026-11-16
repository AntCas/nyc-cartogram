#!/usr/bin/env python3
"""One-shot setup for a fresh clone: download the inputs that aren't in git, then build the site data.

  python3 setup_data.py                   # every city: whatever is missing, then build
  python3 setup_data.py --city stockholm  # just one city (copenhagen or stockholm)
  python3 setup_data.py --refresh-gtfs    # also replace the GTFS feed(s) with the latest
  python3 setup_data.py --refresh-osm     # also re-download all OpenStreetMap layers
  python3 setup_data.py --svg             # also render output/cph_transit_weighted_projection.svg

Steps, per city (see cities.py for the sources):
  1. GTFS/ or GTFS-stockholm/  <- the city's GTFS feed (~55 MB zip, ~350 MB unzipped; not in git)
  2. data/  <- OpenStreetMap layers via Overpass (the large street networks are not in git;
               existing layers are only re-fetched with --refresh-osm)
  3. site/data/<city>/commute_map_data.json + street_graph.bin, and site/data/cities.json
     <- build_commute_site_data.py
"""

from __future__ import annotations

import shutil
import sys
import tempfile
import urllib.request
import zipfile
from pathlib import Path

from cities import CITIES, COPENHAGEN, City, city_from_argv

GTFS_REQUIRED = ("agency.txt", "routes.txt", "trips.txt", "stop_times.txt", "stops.txt", "calendar.txt", "shapes.txt")


def log(message: str) -> None:
    print(message, flush=True)


def gtfs_present(city: City) -> bool:
    return all((city.gtfs_dir / name).exists() for name in GTFS_REQUIRED)


def download_gtfs(city: City) -> None:
    gtfs_dir = city.gtfs_dir
    log(f"Downloading the {city.name} GTFS feed from {city.gtfs_url} …")
    with tempfile.TemporaryDirectory() as tmp:
        archive = Path(tmp) / "GTFS.zip"
        request = urllib.request.Request(city.gtfs_url, headers={"User-Agent": "gtfs-setup/1.0"})
        with urllib.request.urlopen(request, timeout=600) as response, archive.open("wb") as handle:
            shutil.copyfileobj(response, handle)
        log(f"  downloaded {archive.stat().st_size / 1e6:.0f} MB; unzipping into {gtfs_dir.name}/")
        if gtfs_dir.exists():
            shutil.rmtree(gtfs_dir)
        gtfs_dir.mkdir()
        with zipfile.ZipFile(archive) as zipped:
            for member in zipped.infolist():
                # Flatten any folder inside the zip; GTFS files must sit directly in the folder.
                name = Path(member.filename).name
                if member.is_dir() or not name.endswith(".txt"):
                    continue
                with zipped.open(member) as source, (gtfs_dir / name).open("wb") as target:
                    shutil.copyfileobj(source, target)
    missing = [name for name in GTFS_REQUIRED if not (gtfs_dir / name).exists()]
    if missing:
        sys.exit(f"GTFS download is missing {missing}; check {city.gtfs_url}")


def setup_city(city: City, args: set) -> None:
    log(f"== {city.name} ==")
    if "--refresh-gtfs" in args or not gtfs_present(city):
        download_gtfs(city)
    else:
        log(f"{city.gtfs_dir.name}/ present; skipping download (use --refresh-gtfs for the latest feed)")

    import fetch_cph_basemap  # noqa: E402 - local scripts, imported after the GTFS step

    log("Fetching OpenStreetMap layers (skips files already in data/) …")
    fetch_cph_basemap.main(["--city", city.id] + (["--force"] if "--refresh-osm" in args else []))

    import build_commute_site_data  # noqa: E402

    build_commute_site_data.main(["--city", city.id])


def main() -> None:
    argv = sys.argv[1:]
    one_city = any(arg == "--city" or arg.startswith("--city=") for arg in argv)
    city = city_from_argv(argv)
    args = set(argv)
    unknown = args - {"--refresh-gtfs", "--refresh-osm", "--svg"}
    if unknown:
        sys.exit(f"Unknown option(s): {', '.join(sorted(unknown))}\n{__doc__}")

    cities = [city] if one_city else list(CITIES.values())
    for city in cities:
        setup_city(city, args)

    if "--svg" in args and COPENHAGEN in cities:
        import generate_cph_transit_weighted_projection  # noqa: E402

        generate_cph_transit_weighted_projection.main()

    log("Done. Run `python3 serve.py 8080` and open http://localhost:8080/")


if __name__ == "__main__":
    main()
