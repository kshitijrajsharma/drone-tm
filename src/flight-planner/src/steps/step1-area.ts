import { resetTerrain, type Step } from "../app";
import { showArea } from "../map/show-area";
import {
  AoiError,
  type AoiResult,
  corridorArea,
  DEFAULT_CORRIDOR_WIDTH_M,
  formatArea,
  formatLength,
  lineLengthM,
  readAoiFile,
  validateRing,
} from "../core/aoi";
import { coachLead, coachTips } from "../tutorial";
import { escapeHtml, errorPanel } from "./ui";
import { onFilePicked } from "./dropzone";

const LARGE_AREA_HA = 50;

export const step1: Step = {
  key: "aoi",
  label: "Area",

  blocker(state) {
    return state.aoi ? null : "Draw or upload a flight area to continue.";
  },

  render(ctx) {
    const { aoi } = ctx.state;

    const summary = aoi
      ? `<div class="stat-row">
           ${
             aoi.corridor
               ? `<div class="stat"><span class="stat-label">Length</span>
                    <span class="stat-value">${formatLength(lineLengthM(aoi.corridor.centreline))}</span></div>`
               : `<div class="stat"><span class="stat-label">Area</span>
                    <span class="stat-value">${formatArea(aoi.areaM2)}</span></div>
                  <div class="stat"><span class="stat-label">Corners</span>
                    <span class="stat-value">${aoi.ring.length - 1}</span></div>`
           }
         </div>
         ${
           aoi.corridor
             ? `<wa-input
                  id="corridor-width"
                  type="number"
                  min="1"
                  step="1"
                  label="Corridor width"
                  hint="Ground width to map, centred on the line."
                  value="${aoi.corridor.widthM}"
                ><span slot="end">m</span></wa-input>`
             : ""
         }
         ${
           aoi.areaM2 / 10_000 > LARGE_AREA_HA
             ? `<wa-callout variant="warning" appearance="outlined" size="s">
                  <wa-icon slot="icon" name="triangle-exclamation"></wa-icon>
                  That is a large area for one flight. You can carry on - step 4
                  will tell you if it needs more than one battery.
                </wa-callout>`
             : ""
         }`
      : "";

    return `
      ${coachLead("aoi")}

      <div class="step-actions">
        <wa-button id="draw-area" variant="brand" size="l" class="grow">
          <wa-icon slot="start" name="draw-polygon"></wa-icon> Draw area
        </wa-button>
        <wa-button id="draw-line" variant="brand" appearance="outlined" size="l" class="grow">
          <wa-icon slot="start" name="route"></wa-icon> Draw line
        </wa-button>
        ${
          aoi
            ? `<wa-button id="clear-area" appearance="outlined" size="l">
                 <wa-icon slot="start" name="trash-can"></wa-icon> Clear
               </wa-button>`
            : ""
        }
      </div>

      ${summary}

      ${coachTips("aoi")}

      <wa-details summary="Or upload a file" appearance="outlined" class="upload-fold" ${aoi ? "" : "open"}>
        <p class="muted">
          A GeoJSON in longitude/latitude (EPSG:4326): a Polygon for an area, or
          a LineString, such as a road, river or power line, flown as a corridor along it.
        </p>
        <hot-file-input-dropzone
          id="aoi-drop"
          accept=".geojson,.json,application/geo+json,application/json"
          label="Drop a GeoJSON here, or tap to choose"
          variant="compact"
        ></hot-file-input-dropzone>
      </wa-details>

      <div id="aoi-error"></div>
    `;
  },

  mount(root, ctx) {
    const errorHost = root.querySelector<HTMLElement>("#aoi-error")!;

    const accept = (result: ReturnType<typeof validateRing>, fitTo = true) => {
      ctx.state.aoi = result;
      resetTerrain(ctx.state);
      ctx.map.showPlan(null, null);
      if (fitTo) ctx.map.fitBbox(result.bbox);
      errorHost.innerHTML = "";
      ctx.sheet.restore();
      ctx.refresh();
      void ctx.save();
    };

    const showError = (error: unknown) => {
      if (error instanceof AoiError) {
        errorHost.innerHTML = errorPanel(error.message, error.guidance);
      } else {
        errorHost.innerHTML = errorPanel(
          "Could not read that area.",
          error instanceof Error ? error.message : "Try drawing it on the map instead.",
        );
      }
    };

    root.querySelector("#draw-area")?.addEventListener("click", () => {
      errorHost.innerHTML = "";
      ctx.sheet.collapseForMap();
      ctx.map.startDrawing("area");
      ctx.toast("Tap each corner on the map, then tap the first corner to finish.");
    });

    root.querySelector("#draw-line")?.addEventListener("click", () => {
      errorHost.innerHTML = "";
      ctx.sheet.collapseForMap();
      ctx.map.startDrawing("line");
      ctx.toast("Tap along the line, then tap the last point again to finish.");
    });

    root.querySelector("#clear-area")?.addEventListener("click", () => {
      ctx.map.clearRing();
      ctx.state.aoi = null;
      resetTerrain(ctx.state);
      ctx.map.showPlan(null, null);
      ctx.refresh();
      void ctx.save();
    });

    const corridorWidth = () => ctx.state.aoi?.corridor?.widthM ?? DEFAULT_CORRIDOR_WIDTH_M;

    const acceptCorridor = (line: Array<[number, number]>, widthM: number) => {
      let result: AoiResult;
      try {
        result = corridorArea(line, widthM);
      } catch (error) {
        showError(error);
        return;
      }
      accept(result, false);
      ctx.map.showOutline(result.ring);
    };

    root.querySelector("#corridor-width")?.addEventListener("change", (event) => {
      const corridor = ctx.state.aoi?.corridor;
      if (corridor) {
        acceptCorridor(corridor.centreline, Number((event.target as HTMLInputElement).value));
      }
    });

    onFilePicked(root.querySelector("#aoi-drop"), async (file) => {
      try {
        const result = await readAoiFile(file, corridorWidth());
        // Store the area first, so the map's change event sees it unchanged.
        accept(result);
        showArea(ctx.map, result);
        ctx.toast(`Loaded ${escapeHtml(file.name)}.`, "success");
      } catch (error) {
        showError(error);
      }
    });

    return ctx.map.onChange(() => {
      if (ctx.state.step !== 1) return;
      const line = ctx.map.line();
      if (line) {
        const current = ctx.state.aoi?.corridor?.centreline;
        if (current && JSON.stringify(current) === JSON.stringify(line)) return;
        acceptCorridor(line, corridorWidth());
        return;
      }
      const ring = ctx.map.ring();
      if (!ring) {
        ctx.map.showOutline(null);
        return;
      }
      const current = ctx.state.aoi?.ring;
      if (current && JSON.stringify(current) === JSON.stringify(ring)) return;
      try {
        accept(validateRing(ring), false);
      } catch (error) {
        showError(error);
      }
    });
  },
};
