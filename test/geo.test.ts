import { describe, expect, it } from "vitest";
import { ConnectorError } from "../src/errors.js";
import {
  bbox,
  bboxAround,
  distanceKm,
  firmsTransactionWeight,
  formatBbox,
  formatEonetBbox,
  dayRange,
  iso3,
} from "../src/geo.js";

describe("geo", () => {
  it("turns a point and radius into a bbox using the degree lengths", () => {
    const box = bboxAround(0, 0, 111.32);
    expect(box.west).toBeCloseTo(-1, 3);
    expect(box.east).toBeCloseTo(1, 3);
    expect(box.south).toBeCloseTo(-111.32 / 110.574, 4);
    expect(box.north).toBeCloseTo(111.32 / 110.574, 4);
  });

  it("rejects a radius that crosses the antimeridian", () => {
    expect(() => bboxAround(0, 179.5, 100)).toThrow(ConnectorError);
  });

  it("rejects a bbox that wraps or has zero height", () => {
    expect(() => bbox({ west: 10, south: 0, east: -10, north: 1 })).toThrow(/antimeridian/);
    expect(() => bbox({ west: 0, south: 2, east: 1, north: 2 })).toThrow(/south/);
  });

  it("charges VIIRS and MODIS the way the FIRMS area page script does", () => {
    const small = bbox({ west: 0, south: 0, east: 1, north: 1 });
    expect(firmsTransactionWeight("VIIRS_NOAA21_NRT", { kind: "bbox", bbox: small }, dayRange(1))).toBe(
      2,
    );
    expect(firmsTransactionWeight("MODIS_NRT", { kind: "bbox", bbox: small }, dayRange(5))).toBe(3);
    expect(firmsTransactionWeight("VIIRS_NOAA20_NRT", { kind: "world" }, dayRange(1))).toBe(36);
    const country = firmsTransactionWeight(
      "VIIRS_SNPP_NRT",
      { kind: "country", iso3: iso3("usa") },
      dayRange(1),
    );
    expect(country).toBeGreaterThanOrEqual(36);
  });

  it("formats EONET bbox as west, north, east, south", () => {
    const box = bbox({ west: -10, south: 20, east: 10, north: 40 });
    expect(formatBbox(box)).toBe("-10,20,10,40");
    expect(formatEonetBbox(box)).toBe("-10,40,10,20");
  });

  it("measures a short northbound distance", () => {
    const km = distanceKm(0, 0, 1, 0);
    expect(km).toBeGreaterThan(110);
    expect(km).toBeLessThan(112);
  });
});
