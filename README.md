# hazardwatch-mcp (Hazardwatch MCP connector)

hazardwatch is a Model Context Protocol server for NASA FIRMS active-fire hotspots and NASA EONET natural events. FIRMS calls need a free MAP_KEY. EONET calls do not.

The data is not for safety-of-life decisions. Read Attribution and terms before you rely on a result.

## Set up the connector

```bash
npm install
npm run ci          # typecheck, lint, test, build
npm start           # stdio
npm run start:http  # Streamable HTTP at http://localhost:3000/mcp and /health
node scripts/live-check.mjs
```

Request a FIRMS MAP_KEY at <https://firms.modaps.eosdis.nasa.gov/api/map_key/>. Export it as `FIRMS_MAP_KEY`. The variable is optional. Without it, `eonet_events`, `eonet_event`, and `eonet_categories` still work. `fires_near` and `fires_by_country` return a `[config]` error that includes the signup URL. `nearby_hazards` returns the EONET events and puts that explanation in `firms_note`.

Claude Desktop, or any stdio client:

```json
{
  "mcpServers": {
    "hazardwatch": {
      "command": "node",
      "args": ["/workspace/connectors/hazardwatch/dist/index.js"],
      "env": {
        "FIRMS_MAP_KEY": "...",
        "HAZARDWATCH_CONTACT": "you@example.com"
      }
    }
  }
}
```

Docker serves HTTP with no authentication. Keep it on localhost.

```bash
docker build -t hazardwatch .
docker run -p 3000:3000 -e FIRMS_MAP_KEY -e HAZARDWATCH_CONTACT=you@example.com hazardwatch
```

Do not bake the MAP_KEY into the image. `docker run -e FIRMS_MAP_KEY` forwards the variable from the shell when it is set.

## Tools

Register every tool with `registerConnectorTool`. Each tool returns JSON text plus `structuredContent`. Errors use `isError` and a prefix: `[config]`, `[input]`, `[not-found]`, `[rate-limit]`, `[upstream]`, or `[timeout]`.

| Tool               | What it returns                                                                                                                                                                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `fires_near`       | FIRMS hotspots for a point plus `radius_km`, or for `west`, `south`, `east`, and `north`. A point query keeps hotspots inside the radius, nearest first. `day_range` is 1 to 5. `source` defaults to `VIIRS_NOAA21_NRT`.                               |
| `fires_by_country` | FIRMS hotspots for an ISO 3166-1 alpha-3 code. The live country endpoint is marked unavailable. See Limits.                                                                                                                                            |
| `eonet_events`     | EONET events. Filters are `category`, `status` (`open`, `closed`, or `all`), `start`, `end`, `limit`, and an optional bbox.                                                                                                                            |
| `eonet_event`      | One EONET event by id.                                                                                                                                                                                                                                 |
| `nearby_hazards`   | Open EONET events and FIRMS hotspots within `radius_km` of a point. `limit` is 1 to 50 and defaults to 20. It caps both the events and the hotspots. Hotspots are the nearest ones. FIRMS failure leaves `firms` null and explains it in `firms_note`. |
| `eonet_categories` | EONET category ids. Pass an id to `eonet_events`.                                                                                                                                                                                                      |

A point query and a bbox are alternatives. Pass one of them. `radius_km` is greater than 0 and at most 2500. A radius that crosses the antimeridian is rejected. Split that search into two bboxes with `west` less than `east`.

## Hotspot fields

Each hotspot has `latitude`, `longitude`, `acq_date`, `acq_time`, `acquired_at`, `satellite`, `instrument`, `confidence`, `frp`, `brightness`, and `daynight`. `brightness` comes from `bright_ti4` on VIIRS rows and from `brightness` on MODIS rows. `confidence` stays the upstream text, so VIIRS can be `n` and MODIS can be `73`.

`acq_time` is UTC `HHMM` as four digits. FIRMS omits leading zeros, so the connector turns `7` into `0007` and `848` into `0848`. A blank time, a non-numeric time, an hour above 23, or a minute above 59 is null.

