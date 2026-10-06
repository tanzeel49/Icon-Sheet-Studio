/**
 * ICON SHEET STUDIO — Uniform-stroke diagnostics (development tooling).
 *
 * Per-icon transparency for the stroke system, requested for verification:
 * for every icon on a sheet it reports the measured NATIVE effective stroke
 * (canvas px), the ACTIVE request (uniform target or weight delta), the
 * calculated correction (target − native — never target + native), the
 * per-icon capability and the final appearance method the renderer applies.
 *
 * This is DEVELOPMENT/TEST tooling only — it is NOT part of the render
 * pipeline and contributes ZERO markup to preview or export. It is exposed
 * as `window.__strokeDebug()` (installed by studio-app.tsx) so it can be
 * called from the browser console at any moment against the CURRENT sheet;
 * calling it prints a compact console table + summary. Nothing here mutates
 * icon geometry (pure analysis of the immutable source SVGs, all cached).
 */

import type { IconEntry, Sheet } from "./types";
import {
  effectiveStrokeWeightPx,
  effectiveUniformStroke,
  effectiveUniformTargetPx,
  iconStyleForCell,
} from "./types";
import { analyzeNativeStroke } from "./icon-style";
import { iconEmbedPlan } from "./icon-fit";
import { parseIcon } from "./svg";
import { representativeGridIconBox } from "./stroke-migration";
import { heroEmbedBoxSize } from "./icon-preview";

/** One diagnostics row — the per-icon truth behind the stroke system
 *  (same analysis + same factor math the renderer applies). */
export interface StrokeDiagnosticRow {
  icon: string;
  id: string;
  where: "grid" | "hero";
  viewBox: string;
  /** measured native effective stroke in SHEET-CANVAS px (0/— when the
   *  icon has no safely measurable adjustable artwork). */
  nativePx: number | null;
  /** the ACTIVE request: uniform target (absolute) or weight delta. */
  request: string;
  /** required correction = target − native (uniform) / delta (weight);
   *  "—" when unmeasurable. NEGATIVE corrections are preserved verbatim
   *  (they are the thinning direction — never abs()'d). */
  correctionPx: string;
  /** per-icon multiplicative factor the renderer applies. */
  factor: string;
  /** what the icon's artwork is made of. */
  capability: "stroke" | "fill-outline" | "solid-fill" | "mixed" | "unmeasurable";
  /** what the renderer actually does to it. */
  method: string;
  /** per-leaf outcome: supported (adjusted), limited (kept native —
   *  unsafe structure), partial, no-op or unmeasurable. */
  status: "supported" | "partial" | "limited" | "no-op" | "unmeasurable";
  /** the resulting effective stroke in canvas px ("—" unmeasurable,
   *  "native" when kept because it cannot be thinned non-destructively). */
  resultPx: string;
  /** round 9: the icon's per-cell exception target (canvas px) when it has
   *  one — null = the sheet-wide request. Drives the report's exception
   *  badges/filtering; the ROW's request string already reflects it. */
  exceptionTargetPx: number | null;
  /** round 12: the icon's per-cell WEIGHT exception (canvas px, relative
   *  mode) when it has one — null = the sheet-wide weight. Surfaced like
   *  exceptionTargetPx; dormant while uniform stroke is ON. */
  exceptionWeightPx: number | null;
}

function capabilityOf(report: {
  strokedLeaves: number;
  fillOutlineLeaves: number;
  solidFillLeaves: number;
  rootWidth: number;
}): StrokeDiagnosticRow["capability"] {
  if (
    !(report.rootWidth > 0) &&
    report.strokedLeaves === 0 &&
    report.fillOutlineLeaves === 0 &&
    report.solidFillLeaves === 0
  ) {
    return "unmeasurable";
  }
  if (report.strokedLeaves > 0 && (report.fillOutlineLeaves > 0 || report.solidFillLeaves > 0)) {
    return "mixed";
  }
  if (report.fillOutlineLeaves > 0) return "fill-outline";
  if (report.solidFillLeaves > 0) return "solid-fill";
  return "stroke";
}

/* heroBoxSize was deduplicated into icon-preview.ts's heroEmbedBoxSize —
 * the SAME exported helper the panel previews use (one implementation of
 * the hero embed-box math instead of two that could drift). */

