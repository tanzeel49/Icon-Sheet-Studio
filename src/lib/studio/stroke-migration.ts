/**
 * ICON SHEET STUDIO — Legacy stroke-state migration (px era).
 *
 * The stroke system exposes TWO px controls, MUTUALLY EXCLUSIVE (exactly
 * one is active per rendering — uniform ON ⇒ the stored weight delta is
 * preserved but ignored; uniform OFF ⇒ the plain weight delta applies and
 * the target is preserved): the plain "Icon stroke weight" delta
 * (strokeWeightPx, −100…+100 canvas px around each icon's OWN native look)
 * and the optional "Uniform stroke" checkbox (uniformStroke +
 * uniformTargetPx — an ABSOLUTE target: per icon factor = target /
 * nativeVisual, never an amount added). Designs persisted by older UIs may
 * still carry legacy fields; they migrate WITHOUT losing the saved
 * appearance:
 *
 *   · strokeMode "normalize" (+ normalizeTargetPx) — the old two-mode
 *     "Normalize" — maps EXACTLY onto the uniform-stroke feature: the
 *     renderer applies the same per-icon normalization (read-time fallback
 *     in effectiveUniformStroke/effectiveUniformTargetPx), the UI shows
 *     the checkbox ON with the stored target and the weight slider at 0
 *     (the weight was stored-but-unused under normalize). Appearance and
 *     UI are both honest; the first stroke edit rewrites the design onto
 *     the current fields and clears the legacy ones.
 *
 *   · strokeWeightPct / weightScale — the single-control % era — keeps its
 *     EXACT saved multiplicative look via the renderer's dormant fallback
 *     until the first stroke edit. The px slider still needs an honest
 *     value to SHOW: `legacyPctEquivalentPx` derives the best single px
 *     delta from the sheet's ACTUAL icons (median native visual stroke ×
 *     (legacy factor − 1)), so the first drag starts where the artwork
 *     currently is and the design transitions continuously onto the px
 *     model instead of jumping.
 *
 *   · When a legacy NORMALIZE sheet is switched OFF (uniform unchecked),
 *     `legacyNormalizeEquivalentPx` provides the weight delta that keeps
 *     the look continuous: per icon, the legacy render lands at exactly
 *     the target, so the equivalent delta is (factor_i − 1) · native_i
 *     (= target − nativeVisual_i); the MEDIAN over the sheet's icons is
 *     the single best value.
 *
 * Everything here is pure analysis of the immutable source SVGs (cached,
 * deterministic); nothing ever mutates icon geometry.
 */

import type { IconEntry, IconStyle, Sheet } from "./types";
import {
  STROKE_WEIGHT_PX_MAX,
  STROKE_WEIGHT_PX_MIN,
  UNIFORM_TARGET_PX_MAX,
  UNIFORM_TARGET_PX_MIN,
  effectiveNormalizeTargetPx,
  effectiveStrokeWeightPx,
  strokeWeightFactor,
} from "./types";
import { parseIcon } from "./svg";
import { analyzeNativeStroke } from "./icon-style";
import { computeGrid } from "./renderer";
import { sheetTemplate } from "./templates";

/** True while a persisted design still carries the legacy two-mode
 *  "normalize" state (maps onto the uniform-stroke feature until edited). */
export function isLegacyNormalizeMode(icon: IconStyle): boolean {
  return icon.strokeMode === "normalize";
}

/** True while a persisted design predates the px model (neither
 *  strokeWeightPx nor uniformStroke present) — the renderer's dormant %
 *  fallback is active and the UI shows a derived equivalent value. */
export function isLegacyPctMode(icon: IconStyle): boolean {
  return icon.strokeWeightPx == null && icon.uniformStroke == null;
}

/** Representative GRID icon embed box size for a sheet, in canvas px — the
 *  same lattice math the renderer uses (computeGrid + cell padding +
 *  icon scale; custom templates: first detected slot). Falls back to 0
 *  when the template/geometry yields nothing usable. */
export function representativeGridIconBox(sheet: Sheet): number {
  const tpl = sheetTemplate(sheet);
  if (!tpl) return 0;
  const grid = computeGrid(tpl, sheet.design);
  if (grid.slots && grid.slots.length > 0) {
    const slot = grid.slots[0];
    return Math.min(slot.width, slot.height) * (sheet.design.spacing.iconScale ?? 0.8);
  }
  return (
    grid.cell *
    (1 - sheet.design.spacing.cellPadding * 2) *
    (sheet.design.spacing.iconScale ?? 0.86)
  );
}

interface NativeVisual {
  /** measured native width in ICON ROOT units (> 0), or null when the icon
   *  has no measurable adjustable artwork. */
  rootWidth: number | null;
  /** that width converted into SHEET-CANVAS px via the sheet's real grid
   *  embed box (rootWidth · boxSize / viewBox), or null. */
  visualPx: number | null;
}

/** Per-icon native stroke analysis resolved against this sheet's real grid
 *  embed box (pure + cached at the analysis level). */
