import { z, type ZodType } from "zod";
import type { BaseUrl, Secret } from "./brand.js";
import { TtlCache } from "./cache.js";
import { ConnectorError } from "./errors.js";
import type { Logger } from "./log.js";
import type { RateLimiter } from "./rate-limit.js";
import { redact, redactUnknown, stripUrls } from "./redact.js";

const MAX_BODY = 1_000_000;

export interface JsonGet {
  path: string;
  query: Readonly<Record<string, string | number | boolean>> | undefined;
  ttlSec: number;
  cost?: number;
}

export interface HttpClientOptions {
  baseUrl: BaseUrl;
  fetchImpl: typeof fetch;
  timeoutMs: number;
  secrets: readonly string[];
  cache: TtlCache;
  limiter: RateLimiter;
  userAgent: string;
  logger: Logger;
  apiKey: Secret | undefined;
  label: string;
  requireKey: boolean;
  missingKeyMessage: string;
  accept: string;
}

export class HttpClient {
  private readonly baseUrl: BaseUrl;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly secrets: readonly string[];
  private readonly cache: TtlCache;
  private readonly limiter: RateLimiter;
  private readonly userAgent: string;
  private readonly logger: Logger;
  private readonly apiKey: Secret | undefined;
  private readonly label: string;
  private readonly requireKey: boolean;
  private readonly missingKeyMessage: string;
  private readonly acceptHeader: string;

  constructor(options: HttpClientOptions) {
    this.baseUrl = options.baseUrl;
    this.fetchImpl = options.fetchImpl;
    this.timeoutMs = options.timeoutMs;
    this.secrets = options.secrets;
    this.cache = options.cache;
    this.limiter = options.limiter;
    this.userAgent = options.userAgent;
    this.logger = options.logger;
    this.apiKey = options.apiKey;
    this.label = options.label;
    this.requireKey = options.requireKey;
    this.missingKeyMessage = options.missingKeyMessage;
    this.acceptHeader = options.accept;
  }

  async getJson<T>(request: JsonGet, schema: ZodType<T>): Promise<T> {
    return this.fetchParsed(request, schema, (text, status) => {
      if (isHtml(text)) {
        throw new ConnectorError(
          "upstream",
          `${this.label} HTTP ${status}: the service returned an error page instead of JSON.`,
        );
      }
      return parseJsonBody(text, status, this.label);
    });
  }

  async getText(request: JsonGet): Promise<string> {
    return this.fetchParsed(request, z.string(), (text, status) => {
      if (text.trim().length === 0) {
        throw new ConnectorError("upstream", `${this.label} returned an empty body (HTTP ${status}).`);
      }
      if (isHtml(text)) {
        throw new ConnectorError(
          "upstream",
          `${this.label} HTTP ${status}: the service returned an error page instead of the expected data.`,
        );
      }
      return text;
    });
  }

  private async fetchParsed<T>(
    request: JsonGet,
    schema: ZodType<T>,
    interpret: (text: string, status: number) => unknown,
  ): Promise<T> {
    const url = this.buildUrl(request.path, request.query);
    const cacheKey = `GET ${redact(`${url.origin}${url.pathname}${url.search}`, this.secrets)}`;
    const cached = this.readCache(cacheKey, schema);
    if (cached !== undefined) return cached;
    this.ensureKey();
    this.limiter.acquire(normalizeCost(request.cost));
    const response = await this.send(url);
    const text = await readLimited(response, this.label);
    if (!response.ok) throw this.httpError(response, text);
    return this.accept(cacheKey, request.ttlSec, schema, interpret(text, response.status));
  }

  private ensureKey(): void {
    if (this.requireKey && this.apiKey === undefined) {
      throw new ConnectorError("config", this.missingKeyMessage);
    }
  }

  private readCache<T>(cacheKey: string, schema: ZodType<T>): T | undefined {
    const cached = this.cache.get(cacheKey);
    if (cached === undefined) return undefined;
    const parsed = schema.safeParse(cached);
    if (parsed.success) return parsed.data;
    this.cache.delete(cacheKey);
    return undefined;
  }

