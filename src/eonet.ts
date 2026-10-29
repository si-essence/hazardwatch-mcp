import { z } from "zod";
import { EONET_DOCS, MAX_GEOMETRIES, MAX_GEOMETRY_POINTS, SAFETY_CAVEAT } from "./constants.js";
import { ConnectorError } from "./errors.js";
import { bbox, formatEonetBbox, type Bbox } from "./geo.js";
import type { HttpClient } from "./http.js";
import { fixedError } from "./zod-messages.js";

const dateError = fixedError("date must be YYYY-MM-DD");
const limitError = fixedError("limit must be an integer from 1 to 100");
const statusError = fixedError("status must be open, closed, or all");
const categoryError = fixedError("category must be an EONET category id such as wildfires");
const idError = fixedError("id must be an EONET event id such as EONET_25310");

const isoDate = z
  .string({ error: dateError })
  .regex(/^\d{4}-\d{2}-\d{2}$/, { error: dateError })
  .refine(isCalendarDate, { error: dateError });

export const eonetEventsInput = z
  .object({
    category: z
      .string({ error: categoryError })
      .trim()
      .regex(/^[A-Za-z0-9]{1,40}$/, { error: categoryError })
      .optional(),
    status: z.enum(["open", "closed", "all"], { error: statusError }).default("open"),
    start: isoDate.optional(),
    end: isoDate.optional(),
    limit: z.number({ error: limitError }).int({ error: limitError }).min(1).max(100).default(20),
    west: z.number().min(-180).max(180).optional(),
    south: z.number().min(-90).max(90).optional(),
    east: z.number().min(-180).max(180).optional(),
    north: z.number().min(-90).max(90).optional(),
  })
  .strict();

export const eonetEventInput = z
  .object({
    id: z
      .string({ error: idError })
      .trim()
      .regex(/^[A-Za-z0-9_-]{1,64}$/, { error: idError }),
  })
  .strict();

export const eonetCategoriesInput = z.object({}).strict();

const geometrySchema = z.object({
  date: z.string(),
  type: z.string(),
  coordinates: z.unknown(),
  magnitudeValue: z.number().nullable().optional(),
  magnitudeUnit: z.string().nullable().optional(),
});

const eventSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  description: z.string().nullable().optional(),
  link: z.string(),
  closed: z.string().nullable().optional(),
  categories: z.array(z.object({ id: z.string(), title: z.string() })).default([]),
  sources: z.array(z.object({ id: z.string(), url: z.string() })).default([]),
  geometry: z.array(geometrySchema).default([]),
});

const eventsSchema = z.object({
  events: z.array(eventSchema),
});

const categoriesSchema = z.object({
  categories: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      description: z.string().optional(),
      link: z.string().optional(),
    }),
  ),
});

export async function eonetEvents(
  client: HttpClient,
  args: z.output<typeof eonetEventsInput>,
  ttlSec: number,
): Promise<Record<string, unknown>> {
  if (args.start !== undefined && args.end !== undefined && args.end < args.start) {
    throw new ConnectorError("input", "end must be on or after start.");
  }
  const box = optionalBbox(args);
  const query: Record<string, string | number> = {
    status: args.status,
    limit: args.limit,
  };
  if (args.category !== undefined) query["category"] = args.category;
  if (args.start !== undefined) query["start"] = args.start;
  if (args.end !== undefined) query["end"] = args.end;
  if (box !== undefined) query["bbox"] = formatEonetBbox(box);
  const body = await client.getJson({ path: "events", query, ttlSec, cost: 1 }, eventsSchema);
  const events = body.events.map((event) => shapeEvent(event));
  return {
    provider: "NASA EONET",
    status: args.status,
    category: args.category ?? null,
    start: args.start ?? null,
    end: args.end ?? null,
    limit: args.limit,
    bbox: box === undefined ? null : bboxRecord(box),
    count: events.length,
    events,
    caveat: SAFETY_CAVEAT,
    docs: EONET_DOCS,
  };
}

export async function eonetEvent(
  client: HttpClient,
  id: string,
  ttlSec: number,
): Promise<Record<string, unknown>> {
  if (id.includes("/") || id.includes("..")) {
    throw new ConnectorError("input", "id must be an EONET event id such as EONET_25310.");
  }
  const event = await client.getJson(
    { path: `events/${id}`, query: undefined, ttlSec, cost: 1 },
    eventSchema,
  );
  return {
    provider: "NASA EONET",
    ...shapeEvent(event),
    caveat: SAFETY_CAVEAT,
    docs: EONET_DOCS,
  };
}

export async function eonetCategories(
  client: HttpClient,
  ttlSec: number,
): Promise<Record<string, unknown>> {
  const body = await client.getJson(
    { path: "categories", query: undefined, ttlSec, cost: 1 },
    categoriesSchema,
  );
  return {
    provider: "NASA EONET",
    count: body.categories.length,
    categories: body.categories.map((category) => ({
      id: category.id,
      title: category.title,
      description: category.description ?? null,
      link: category.link ?? null,
    })),
    caveat: SAFETY_CAVEAT,
    docs: EONET_DOCS,
  };
}

export function shapeEvent(event: z.output<typeof eventSchema>): Record<string, unknown> {
  const geometries = event.geometry.slice(0, MAX_GEOMETRIES).map((geometry) => ({
    date: geometry.date,
    type: geometry.type,
    coordinates: geometry.coordinates,
    magnitude_value: geometry.magnitudeValue ?? null,
    magnitude_unit: geometry.magnitudeUnit ?? null,
  }));
  return {
    id: event.id,
    title: event.title,
    description: event.description ?? null,
    link: event.link,
    closed: event.closed ?? null,
    categories: event.categories.map((category) => ({ id: category.id, title: category.title })),
    sources: event.sources.map((source) => ({ id: source.id, url: source.url })),
    geometry_count: event.geometry.length,
    geometries,
    geometries_truncated: event.geometry.length > geometries.length,
  };
}

export function positionsIn(value: unknown): Array<{ latitude: number; longitude: number }> {
  const positions: Array<{ latitude: number; longitude: number }> = [];
  collectPositions(value, positions);
  return positions;
}

function optionalBbox(args: z.output<typeof eonetEventsInput>): Bbox | undefined {
  const parts = [args.west, args.south, args.east, args.north];
  const present = parts.filter((part) => part !== undefined).length;
  if (present === 0) return undefined;
  if (
    present !== 4 ||
    args.west === undefined ||
    args.south === undefined ||
    args.east === undefined ||
    args.north === undefined
  ) {
    throw new ConnectorError("input", "bbox needs west, south, east, and north together.");
  }
  return bbox({ west: args.west, south: args.south, east: args.east, north: args.north });
}

function bboxRecord(box: Bbox): Record<string, number> {
  return { west: box.west, south: box.south, east: box.east, north: box.north };
}

function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function collectPositions(
  value: unknown,
  out: Array<{ latitude: number; longitude: number }>,
): void {
  if (out.length >= MAX_GEOMETRY_POINTS || !isUnknownArray(value)) return;
  const first = value[0];
  const second = value[1];
  if (typeof first === "number" && typeof second === "number") {
    if (Number.isFinite(first) && Number.isFinite(second)) {
      out.push({ longitude: first, latitude: second });
    }
    return;
  }
  for (const item of value) collectPositions(item, out);
}

function isCalendarDate(value: string): boolean {
  const parts = value.split("-");
  if (parts.length !== 3) return false;
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}
