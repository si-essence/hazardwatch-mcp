import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { toolDescription, toolName } from "./brand.js";
import { CONNECTOR_NAME, CONNECTOR_VERSION, DAY_RANGE_MAX, MAX_RADIUS_KM } from "./constants.js";
import {
  eonetCategories,
  eonetCategoriesInput,
  eonetEvent,
  eonetEventInput,
  eonetEvents,
  eonetEventsInput,
} from "./eonet.js";
import { firesByCountry, firesByCountryInput, firesNear, firesNearInput } from "./firms.js";
import { nearbyHazards, nearbyHazardsInput } from "./nearby.js";
import type { Runtime } from "./runtime.js";
import { READ_ONLY_REMOTE, registerConnectorTool } from "./tools.js";

const annotations = { ...READ_ONLY_REMOTE, idempotentHint: true };

export const TOOL_NAMES = [
  "fires_near",
  "fires_by_country",
  "eonet_events",
  "eonet_event",
  "nearby_hazards",
  "eonet_categories",
] as const;

export function createServer(runtime: Runtime): McpServer {
  const server = new McpServer({ name: CONNECTOR_NAME, version: CONNECTOR_VERSION });
  const ctx = { secrets: runtime.secrets, logger: runtime.logger };
  const firms = {
    client: runtime.firms,
    mapKey: runtime.config.firmsMapKey,
    cacheTtlSec: runtime.cacheTtlSec,
  };

  registerConnectorTool(
    server,
    {
      name: toolName("fires_near"),
      description: toolDescription(
        `Active fire hotspots from NASA FIRMS. Pass latitude, longitude, and radius_km (kilometers, greater than 0 and at most ${MAX_RADIUS_KM}), or west, south, east, and north in degrees. A point query keeps hotspots within radius_km, nearest first. day_range is an integer from 1 to ${DAY_RANGE_MAX}. source defaults to VIIRS_NOAA21_NRT. Suomi-NPP deliveries are scheduled to stop on 2026-11-02. Requires FIRMS_MAP_KEY. Not for safety-of-life decisions.`,
      ),
      inputSchema: firesNearInput,
      annotations,
      handler: (args) => firesNear(firms, args),
    },
    ctx,
  );

  registerConnectorTool(
    server,
    {
      name: toolName("fires_by_country"),
      description: toolDescription(
        `Active fire hotspots from NASA FIRMS for one ISO 3166-1 alpha-3 country code. day_range is 1 to ${DAY_RANGE_MAX}. The FIRMS country endpoint is marked unavailable on the API index and this tool reports that upstream failure until NASA restores it. Requires FIRMS_MAP_KEY. Not for safety-of-life decisions.`,
      ),
      inputSchema: firesByCountryInput,
      annotations,
      handler: (args) => firesByCountry(firms, args),
    },
    ctx,
  );

  registerConnectorTool(
    server,
    {
      name: toolName("eonet_events"),
      description: toolDescription(
        "Natural-event metadata from NASA EONET v3. Filter with category id, status open, closed, or all, start and end as YYYY-MM-DD, limit, and an optional west, south, east, north bbox. No API key. Events link to third-party sources with their own licenses. Not for safety-of-life decisions.",
      ),
      inputSchema: eonetEventsInput,
      annotations,
      handler: (args) => eonetEvents(runtime.eonet, args, runtime.cacheTtlSec),
    },
    ctx,
  );

  registerConnectorTool(
    server,
    {
      name: toolName("eonet_event"),
      description: toolDescription(
        "One NASA EONET v3 event by id, including categories, sources, and geometries. No API key. Not for safety-of-life decisions.",
      ),
      inputSchema: eonetEventInput,
      annotations,
      handler: (args) => eonetEvent(runtime.eonet, args.id, runtime.cacheTtlSec),
    },
    ctx,
  );

  registerConnectorTool(
    server,
    {
      name: toolName("nearby_hazards"),
      description: toolDescription(
        `Open EONET events and FIRMS hotspots within radius_km of a latitude and longitude. limit is an integer from 1 to 50 and caps both the events and the hotspots. Hotspots are the nearest ones. If FIRMS_MAP_KEY is unset or FIRMS fails, events are still returned and firms_note explains why. day_range is 1 to ${DAY_RANGE_MAX}. Not for safety-of-life decisions.`,
      ),
      inputSchema: nearbyHazardsInput,
      annotations,
      handler: (args) => nearbyHazards(runtime, args),
    },
    ctx,
  );

  registerConnectorTool(
    server,
    {
      name: toolName("eonet_categories"),
      description: toolDescription(
        "List NASA EONET v3 category ids and titles. Pass a category id to eonet_events. No API key.",
      ),
      inputSchema: eonetCategoriesInput,
      annotations,
      handler: () => eonetCategories(runtime.eonet, runtime.cacheTtlSec),
    },
    ctx,
  );

  return server;
}
