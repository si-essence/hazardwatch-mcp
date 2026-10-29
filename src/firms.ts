import { z } from "zod";
import {
  DAY_RANGE_MAX,
  DEFAULT_FIRE_SOURCE,
  FIRE_SOURCES,
  FIRMS_AREA_DOCS,
  FIRMS_COUNTRY_UNAVAILABLE,
  FIRMS_KEY_HINT,
  MAX_HOTSPOTS,
  MAX_RADIUS_KM,
  SAFETY_CAVEAT,
  type FireSource,
} from "./constants.js";
import { parseCsv } from "./csv.js";
import { ConnectorError } from "./errors.js";
import {
  bbox,
  bboxAround,
  dayRange,
  distanceKm,
  firmsTransactionWeight,
  formatBbox,
  isWorld,
  iso3,
  type Bbox,
  type DayRange,
  type FirmsArea,
  type Iso3,
} from "./geo.js";
import type { HttpClient } from "./http.js";
import type { Secret } from "./brand.js";
import { fixedError } from "./zod-messages.js";

const sourceError = fixedError(
  "source must be a FIRMS sensor id such as VIIRS_NOAA21_NRT, VIIRS_NOAA20_NRT, VIIRS_SNPP_NRT, or MODIS_NRT",
);
const dayError = fixedError(`day_range must be an integer from 1 to ${DAY_RANGE_MAX}`);
const dateError = fixedError("date must be YYYY-MM-DD");
const coordError = fixedError("coordinates must be finite numbers inside the valid range");

const sourceField = z.enum(FIRE_SOURCES, { error: sourceError }).default(DEFAULT_FIRE_SOURCE);
const dayField = z.number({ error: dayError }).int({ error: dayError }).min(1).max(DAY_RANGE_MAX);
const dateField = z
  .string({ error: dateError })
  .regex(/^\d{4}-\d{2}-\d{2}$/, { error: dateError })
  .refine(isCalendarDate, { error: dateError })
  .optional();

export const firesNearInput = z
  .object({
    latitude: z.number({ error: coordError }).min(-90).max(90).optional(),
    longitude: z.number({ error: coordError }).min(-180).max(180).optional(),
    radius_km: z.number({ error: coordError }).positive().max(MAX_RADIUS_KM).optional(),
    west: z.number({ error: coordError }).min(-180).max(180).optional(),
    south: z.number({ error: coordError }).min(-90).max(90).optional(),
    east: z.number({ error: coordError }).min(-180).max(180).optional(),
    north: z.number({ error: coordError }).min(-90).max(90).optional(),
    day_range: dayField.default(1),
    source: sourceField,
    date: dateField,
  })
  .strict();

export const firesByCountryInput = z
  .object({
    country: z
      .string({ error: fixedError("country must be an ISO 3166-1 alpha-3 code") })
      .trim()
      .regex(/^[A-Za-z]{3}$/, { error: fixedError("country must be an ISO 3166-1 alpha-3 code") }),
    day_range: dayField.default(1),
    source: sourceField,
    date: dateField,
  })
  .strict();

declare const acqTimeBrand: unique symbol;

export type AcqTime = string & { readonly [acqTimeBrand]: "AcqTime" };

export interface Hotspot {
  latitude: number;
  longitude: number;
  acq_date: string | null;
  acq_time: AcqTime | null;
  acquired_at: string | null;
  satellite: string | null;
  instrument: string | null;
  confidence: string | null;
  frp: number | null;
  brightness: number | null;
  daynight: string | null;
}

export interface RankedHotspot extends Hotspot {
  distance_km: number;
}

interface FireReportBase {
  provider: "NASA FIRMS";
  sensor: FireSource;
  bbox: Bbox | null;
  queried_bbox: Bbox | null;
  country: Iso3 | null;
  day_range: DayRange;
  date: string | null;
  transaction_weight: number;
  returned: number;
  truncated: boolean;
  caveat: string;
  docs: string;
}

export interface RegionFireReport extends FireReportBase {
  area: "bbox" | "world" | "country";
  count: number;
  hotspots: Hotspot[];
}

export interface PointFireReport extends FireReportBase {
  area: "point";
  count: number;
  bbox_count: number;
  hotspots: RankedHotspot[];
}

export type FireReport = RegionFireReport | PointFireReport;

export interface FirmsDeps {
  client: HttpClient;
  mapKey: Secret | undefined;
  cacheTtlSec: number;
}

