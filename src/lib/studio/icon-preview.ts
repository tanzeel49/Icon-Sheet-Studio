/**
 * ICON SHEET STUDIO — Styled single-icon previews (panel-side).
 *
 * The Properties panel's hero thumbnail and hero-picker tiles previously
 * rendered the RAW original SVGs — while the sheet itself renders the
 * STYLED artwork (stroke weight / uniform target / tint). A user setting
 * "Uniform 5 px + tint" saw thin dark originals in the panel next to a
 * bold tinted sheet: the classic "UI state ≠ rendered state" gap.
 *
 * This module closes it WITHOUT touching the render pipeline: the SAME
 * engine functions the sheet renderer uses (analyzeNativeStroke →
 * computeStrokeAdjustment → adjustIconStrokes → tintIconArtwork, all pure
 * + cached) are applied to a standalone preview `<svg>`. The preview is
 * geometry-safe by construction — every guarantee of icon-style.ts holds
 * (original source immutable, appearance-only overrides, verbatim `d`).
 *
 * The per-icon factor is computed against the sheet's REAL embed box
 * (grid cell for sheet icons, hero card for the hero) so the preview's
 * visual weight is the sheet's visual weight, then the whole SVG scales
 * to the requested display size — exactly like zooming the sheet.
 */

import type { CellOverride, IconEntry, Sheet, SheetDesign } from "./types";
import { effectiveTintIcons, iconStyleForCell } from "./types";
import { parseIcon, namespaceIds, escapeXml } from "./svg";
import {
  adjustIconStrokes,
  applyRootTint,
  resolveRootStrokeWidthUnits,
  scaleRootStrokeWidth,
  tintIconArtwork,
} from "./icon-style";
import { iconEmbedPlan, iconInkBounds } from "./icon-fit";
import { representativeGridIconBox } from "./stroke-migration";
import { sheetTemplate } from "./templates";
import { heroIconBoxSize, heroUsableRect } from "./hero-fit";

/** Hero icon embed box size (canvas px) — the SAME math the renderer uses,
 *  now delegated to the shared P5 fitting engine (hero-fit.ts): card/slot
 *  bounds → usable area (− padding) → square embed × clamped iconScale.
 *  0 when the sheet has no hero embed. */
export function heroEmbedBoxSize(sheet: Sheet): number {
  const tpl = sheetTemplate(sheet);
  if (!tpl) return 0;
  const hero = sheet.design.hero;
  if (tpl.custom) {
    const slot = tpl.custom.heroSlot;
    const base =
      hero.customHeroCard === true
        ? Math.max(hero.cardSize, 1)
        : slot
          ? Math.max(Math.min(slot.width, slot.height), 1)
          : 0;
    if (base <= 0) return 0;
    const bounds = slot ? { x: slot.x, y: slot.y, width: base, height: base } : { x: 0, y: 0, width: base, height: base };
    return heroIconBoxSize(heroUsableRect(bounds, hero), hero);
  }
  const bounds = { x: 0, y: 0, width: Math.max(hero.cardSize, 1), height: Math.max(hero.cardSize, 1) };
  return heroIconBoxSize(heroUsableRect(bounds, hero), hero);
}

/* ---- output cache ----------------------------------------------------
 * The expensive inner steps (analysis, stroke adjustment, tint) are already
 * cached inside icon-style.ts; this LRU only avoids re-assembling the same
 * standalone svg string (regex parse + attribute concat) on every panel
 * render while a slider drags. Keyed by everything that affects the output. */
const PREVIEW_CAP = 600;
const previewCache = new Map<string, string>();

/* tintColor satisfies the required field but is NEVER consulted: tintIcons
 * is absent ⇒ OFF, so previews with this base always keep original colors. */
const NO_STROKE_STYLE: SheetDesign["icon"] = { tintColor: "#000000" };

/**
 * A standalone, sheet-styled preview SVG for one icon.
 *
 * @param entry     the library icon (source of truth — never modified)
 * @param iconStyle the sheet's icon design (stroke weight / uniform /
 *                  tint settings — the SAME state the sheet renders with)
 * @param opts.boxSize  the REAL sheet-canvas embed box the icon renders at
 *                  (grid cell or hero box) — the factor is computed against
 *                  it so the preview's visual weight matches the sheet;
 *                  defaults to a no-request neutral preview when 0/unknown.
 * @param opts.size     display size in px for the returned svg (default 64).
 * @param opts.colorOverride  hero color override (wins over the sheet tint,
 *                  exactly like the renderer's hero embed).
 * @param opts.keyPrefix  deterministic id-namespacing prefix (default:
 *                  `prev-{icon id}` — same icon + same style ⇒ same ids,
 *                  so duplicates in one document resolve to identical
 *                  paints and stay visually correct).
 * @param opts.cellOverride  the icon's per-cell exception record (round 9
 *                  target / round 12 weight) — a strokeTargetPx or
 *                  strokeWeightPx here overrides the sheet-wide control
 *                  exactly like the sheet renderer would for that cell, so
 *                  panel previews can never disagree with the sheet
 *                  artwork.
 * @returns a complete `<svg …>…</svg>` string, or "" when the source
 *          cannot be parsed (the caller falls back to the raw original).
 */
