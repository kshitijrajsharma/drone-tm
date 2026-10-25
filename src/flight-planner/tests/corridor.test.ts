import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { corridorOutline, generateCorridor } from "../src/core/qfield";
import type { CorridorConfig, FlightModeKey } from "../src/core/types";

const fixtures = new URL("./fixtures/", import.meta.url);
const read = (name: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(name, fixtures)), "utf-8"));

const ROAD: Array<[number, number]> =
  read("corridor-road.geojson").features[0].geometry.coordinates;

const BASE: Omit<CorridorConfig, "corridorWidth"> = {
  gsd: 3.5,
  forwardOverlap: 75,
  sideOverlap: 75,
  droneType: "DJI_MINI_4_PRO",
  gimbalAngle: "-80",
  imageInterval: 2,
};

// Direct Mercator formulas differ from pyproj by less than 0.11 m.
const COORD_TOLERANCE_DEG = 1e-6;
const HEADING_TOLERANCE_DEG = 0.01;

type RefPoint = [number, number, number, boolean];

const CASES: Record<string, { corridorWidth: number; flightMode: FlightModeKey }> = {
  "width80-waylines": { corridorWidth: 80, flightMode: "waylines" },
  "width250-waylines": { corridorWidth: 250, flightMode: "waylines" },
  "width250-waypoints": { corridorWidth: 250, flightMode: "waypoints" },
};

/** Ground metres between two lon/lat points, accurate over a few kilometres. */
function metres(a: number[], b: number[]): number {
  const latScale = 110574;
  const lonScale = 111320 * Math.cos((a[1] * Math.PI) / 180);
  return Math.hypot((b[0] - a[0]) * lonScale, (b[1] - a[1]) * latScale);
}

function distanceToRoad(point: number[]): number {
  let best = Infinity;
  for (let i = 0; i < ROAD.length - 1; i++) {
    const [a, b] = [ROAD[i], ROAD[i + 1]];
    for (let t = 0; t <= 1; t += 0.02) {
      const onRoad = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      best = Math.min(best, metres(point, onRoad));
    }
  }
  return best;
}

describe("corridor-road.geojson matches drone-flightplan", () => {
  const reference = read("python-corridor-road.json") as Record<
    string,
    { count: number; time: number; battery: boolean; passes: number; pts: RefPoint[] }
  >;

  for (const [caseName, config] of Object.entries(CASES)) {
    const ref = reference[caseName];
    const result = generateCorridor(ROAD, { ...BASE, ...config });
    const features = result.geojson.features;

    describe(caseName, () => {
      it("flies the same number of passes and waypoints", () => {
        expect(result.passCount).toBe(ref.passes);
        expect(features.length).toBe(ref.count);
      });

      it("estimates the same flight time and battery warning", () => {
        expect(result.estimatedFlightTimeMinutes).toBeCloseTo(ref.time, 1);
        expect(result.batteryWarning).toBe(ref.battery);
      });

      it("places, heads and triggers every waypoint as Python does", () => {
        const mismatches: string[] = [];
        ref.pts.forEach((point, i) => {
          const [lon, lat] = features[i].geometry.coordinates;
          const { heading, take_photo } = features[i].properties;
          if (Math.max(Math.abs(lon - point[0]), Math.abs(lat - point[1])) > COORD_TOLERANCE_DEG) {
            mismatches.push(`${i}: position`);
          }
          if (Math.abs(heading - point[2]) > HEADING_TOLERANCE_DEG) {
            mismatches.push(`${i}: heading ${heading} vs ${point[2]}`);
          }
          if (Boolean(take_photo) !== point[3]) mismatches.push(`${i}: take_photo`);
        });
        expect(mismatches.slice(0, 5)).toEqual([]);
      });
    });
  }
});

describe("generateCorridor", () => {
  const photoWidth = generateCorridor(ROAD, { ...BASE, corridorWidth: 1 }).parameters
    .side_photo_width;

  it("flies the centreline once when one photo spans the corridor", () => {
    const result = generateCorridor(ROAD, { ...BASE, corridorWidth: photoWidth });

    expect(result.passCount).toBe(1);
  });

  it("adds a pass as soon as the corridor is wider than the passes cover", () => {
    const flightMode = "waypoints";
    const two = generateCorridor(ROAD, { ...BASE, flightMode, corridorWidth: photoWidth + 1 });
    const sideSpacing = two.parameters.side_spacing;
    const exactlyTwo = generateCorridor(ROAD, {
      ...BASE,
      flightMode,
      corridorWidth: photoWidth + sideSpacing,
    });
    const three = generateCorridor(ROAD, {
      ...BASE,
      flightMode,
      corridorWidth: photoWidth + sideSpacing + 1,
    });

    expect([two.passCount, exactlyTwo.passCount, three.passCount]).toEqual([2, 2, 3]);
  });

  it("keeps every photo within the corridor half-width of the road", () => {
    const width = 250;
    const result = generateCorridor(ROAD, {
      ...BASE,
      flightMode: "waypoints",
      corridorWidth: width,
    });
    const photos = result.geojson.features.filter((feature) => feature.properties.take_photo);
    const farthest = Math.max(...photos.map((f) => distanceToRoad(f.geometry.coordinates)));

    expect(farthest).toBeLessThan(width / 2);
  });

  it("heads along the road, and back the other way on the return pass", () => {
    const result = generateCorridor(ROAD, { ...BASE, flightMode: "waypoints", corridorWidth: 250 });
    const headings = result.geojson.features.map((feature) => feature.properties.heading);

    // The road starts by running due east; passes alternate direction.
    expect(headings[0]).toBeCloseTo(90, 0);
    expect(headings).toContainEqual(expect.closeTo(270, 0));
  });

  it("keeps the bends in waylines mode instead of cutting across them", () => {
    const result = generateCorridor(ROAD, { ...BASE, flightMode: "waylines", corridorWidth: 80 });
    const points = result.geojson.features.map((feature) => feature.geometry.coordinates);
    let worstCut = 0;
    // The first and last legs are the lead-in and lead-out, which extend past the road's ends.
    for (let i = 1; i < points.length - 2; i++) {
      const midpoint = [
        (points[i][0] + points[i + 1][0]) / 2,
        (points[i][1] + points[i + 1][1]) / 2,
      ];
      worstCut = Math.max(worstCut, distanceToRoad(midpoint));
    }

    // A single centreline pass: no leg of the path strays more than a few metres off the road.
    expect(result.passCount).toBe(1);
    expect(worstCut).toBeLessThan(5);
  });
});

describe("corridorOutline", () => {
  it("is a closed ring that lies the corridor half-width from the road", () => {
    const ring = corridorOutline(ROAD, 100);
    const distances = ring.map((point) => distanceToRoad(point));

    expect(ring[0]).toEqual(ring[ring.length - 1]);
    expect(Math.min(...distances)).toBeGreaterThan(48);
    expect(Math.max(...distances)).toBeLessThan(52);
  });
});
