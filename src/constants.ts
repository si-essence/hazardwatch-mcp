export const CONNECTOR_NAME = "hazardwatch";
export const CONNECTOR_VERSION = "0.1.0";

export const FIRMS_ORIGIN = "https://firms.modaps.eosdis.nasa.gov";
export const EONET_ORIGIN = "https://eonet.gsfc.nasa.gov/api/v3";
export const FIRMS_KEY_URL = "https://firms.modaps.eosdis.nasa.gov/api/map_key/";
export const FIRMS_API_INDEX = "https://firms.modaps.eosdis.nasa.gov/api/";
export const FIRMS_AREA_DOCS = "https://firms.modaps.eosdis.nasa.gov/api/area/";
export const EONET_DOCS = "https://eonet.gsfc.nasa.gov/docs/v3";

export const FIRMS_KEY_HINT =
  "FIRMS_MAP_KEY is not set. Request a free MAP_KEY at https://firms.modaps.eosdis.nasa.gov/api/map_key/ and export FIRMS_MAP_KEY.";

export const FIRMS_COUNTRY_UNAVAILABLE =
  "FIRMS rejected the country query with HTTP 400. The API index marks country as not available (https://firms.modaps.eosdis.nasa.gov/api/). Use fires_near with a bounding box until NASA restores the country endpoint. If the endpoint is back, check the ISO3 code and the day range.";

export const SAFETY_CAVEAT =
  "Not for safety-of-life decisions. FIRMS hotspots are near-real-time detections and include false positives. EONET events are for visualization and general information, and they link to third-party sources with their own licenses. No NASA endorsement is implied.";

export const FIRE_SOURCES = [
  "VIIRS_SNPP_NRT",
  "VIIRS_NOAA20_NRT",
  "VIIRS_NOAA21_NRT",
  "VIIRS_SNPP_SP",
  "VIIRS_NOAA20_SP",
  "MODIS_NRT",
  "MODIS_SP",
  "LANDSAT_NRT",
] as const;

export type FireSource = (typeof FIRE_SOURCES)[number];

export const DEFAULT_FIRE_SOURCE: FireSource = "VIIRS_NOAA21_NRT";

export const DAY_RANGE_MAX = 5;
export const MAX_RADIUS_KM = 2500;
export const MAX_HOTSPOTS = 500;
export const MAX_GEOMETRIES = 30;
export const MAX_GEOMETRY_POINTS = 400;
export const FIRMS_TRANSACTION_LIMIT = 5000;
export const FIRMS_TRANSACTION_WINDOW_MS = 600_000;