  private accept<T>(cacheKey: string, ttlSec: number, schema: ZodType<T>, json: unknown): T {
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new ConnectorError("upstream", `${this.label} response did not match the expected shape.`);
    }
    const safe = schema.safeParse(redactUnknown(parsed.data, this.secrets));
    if (!safe.success) {
      throw new ConnectorError("upstream", `${this.label} response could not be returned safely.`);
    }
    if (ttlSec > 0) this.cache.set(cacheKey, safe.data, ttlSec);
    return safe.data;
  }

  private buildUrl(
    path: string,
    query: Readonly<Record<string, string | number | boolean>> | undefined,
  ): URL {
    if (
      path.length === 0 ||
      path.startsWith("/") ||
      path.includes("?") ||
      path.includes("#") ||
      path.includes("\\") ||
      path.includes("..")
    ) {
      throw new ConnectorError("input", "Request path must be a relative path.");
    }
    const base = new URL(`${this.baseUrl}/`);
    const url = new URL(path, base);
    if (url.origin !== base.origin) {
      throw new ConnectorError("input", "Request path must stay on the configured base URL.");
    }
    if (query !== undefined) {
      for (const key of Object.keys(query).sort()) {
        const value = query[key];
        if (value === undefined) continue;
        const text = String(value);
        this.assertNoSecret(text);
        url.searchParams.set(key, text);
      }
    }
    return url;
  }

  private assertNoSecret(value: string): void {
    for (const secret of this.secrets) {
      if (
        secret.length >= 8 &&
        (value.includes(secret) || value.includes(encodeURIComponent(secret)))
      ) {
        this.logger.error("Refusing to place a secret in the request URL.");
        throw new ConnectorError("config", "Refusing to place a secret in the request URL.");
      }
    }
  }

  private async send(url: URL): Promise<Response> {
    const headers = new Headers();
    headers.set("accept", this.acceptHeader);
    headers.set("user-agent", this.userAgent);
    try {
      return await this.fetchImpl(url, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
      const name = error instanceof Error ? error.name : "";
      if (name === "TimeoutError" || name === "AbortError") {
        const seconds = Math.max(1, Math.round(this.timeoutMs / 1000));
        throw new ConnectorError("timeout", `${this.label} request timed out after ${seconds}s.`);
      }
      const raw = error instanceof Error ? error.message : "network error";
      const safe = publicSnippet(raw, this.secrets);
      this.logger.error(`${this.label} request failed: ${safe}`);
      throw new ConnectorError("upstream", `${this.label} request failed: ${safe}`);
    }
  }

  private httpError(response: Response, text: string): ConnectorError {
    const snippet = publicSnippet(text, this.secrets);
    const detail = snippet.length > 0 ? `: ${snippet}` : "";
    if (response.status === 404) {
      return new ConnectorError("not_found", `${this.label} HTTP 404${detail}`);
    }
    if (response.status === 429) {
      return new ConnectorError(
        "rate_limit",
        `${this.label} HTTP 429${detail}`,
        retryAfterSeconds(response),
      );
    }
    this.logger.error(`${this.label} HTTP ${response.status}${detail}`);
    return new ConnectorError("upstream", `${this.label} HTTP ${response.status}${detail}`);
  }
}

function isHtml(text: string): boolean {
  return /<!doctype html|<html[\s>]/i.test(text);
}

function normalizeCost(cost: number | undefined): number {
  const value = cost ?? 1;
  if (!Number.isInteger(value) || value < 1) {
    throw new ConnectorError("input", "Request cost must be a positive integer.");
  }
  return value;
}

function publicSnippet(text: string, secrets: readonly string[]): string {
  return stripUrls(redact(text, secrets)).replace(/\s+/g, " ").trim().slice(0, 180);
}

function parseJsonBody(text: string, status: number, label: string): unknown {
  if (text.trim().length === 0) {
    throw new ConnectorError("upstream", `${label} returned an empty body (HTTP ${status}).`);
  }
  try {
    return parseJson(text);
  } catch {
    throw new ConnectorError("upstream", `${label} returned non-JSON (HTTP ${status}).`);
  }
}

function parseJson(text: string): unknown {
  return JSON.parse(text) as unknown;
}

async function readLimited(response: Response, label: string): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null && /^[0-9]+$/.test(declared) && Number(declared) > MAX_BODY) {
    await response.body?.cancel().catch(() => undefined);
    throw new ConnectorError("upstream", `${label} response was too large to parse.`);
  }
  let text = "";
  try {
    text = await response.text();
  } catch {
    throw new ConnectorError("upstream", `${label} response could not be read.`);
  }
  if (text.length > MAX_BODY) {
    throw new ConnectorError("upstream", `${label} response was too large to parse.`);
  }
  return text;
}

function retryAfterSeconds(response: Response): number | null {
  const raw = response.headers.get("retry-after");
  if (raw === null) return null;
  if (/^[0-9]+$/.test(raw)) {
    const seconds = Number(raw);
    return seconds > 0 ? seconds : null;
  }
  const when = Date.parse(raw);
  if (Number.isNaN(when)) return null;
  return Math.max(1, Math.ceil((when - Date.now()) / 1000));
}
