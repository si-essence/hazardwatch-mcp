import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { CONNECTOR_NAME, FIRMS_KEY_HINT, SAFETY_CAVEAT } from "../src/constants.js";
import { loadConfig } from "../src/config.js";
import { bboxAround, distanceKm } from "../src/geo.js";
import { createRuntime } from "../src/runtime.js";
import { TOOL_NAMES } from "../src/server.js";
import { connectServer } from "./mcp.js";
import { readToolText } from "./result.js";

const KEY = "Aa1Bb2Cc3Dd4Ee5Ff6Gg7Hh8Ii9Jj0Kk";

const CSV = [
  "latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight",
  "35.01,-111.65,320.1,0.4,0.4,2026-10-16,1230,N21,VIIRS,nominal,2.0NRT,290.1,12.5,D",
  "35.20,-111.40,300.0,0.4,0.4,2026-10-16,1240,N21,VIIRS,high,2.0NRT,280.0,4.0,N",
].join("\n");

const NEAR_EVENT = {
  id: "EONET_25310",
  title: "Prescribed Fire Newman Piles RX",
  description: null,
  link: "https://eonet.gsfc.nasa.gov/api/v3/events/EONET_25310",
  closed: null,
  categories: [{ id: "wildfires", title: "Wildfires" }],
  sources: [{ id: "IRWIN", url: "https://irwin.doi.gov/observer/incidents/example" }],
  geometry: [
    {
      magnitudeValue: 751,
      magnitudeUnit: "acres",
      date: "2026-10-14T10:42:00Z",
      type: "Point",
      coordinates: [-111.65, 35.016667],
    },
  ],
};

const FAR_EVENT = {
  ...NEAR_EVENT,
  id: "EONET_99999",
  title: "Far away storm",
  categories: [{ id: "severeStorms", title: "Severe Storms" }],
  geometry: [
    {
      magnitudeValue: null,
      magnitudeUnit: null,
      date: "2026-10-14T00:00:00Z",
      type: "Point",
      coordinates: [10, 10],
    },
  ],
};

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function runtimeFor(fetchImpl: typeof fetch, env: NodeJS.ProcessEnv = {}, now?: () => number) {
  return createRuntime(
    loadConfig({ FIRMS_MAP_KEY: KEY, HAZARDWATCH_CACHE_TTL_SEC: "60", ...env }, []),
    { fetchImpl, ...(now === undefined ? {} : { now }) },
  );
}

async function call(
  runtime: ReturnType<typeof createRuntime>,
  name: string,
  args: Record<string, unknown> = {},
) {
  const { client, close } = await connectServer(runtime);
  try {
    return readToolText(await client.callTool({ name, arguments: args }));
  } finally {
    await close();
  }
}

