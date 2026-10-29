import { z } from "zod";
import { brandBaseUrl, brandSecret, type BaseUrl, type Secret } from "./brand.js";
import {
  CONNECTOR_NAME,
  CONNECTOR_VERSION,
  EONET_ORIGIN,
  FIRMS_ORIGIN,
  FIRMS_TRANSACTION_LIMIT,
} from "./constants.js";
import { ConnectorError } from "./errors.js";
import { fixedError } from "./zod-messages.js";

const invalid = fixedError("invalid");

const EnvSchema = z.object({
  FIRMS_MAP_KEY: z
    .string({ error: invalid })
    .trim()
    .regex(/^[0-9A-Za-z]{32}$/, { error: invalid })
    .optional(),
  FIRMS_BASE_URL: z.url({ error: invalid }).optional(),
  EONET_BASE_URL: z.url({ error: invalid }).optional(),
  FIRMS_TRANSACTIONS_PER_10_MIN: z
    .string({ error: invalid })
    .regex(/^[0-9]+$/, { error: invalid })
    .optional(),
  EONET_PER_MINUTE: z
    .string({ error: invalid })
    .regex(/^[0-9]+$/, { error: invalid })
    .optional(),
  HAZARDWATCH_TIMEOUT_MS: z
    .string({ error: invalid })
    .regex(/^[0-9]+$/, { error: invalid })
    .optional(),
  HAZARDWATCH_CONTACT: z
    .string({ error: invalid })
    .trim()
    .min(1, { error: invalid })
    .max(120, { error: invalid })
    .optional(),
  MCP_TRANSPORT: z.enum(["stdio", "http"], { error: invalid }).optional(),
  PORT: z
    .string({ error: invalid })
    .regex(/^[0-9]+$/, { error: invalid })
    .optional(),
  HAZARDWATCH_CACHE_TTL_SEC: z
    .string({ error: invalid })
    .regex(/^[0-9]+$/, { error: invalid })
    .optional(),
});

export interface Config {
  firmsMapKey: Secret | undefined;
  firmsBaseUrl: BaseUrl;
  eonetBaseUrl: BaseUrl;
  firmsTransactionsPer10Min: number;
  eonetPerMinute: number;
  timeoutMs: number;
  contact: string;
  transport: "stdio" | "http";
  port: number;
  cacheTtlSec: number;
  userAgent: string;
}

function hasControlChar(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function blank(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function read(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return blank(env[name]);
}

function issueSummary(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path =
        issue.path.length === 0 ? "(root)" : issue.path.map((part) => String(part)).join(".");
      return `${path} (${issue.code})`;
    })
    .join("; ");
}

function boundedInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
  field: string,
): number {
  if (raw === undefined) return fallback;
  const parsed = z.number().int().min(min).max(max).safeParse(Number(raw));
  if (!parsed.success) {
    throw new ConnectorError("config", `Invalid environment: ${field} (out_of_range).`);
  }
  return parsed.data;
}

function userAgentFor(contact: string): string {
  const clean = contact
    .replace(/[\r\n]+/g, " ")
    .trim()
    .slice(0, 120);
  return `${CONNECTOR_NAME}/${CONNECTOR_VERSION} (${clean.length > 0 ? clean : "contact@example.com"})`;
}

function normalizeBaseUrl(value: string, field: string): BaseUrl {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConnectorError("config", `Invalid environment: ${field} (invalid_url).`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConnectorError("config", `Invalid environment: ${field} (invalid_url).`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new ConnectorError("config", `Invalid environment: ${field} (userinfo).`);
  }
  if (url.search !== "" || url.hash !== "") {
    throw new ConnectorError("config", `Invalid environment: ${field} (query_or_hash).`);
  }
  return brandBaseUrl(value.replace(/\/+$/, ""));
}

export function loadConfig(env: NodeJS.ProcessEnv, argv: readonly string[]): Config {
  const parsed = EnvSchema.safeParse({
    FIRMS_MAP_KEY: read(env, "FIRMS_MAP_KEY"),
    FIRMS_BASE_URL: read(env, "FIRMS_BASE_URL"),
    EONET_BASE_URL: read(env, "EONET_BASE_URL"),
    FIRMS_TRANSACTIONS_PER_10_MIN: read(env, "FIRMS_TRANSACTIONS_PER_10_MIN"),
    EONET_PER_MINUTE: read(env, "EONET_PER_MINUTE"),
    HAZARDWATCH_TIMEOUT_MS: read(env, "HAZARDWATCH_TIMEOUT_MS"),
    HAZARDWATCH_CONTACT: read(env, "HAZARDWATCH_CONTACT"),
    MCP_TRANSPORT: read(env, "MCP_TRANSPORT"),
    PORT: read(env, "PORT"),
    HAZARDWATCH_CACHE_TTL_SEC: read(env, "HAZARDWATCH_CACHE_TTL_SEC"),
  });
  if (!parsed.success) {
    throw new ConnectorError("config", `Invalid environment: ${issueSummary(parsed.error)}.`);
  }

  const data = parsed.data;
  const firmsMapKey = data.FIRMS_MAP_KEY === undefined ? undefined : brandSecret(data.FIRMS_MAP_KEY);
  const firmsBaseUrl = normalizeBaseUrl(data.FIRMS_BASE_URL ?? FIRMS_ORIGIN, "FIRMS_BASE_URL");
  const eonetBaseUrl = normalizeBaseUrl(data.EONET_BASE_URL ?? EONET_ORIGIN, "EONET_BASE_URL");
  const contact = data.HAZARDWATCH_CONTACT ?? "contact@example.com";
  if (hasControlChar(contact)) {
    throw new ConnectorError("config", "Invalid environment: HAZARDWATCH_CONTACT (control_character).");
  }
  const userAgent = userAgentFor(contact);
  if (firmsMapKey !== undefined) {
    for (const [field, value] of [
      ["FIRMS_BASE_URL", firmsBaseUrl],
      ["EONET_BASE_URL", eonetBaseUrl],
      ["HAZARDWATCH_CONTACT", contact],
    ] as const) {
      if (value.includes(firmsMapKey)) {
        throw new ConnectorError("config", `Invalid environment: ${field} (contains_secret).`);
      }
    }
    if (userAgent.includes(firmsMapKey)) {
      throw new ConnectorError("config", "Invalid environment: HAZARDWATCH_CONTACT (contains_secret).");
    }
  }

  const envTransport = data.MCP_TRANSPORT ?? "stdio";
  const transport = argv.includes("--http") ? "http" : envTransport;

  return {
    firmsMapKey,
    firmsBaseUrl,
    eonetBaseUrl,
    firmsTransactionsPer10Min: boundedInt(
      data.FIRMS_TRANSACTIONS_PER_10_MIN,
      FIRMS_TRANSACTION_LIMIT,
      1,
      FIRMS_TRANSACTION_LIMIT,
      "FIRMS_TRANSACTIONS_PER_10_MIN",
    ),
    eonetPerMinute: boundedInt(data.EONET_PER_MINUTE, 30, 1, 600, "EONET_PER_MINUTE"),
    timeoutMs: boundedInt(data.HAZARDWATCH_TIMEOUT_MS, 20_000, 100, 120_000, "HAZARDWATCH_TIMEOUT_MS"),
    contact,
    transport,
    port: boundedInt(data.PORT, 3000, 1, 65_535, "PORT"),
    cacheTtlSec: boundedInt(data.HAZARDWATCH_CACHE_TTL_SEC, 60, 0, 86_400, "HAZARDWATCH_CACHE_TTL_SEC"),
    userAgent,
  };
}