`acquired_at` is UTC `YYYY-MM-DDTHH:MM:00Z` when both the date and the time are valid. `acquired_at` is null when either one is missing, when the time is invalid, or when the date is not a real `YYYY-MM-DD` calendar day. An invalid date is still returned in `acq_date`.

A point query sets `area` to `point`. Each returned hotspot then has `distance_km`, the great-circle distance from the query point in kilometers, rounded to one decimal place. Hotspots farther than `radius_km` are dropped. The rest are sorted nearest first. `count` is the number inside the radius. `bbox_count` is the number of hotspots in the square sent to FIRMS, before that filter. `returned` is the number of hotspots in this response. `truncated` is true when `count` is greater than `returned`.

A bbox query sets `area` to `bbox`, or to `world` for the whole globe. Those hotspots stay in FIRMS CSV order and do not include `distance_km` or `bbox_count`. `fires_by_country` sets `area` to `country` and uses that same shape.

`nearby_hazards` runs the point query, then keeps at most `limit` of the nearest hotspots. `firms.count` and `firms.bbox_count` still describe the full circle and the square. `firms.returned` and `firms.truncated` follow the limit. Every fire report and `nearby_hazards` include the safety caveat. The data is not for safety-of-life decisions.

EONET's bbox query is ordered west, north, east, south. This connector accepts west, south, east, north on every tool and translates the order for EONET.

## Environment

| Variable                        | Default                                | Role                                                                                          |
| ------------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------- |
| `FIRMS_MAP_KEY`                 | unset                                  | 32 letters or digits. Placed only in the FIRMS path. Redacted from results, errors, and logs. |
| `FIRMS_BASE_URL`                | `https://firms.modaps.eosdis.nasa.gov` | Origin only. No userinfo, query, or hash.                                                     |
| `EONET_BASE_URL`                | `https://eonet.gsfc.nasa.gov/api/v3`   | EONET v3 origin. No key.                                                                      |
| `HAZARDWATCH_CONTACT`           | `contact@example.com`                  | Contact inside the User-Agent. Must not contain the MAP_KEY.                                  |
| `FIRMS_TRANSACTIONS_PER_10_MIN` | `5000`                                 | Local cap. Cannot be set above 5000.                                                          |
| `EONET_PER_MINUTE`              | `30`                                   | Local EONET sliding window.                                                                   |
| `HAZARDWATCH_CACHE_TTL_SEC`     | `60`                                   | TTL for successful responses. `0` disables the cache.                                         |
| `HAZARDWATCH_TIMEOUT_MS`        | `20000`                                | Upstream timeout.                                                                             |
| `MCP_TRANSPORT`                 | `stdio`                                | `stdio` or `http`. `--http` forces HTTP.                                                      |
| `PORT`                          | `3000`                                 | HTTP listen port.                                                                             |

Invalid values are reported by field name and issue code. The rejected value is not included in the error.

Requests send `hazardwatch/0.1.0 (<HAZARDWATCH_CONTACT>)`.

## Limits

Checked against the live FIRMS area page and API index on 2026-10-17 (API 4.2.0).

