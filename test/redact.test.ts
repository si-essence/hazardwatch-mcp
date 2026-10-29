import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/log.js";
import { redact, redactUnknown } from "../src/redact.js";
import { createRuntime } from "../src/runtime.js";
import { connectServer } from "./mcp.js";
import { readToolText } from "./result.js";

const KEY = "super-secret/key+value=99";
const MAP_KEY = "Aa1Bb2Cc3Dd4Ee5Ff6Gg7Hh8Ii9Jj0Kk";
const ENCODED = encodeURIComponent(KEY);

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function assertNoKey(label: string, text: string): void {
  expect(text, label).not.toContain(KEY);
  expect(text, label).not.toContain(ENCODED);
}

describe("redact", () => {
  it("strips the secret, its url encoding, query params, and bearer tokens", () => {
    const raw = [
      `key=${KEY}`,
      `encoded=${ENCODED}`,
      `https://upstream.test/lookup?api_key=${KEY}&x=1`,
      `Authorization: Bearer ${KEY}`,
    ].join("\n");
    const cleaned = redact(raw, [KEY]);
    assertNoKey("redact", cleaned);
    expect(cleaned).toContain("api_key=[redacted]");
    expect(cleaned).toContain("Bearer [redacted]");
  });

  it("redacts nested strings and object keys", () => {
    const cleaned = JSON.stringify(redactUnknown({ [KEY]: [{ title: `see ${KEY}` }] }, [KEY]));
    assertNoKey("nested", cleaned);
    expect(cleaned).toContain("[redacted]");
  });

  it("redacts logger lines", () => {
    const lines: string[] = [];
    const logger = createLogger([KEY], (line) => {
      lines.push(line);
    });
    logger.error(`upstream said ${KEY}`);
    assertNoKey("logger", lines.join("\n"));
    expect(lines.join("\n")).toContain("[redacted]");
  });

  it("keeps the map key out of tool output, errors, and logs", async () => {
    const logs: string[] = [];
    const consoleLines: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      consoleLines.push(
        args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "),
      );
    });
    const csv = `latitude,longitude,satellite\n35.0,-111.0,${MAP_KEY}\n`;
    expect(csv).toContain(MAP_KEY);

    let call = 0;
    const fetchImpl = vi.fn<typeof fetch>((input) => {
      const url = requestUrl(input);
      expect(url).toContain(MAP_KEY);
      call += 1;
      if (call === 1) return Promise.resolve(new Response(csv, { status: 200 }));
      return Promise.reject(new Error(`connect failed ${url}`));
    });

    const runtime = createRuntime(
      loadConfig({ FIRMS_MAP_KEY: MAP_KEY, HAZARDWATCH_CACHE_TTL_SEC: "0" }, []),
      {
        fetchImpl,
        logger: createLogger([MAP_KEY], (line) => {
          logs.push(line);
        }),
      },
    );
    const { client, close } = await connectServer(runtime);
    try {
      const ok = readToolText(
        await client.callTool({
          name: "fires_near",
          arguments: { latitude: 35, longitude: -111, radius_km: 20 },
        }),
      );
      const bad = readToolText(
        await client.callTool({
          name: "fires_near",
          arguments: { west: 1, south: 1, east: 2, north: 2 },
        }),
      );
      const invalid = readToolText(
        await client.callTool({
          name: "fires_by_country",
          arguments: { country: MAP_KEY },
        }),
      );

      expect(ok.isError).toBe(false);
      expect(ok.text).toContain("[redacted]");
      expect(ok.text).not.toContain(MAP_KEY);

      expect(bad.isError).toBe(true);
      expect(bad.text).not.toContain(MAP_KEY);
      expect(bad.text).toContain("[url]");

      expect(invalid.isError).toBe(true);
      expect(invalid.text).not.toContain(MAP_KEY);

      expect(logs.length).toBeGreaterThan(0);
      expect(logs.join("\n")).not.toContain(MAP_KEY);
      expect(consoleLines.join("\n")).not.toContain(MAP_KEY);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
      await close();
    }
  });
});