/** The per-icon diagnostics table for a sheet (grid icons + hero row).
 *  Pure — safe to call anywhere, anytime; nothing is cached at this layer
 *  beyond the shared analysis caches. */
export function strokeDiagnosticRows(
  sheet: Sheet,
  icons: Record<string, IconEntry>
): StrokeDiagnosticRow[] {
  const icon = sheet.design.icon;
  const uniformOn = effectiveUniformStroke(icon);
  const targetPx = effectiveUniformTargetPx(icon);
  const deltaPx = effectiveStrokeWeightPx(icon);
  const request = uniformOn
    ? `uniform ${targetPx} px`
    : deltaPx === 0
      ? "none (native)"
      : `weight ${deltaPx >= 0 ? "+" : ""}${deltaPx} px`;

  const rows: StrokeDiagnosticRow[] = [];

  const pushRow = (entry: IconEntry, where: "grid" | "hero", boxSize: number): void => {
    /* per-icon exceptions (round 9 target + round 12 weight): resolve THIS
     *  icon's effective style the same way the renderer does
     *  (iconStyleForCell) so the request, the factor and the result column
     *  can never disagree with what renders */
    const cellOverride = sheet.cellOverrides?.[entry.id];
    const style = iconStyleForCell(icon, cellOverride);
    const exceptionTargetPx =
      cellOverride?.strokeTargetPx != null && Number.isFinite(cellOverride.strokeTargetPx)
        ? effectiveUniformTargetPx(style)
        : null;
    const exceptionWeightPx =
      cellOverride?.strokeWeightPx != null && Number.isFinite(cellOverride.strokeWeightPx)
        ? effectiveStrokeWeightPx(style)
        : null;
    /* round 12: the request is MODE-AWARE — the active system's exception
     *  (or the sheet-wide value) is what the row shows, so a dormant
     *  exception can never masquerade as the live request (a target
     *  exception while uniform is OFF / a weight exception while ON). */
    const rowRequest = uniformOn
      ? exceptionTargetPx != null
        ? `uniform ${exceptionTargetPx} px (exception)`
        : request
      : exceptionWeightPx != null
        ? exceptionWeightPx === 0
          ? "native (exception — pinned to original)"
          : `weight ${exceptionWeightPx >= 0 ? "+" : ""}${exceptionWeightPx} px (exception)`
        : request;
    const parsed = parseIcon(entry.svg);
    const native = analyzeNativeStroke(entry.svg);
    /* P7: THE shared embed plan (icon-fit.ts) — the same basis-corrected
     * factor the renderer applies, so the request/factor/result columns
     * can never disagree with what actually renders (the legacy viewBox
     * basis is kept only as the unmeasurable fallback inside the plan). */
    const plan = iconEmbedPlan(entry.svg, boxSize, style).plan;
    const capability = capabilityOf(native);
    const unmeasurable = plan.nativeVisualPx === 0;

    let correction = "—";
    if (!unmeasurable && uniformOn) {
      const rowTarget = exceptionTargetPx != null ? exceptionTargetPx : targetPx;
      const c = rowTarget - plan.nativeVisualPx;
      correction = `${c >= 0 ? "+" : ""}${Math.round(c * 100) / 100} px`;
    } else if (!unmeasurable) {
      /* round 12: the row's weight — the exception when one is active,
       *  else the sheet-wide delta (0 renders "—": factor 1, no request) */
      const rowDelta = exceptionWeightPx != null ? exceptionWeightPx : deltaPx;
      if (rowDelta !== 0) {
        correction = `${rowDelta >= 0 ? "+" : ""}${rowDelta} px`;
      }
    }

    let method: string;
    let result: string;
    let status: StrokeDiagnosticRow["status"];
    if (unmeasurable) {
      method = "kept native (unmeasurable)";
      result = "—";
      status = "unmeasurable";
    } else if (plan.factor === 1) {
      method = uniformOn ? "already at target (no-op)" : "native (no request)";
      result = `${Math.round(plan.nativeVisualPx * 100) / 100} px`;
      status = "no-op";
    } else if (plan.limitedFillLeaves > 0 && plan.adjustedLeaves === 0) {
      method = "kept native (unsafe subpath structure)";
      result = "native";
      status = "limited";
    } else if (plan.limitedFillLeaves > 0) {
      method = `partial — adjustable marks ×${Math.round(plan.factor * 1000) / 1000}, unsafe subpaths kept native`;
      result = "mixed";
      status = "partial";
    } else if (plan.factor < 1 && capability !== "stroke" && plan.thinnedFillLeaves > 0) {
      method = `erosion thinning ×${Math.round(plan.factor * 1000) / 1000} (Illustrator-style — every mark keeps its centerline and lands on factor·W as ONE single thinner line; geometry verbatim)`;
      result = `${Math.round(plan.factor * plan.nativeVisualPx * 100) / 100} px`;
      status = "supported";
    } else if (plan.factor > 1 && capability !== "stroke") {
      method = `per-part dilation +${Math.round((plan.factor - 1) * plan.nativeVisualPx * 100) / 100} px (mirrored-fill stroke per part — bands AND solids grow around their own contours, geometry untouched)`;
      result = `${Math.round(plan.factor * plan.nativeVisualPx * 100) / 100} px`;
      status = "supported";
    } else {
      method = `stroke-width ×${Math.round(plan.factor * 1000) / 1000}`;
      result = `${Math.round(plan.factor * plan.nativeVisualPx * 100) / 100} px`;
      status = "supported";
    }

    rows.push({
      icon: entry.fileName || entry.id,
      id: entry.id,
      where,
      viewBox: parsed ? `${parsed.viewBox[2]}×${parsed.viewBox[3]}` : "—",
      nativePx: unmeasurable ? null : Math.round(plan.nativeVisualPx * 100) / 100,
      request: rowRequest,
      correctionPx: correction,
      factor: unmeasurable ? "—" : `×${Math.round(plan.factor * 1000) / 1000}`,
      capability,
      method,
      status,
      resultPx: result,
      exceptionTargetPx,
      exceptionWeightPx,
    });
  };

  const cell = representativeGridIconBox(sheet);
  if (cell > 0) {
    for (const id of sheet.iconIds) {
      const entry = icons[id];
      if (entry?.svg) pushRow(entry, "grid", cell);
    }
  }
  const heroEntry = sheet.heroIconId ? icons[sheet.heroIconId] : undefined;
  const heroBox = heroEmbedBoxSize(sheet);
  if (heroEntry?.svg && heroBox > 0) pushRow(heroEntry, "hero", heroBox);

  return rows;
}

