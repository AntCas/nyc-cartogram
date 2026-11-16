"""Per-city configuration: where the data comes from, which area is mapped, and how the GTFS feed's
routes turn into the modes shown in the app.

Every build script takes `--city <id>` (default: copenhagen). To add a city, add a `City` below and
run `python3 setup_data.py --city <id>`.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Dict, Optional, Tuple

ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"
SITE_DATA_DIR = ROOT / "site" / "data"

# (mode id, route key, label shown in the app) for a routes.txt row, or None to leave the route out.
RouteClassifier = Callable[[dict, str], Optional[Tuple[str, str, str]]]
BBox = Tuple[float, float, float, float]


@dataclass(frozen=True)
class City:
    id: str
    name: str
    # Prefix of this city's files in data/ (e.g. data/cph_parks.geojson).
    prefix: str
    gtfs_dir_name: str
    gtfs_url: str
    # Credit lines shown in the app.
    transit_source: str
    country_codes: str
    search_languages: str

    # OSM `name` of each mapped municipality (admin_level 7) -> label drawn on the map.
    municipalities: Dict[str, str]
    # All boxes are (south, west, north, east).
    boundary_bbox: BBox  # municipalities, including the neighbours drawn as context
    detail_bbox: BBox  # parks, water, major streets
    # The mapped municipalities plus a margin, so routes that briefly leave the area still exist.
    # Fetched as a grid of tiles; one request for the whole area tends to time out.
    street_bbox: BBox
    street_tiles: Tuple[int, int]  # rows, cols
    # (west, south, east, north) the app opens framed on.
    initial_view_bbox: BBox

    modes: Tuple[dict, ...]
    # Draw order (first = bottom).
    mode_draw_order: Tuple[str, ...]
    classify_route: RouteClassifier
    normalize_station_name: Callable[[str], str]
    route_colors: Dict[str, str] = field(default_factory=dict)
    route_text_colors: Dict[str, str] = field(default_factory=dict)
    # Minutes from the street to the platform (and back), per mode; bikes add lift/ramp time.
    station_access_minutes: Dict[str, float] = field(default_factory=dict)
    bike_station_extra_minutes: Dict[str, float] = field(default_factory=dict)
    # Modes that can't be boarded with a bike.
    no_bike_modes: Tuple[str, ...] = ("bus",)

    # Drop municipality polygons (islands) lying entirely east of this longitude.
    max_polygon_lon: Optional[float] = None
    min_municipality_polygon_m2: float = 40_000.0
    # True where the municipality boundaries extend over the sea (Sweden): the sea is then cut out
    # along OSM's natural=coastline ways. Danish boundaries already follow the coast.
    sea_from_coastline: bool = False
    # Parks and woods smaller than this (m²) aren't drawn.
    min_park_area: float = 8_000.0
    major_streets_file: Optional[str] = None
    # Station names marked with a fixed pin on the map.
    landmark_stations: Tuple[str, ...] = ()

    @property
    def gtfs_dir(self) -> Path:
        return ROOT / self.gtfs_dir_name

    def data_path(self, name: str) -> Path:
        return DATA_DIR / f"{self.prefix}_{name}"

    @property
    def municipalities_path(self) -> Path:
        return self.data_path("municipalities.geojson")

    @property
    def external_land_path(self) -> Path:
        return self.data_path("external_land.geojson")

    @property
    def parks_path(self) -> Path:
        return self.data_path("parks.geojson")

    @property
    def water_path(self) -> Path:
        return self.data_path("water.geojson")

    @property
    def coastline_path(self) -> Path:
        return self.data_path("coastline.json")

    @property
    def major_streets_path(self) -> Path:
        return DATA_DIR / (self.major_streets_file or f"{self.prefix}_major_streets.json")

    @property
    def street_network_path(self) -> Path:
        return self.data_path("street_network.json")

    @property
    def transit_cache_path(self) -> Path:
        return self.data_path("transit_network.json")

    @property
    def site_data_dir(self) -> Path:
        return SITE_DATA_DIR / self.id


# ---------- Copenhagen (Rejseplanen's national feed) ----------

# Movia's buses (route_type 3) and S-buses (700). Rail-replacement buses run by DSB and the Metro
# are left out, as are demand-responsive services (715).
CPH_BUS_AGENCIES = {"Movia"}
CPH_BUS_ROUTE_TYPES = {"3", "700"}
# Regional operators are merged into one route per operator so that combined
# frequencies (e.g. all Øresundståg variants) produce realistic waits.
CPH_REGIONAL_ROUTE_NAMES = {
    "DSB": "DSB",
    "DSB Vores Tog": "DSB",
    "Skånetrafiken": "Øresundståg",
    "Lokaltog A/S": "Lokaltog",
    "Snälltåget AB": "Snälltåget",
}
# Stop names that refer to the same place under different names.
CPH_STATION_NAME_ALIASES = {
    "CPH Lufthavn": "Københavns Lufthavn",
}


def classify_cph_route(row: dict, agency: str) -> Optional[Tuple[str, str, str]]:
    route_type = row["route_type"]
    short_name = (row.get("route_short_name") or "").strip()
    if route_type == "1":
        return "metro", short_name, short_name
    if route_type == "109":
        return "stog", short_name, short_name
    if route_type == "0":
        return "letbane", "L", "L"
    if route_type == "2":
        name = CPH_REGIONAL_ROUTE_NAMES.get(agency, agency or short_name)
        return "regional", name, name
    if route_type == "4":
        return "harbour", "Havnebus", "Havnebus"
    if route_type in CPH_BUS_ROUTE_TYPES and agency in CPH_BUS_AGENCIES and short_name:
        return "bus", "bus:" + short_name, short_name
    return None


def normalize_cph_station_name(name: str) -> str:
    name = re.sub(r"\s*\([^)]*\)\s*$", "", name)
    name = re.sub(r"\s+St\.$", "", name.strip())
    name = re.sub(r"\s+", " ", name).strip()
    return CPH_STATION_NAME_ALIASES.get(name, name)


COPENHAGEN = City(
    id="copenhagen",
    name="Copenhagen",
    prefix="cph",
    gtfs_dir_name="GTFS",
    gtfs_url="https://www.rejseplanen.info/labs/GTFS.zip",
    transit_source="Rejseplanen GTFS",
    country_codes="dk",
    search_languages="da,en",
    # Byen København + Københavns omegn (Statistics Denmark's "landsdele").
    municipalities={
        "Københavns Kommune": "København",
        "Frederiksberg Kommune": "Frederiksberg",
        "Tårnby Kommune": "Tårnby",
        "Dragør Kommune": "Dragør",
        "Gentofte Kommune": "Gentofte",
        "Gladsaxe Kommune": "Gladsaxe",
        "Lyngby-Taarbæk Kommune": "Lyngby-Taarbæk",
        "Herlev Kommune": "Herlev",
        "Ballerup Kommune": "Ballerup",
        "Rødovre Kommune": "Rødovre",
        "Hvidovre Kommune": "Hvidovre",
        "Glostrup Kommune": "Glostrup",
        "Brøndby Kommune": "Brøndby",
        "Albertslund Kommune": "Albertslund",
        "Vallensbæk Kommune": "Vallensbæk",
        "Ishøj Kommune": "Ishøj",
        "Høje-Taastrup Kommune": "Høje-Taastrup",
    },
    boundary_bbox=(55.45, 11.95, 55.95, 12.75),
    detail_bbox=(55.54, 12.12, 55.84, 12.72),
    street_bbox=(55.550, 12.160, 55.830, 12.720),
    street_tiles=(3, 4),
    # Central Copenhagen out to Rødovre (west), Hellerup (north), Ørestad (south), Kastrup (east).
    initial_view_bbox=(12.430, 55.625, 12.680, 55.735),
    modes=(
        {"id": "metro", "label": "Metro", "color": "#E30613"},
        {"id": "stog", "label": "S-tog", "color": "#B41730"},
        {"id": "letbane", "label": "Letbane", "color": "#5E6F82"},
        {"id": "regional", "label": "Regional trains", "color": "#7C3A5E"},
        {"id": "harbour", "label": "Harbour bus", "color": "#4FB3BF"},
        # Dark amber: Movia's yellow would clash with the F line and M2.
        {"id": "bus", "label": "Bus", "color": "#A8661C"},
    ),
    # Long-distance lines underneath, metro on top.
    mode_draw_order=("bus", "regional", "harbour", "stog", "letbane", "metro"),
    classify_route=classify_cph_route,
    normalize_station_name=normalize_cph_station_name,
    route_colors={
        "M1": "#00814F",
        "M2": "#FFC20E",
        "M3": "#E30613",
        "M4": "#0091D2",
        "A": "#00A0DF",
        "B": "#4BA545",
        "Bx": "#A5CF4C",
        "C": "#F28C00",
        "E": "#7D60A6",
        "F": "#F5C400",
        "H": "#E2001A",
        "L": "#5E6F82",
    },
    route_text_colors={"M2": "#17304D", "F": "#17304D", "Bx": "#17304D"},
    # Deep metro and mainline stations take longer than street-level light rail and harbour-bus stops.
    station_access_minutes={"metro": 2.0, "stog": 1.5, "regional": 2.0, "letbane": 0.5, "harbour": 0.5, "bus": 0.3},
    bike_station_extra_minutes={"metro": 1.0, "stog": 1.0, "regional": 1.0, "letbane": 0.5, "harbour": 0.5, "bus": 0.0},
    # Bikes aren't allowed on Movia buses.
    no_bike_modes=("bus",),
    # Drop Saltholm/Peberholm and the harbour forts: islands east of this longitude
    # are uninhabited and only stretch the map bounds.
    max_polygon_lon=12.70,
    major_streets_file="osm_major_streets.json",
)


# ---------- Stockholm (SL's GTFS Regional feed) ----------

STO_SL_AGENCY = "AB Storstockholms Lokaltrafik"
# Pendeltåg and metro platforms that are one interchange under different names.
STO_STATION_NAME_ALIASES = {
    "Stockholm City": "T-Centralen",
    "Stockholm Odenplan": "Odenplan",
    "Sundbybergs centrum": "Sundbyberg",
    "Solna station": "Solna",
}


def classify_sto_route(row: dict, agency: str) -> Optional[Tuple[str, str, str]]:
    """SL's own lines only: the feed also lists the archipelago boats (Waxholmsbolaget), dial-a-ride
    (Närtrafiken), and a few neighbouring-county buses. Route keys get a prefix per mode because
    SL's line numbers are only unique within a mode."""
    short_name = (row.get("route_short_name") or "").strip()
    if agency != STO_SL_AGENCY or not short_name:
        return None
    route_type = row["route_type"]
    if route_type == "401":
        return "metro", "T" + short_name, "T" + short_name
    if route_type == "100":
        return "pendeltag", "J" + short_name, short_name
    if route_type == "900":
        return "tram", "L" + short_name, short_name
    if route_type == "1000":
        return "boat", "B" + short_name, short_name
    if route_type == "700":
        return "bus", "bus:" + short_name, short_name
    return None


