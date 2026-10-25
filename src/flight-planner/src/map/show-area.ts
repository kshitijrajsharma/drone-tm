import type { AoiResult } from "../core/aoi";
import type { MapController } from "./index";

export function showArea(map: MapController, aoi: AoiResult): void {
  if (aoi.corridor) {
    map.setLine(aoi.corridor.centreline);
    map.showOutline(aoi.ring);
  } else {
    map.setRing(aoi.ring);
  }
}