export async function firesNear(
  deps: FirmsDeps,
  args: z.output<typeof firesNearInput>,
): Promise<FireReport> {
  return loadFires(deps, nearArea(args), args.source, dayRange(args.day_range), args.date);
}

function nearArea(args: z.output<typeof firesNearInput>): FirmsArea {
  const point = pointQuery(args);
  const box = boxQuery(args);
  if (point !== undefined && box !== undefined) {
    throw new ConnectorError(
      "input",
      "Pass latitude, longitude, and radius_km, or west, south, east, and north, not both.",
    );
  }
  if (point !== undefined) {
    return {
      kind: "point",
      latitude: point.latitude,
      longitude: point.longitude,
      radiusKm: point.radiusKm,
      bbox: bboxAround(point.latitude, point.longitude, point.radiusKm),
    };
  }
  if (box !== undefined) {
    const checked = bbox(box);
    return isWorld(checked) ? { kind: "world" } : { kind: "bbox", bbox: checked };
  }
  throw new ConnectorError(
    "input",
    "Pass latitude, longitude, and radius_km, or west, south, east, and north.",
  );
}

function pointQuery(
  args: z.output<typeof firesNearInput>,
): { latitude: number; longitude: number; radiusKm: number } | undefined {
  const { latitude, longitude, radius_km: radiusKm } = args;
  if (latitude === undefined && longitude === undefined && radiusKm === undefined) return undefined;
  if (latitude === undefined || longitude === undefined || radiusKm === undefined) {
    throw new ConnectorError("input", "A point query needs latitude, longitude, and radius_km.");
  }
  return { latitude, longitude, radiusKm };
}

function boxQuery(args: z.output<typeof firesNearInput>): Bbox | undefined {
  const { west, south, east, north } = args;
  if (west === undefined && south === undefined && east === undefined && north === undefined) {
    return undefined;
  }
  if (west === undefined || south === undefined || east === undefined || north === undefined) {
    throw new ConnectorError("input", "A bbox query needs west, south, east, and north.");
  }
  return { west, south, east, north };
}

export async function firesByCountry(
  deps: FirmsDeps,
  args: z.output<typeof firesByCountryInput>,
): Promise<FireReport> {
  const code = iso3(args.country);
  return loadFires(
    deps,
    { kind: "country", iso3: code },
    args.source,
    dayRange(args.day_range),
    args.date,
  );
}

/** Keep the nearest `limit` hotspots. `count` stays the number inside the radius. */
export function limitPointHotspots(report: PointFireReport, limit: number): PointFireReport {
  const hotspots = report.hotspots.slice(0, limit);
  return {
    ...report,
    hotspots,
    returned: hotspots.length,
    truncated: report.count > hotspots.length,
  };
}

async function loadFires(
  deps: FirmsDeps,
  area: FirmsArea,
  source: FireSource,
  days: DayRange,
  date: string | undefined,
): Promise<FireReport> {
  const key = requireMapKey(deps.mapKey);
  const weight = firmsTransactionWeight(source, area, days);
  const path = firmsPath(key, area, source, days, date);
  let text: string;
  try {
    text = await deps.client.getText({
      path,
      query: undefined,
      ttlSec: deps.cacheTtlSec,
      cost: weight,
    });
  } catch (error) {
    if (
      area.kind === "country" &&
      error instanceof ConnectorError &&
      error.code === "upstream" &&
      error.message.includes("HTTP 400")
    ) {
      throw new ConnectorError("upstream", FIRMS_COUNTRY_UNAVAILABLE);
    }
    throw error;
  }
  const parsed = hotspotsFromCsv(text);
  const base = {
    provider: "NASA FIRMS" as const,
    sensor: source,
    day_range: days,
    date: date ?? null,
    transaction_weight: weight,
    caveat: SAFETY_CAVEAT,
    docs: FIRMS_AREA_DOCS,
  };
  if (area.kind === "point") {
    const ranked = rankHotspots(parsed, area);
    const hotspots = ranked.slice(0, MAX_HOTSPOTS);
    return {
      ...base,
      area: "point",
      bbox: area.bbox,
      queried_bbox: area.bbox,
      country: null,
      count: ranked.length,
      bbox_count: parsed.length,
      returned: hotspots.length,
      truncated: ranked.length > hotspots.length,
      hotspots,
    };
  }
  const hotspots = parsed.slice(0, MAX_HOTSPOTS);
  const box = area.kind === "country" ? null : area.kind === "world" ? worldBox() : area.bbox;
  return {
    ...base,
    area: area.kind,
    bbox: box,
    queried_bbox: box,
    country: area.kind === "country" ? area.iso3 : null,
    count: parsed.length,
    returned: hotspots.length,
    truncated: parsed.length > hotspots.length,
    hotspots,
  };
}

