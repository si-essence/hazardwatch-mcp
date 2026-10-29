import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { loadConfig } from "../src/config.js";
import { createRuntime } from "../src/runtime.js";

const KEY = "Aa1Bb2Cc3Dd4Ee5Ff6Gg7Hh8Ii9Jj0Kk";

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

describe("HttpClient", () => {
  it("caches a FIRMS body and keeps the map key out of the cache key's observable errors", async () => {
    const fetchImpl = vi.fn<typeof fetch>((input, init) => {
      const url = requestUrl(input);
      expect(url).toContain(KEY);
      expect(new Headers(init?.headers).get("x-api-key")).toBeNull();
      return Promise.resolve(new Response("latitude,longitude\n1,2\n", { status: 200 }));
    });
    const runtime = createRuntime(
      loadConfig({ FIRMS_MAP_KEY: KEY, HAZARDWATCH_CACHE_TTL_SEC: "30" }, []),
      { fetchImpl },
    );
    const first = await runtime.firms.getText({
      path: `api/area/csv/${KEY}/VIIRS_NOAA21_NRT/0,0,1,1/1`,
      query: undefined,
      ttlSec: 30,
      cost: 2,
    });
    const second = await runtime.firms.getText({
      path: `api/area/csv/${KEY}/VIIRS_NOAA21_NRT/0,0,1,1/1`,
      query: undefined,
      ttlSec: 30,
      cost: 2,
    });
    expect(first).toBe(second);
    expect(first).not.toContain(KEY);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("refuses to put the map key in the query string", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const runtime = createRuntime(loadConfig({ FIRMS_MAP_KEY: KEY }, []), { fetchImpl });
    await expect(
      runtime.firms.getText({
        path: "api/area/csv/world",
        query: { key: KEY },
        ttlSec: 0,
      }),
    ).rejects.toThrow(/Refusing to place a secret/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails closed when the FIRMS key is missing and still calls EONET", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(Response.json({ categories: [] })),
    );
    const runtime = createRuntime(loadConfig({}, []), { fetchImpl });
    await expect(
      runtime.firms.getText({ path: "api/area/csv/no-key", query: undefined, ttlSec: 0 }),
    ).rejects.toMatchObject({ code: "config" });
    const categories = await runtime.eonet.getJson(
      { path: "categories", query: undefined, ttlSec: 0 },
      z.object({ categories: z.array(z.unknown()) }),
    );
    expect(categories.categories).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const header = new Headers(fetchImpl.mock.calls[0]?.[1]?.headers).get("x-api-key");
    expect(header).toBeNull();
  });

  it("maps timeout, not found, and too many requests", async () => {
    const timeout = new Error("timed out");
    timeout.name = "TimeoutError";
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(timeout)
      .mockResolvedValueOnce(new Response("missing", { status: 404 }))
      .mockResolvedValueOnce(
        new Response("slow", { status: 429, headers: { "retry-after": "9" } }),
      );
    const runtime = createRuntime(loadConfig({}, []), { fetchImpl });
    await expect(
      runtime.eonet.getJson({ path: "events", query: undefined, ttlSec: 0 }, z.object({})),
    ).rejects.toMatchObject({ code: "timeout" });
    await expect(
      runtime.eonet.getJson({ path: "events/missing", query: undefined, ttlSec: 0 }, z.object({})),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      runtime.eonet.getJson({ path: "events/again", query: undefined, ttlSec: 0 }, z.object({})),
    ).rejects.toMatchObject({ code: "rate_limit", retryAfterSeconds: 9 });
  });
});