export function styledIconPreviewSvg(
  entry: IconEntry,
  iconStyle: SheetDesign["icon"] | undefined,
  opts: {
    boxSize?: number;
    size?: number;
    colorOverride?: string | null;
    cellOverride?: CellOverride;
    keyPrefix?: string;
  } = {}
): string {
  const base = iconStyle ?? NO_STROKE_STYLE;
  const style = iconStyleForCell(base, opts.cellOverride);
  const size = opts.size ?? 64;
  const boxSize = opts.boxSize && opts.boxSize > 0 ? opts.boxSize : 0;

  const parsed = parseIcon(entry.svg);
  if (!parsed) return "";
  const [, , vbW, vbH] = parsed.viewBox;
  const [vbX, vbY] = parsed.viewBox;

  /* -- factor: THE shared embed plan (icon-fit.ts) — the same basis-corrected
   *  computation the sheet renderer applies, so the preview's visual weight
   *  is the sheet's visual weight. boxSize 0 = unknown box → neutral preview,
   *  no request computed (factor 1) — but the ink viewport below still uses
   *  the measured bounds (the library's original-look tiles get the SAME
   *  full-visibility viewport the sheet's fit guarantees). */
  let factor = 1;
  let ink: { x: number; y: number; width: number; height: number } | null = null;
  if (boxSize > 0) {
    const embed = iconEmbedPlan(entry.svg, boxSize, style);
    factor = embed.plan.factor;
    ink = embed.ink;
  } else {
    ink = iconInkBounds(entry.svg, 1);
  }

  const tintColor =
    opts.colorOverride != null
      ? opts.colorOverride
      : effectiveTintIcons(style)
        ? style.tintColor
        : null;

  const cacheKey = `${entry.id}|${factor}|${tintColor ?? "-"}|${size}`;
  const cached = previewCache.get(cacheKey);
  if (cached !== undefined) {
    previewCache.delete(cacheKey);
    previewCache.set(cacheKey, cached); // LRU refresh
    return cached;
  }

  let content = parsed.inner;
  const rootStyle: Record<string, string> = { ...parsed.rootStyle };
  /* Percentage root stroke-widths resolve against the icon's OWN viewBox
   * diagonal — identical to the sheet renderer's embed behavior. */
  resolveRootStrokeWidthUnits(rootStyle, parsed.viewBox);
  if (factor !== 1) {
    content = adjustIconStrokes(content, rootStyle, parsed.viewBox, factor);
    scaleRootStrokeWidth(rootStyle, factor, parsed.viewBox);
  }
  if (tintColor) {
    applyRootTint(rootStyle, tintColor);
    content = tintIconArtwork(content, rootStyle, tintColor);
  }
  const prefix = opts.keyPrefix ?? `prev-${entry.id.replace(/[^a-zA-Z0-9-]/g, "")}-`;
  content = namespaceIds(content, prefix);

  const rootAttrs = Object.entries(rootStyle)
    .map(([k, v]) => ` ${k}="${escapeXml(v)}"`)
    .join("");
  /* P7: the preview viewport is the icon's EFFECTIVE VISUAL (ink) bounds at
   * the applied factor — the SAME region the sheet's embed box fits. The old
   * viewport (the declared viewBox) hard-clipped artwork that extends past
   * the viewBox and stroke expansion beyond it: the exact “uniform 7 px →
   * icon partially cut off, normal → fully visible” preview regression.
   * Unmeasurable icons keep the viewBox viewport (previous look). */
  const fit = ink ?? { x: vbX, y: vbY, width: vbW, height: vbH };
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${round4(fit.x)} ${round4(fit.y)} ${round4(fit.width)} ${round4(fit.height)}"` +
    ` width="${size}" height="${size}"${rootAttrs}>${content}</svg>`;

  if (previewCache.size >= PREVIEW_CAP) {
    const oldest = previewCache.keys().next().value;
    if (oldest !== undefined) previewCache.delete(oldest);
  }
  previewCache.set(cacheKey, svg);
  return svg;
}

/** The sheet's REAL grid icon embed box (canvas px) for preview factor
 *  computation — the shared lattice helper (computeGrid + cell padding +
 *  icon scale; custom templates: first detected slot). */
export function sheetGridIconBox(sheet: Sheet): number {
  return representativeGridIconBox(sheet);
}

function round4(n: number): number {
  const f = Math.pow(10, 4);
  return Math.round(n * f) / f;
}