/** Print the per-icon diagnostics table + a compact summary to the console
 *  (development/verification tooling — `window.__strokeDebug()`). */
export function logStrokeDiagnostics(sheet: Sheet, icons: Record<string, IconEntry>): void {
  const rows = strokeDiagnosticRows(sheet, icons);
  const icon = sheet.design.icon;
  const uniformOn = effectiveUniformStroke(icon);
  const targetPx = effectiveUniformTargetPx(icon);
  const deltaPx = effectiveStrokeWeightPx(icon);

  // (console output is the entire purpose of this tool)
  console.group(
    `%cStroke diagnostics — sheet "${sheet.name ?? sheet.id}"`,
    "font-weight:600"
  );
  console.info(
    uniformOn
      ? `UNIFORM STROKE ON — target ${targetPx} px (ABSOLUTE: correction = target − native per icon). Stored weight ${deltaPx >= 0 ? "+" : ""}${deltaPx} px is preserved but IGNORED (mutual exclusion).`
      : deltaPx === 0
        ? "No stroke request — native look."
        : `WEIGHT ${deltaPx >= 0 ? "+" : ""}${deltaPx} px (relative to each icon's own native; clamped ×0.25…×4 per icon). Uniform OFF.`
  );
  if (rows.length === 0) {
    console.info("(no icons on this sheet)");
  } else {
    console.table(rows);
    const hasRequest = uniformOn || deltaPx !== 0;
    if (!hasRequest) {
      console.info(
        `${rows.length} embeds · all at native (no stroke request) · ${rows.filter((r) => r.nativePx == null).length} unmeasurable (original look kept)`
      );
    } else {
      const atTarget = rows.filter((r) => /^\d/.test(r.resultPx)).length;
      const limited = rows.filter((r) => r.status === "limited" || r.status === "partial").length;
      const unmeasured = rows.filter((r) => r.nativePx == null).length;
      console.info(
        `${rows.length} embeds · ${atTarget} land on the requested width · ${limited} limited (unsafe structure — original look kept) · ${unmeasured} unmeasurable (original look kept)`
      );
    }
  }
  console.groupEnd();
}
