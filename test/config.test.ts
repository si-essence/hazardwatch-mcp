import { describe, expect, it } from "vitest";
import { CONNECTOR_NAME, CONNECTOR_VERSION, EONET_ORIGIN, FIRMS_ORIGIN } from "../src/constants.js";
import { loadConfig } from "../src/config.js";
import { ConnectorError } from "../src/errors.js";

const KEY = "Aa1Bb2Cc3Dd4Ee5Ff6Gg7Hh8Ii9Jj0Kk";

function messageOf(error: unknown): string {
  expect(error).toBeInstanceOf(ConnectorError);
  if (!(error instanceof ConnectorError)) throw error;
  return error.message;
}

describe("loadConfig", () => {
  it("applies defaults and leaves the FIRMS key unset", () => {
    const config = loadConfig({}, []);
    expect(config.firmsMapKey).toBeUndefined();
    expect(config.firmsBaseUrl).toBe(FIRMS_ORIGIN);
    expect(config.eonetBaseUrl).toBe(EONET_ORIGIN);
    expect(config.firmsTransactionsPer10Min).toBe(5000);
    expect(config.eonetPerMinute).toBe(30);
    expect(config.timeoutMs).toBe(20_000);
    expect(config.contact).toBe("contact@example.com");
    expect(config.transport).toBe("stdio");
    expect(config.port).toBe(3000);
    expect(config.cacheTtlSec).toBe(60);
    expect(config.userAgent).toBe(`${CONNECTOR_NAME}/${CONNECTOR_VERSION} (contact@example.com)`);
  });

  it("lets --http override the transport", () => {
    expect(loadConfig({ MCP_TRANSPORT: "stdio" }, ["node", "app", "--http"]).transport).toBe("http");
    expect(loadConfig({ MCP_TRANSPORT: "http" }, []).transport).toBe("http");
  });

  it("reports invalid fields without the rejected value or the map key", () => {
    const message = messageOf(
      catchError(() => loadConfig({ FIRMS_MAP_KEY: KEY, PORT: "nope", MCP_TRANSPORT: "sse" }, [])),
    );
    expect(message).toContain("PORT");
    expect(message).toContain("MCP_TRANSPORT");
    expect(message).not.toContain(KEY);
    expect(message).not.toContain("nope");
    expect(message).not.toContain("sse");
  });

  it("rejects a short or non-alphanumeric map key without echoing it", () => {
    const short = messageOf(catchError(() => loadConfig({ FIRMS_MAP_KEY: "short" }, [])));
    expect(short).toContain("FIRMS_MAP_KEY");
    expect(short).not.toContain("short");

    const messy = "super-secret/key+value=99";
    const special = messageOf(catchError(() => loadConfig({ FIRMS_MAP_KEY: messy }, [])));
    expect(special).toContain("FIRMS_MAP_KEY");
    expect(special).not.toContain(messy);
    expect(special).not.toContain("secret");
  });

  it("rejects a base url or contact that contains the map key", () => {
    const inUrl = messageOf(
      catchError(() =>
        loadConfig({ FIRMS_MAP_KEY: KEY, FIRMS_BASE_URL: `https://example.invalid/${KEY}` }, []),
      ),
    );
    expect(inUrl).toContain("contains_secret");
    expect(inUrl).not.toContain(KEY);

    const inContact = messageOf(
      catchError(() => loadConfig({ FIRMS_MAP_KEY: KEY, HAZARDWATCH_CONTACT: KEY }, [])),
    );
    expect(inContact).toContain("HAZARDWATCH_CONTACT");
    expect(inContact).not.toContain(KEY);
  });

  it("rejects userinfo and query strings on the base url", () => {
    const userinfo = messageOf(
      catchError(() => loadConfig({ FIRMS_BASE_URL: "https://user:pass@example.invalid" }, [])),
    );
    expect(userinfo).toContain("userinfo");
    expect(userinfo).not.toContain("pass");

    const query = messageOf(
      catchError(() =>
        loadConfig({ EONET_BASE_URL: `https://example.invalid/v3?api_key=${KEY}` }, []),
      ),
    );
    expect(query).toContain("EONET_BASE_URL");
    expect(query).not.toContain(KEY);
  });

  it("rejects a transaction budget above the published 5000", () => {
    const message = messageOf(
      catchError(() => loadConfig({ FIRMS_TRANSACTIONS_PER_10_MIN: "5001" }, [])),
    );
    expect(message).toContain("FIRMS_TRANSACTIONS_PER_10_MIN");
    expect(message).not.toContain("5001");
  });
});

function catchError(fn: () => unknown): unknown {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error;
  }
}