def normalize_sto_station_name(name: str) -> str:
    name = re.sub(r"\s+", " ", name).strip()
    return STO_STATION_NAME_ALIASES.get(name, name)


STO_BLUE, STO_RED, STO_GREEN = "#0089CA", "#D71D24", "#179D4D"
STO_ROSLAGSBANAN, STO_SALTSJOBANAN, STO_TVARBANAN = "#A86DAE", "#21B6BA", "#D77D00"

STOCKHOLM = City(
    id="stockholm",
    name="Stockholm",
    prefix="sto",
    gtfs_dir_name="GTFS-stockholm",
    # Mobility Database's daily mirror of Trafiklab's "GTFS Regional SL" feed. The original
    # (https://opendata.samtrafiken.se/gtfs/sl/sl.zip?key=…) needs a free Trafiklab API key.
    gtfs_url="https://files.mobilitydatabase.org/mdb-3237/latest.zip",
    transit_source="SL GTFS (Trafiklab)",
    country_codes="se",
    search_languages="sv,en",
    # The city, its inner suburbs, and the municipalities around Kista (Sollentuna, Järfälla).
    municipalities={
        "Stockholms kommun": "Stockholm",
        "Solna kommun": "Solna",
        "Sundbybergs kommun": "Sundbyberg",
        "Danderyds kommun": "Danderyd",
        "Lidingö kommun": "Lidingö",
        "Nacka kommun": "Nacka",
        "Sollentuna kommun": "Sollentuna",
        "Järfälla kommun": "Järfälla",
        "Huddinge kommun": "Huddinge",
    },
    boundary_bbox=(59.00, 17.30, 59.70, 18.90),
    detail_bbox=(59.135, 17.715, 59.515, 18.400),
    street_bbox=(59.135, 17.715, 59.515, 18.400),
    street_tiles=(4, 4),
    # The inner city out to Kista (north-west), Danderyd (north), Nacka (east), and Älvsjö (south).
    initial_view_bbox=(17.900, 59.265, 18.180, 59.420),
    modes=(
        # "short" is the text on the app's mode switch where the full label doesn't fit.
        {"id": "metro", "label": "Tunnelbana", "short": "T-bana", "color": STO_BLUE},
        {"id": "pendeltag", "label": "Pendeltåg", "short": "Train", "color": "#EC619F"},
        {"id": "tram", "label": "Tram & local rail", "short": "Tram", "color": STO_TVARBANAN},
        {"id": "boat", "label": "Commuter boat", "short": "Boat", "color": "#4FB3BF"},
        # Dark amber rather than SL's red, which is the Red line's colour.
        {"id": "bus", "label": "Bus", "color": "#A8661C"},
    ),
    mode_draw_order=("bus", "boat", "pendeltag", "tram", "metro"),
    classify_route=classify_sto_route,
    normalize_station_name=normalize_sto_station_name,
    route_colors={
        "T10": STO_BLUE,
        "T11": STO_BLUE,
        "T13": STO_RED,
        "T14": STO_RED,
        "T17": STO_GREEN,
        "T18": STO_GREEN,
        "T19": STO_GREEN,
        "L7": "#878A83",  # Spårväg City
        "L12": "#738BA4",  # Nockebybanan
        "L21": "#B76020",  # Lidingöbanan
        "L25": STO_SALTSJOBANAN,
        "L26": STO_SALTSJOBANAN,
        "L27": STO_ROSLAGSBANAN,
        "L27S": STO_ROSLAGSBANAN,
        "L28": STO_ROSLAGSBANAN,
        "L28S": STO_ROSLAGSBANAN,
        "L29": STO_ROSLAGSBANAN,
        "L30": STO_TVARBANAN,
        "L31": STO_TVARBANAN,
    },
    # The tunnelbana and the City/Odenplan commuter platforms are deep underground.
    station_access_minutes={"metro": 2.5, "pendeltag": 2.5, "tram": 0.5, "boat": 0.5, "bus": 0.3},
    bike_station_extra_minutes={"metro": 1.0, "pendeltag": 1.0, "tram": 0.5, "boat": 0.5, "bus": 0.0},
    # SL takes bikes on the pendeltåg (off-peak) and the commuter boats only.
    no_bike_modes=("bus", "metro", "tram"),
    sea_from_coastline=True,
    landmark_stations=("Kista",),
    # Greater Stockholm is half forest; skipping the small patches keeps the download reasonable.
    min_park_area=40_000.0,
)


CITIES: Dict[str, City] = {city.id: city for city in (COPENHAGEN, STOCKHOLM)}
DEFAULT_CITY = COPENHAGEN.id


def get_city(city_id: Optional[str] = None) -> City:
    try:
        return CITIES[city_id or DEFAULT_CITY]
    except KeyError:
        raise SystemExit(f"Unknown city {city_id!r}; choose one of: {', '.join(CITIES)}") from None


def city_from_argv(argv: list) -> City:
    """Pop `--city <id>` / `--city=<id>` from argv (in place) and return that city."""
    city_id = None
    index = 0
    while index < len(argv):
        arg = argv[index]
        if arg == "--city":
            if index + 1 >= len(argv):
                raise SystemExit("--city needs a value")
            city_id = argv[index + 1]
            del argv[index : index + 2]
        elif arg.startswith("--city="):
            city_id = arg.split("=", 1)[1]
            del argv[index]
        else:
            index += 1
    return get_city(city_id)
