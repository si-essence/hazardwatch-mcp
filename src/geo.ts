import { DAY_RANGE_MAX, type FireSource, MAX_RADIUS_KM } from "./constants.js";
import { ConnectorError } from "./errors.js";

declare const dayRangeBrand: unique symbol;
declare const iso3Brand: unique symbol;

/** Inclusive FIRMS day count. The live area page allows 1 through 5. */
export type DayRange = number & { readonly [dayRangeBrand]: "DayRange" };

/** ISO 3166-1 alpha-3 country code. */
export type Iso3 = string & { readonly [iso3Brand]: "Iso3" };

export interface Bbox {
  west: number;
  south: number;
  east: number;
  north: number;
}

export type FirmsArea =
  | { kind: "bbox"; bbox: Bbox }
  | { kind: "point"; latitude: number; longitude: number; radiusKm: number; bbox: Bbox }
  | { kind: "world" }
  | { kind: "country"; iso3: Iso3 };

export function dayRange(value: number): DayRange {
  if (!Number.isInteger(value) || value < 1 || value > DAY_RANGE_MAX) {
    throw new ConnectorError("input", `day_range must be an integer from 1 to ${DAY_RANGE_MAX}.`);
  }
  return value as DayRange;
}

export function iso3(value: string): Iso3 {
  const text = value.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(text)) {
    throw new ConnectorError("input", "country must be an ISO 3166-1 alpha-3 code.");
  }
  return text as Iso3;
}

export function bbox(value: Bbox): Bbox {
  const { west, south, east, north } = value;
  if (
    !inRange(west, -180, 180) ||
    !inRange(east, -180, 180) ||
    !inRange(south, -90, 90) ||
    !inRange(north, -90, 90)
  ) {
    throw new ConnectorError(
      "input",
      "bbox coordinates must be west and east in [-180, 180] and south and north in [-90, 90].",
    );
  }
  if (south >= north) {
    throw new ConnectorError("input", "bbox south must be less than north.");
  }
  if (west >= east) {
    throw new ConnectorError(
      "input",
      "bbox west must be less than east. This connector does not wrap across the antimeridian.",
    );
  }
  return { west, south, east, north };
}

export function bboxAround(latitude: number, longitude: number, radiusKm: number): Bbox {
  if (!inRange(latitude, -90, 90) || !inRange(longitude, -180, 180)) {
    throw new ConnectorError(
      "input",
      "latitude must be in [-90, 90] and longitude in [-180, 180].",
    );
  }
  if (!Number.isFinite(radiusKm) || radiusKm <= 0 || radiusKm > MAX_RADIUS_KM) {
    throw new ConnectorError(
      "input",
      `radius_km must be greater than 0 and at most ${MAX_RADIUS_KM}.`,
    );
  }
  const latDelta = radiusKm / 110.574;
  const south = Math.max(-90, latitude - latDelta);
  const north = Math.min(90, latitude + latDelta);
  const lonScale = 111.32 * Math.abs(Math.cos((latitude * Math.PI) / 180));
  if (lonScale < 1e-6 || radiusKm / lonScale >= 180) {
    return bbox({ west: -180, south, east: 180, north });
  }
  const lonDelta = radiusKm / lonScale;
  const west = longitude - lonDelta;
  const east = longitude + lonDelta;
  if (west < -180 || east > 180) {
    throw new ConnectorError(
      "input",
      "The radius crosses the antimeridian. Pass a bbox with west less than east, or split the query.",
    );
  }
  return bbox({ west, south, east, north });
}

export function isWorld(box: Bbox): boolean {
  return box.west === -180 && box.south === -90 && box.east === 180 && box.north === 90;
}

/**
 * Transaction weight from the FIRMS area page script (computeWeight).
 * VIIRS counts as 2, other sensors as 0.5. Cells are 60 degrees on a side.
 * Country cost there is ceil(weight[iso3] * 20 * sensor * days). The weight
 * table is not in the public area HTML, and the country page returns HTTP 400,
 * so this uses weight 1 and also charges at least a world query. A country
 * whose unpublished weight is above 1 is under-counted.
 */
export function firmsTransactionWeight(
  source: FireSource,
  area: FirmsArea,
  days: DayRange,
): number {
  const sensor = source.includes("VIIRS") ? 2 : 0.5;
  if (area.kind === "country") {
    const assumed = Math.ceil(20 * sensor * days);
    return Math.max(assumed, worldWeight(sensor, days));
  }
  const box = area.kind === "world" ? { west: -180, south: -90, east: 180, north: 90 } : area.bbox;
  const cellsX = Math.ceil((box.east - box.west) / 60);
  const cellsY = Math.ceil((box.north - box.south) / 60);
  return Math.max(1, Math.ceil(cellsX * cellsY * sensor * days));
}

export function distanceKm(
  latitude: number,
  longitude: number,
  otherLatitude: number,
  otherLongitude: number,
): number {
  const radius = 6371;
  const lat1 = (latitude * Math.PI) / 180;
  const lat2 = (otherLatitude * Math.PI) / 180;
  const dLat = lat2 - lat1;
  const dLon = ((otherLongitude - longitude) * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * radius * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function formatCoord(value: number): string {
  const trimmed = value
    .toFixed(6)
    .replace(/(\.\d*?)0+$/, "$1")
    .replace(/\.$/, "");
  return trimmed === "-0" ? "0" : trimmed;
}

export function formatBbox(box: Bbox): string {
  return [box.west, box.south, box.east, box.north].map((value) => formatCoord(value)).join(",");
}

/** EONET documents bbox as min lon, max lat, max lon, min lat. */
export function formatEonetBbox(box: Bbox): string {
  return [box.west, box.north, box.east, box.south].map((value) => formatCoord(value)).join(",");
}

function worldWeight(sensor: number, days: number): number {
  return Math.max(1, Math.ceil(6 * 3 * sensor * days));
}

function inRange(value: number, min: number, max: number): boolean {
  return Number.isFinite(value) && value >= min && value <= max;
}
