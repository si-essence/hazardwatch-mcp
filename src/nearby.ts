import { z } from "zod";
import {
  DAY_RANGE_MAX,
  DEFAULT_FIRE_SOURCE,
  EONET_DOCS,
  FIRE_SOURCES,
  MAX_RADIUS_KM,
  SAFETY_CAVEAT,
} from "./constants.js";
import { ConnectorError, errorPrefix } from "./errors.js";
import { eonetEvents, eonetEventsInput, positionsIn } from "./eonet.js";
import { firesNear, firesNearInput, limitPointHotspots, type FireReport } from "./firms.js";
import { bboxAround, distanceKm } from "./geo.js";
import type { Runtime } from "./runtime.js";
import { fixedError } from "./zod-messages.js";

const coordError = fixedError("coordinates must be finite numbers inside the valid range");
const dayError = fixedError(`day_range must be an integer from 1 to ${DAY_RANGE_MAX}`);
const sourceError = fixedError("source must be a FIRMS sensor id");
const limitError = fixedError("limit must be an integer from 1 to 50");

export const nearbyHazardsInput = z
  .object({
    latitude: z.number({ error: coordError }).min(-90).max(90),
    longitude: z.number({ error: coordError }).min(-180).max(180),
    radius_km: z.number({ error: coordError }).positive().max(MAX_RADIUS_KM),
    day_range: z
      .number({ error: dayError })
      .int({ error: dayError })
      .min(1)
      .max(DAY_RANGE_MAX)
      .default(1),
    source: z.enum(FIRE_SOURCES, { error: sourceError }).default(DEFAULT_FIRE_SOURCE),
    limit: z.number({ error: limitError }).int({ error: limitError }).min(1).max(50).default(20),
  })
  .strict();

export async function nearbyHazards(
  runtime: Runtime,
  args: z.output<typeof nearbyHazardsInput>,
): Promise<Record<string, unknown>> {
  const box = bboxAround(args.latitude, args.longitude, args.radius_km);
  const firmsArgs = firesNearInput.parse({
    latitude: args.latitude,
    longitude: args.longitude,
    radius_km: args.radius_km,
    day_range: args.day_range,
    source: args.source,
  });
  const eventArgs = eonetEventsInput.parse({
    status: "open",
    limit: args.limit,
    west: box.west,
    south: box.south,
    east: box.east,
    north: box.north,
  });
  const [firmsResult, eventsResult] = await Promise.allSettled([
    firesNear(
      {
        client: runtime.firms,
        mapKey: runtime.config.firmsMapKey,
        cacheTtlSec: runtime.cacheTtlSec,
      },
      firmsArgs,
    ),
    eonetEvents(runtime.eonet, eventArgs, runtime.cacheTtlSec),
  ]);

  let firms: FireReport | null = null;
  let firmsNote: string | null = null;
  if (firmsResult.status === "fulfilled") {
    const report = firmsResult.value;
    firms = report.area === "point" ? limitPointHotspots(report, args.limit) : report;
  } else {
    firmsNote = noteFor(firmsResult.reason);
  }

  let events: Record<string, unknown>[] = [];
  let eventsNote: string | null = null;
  if (eventsResult.status === "fulfilled") {
    events = withinRadius(eventsResult.value, args.latitude, args.longitude, args.radius_km);
  } else {
    eventsNote = noteFor(eventsResult.reason);
  }

  return {
    provider: "hazardwatch",
    latitude: args.latitude,
    longitude: args.longitude,
    radius_km: args.radius_km,
    bbox: { west: box.west, south: box.south, east: box.east, north: box.north },
    firms,
    firms_note: firmsNote,
    events,
    events_count: events.length,
    events_note: eventsNote,
    caveat: SAFETY_CAVEAT,
    docs: EONET_DOCS,
  };
}

function withinRadius(
  report: Record<string, unknown>,
  latitude: number,
  longitude: number,
  radiusKm: number,
): Record<string, unknown>[] {
  const events = report["events"];
  if (!Array.isArray(events)) return [];
  const kept: Record<string, unknown>[] = [];
  for (const event of events) {
    if (!isRecord(event)) continue;
    const geometries = event["geometries"];
    if (!Array.isArray(geometries)) continue;
    const positions = geometries.flatMap((geometry) => {
      if (!isRecord(geometry)) return [];
      return positionsIn(geometry["coordinates"]);
    });
    const near = positions.some(
      (position) =>
        distanceKm(latitude, longitude, position.latitude, position.longitude) <= radiusKm,
    );
    if (near) kept.push(event);
  }
  return kept;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function noteFor(error: unknown): string {
  if (error instanceof ConnectorError) return `${errorPrefix(error.code)}${error.message}`;
  if (error instanceof Error) return error.message;
  return "The upstream request failed.";
}
