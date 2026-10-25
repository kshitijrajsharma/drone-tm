import { describe, expect, it } from "vitest";
import { corridorArea, validateRing } from "../src/core/aoi";
import type { MapController } from "../src/map";
import { showArea } from "../src/map/show-area";

function recordingMap(): { map: MapController; calls: string[] } {
  const calls: string[] = [];
  const map = {
    setLine: () => calls.push("setLine"),
    showOutline: (ring: unknown) => calls.push(ring ? "showOutline" : "hideOutline"),
    setRing: () => calls.push("setRing"),
  } as unknown as MapController;
  return { map, calls };
}

describe("showArea", () => {
  it("shows a corridor as its editable line inside its outline", () => {
    const { map, calls } = recordingMap();

    showArea(
      map,
      corridorArea(
        [
          [85.3, 27.7],
          [85.31, 27.7],
        ],
        80,
      ),
    );

    expect(calls).toEqual(["setLine", "showOutline"]);
  });

  it("shows an area as an editable polygon with no outline", () => {
    const { map, calls } = recordingMap();
    const square: Array<[number, number]> = [
      [85.3, 27.7],
      [85.31, 27.7],
      [85.31, 27.71],
      [85.3, 27.71],
    ];

    showArea(map, validateRing(square));

    expect(calls).toEqual(["setRing"]);
  });
});