- Area URL shape: `/api/area/csv/{MAP_KEY}/{SOURCE}/{west,south,east,north|world}/{DAY_RANGE}` and an optional `/{DATE}`.
- Country URL shape, for when NASA turns it back on: `/api/country/csv/{MAP_KEY}/{SOURCE}/{ISO3}/{DAY_RANGE}` and an optional `/{DATE}`.
- `DAY_RANGE` on the area page is 1 to 5. Values outside that range are rejected here. An older note of 1 to 10 does not match the current page.
- Sensors: `VIIRS_SNPP_NRT`, `VIIRS_NOAA20_NRT`, `VIIRS_NOAA21_NRT`, `VIIRS_SNPP_SP`, `VIIRS_NOAA20_SP`, `MODIS_NRT`, `MODIS_SP`, `LANDSAT_NRT`. `LANDSAT_NRT` is US and Canada only. NASA Earthdata says new Suomi-NPP observations cease on 2026-11-02 (<https://www.earthdata.nasa.gov/data/alerts-outages/suomi-npp-observations-cease-november-2-2026>). A FIRMS news item says data products cease on 2026-11-01 (<https://firms.modaps.eosdis.nasa.gov/content/notifications/firms/news.html>). Prefer NOAA-21 or NOAA-20.
- The MAP_KEY budget is 5000 transactions per 10 minutes. A call can count as more than one transaction. The area page script charges VIIRS as 2 and other sensors as 0.5. Area cells are 60 degrees on a side. A country call in that script is `ceil(weight[iso3] * 20 * sensor * days)`. The per-country `weight` table is not in the public area HTML, and the country page returns HTTP 400, so this connector uses weight 1 and also charges at least a world query. A country whose unpublished weight is above 1 would be under-counted.
- The API index lists `country` and `countries` as not available. `GET /api/country/` returned HTTP 400 with the body `Invalid API call.` `fires_by_country` still builds the documented URL. A 400 becomes an `[upstream]` message that names the outage. A CSV body is parsed, so the tool works again if NASA restores the endpoint.
- At most 500 hotspots are returned from one FIRMS query. For a point query, `count` is the number inside the radius and the 500 are the nearest. `truncated` is true when that count is larger than `returned`. `nearby_hazards` then keeps at most `limit` of those nearest hotspots. Response bodies larger than 1,000,000 characters are rejected.
- FIRMS and EONET each have their own cache and their own limiter. A cache hit does not spend the limiter.
- HTTP mode has no authentication.

## Attribution and terms

NASA Earthdata data-use guidance says that, unless a product is marked with another restriction, data from a NASA-led mission are licensed as Creative Commons Zero (CC0). Cite the data. See <https://www.earthdata.nasa.gov/engage/open-data-services-software-policies/data-use-guidance>.

We acknowledge the use of data and/or imagery from NASA's Fire Information for Resource Management System (FIRMS) (<https://earthdata.nasa.gov/firms>), part of NASA's Land, Atmosphere Near real-time Capability for Earth observations (LANCE) (<https://earthdata.nasa.gov/lance>) and NASA's Earth Science Data and Information System (ESDIS).

EONET metadata is from NASA's Earth Observatory Natural Event Tracker (<https://eonet.gsfc.nasa.gov/>).

No NASA endorsement is implied. This project does not use the NASA insignia, the NASA logotype, or the NASA seal. NASA media guidance says those marks are not in the public domain (<https://www.nasa.gov/nasa-brand-center/images-and-media/>).

## Risks

These pages were read on 2026-10-17.

- LANCE, GIBS, Worldview, and FIRMS data are provided as is. Users bear the responsibility for their use. The disclaimer says the data are not advised for tactical decision-making or for conditions at a local scale. <https://www.earthdata.nasa.gov/data/projects/lance/disclaimer>
- FIRMS detections are near real time. NASA EOSDIS describes real time as available within 60 minutes of the satellite overpass, and FIRMS ultra real time as under 60 seconds for much of the US and Canada. Standard processing replaces near-real-time data later. The FIRMS FAQ describes false alarms over bright roofs, sun glint, and other hot surfaces, and it says MODIS confidence and VIIRS confidence are not the same scale. <https://firms.modaps.eosdis.nasa.gov/api/area/> and <https://www.earthdata.nasa.gov/data/tools/firms/faq>
- EONET says its metadata and services are for visualization and general information only, and that spatial and temporal extents are approximations from multiple sources. <https://eonet.gsfc.nasa.gov/what-is-eonet>
- Each EONET event links to the curator that supplied it. Those third-party pages keep their own licenses. A link in `sources` is not a NASA CC0 grant.
- The NASA name and insignia cannot be used to imply endorsement. Do not describe this connector as NASA-approved or as an official NASA service.
- NASA Earthdata says new Suomi-NPP observations cease on 2026-11-02. The FIRMS news page says data products cease on 2026-11-01. Both pages link the same Earthdata alert, which currently redirects to the November 2 observations notice. Default sensor is `VIIRS_NOAA21_NRT`. <https://www.earthdata.nasa.gov/data/alerts-outages/suomi-npp-observations-cease-november-2-2026> and <https://firms.modaps.eosdis.nasa.gov/content/notifications/firms/news.html>

## License

MIT, see [LICENSE](LICENSE). This is an independent, unofficial connector and is not endorsed by the Hazardwatch project or its owners.