function requireMapKey(mapKey: Secret | undefined): Secret {
  if (mapKey === undefined) throw new ConnectorError("config", FIRMS_KEY_HINT);
  return mapKey;
}

function firmsPath(
  key: string,
  area: FirmsArea,
  source: FireSource,
  days: number,
  date: string | undefined,
): string {
  const endpoint = area.kind === "country" ? "country" : "area";
  const parts = ["api", endpoint, "csv", key, source, areaToken(area), String(days)];
  if (date !== undefined) parts.push(date);
  return parts.join("/");
}

function areaToken(area: FirmsArea): string {
  switch (area.kind) {
    case "country":
      return area.iso3;
    case "world":
      return "world";
    case "bbox":
    case "point":
      return isWorld(area.bbox) ? "world" : formatBbox(area.bbox);
    default: {
      const unreachable: never = area;
      return unreachable;
    }
  }
}

function hotspotsFromCsv(text: string): Hotspot[] {
  const rows = parseCsv(text);
  if (rows.length === 0 && !/latitude/i.test(text)) {
    throw new ConnectorError("upstream", "FIRMS response was not a CSV table.");
  }
  const hotspots: Hotspot[] = [];
  for (const row of rows) {
    const latitude = parseNumber(row["latitude"]);
    const longitude = parseNumber(row["longitude"]);
    if (latitude === null || longitude === null) continue;
    if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) continue;
    const clock = acqTime(blank(row["acq_time"]));
    const acqDate = blank(row["acq_date"]);
    hotspots.push({
      latitude,
      longitude,
      acq_date: acqDate,
      acq_time: clock,
      acquired_at: acquiredAt(acqDate, clock),
      satellite: blank(row["satellite"]),
      instrument: blank(row["instrument"]),
      confidence: blank(row["confidence"]),
      frp: parseNumber(row["frp"]),
      brightness: parseNumber(row["brightness"]) ?? parseNumber(row["bright_ti4"]),
      daynight: blank(row["daynight"]),
    });
  }
  return hotspots;
}

function rankHotspots(
  hotspots: readonly Hotspot[],
  area: Extract<FirmsArea, { kind: "point" }>,
): RankedHotspot[] {
  const inside: { hotspot: Hotspot; distance: number }[] = [];
  for (const hotspot of hotspots) {
    const distance = distanceKm(area.latitude, area.longitude, hotspot.latitude, hotspot.longitude);
    if (distance > area.radiusKm) continue;
    inside.push({ hotspot, distance });
  }
  inside.sort((left, right) => left.distance - right.distance);
  return inside.map(({ hotspot, distance }) => ({ ...hotspot, distance_km: roundTenth(distance) }));
}

function roundTenth(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * FIRMS sends acq_time as HHMM and omits leading zeros, so "7" is 00:07 UTC and "848" is 08:48 UTC.
 * Hours above 23 or minutes above 59 are rejected.
 */
function acqTime(value: string | null): AcqTime | null {
  if (value === null || !/^\d{1,4}$/.test(value)) return null;
  const hhmm = value.padStart(4, "0");
  const hours = Number(hhmm.slice(0, 2));
  const minutes = Number(hhmm.slice(2, 4));
  if (hours > 23 || minutes > 59) return null;
  return hhmm as AcqTime;
}

function acquiredAt(date: string | null, clock: AcqTime | null): string | null {
  if (
    date === null ||
    clock === null ||
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    !isCalendarDate(date)
  ) {
    return null;
  }
  return `${date}T${clock.slice(0, 2)}:${clock.slice(2, 4)}:00Z`;
}

function parseNumber(value: string | undefined): number | null {
  if (value === undefined || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function blank(value: string | undefined): string | null {
  if (value === undefined || value.trim() === "") return null;
  return value.trim();
}

function worldBox(): Bbox {
  return { west: -180, south: -90, east: 180, north: 90 };
}

function isCalendarDate(value: string): boolean {
  const parts = value.split("-");
  if (parts.length !== 3) return false;
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}
