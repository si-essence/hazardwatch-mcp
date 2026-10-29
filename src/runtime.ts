import { FIRMS_KEY_HINT, FIRMS_TRANSACTION_WINDOW_MS } from "./constants.js";
import type { Config } from "./config.js";
import { TtlCache } from "./cache.js";
import { HttpClient } from "./http.js";
import { createLogger, type Logger } from "./log.js";
import { SlidingWindowLimiter } from "./rate-limit.js";

export interface Runtime {
  config: Config;
  firms: HttpClient;
  eonet: HttpClient;
  secrets: readonly string[];
  logger: Logger;
  cacheTtlSec: number;
}

export interface RuntimeOverrides {
  fetchImpl?: typeof fetch;
  now?: () => number;
  logger?: Logger;
}

export function createRuntime(config: Config, overrides: RuntimeOverrides = {}): Runtime {
  const now = overrides.now ?? Date.now;
  const secrets = config.firmsMapKey === undefined ? [] : [config.firmsMapKey];
  const logger = overrides.logger ?? createLogger(secrets);
  const fetchImpl = overrides.fetchImpl ?? fetch;
  const firms = new HttpClient({
    baseUrl: config.firmsBaseUrl,
    fetchImpl,
    timeoutMs: config.timeoutMs,
    secrets,
    cache: new TtlCache(now),
    limiter: new SlidingWindowLimiter(config.firmsTransactionsPer10Min, FIRMS_TRANSACTION_WINDOW_MS, now),
    userAgent: config.userAgent,
    logger,
    apiKey: config.firmsMapKey,
    label: "FIRMS",
    requireKey: true,
    missingKeyMessage: FIRMS_KEY_HINT,
    accept: "text/csv, text/plain;q=0.9, */*;q=0.8",
  });
  const eonet = new HttpClient({
    baseUrl: config.eonetBaseUrl,
    fetchImpl,
    timeoutMs: config.timeoutMs,
    secrets,
    cache: new TtlCache(now),
    limiter: new SlidingWindowLimiter(config.eonetPerMinute, 60_000, now),
    userAgent: config.userAgent,
    logger,
    apiKey: undefined,
    label: "EONET",
    requireKey: false,
    missingKeyMessage: FIRMS_KEY_HINT,
    accept: "application/json",
  });
  return {
    config,
    firms,
    eonet,
    secrets,
    logger,
    cacheTtlSec: config.cacheTtlSec,
  };
}