describe("hazardwatch tools", () => {
  it("publishes the six tools and keeps the package name", async () => {
    const runtime = createRuntime(loadConfig({}, []));
    const { client, close } = await connectServer(runtime);
    try {
      const listed = await client.listTools();
      const names = listed.tools.map((tool) => tool.name);
      expect(names).toHaveLength(TOOL_NAMES.length);
      expect(new Set(names)).toEqual(new Set(TOOL_NAMES));
      for (const tool of listed.tools) {
        expect((tool.description ?? "").length).toBeGreaterThan(20);
        expect(tool.inputSchema).toBeTypeOf("object");
      }
      const nearby = listed.tools.find((tool) => tool.name === "nearby_hazards");
      expect(nearby?.description).toContain("caps both the events and the hotspots");
      expect(nearby?.description).toContain("nearest");
    } finally {
      await close();
    }
    const pkg = z
      .object({ name: z.string() })
      .parse(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")));
    expect(pkg.name).toBe(CONNECTOR_NAME);
  });

  it("reads the attribution the README has to carry", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    expect(readme).toContain("Creative Commons Zero (CC0)");
    expect(readme).toContain("No NASA endorsement is implied");
    expect(readme).toContain("https://firms.modaps.eosdis.nasa.gov/api/map_key/");
    expect(readme).toContain("https://www.earthdata.nasa.gov/data/projects/lance/disclaimer");
    expect(readme).toContain("https://eonet.gsfc.nasa.gov/what-is-eonet");
    expect(readme).toContain("not available");
    expect(readme).toContain("1 to 5");
    expect(readme.toLowerCase()).not.toContain("meatball");
  });

  it("queries FIRMS by point, returns hotspots, and caches the CSV", async () => {
    const fetchImpl = vi.fn<typeof fetch>((input, init) => {
      const url = new URL(requestUrl(input));
      expect(url.pathname).toContain(`/api/area/csv/${KEY}/VIIRS_NOAA21_NRT/`);
      expect(url.pathname.endsWith("/1")).toBe(true);
      const area = url.pathname.split("/")[6] ?? "";
      const [west, south, east, north] = area.split(",").map(Number);
      expect(west).toBeLessThan(-111);
      expect(east).toBeGreaterThan(-111);
      expect(south).toBeLessThan(35);
      expect(north).toBeGreaterThan(35);
      expect(new Headers(init?.headers).get("user-agent")).toContain("hazardwatch/");
      return Promise.resolve(new Response(CSV, { status: 200 }));
    });
    const runtime = runtimeFor(fetchImpl);
    const first = await call(runtime, "fires_near", {
      latitude: 35,
      longitude: -111,
      radius_km: 70,
    });
    const second = await call(runtime, "fires_near", {
      latitude: 35,
      longitude: -111,
      radius_km: 70,
    });
    expect(first.isError).toBe(false);
    expect(second.text).toBe(first.text);
    const body = z
      .object({
        provider: z.literal("NASA FIRMS"),
        sensor: z.literal("VIIRS_NOAA21_NRT"),
        area: z.literal("point"),
        count: z.literal(2),
        bbox_count: z.literal(2),
        truncated: z.literal(false),
        hotspots: z.array(
          z.object({
            latitude: z.number(),
            longitude: z.number(),
            confidence: z.string(),
            frp: z.number(),
            brightness: z.number(),
            acq_time: z.string(),
            acquired_at: z.string(),
            distance_km: z.number(),
          }),
        ),
        caveat: z.literal(SAFETY_CAVEAT),
      })
      .parse(JSON.parse(first.text));
    expect(body.hotspots[0]?.confidence).toBe("high");
    expect(body.hotspots[0]?.frp).toBe(4);
    expect(body.hotspots[0]?.distance_km).toBe(42.6);
    expect(body.hotspots[0]?.acq_time).toBe("1240");
    expect(body.hotspots[0]?.acquired_at).toBe("2026-10-16T12:40:00Z");
    expect(body.hotspots[1]?.confidence).toBe("nominal");
    expect(body.hotspots[1]?.distance_km).toBe(59.2);
    expect(first.text).not.toContain(KEY);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("sends an explicit bbox and a date, and uses world for the full globe", async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>((input) => {
      urls.push(requestUrl(input));
      return Promise.resolve(new Response("latitude,longitude\n", { status: 200 }));
    });
    const runtime = runtimeFor(fetchImpl, { HAZARDWATCH_CACHE_TTL_SEC: "0" });
    const box = await call(runtime, "fires_near", {
      west: -10,
      south: 20,
      east: 10,
      north: 40,
      day_range: 2,
      source: "MODIS_NRT",
      date: "2026-10-01",
    });
    const world = await call(runtime, "fires_near", {
      west: -180,
      south: -90,
      east: 180,
      north: 90,
      source: "VIIRS_NOAA20_NRT",
    });
    expect(box.isError).toBe(false);
    expect(world.isError).toBe(false);
    expect(urls[0]).toContain("/MODIS_NRT/-10,20,10,40/2/2026-10-01");
    expect(urls[1]).toContain("/VIIRS_NOAA20_NRT/world/1");
    const worldBody = z.object({ area: z.literal("world") }).parse(JSON.parse(world.text));
    expect(worldBody.area).toBe("world");
  });

  it("rejects mixed geometry, a day range outside 1 to 5, and a wrapping bbox without calling FIRMS", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const runtime = runtimeFor(fetchImpl);
    const mixed = await call(runtime, "fires_near", {
      latitude: 1,
      longitude: 2,
      radius_km: 3,
      west: 0,
      south: 0,
      east: 1,
      north: 1,
    });
    const days = await call(runtime, "fires_near", {
      latitude: 1,
      longitude: 2,
      radius_km: 3,
      day_range: 10,
    });
    const wrap = await call(runtime, "fires_near", { west: 10, south: 0, east: -10, north: 1 });
    const empty = await call(runtime, "fires_near", {});
    expect(mixed.isError).toBe(true);
    expect(mixed.text).toContain("[input]");
    expect(days.isError).toBe(true);
    expect(days.text).toContain("day_range must be an integer from 1 to 5");
    expect(wrap.text).toContain("[input]");
    expect(empty.text).toContain("[input]");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("explains a missing FIRMS key and still lists EONET categories", async () => {
    const fetchImpl = vi.fn<typeof fetch>((input) => {
      const url = requestUrl(input);
      expect(url).not.toContain("map_key");
      if (url.includes("/categories")) {
        return Promise.resolve(
          Response.json({
            categories: [
              {
                id: "wildfires",
                title: "Wildfires",
                description: "Active fires",
                link: "https://eonet.gsfc.nasa.gov/api/v3/categories/wildfires",
              },
            ],
          }),
        );
      }
      return Promise.resolve(new Response("unexpected", { status: 500 }));
    });
    const runtime = createRuntime(loadConfig({}, []), { fetchImpl });
    const fires = await call(runtime, "fires_near", { latitude: 1, longitude: 2, radius_km: 5 });
    const country = await call(runtime, "fires_by_country", { country: "USA" });
    const categories = await call(runtime, "eonet_categories");
    expect(fires.isError).toBe(true);
    expect(fires.text).toContain("[config]");
    expect(fires.text).toContain(FIRMS_KEY_HINT);
    expect(country.text).toContain("[config]");
    expect(categories.isError).toBe(false);
    const body = z
      .object({
        count: z.literal(1),
        categories: z.array(z.object({ id: z.literal("wildfires") })),
      })
      .parse(JSON.parse(categories.text));
    expect(body.count).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("calls the country endpoint and explains the live outage", async () => {
    const fetchImpl = vi.fn<typeof fetch>((input) => {
      const url = requestUrl(input);
      if (url.includes("/api/country/csv/")) {
        expect(url).toContain("/USA/1");
        return Promise.resolve(new Response("Invalid API call.", { status: 400 }));
      }
      return Promise.resolve(new Response("no", { status: 500 }));
    });
    const runtime = runtimeFor(fetchImpl);
    const result = await call(runtime, "fires_by_country", { country: "usa" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("[upstream]");
    expect(result.text).toContain("not available");
    expect(result.text).not.toContain(KEY);
  });

  it("returns country hotspots when FIRMS sends CSV", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(CSV, { status: 200 })),
    );
    const runtime = runtimeFor(fetchImpl);
    const result = await call(runtime, "fires_by_country", {
      country: "CAN",
      source: "VIIRS_NOAA21_NRT",
      day_range: 1,
    });
    expect(result.isError).toBe(false);
    const body = z
      .object({ area: z.literal("country"), country: z.literal("CAN"), count: z.literal(2) })
      .parse(JSON.parse(result.text));
    expect(body.country).toBe("CAN");
  });

  it("filters EONET events and translates the bbox order", async () => {
    const fetchImpl = vi.fn<typeof fetch>((input) => {
      const url = new URL(requestUrl(input));
      expect(url.pathname.endsWith("/events")).toBe(true);
      expect(url.searchParams.get("status")).toBe("open");
      expect(url.searchParams.get("category")).toBe("wildfires");
      expect(url.searchParams.get("limit")).toBe("5");
      expect(url.searchParams.get("bbox")).toBe("-10,40,10,20");
      expect(url.searchParams.get("start")).toBe("2026-10-01");
      return Promise.resolve(
        Response.json({ events: [NEAR_EVENT, { ...FAR_EVENT, id: "EONET_1", title: "Other" }] }),
      );
    });
    const runtime = runtimeFor(fetchImpl);
    const result = await call(runtime, "eonet_events", {
      category: "wildfires",
      status: "open",
      limit: 5,
      start: "2026-10-01",
      end: "2026-10-15",
      west: -10,
      south: 20,
      east: 10,
      north: 40,
    });
    expect(result.isError).toBe(false);
    const body = z
      .object({
        count: z.literal(2),
        events: z.array(
          z.object({ id: z.string(), sources: z.array(z.object({ url: z.string() })) }),
        ),
      })
      .parse(JSON.parse(result.text));
    expect(body.events[0]?.sources[0]?.url).toContain("irwin.doi.gov");
  });

  it("rejects a partial bbox and an end date before the start", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const runtime = runtimeFor(fetchImpl);
    const partial = await call(runtime, "eonet_events", { west: -10, south: 0 });
    const order = await call(runtime, "eonet_events", { start: "2026-10-10", end: "2026-10-01" });
    expect(partial.text).toContain("west, south, east, and north");
    expect(order.text).toContain("end must be on or after start");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("loads one EONET event and reports a missing id", async () => {
    const fetchImpl = vi.fn<typeof fetch>((input) => {
      const url = requestUrl(input);
      expect(url).toContain("/events/EONET_25310");
      return Promise.resolve(Response.json(NEAR_EVENT));
    });
    const runtime = runtimeFor(fetchImpl);
    const found = await call(runtime, "eonet_event", { id: "EONET_25310" });
    expect(found.isError).toBe(false);
    expect(JSON.parse(found.text)).toMatchObject({
      id: "EONET_25310",
      geometry_count: 1,
      geometries: [{ magnitude_value: 751, magnitude_unit: "acres" }],
    });

    const missingFetch = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response("not found", { status: 404 })),
    );
    const missing = await call(runtimeFor(missingFetch), "eonet_event", { id: "EONET_0" });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain("[not-found]");
  });

  it("returns nearby EONET events when the FIRMS key is missing", async () => {
    const fetchImpl = vi.fn<typeof fetch>((input) => {
      const url = new URL(requestUrl(input));
      expect(url.pathname).toContain("/events");
      expect(url.searchParams.get("status")).toBe("open");
      return Promise.resolve(Response.json({ events: [NEAR_EVENT, FAR_EVENT] }));
    });
    const runtime = createRuntime(loadConfig({}, []), { fetchImpl });
    const result = await call(runtime, "nearby_hazards", {
      latitude: 35.016667,
      longitude: -111.65,
      radius_km: 30,
    });
    expect(result.isError).toBe(false);
    const body = z
      .object({
        firms: z.null(),
        firms_note: z.string(),
        events_count: z.literal(1),
        events: z.array(z.object({ id: z.literal("EONET_25310") })),
        caveat: z.literal(SAFETY_CAVEAT),
      })
      .parse(JSON.parse(result.text));
    expect(body.firms_note).toContain("FIRMS_MAP_KEY is not set");
    expect(result.text).not.toContain("EONET_99999");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("combines FIRMS and EONET for a nearby query and drops the far event", async () => {
    const fetchImpl = vi.fn<typeof fetch>((input) => {
      const url = requestUrl(input);
      if (url.includes("/api/area/csv/")) {
        return Promise.resolve(new Response(CSV, { status: 200 }));
      }
      return Promise.resolve(Response.json({ events: [NEAR_EVENT, FAR_EVENT] }));
    });
    const runtime = runtimeFor(fetchImpl);
    const result = await call(runtime, "nearby_hazards", {
      latitude: 35.01,
      longitude: -111.65,
      radius_km: 40,
      source: "VIIRS_NOAA21_NRT",
    });
    expect(result.isError).toBe(false);
    const body = z
      .object({
        firms: z.object({ count: z.literal(2) }),
        firms_note: z.null(),
        events_count: z.literal(1),
        events_note: z.null(),
      })
      .parse(JSON.parse(result.text));
    expect(body.events_count).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("keeps EONET results when FIRMS answers HTTP 429", async () => {
    const fetchImpl = vi.fn<typeof fetch>((input) => {
      const url = requestUrl(input);
      if (url.includes("firms")) {
        return Promise.resolve(
          new Response("slow down", { status: 429, headers: { "retry-after": "12" } }),
        );
      }
      return Promise.resolve(Response.json({ events: [NEAR_EVENT] }));
    });
    const runtime = runtimeFor(fetchImpl);
    const result = await call(runtime, "nearby_hazards", {
      latitude: 35.016667,
      longitude: -111.65,
      radius_km: 30,
    });
    expect(result.isError).toBe(false);
    const body = z
      .object({ firms: z.null(), firms_note: z.string(), events_count: z.literal(1) })
      .parse(JSON.parse(result.text));
    expect(body.firms_note).toContain("[rate-limit]");
  });

  it("serves a cached FIRMS lookup after the local transaction window is full", async () => {
    let now = 0;
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response("latitude,longitude\n1,2\n", { status: 200 })),
    );
    const runtime = runtimeFor(fetchImpl, { FIRMS_TRANSACTIONS_PER_10_MIN: "2" }, () => now);
    const first = await call(runtime, "fires_near", { west: 0, south: 0, east: 1, north: 1 });
    const cached = await call(runtime, "fires_near", { west: 0, south: 0, east: 1, north: 1 });
    const blocked = await call(runtime, "fires_near", { west: 2, south: 0, east: 3, north: 1 });
    expect(first.isError).toBe(false);
    expect(cached.isError).toBe(false);
    expect(blocked.isError).toBe(true);
    expect(blocked.text).toContain("[rate-limit]");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    now = 600_000;
    const later = await call(runtime, "fires_near", { west: 2, south: 0, east: 3, north: 1 });
    expect(later.isError).toBe(false);
  });

  it("normalizes unpadded FIRMS acq_time and leaves acquired_at null when the clock or date is invalid", async () => {
    const viirs = [
      "latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight",
      "11.80744,14.07654,322.53,0.52,0.5,2026-10-17,7,N21,VIIRS,n,2.0NRT,294.38,3.21,N",
      "11.81000,14.08000,321.00,0.52,0.5,2026-10-16,848,N21,VIIRS,n,2.0NRT,293.00,2.50,D",
      "11.82000,14.09000,320.00,0.52,0.5,2026-10-17,0,N21,VIIRS,n,2.0NRT,290.00,1.00,N",
      "11.83000,14.10000,320.00,0.52,0.5,2026-10-17,2400,N21,VIIRS,n,2.0NRT,290.00,1.00,N",
      "11.84000,14.11000,320.00,0.52,0.5,2026-10-17,1660,N21,VIIRS,n,2.0NRT,290.00,1.00,N",
      "11.85000,14.12000,320.00,0.52,0.5,,1230,N21,VIIRS,n,2.0NRT,290.00,1.00,N",
      "11.86000,14.13000,320.00,0.52,0.5,2026-02-31,1230,N21,VIIRS,n,2.0NRT,290.00,1.00,N",
      "11.87000,14.14000,320.00,0.52,0.5,2026-10-17,,N21,VIIRS,n,2.0NRT,290.00,1.00,N",
      "11.88000,14.15000,320.00,0.52,0.5,2026-10-17,7am,N21,VIIRS,n,2.0NRT,290.00,1.00,N",
    ].join("\n");
    const modis = [
      "latitude,longitude,brightness,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_t31,frp,daynight",
      "13.60064,5.15958,307.97,1.22,1.1,2026-10-17,345,Aqua,MODIS,73,6.1NRT,294.49,10.26,N",
    ].join("\n");
    const fetchImpl = vi.fn<typeof fetch>((input) => {
      const url = requestUrl(input);
      const body = url.includes("/MODIS_NRT/") ? modis : viirs;
      return Promise.resolve(new Response(body, { status: 200 }));
    });
    const runtime = runtimeFor(fetchImpl, { HAZARDWATCH_CACHE_TTL_SEC: "0" });
    const viirsResult = await call(runtime, "fires_near", {
      west: 0,
      south: 0,
      east: 20,
      north: 20,
    });
    const modisResult = await call(runtime, "fires_near", {
      west: 0,
      south: 0,
      east: 20,
      north: 20,
      source: "MODIS_NRT",
    });
    expect(viirsResult.isError).toBe(false);
    expect(modisResult.isError).toBe(false);
    const viirsRaw: unknown = JSON.parse(viirsResult.text);
    expect(viirsRaw).not.toHaveProperty("bbox_count");
    const parsed = z
      .object({
        area: z.literal("bbox"),
        hotspots: z.array(
          z.looseObject({
            latitude: z.number(),
            acq_date: z.string().nullable(),
            acq_time: z.string().nullable(),
            acquired_at: z.string().nullable(),
            brightness: z.number(),
            confidence: z.string(),
          }),
        ),
      })
      .parse(viirsRaw);
    const byLat = new Map(parsed.hotspots.map((hotspot) => [hotspot.latitude, hotspot]));
    expect(byLat.get(11.80744)).toMatchObject({
      acq_time: "0007",
      acquired_at: "2026-10-17T00:07:00Z",
      brightness: 322.53,
      confidence: "n",
    });
    expect(byLat.get(11.81)).toMatchObject({
      acq_time: "0848",
      acquired_at: "2026-10-16T08:48:00Z",
    });
    expect(byLat.get(11.82)).toMatchObject({
      acq_time: "0000",
      acquired_at: "2026-10-17T00:00:00Z",
    });
    expect(byLat.get(11.83)).toMatchObject({ acq_time: null, acquired_at: null });
    expect(byLat.get(11.84)).toMatchObject({ acq_time: null, acquired_at: null });
    expect(byLat.get(11.85)).toMatchObject({
      acq_date: null,
      acq_time: "1230",
      acquired_at: null,
    });
    expect(byLat.get(11.86)).toMatchObject({
      acq_date: "2026-02-31",
      acq_time: "1230",
      acquired_at: null,
    });
    expect(byLat.get(11.87)).toMatchObject({ acq_time: null, acquired_at: null });
    expect(byLat.get(11.88)).toMatchObject({ acq_time: null, acquired_at: null });
    expect(viirsResult.text).not.toContain('"acq_time":"7"');
    expect(viirsResult.text).not.toContain('"acq_time":"848"');
    for (const hotspot of parsed.hotspots) {
      expect(hotspot).not.toHaveProperty("distance_km");
    }

    const modisBody = z
      .object({
        hotspots: z.array(
          z.object({
            latitude: z.number(),
            brightness: z.number(),
            confidence: z.string(),
            frp: z.number(),
            acq_time: z.string(),
            acquired_at: z.string(),
          }),
        ),
      })
      .parse(JSON.parse(modisResult.text));
    expect(modisBody.hotspots[0]).toMatchObject({
      latitude: 13.60064,
      brightness: 307.97,
      confidence: "73",
      frp: 10.26,
      acq_time: "0345",
      acquired_at: "2026-10-17T03:45:00Z",
    });
    expect(modisResult.text).not.toContain('"acq_time":"345"');
  });

  it("keeps point hotspots inside the radius, sorts nearest first, and leaves bbox order unchanged", async () => {
    const csv = [
      "latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight",
      "0.9,0.89,300,0.4,0.4,2026-10-17,7,N21,VIIRS,n,2.0NRT,290,1,N",
      "0,0.5,310,0.4,0.4,2026-10-17,848,N21,VIIRS,n,2.0NRT,290,2,D",
      "0,0,320,0.4,0.4,2026-10-17,1230,N21,VIIRS,high,2.0NRT,290,3,D",
    ].join("\n");
    const square = bboxAround(0, 0, 100);
    expect(0.9).toBeLessThanOrEqual(square.north);
    expect(0.89).toBeLessThanOrEqual(square.east);
    expect(distanceKm(0, 0, 0.9, 0.89)).toBeGreaterThan(100);
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(csv, { status: 200 })),
    );
    const runtime = runtimeFor(fetchImpl, { HAZARDWATCH_CACHE_TTL_SEC: "0" });
    const point = await call(runtime, "fires_near", { latitude: 0, longitude: 0, radius_km: 100 });
    const box = await call(runtime, "fires_near", { west: -2, south: -2, east: 2, north: 2 });
    expect(point.isError).toBe(false);
    expect(box.isError).toBe(false);
    const pointBody = z
      .object({
        area: z.literal("point"),
        count: z.literal(2),
        bbox_count: z.literal(3),
        returned: z.literal(2),
        truncated: z.literal(false),
        hotspots: z.array(
          z.object({
            latitude: z.number(),
            longitude: z.number(),
            distance_km: z.number(),
            acq_time: z.string(),
          }),
        ),
      })
      .parse(JSON.parse(point.text));
    expect(pointBody.hotspots.map((hotspot) => hotspot.latitude)).toEqual([0, 0]);
    expect(pointBody.hotspots.map((hotspot) => hotspot.longitude)).toEqual([0, 0.5]);
    expect(pointBody.hotspots.map((hotspot) => hotspot.distance_km)).toEqual([0, 55.6]);
    expect(pointBody.hotspots.map((hotspot) => hotspot.acq_time)).toEqual(["1230", "0848"]);

    const boxRaw: unknown = JSON.parse(box.text);
    expect(boxRaw).not.toHaveProperty("bbox_count");
    const boxBody = z
      .object({
        area: z.literal("bbox"),
        count: z.literal(3),
        hotspots: z.array(z.looseObject({ latitude: z.number(), longitude: z.number() })),
      })
      .parse(boxRaw);
    expect(boxBody.hotspots.map((hotspot) => [hotspot.latitude, hotspot.longitude])).toEqual([
      [0.9, 0.89],
      [0, 0.5],
      [0, 0],
    ]);
    for (const hotspot of boxBody.hotspots) {
      expect(hotspot).not.toHaveProperty("distance_km");
    }
  });

  it("returns the nearest hotspots when a point query is longer than the response cap", async () => {
    const header =
      "latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight";
    const far = Array.from(
      { length: 500 },
      () => "10,0,300,0.4,0.4,2026-10-17,1230,N21,VIIRS,n,2.0NRT,290,1,D",
    );
    const csv = [header, ...far, "0,0,320,0.4,0.4,2026-10-17,7,N21,VIIRS,n,2.0NRT,290,9,D"].join(
      "\n",
    );
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(csv, { status: 200 })),
    );
    const runtime = runtimeFor(fetchImpl);
    const result = await call(runtime, "fires_near", {
      latitude: 0,
      longitude: 0,
      radius_km: 2000,
    });
    expect(result.isError).toBe(false);
    const body = z
      .object({
        area: z.literal("point"),
        count: z.literal(501),
        bbox_count: z.literal(501),
        returned: z.literal(500),
        truncated: z.literal(true),
        hotspots: z.array(z.object({ latitude: z.number(), distance_km: z.number() })),
      })
      .parse(JSON.parse(result.text));
    expect(body.hotspots[0]).toEqual({ latitude: 0, distance_km: 0 });
    expect(body.hotspots.some((hotspot) => hotspot.latitude === 10)).toBe(true);
  });

  it("caps nearby_hazards hotspots at limit and keeps returned and truncated consistent", async () => {
    const csv = [
      "latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight",
      "0.5,0,300,0.4,0.4,2026-10-17,848,N21,VIIRS,n,2.0NRT,290,1,D",
      "0.2,0,310,0.4,0.4,2026-10-17,7,N21,VIIRS,n,2.0NRT,290,2,D",
      "0,0,320,0.4,0.4,2026-10-17,1230,N21,VIIRS,high,2.0NRT,290,3,D",
    ].join("\n");
    const fetchImpl = vi.fn<typeof fetch>((input) => {
      const url = new URL(requestUrl(input));
      if (url.pathname.includes("/api/area/csv/")) {
        return Promise.resolve(new Response(csv, { status: 200 }));
      }
      expect(url.searchParams.get("limit")).toBe("1");
      return Promise.resolve(Response.json({ events: [NEAR_EVENT, FAR_EVENT] }));
    });
    const runtime = runtimeFor(fetchImpl);
    const result = await call(runtime, "nearby_hazards", {
      latitude: 0,
      longitude: 0,
      radius_km: 200,
      limit: 1,
    });
    expect(result.isError).toBe(false);
    const body = z
      .object({
        firms: z.object({
          area: z.literal("point"),
          count: z.literal(3),
          bbox_count: z.literal(3),
          returned: z.literal(1),
          truncated: z.literal(true),
          hotspots: z.array(
            z.object({
              latitude: z.number(),
              longitude: z.number(),
              distance_km: z.number(),
              confidence: z.string(),
            }),
          ),
        }),
        firms_note: z.null(),
        caveat: z.literal(SAFETY_CAVEAT),
      })
      .parse(JSON.parse(result.text));
    expect(body.firms.hotspots).toEqual([
      { latitude: 0, longitude: 0, distance_km: 0, confidence: "high" },
    ]);
    expect(result.text).not.toContain(KEY);
  });
});