function nativeVisualFor(entry: IconEntry, boxSize: number): NativeVisual {
  if (!(boxSize > 0) || !Number.isFinite(boxSize)) return { rootWidth: null, visualPx: null };
  const native = analyzeNativeStroke(entry.svg); // cached, pure
  if (!(native.rootWidth > 0) || !Number.isFinite(native.rootWidth)) {
    return { rootWidth: null, visualPx: null };
  }
  const parsed = parseIcon(entry.svg); // regex-based, cheap
  if (!parsed) return { rootWidth: null, visualPx: null };
  const maxDim = Math.max(parsed.viewBox[2], parsed.viewBox[3]) || 24;
  const visualPx = (native.rootWidth * boxSize) / maxDim;
  if (!Number.isFinite(visualPx) || !(visualPx > 0)) return { rootWidth: null, visualPx: null };
  return { rootWidth: native.rootWidth, visualPx };
}

function clampPx(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.round(Math.min(STROKE_WEIGHT_PX_MAX, Math.max(STROKE_WEIGHT_PX_MIN, v)));
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * The px weight value a legacy % -era sheet should DISPLAY (and migrate
 * from): the legacy render multiplies every icon by ONE uniform factor
 * f = strokeWeightFactor (clamped 0.25…2). The equivalent single px delta
 * is (f − 1) · median(nativeVisual_i) — the delta that, applied through
 * the per-icon px engine, best reproduces the same look for the typical
 * icon on the sheet (icons with different natives deviate only in the
 * per-icon detail the legacy model never captured). Clamped to the
 * control's ±100 px range; sheets with no measurable icons show 0.
 */
export function legacyPctEquivalentPx(
  sheet: Sheet,
  icons: Record<string, IconEntry>
): number {
  if (!isLegacyPctMode(sheet.design.icon) || isLegacyNormalizeMode(sheet.design.icon)) {
    return 0;
  }
  const f = strokeWeightFactor(sheet.design.icon);
  if (f === 1) return 0;
  const boxSize = representativeGridIconBox(sheet);
  if (!(boxSize > 0)) return 0;
  const visuals: number[] = [];
  for (const id of sheet.iconIds) {
    const entry: IconEntry | undefined = icons[id];
    if (!entry) continue;
    const { visualPx } = nativeVisualFor(entry, boxSize);
    if (visualPx != null) visuals.push(visualPx);
  }
  const med = median(visuals);
  if (med == null) return 0;
  return clampPx((f - 1) * med);
}

/**
 * The px weight delta that keeps a legacy NORMALIZE sheet's look
 * continuous when the user switches uniform stroke OFF: the legacy render
 * lands every measurable icon at exactly the stored target, so the
 * equivalent delta per icon is (f_i − 1) · nativeVisual_i = target −
 * nativeVisual_i; the MEDIAN is the single best value. Clamped to ±100 px.
 */
export function legacyNormalizeEquivalentPx(
  sheet: Sheet,
  icons: Record<string, IconEntry>
): number {
  if (!isLegacyNormalizeMode(sheet.design.icon)) return 0;
  const targetPx = effectiveNormalizeTargetPx(sheet.design.icon);
  const boxSize = representativeGridIconBox(sheet);
  if (!(boxSize > 0)) return 0;
  const deltas: number[] = [];
  for (const id of sheet.iconIds) {
    const entry: IconEntry | undefined = icons[id];
    if (!entry) continue;
    const { visualPx } = nativeVisualFor(entry, boxSize);
    if (visualPx != null) deltas.push(targetPx - visualPx);
  }
  const med = median(deltas);
  if (med == null) return 0;
  return clampPx(med);
}

/**
 * FULL migration onto the current stroke model (called from the properties
 * panel on every stroke edit — weight drag, uniform toggle, target change).
 * Writes the three current fields and REMOVES every legacy stroke field
 * (delete — not undefined assignment — so IndexedDB's structured clone
 * stops persisting the keys at all). Pure draft mutation; the caller's
 * update pipeline handles history/persistence.
 */
export function applyStrokeModel(
  icon: IconStyle,
  weightPx: number,
  uniform: boolean,
  targetPx: number
): void {
  icon.strokeWeightPx = clampPx(weightPx);
  icon.uniformStroke = uniform === true;
  /* Absolute target, 0.5…100, kept to ONE decimal — a sub-1 px target
   * (0.5) is a real, representable request (the mandatory thinning
   * test); it must never round up to 1. */
  icon.uniformTargetPx =
    Math.round(
      Math.min(UNIFORM_TARGET_PX_MAX, Math.max(UNIFORM_TARGET_PX_MIN, Number.isFinite(targetPx) ? targetPx : 2)) * 10
    ) / 10;
  delete icon.strokeWeightPct;
  delete icon.weightScale;
  delete icon.strokeMode;
  delete icon.normalizeTargetPx;
  delete icon.normalizeWeight;
}

/** Display value for the px weight slider (memoized by the panel):
 *  current designs read their stored value; legacy % -era designs show the
 *  derived equivalent; legacy normalize designs show 0 (the weight was
 *  stored-but-unused — the uniform checkbox + target explain the look). */
export function displayStrokeWeightPx(
  sheet: Sheet,
  icons: Record<string, IconEntry>
): number {
  const icon = sheet.design.icon;
  if (!isLegacyPctMode(icon)) return effectiveStrokeWeightPx(icon);
  if (isLegacyNormalizeMode(icon)) return 0;
  return legacyPctEquivalentPx(sheet, icons);
}
