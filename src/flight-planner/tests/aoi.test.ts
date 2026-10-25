import { describe, expect, it } from "vitest";
import {
  AoiError,
  areaSize,
  corridorArea,
  formatArea,
  formatLength,
  lineLengthM,
  readAoiFile,
  ringAreaM2,
  validateRing,
} from "../src/core/aoi";

const SQUARE: Array<[number, number]> = [
  [85.28, 27.68],
  [85.32, 27.68],
  [85.32, 27.72],
  [85.28, 27.72],
  [85.28, 27.68],
];

describe("validateRing", () => {
  it("accepts a closed square", () => {
    const result = validateRing(SQUARE);

    expect(result.ring).toHaveLength(5);
    expect(result.bbox).toEqual([85.28, 27.68, 85.32, 27.72]);
  });

  it("closes an open ring", () => {
    const open = SQUARE.slice(0, 4);
    const result = validateRing(open);

    expect(result.ring).toHaveLength(5);
    expect(result.ring.at(-1)).toEqual(result.ring[0]);
  });

  it("rejects fewer than three corners", () => {
    expect(() =>
      validateRing([
        [0, 0],
        [1, 1],
      ]),
    ).toThrow(AoiError);
  });

  it("rejects projected coordinates with an explanation", () => {
    try {
      validateRing([
        [9494000, 3200000],
        [9495000, 3200000],
        [9495000, 3201000],
      ]);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(AoiError);
      expect((error as AoiError).guidance).toMatch(/EPSG:4326/);
    }
  });

  it("rejects a zero-height area", () => {
    expect(() =>
      validateRing([
        [85.28, 27.68],
        [85.32, 27.68],
        [85.3, 27.68],
      ]),
    ).toThrow(/no width or height/);
  });

  it("rejects an antimeridian crossing before the DEM service has to", () => {
    expect(() =>
      validateRing([
        [-179.9, 27.6],
        [179.9, 27.6],
        [179.9, 27.7],
      ]),
    ).toThrow(/antimeridian/);
  });

  it("rejects a non-numeric coordinate", () => {
    expect(() =>
      validateRing([
        [85.28, 27.68],
        ["x", 27.68],
        [85.3, 27.7],
      ] as never),
    ).toThrow(/valid coordinate/);
  });

  it("rejects a ring with no surface", () => {
    expect(() =>
      validateRing([
        [0, 0],
        [1, 1],
        [0, 0],
      ]),
    ).toThrow(/no usable surface/);
  });

  it("rejects a self-crossing ring even when its signed area is nonzero", () => {
    expect(() =>
      validateRing([
        [0, 0],
        [4, 4],
        [0, 2],
        [3, 0],
      ]),
    ).toThrow(/edges cross/);
  });
});

describe("readAoiFile", () => {
  const file = (geometry: object) =>
    new File([JSON.stringify({ type: "Feature", properties: {}, geometry })], "area.geojson");

  it("rejects polygons with holes", async () => {
    await expect(
      readAoiFile(
        file({
          type: "Polygon",
          coordinates: [
            SQUARE,
            [
              [85.29, 27.69],
              [85.3, 27.69],
              [85.3, 27.7],
              [85.29, 27.69],
            ],
          ],
        }),
      ),
    ).rejects.toThrow(/holes/);
  });

  it("rejects multiple polygons", async () => {
    await expect(
      readAoiFile(file({ type: "MultiPolygon", coordinates: [[SQUARE], [SQUARE]] })),
    ).rejects.toThrow(/multiple flight areas/);
  });

  it("reads a line as a corridor of the width asked for", async () => {
    const road = [
      [85.3, 27.7],
      [85.31, 27.7],
    ];

    const result = await readAoiFile(file({ type: "LineString", coordinates: road }), 80);

    expect(result.corridor).toEqual({ centreline: road, widthM: 80 });
    // 985 m long and 80 m wide
    expect(result.areaM2).toBeGreaterThan(985 * 80 * 0.95);
    expect(result.areaM2).toBeLessThan(985 * 80 * 1.05);
  });

  it("still reads a polygon as a plain flight area", async () => {
    const result = await readAoiFile(file({ type: "Polygon", coordinates: [SQUARE] }), 80);

    expect(result.corridor).toBeUndefined();
  });

  it("explains that a point cannot define an area", async () => {
    await expect(readAoiFile(file({ type: "Point", coordinates: [85.3, 27.7] }))).rejects.toThrow(
      /No polygon or line/,
    );
  });
});

describe("lineLengthM", () => {
  it("measures a degree of latitude as about 111 km", () => {
    expect(
      lineLengthM([
        [85.3, 27],
        [85.3, 28],
      ]),
    ).toBeCloseTo(111195, -2);
  });

  it("adds up every segment of a bent line", () => {
    const bent: Array<[number, number]> = [
      [85.3, 27.7],
      [85.31, 27.7],
      [85.31, 27.71],
    ];
    expect(lineLengthM(bent)).toBeCloseTo(
      lineLengthM([bent[0], bent[1]]) + lineLengthM([bent[1], bent[2]]),
      6,
    );
  });

  it("formats short lines in metres and long ones in km", () => {
    expect([formatLength(850), formatLength(3813)]).toEqual(["850 m", "3.81 km"]);
  });
});

describe("areaSize", () => {
  it("gives a line's length and width, and an area's size", () => {
    // 0.01 degrees of longitude at 27.7 degrees north is about 985 m
    const line = corridorArea(
      [
        [85.3, 27.7],
        [85.31, 27.7],
      ],
      120,
    );

    expect(areaSize(line)).toBe("985 m line, 120 m wide");
    expect(areaSize(validateRing(SQUARE))).toMatch(/^\d+\.\d+ km² area$/);
  });
});

describe("corridorArea", () => {
  const road: Array<[number, number]> = [
    [85.3, 27.7],
    [85.31, 27.7],
  ];

  it("grows with the corridor width", () => {
    expect(corridorArea(road, 200).areaM2).toBeGreaterThan(corridorArea(road, 100).areaM2 * 1.9);
  });

  it("rejects a width of zero", () => {
    expect(() => corridorArea(road, 0)).toThrow(AoiError);
  });

  it("rejects a line with no length", () => {
    expect(() => corridorArea([road[0], road[0]], 50)).toThrow(/no length/);
  });
});

describe("ringAreaM2", () => {
  it("gets a 0.04 degree square near Kathmandu about right", () => {
    const area = ringAreaM2(SQUARE);

    expect(area / 1_000_000).toBeGreaterThan(15);
    expect(area / 1_000_000).toBeLessThan(20);
  });

  it("is sign independent of winding order", () => {
    expect(ringAreaM2([...SQUARE].reverse())).toBeCloseTo(ringAreaM2(SQUARE), 0);
  });

  it("is zero for a degenerate ring", () => {
    expect(
      ringAreaM2([
        [0, 0],
        [1, 1],
      ]),
    ).toBe(0);
  });
});

describe("formatArea", () => {
  it.each([
    [500, "0.001 km²"],
    [50_000, "0.050 km²"],
    [708_000, "0.708 km²"],
    [5_000_000, "5.00 km²"],
    [150_000_000, "150.0 km²"],
  ])("formats %i m² as %s", (input, expected) => {
    expect(formatArea(input)).toBe(expected);
  });
});
