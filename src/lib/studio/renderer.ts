/**
 * ICON SHEET STUDIO — THE rendering engine.
 * One renderer powers preview, thumbnails, SVG export and PNG export.
 *
 *   Sheet State → Template Definition → Icon Data → Design State → SVG
 *
 * Pure function: renderSheet(sheet, template, icons, options) → svg string.
 */

import type { IconEntry, Rect, RegionKey, Sheet, SheetDesign, TemplateDef, TemplateRail, TextStyle, GradientFill, RailStyle, CellOverride } from "./types";
import { fitTitle, centeredBlockTop, titleBaselines, measureTextWidth, wrapLinesToWidth } from "./title-fit";
import { formatVolume, effectiveTintIcons, iconStyleForCell } from "./types";
import { escapeXml, namespaceIds, parseIcon } from "./svg";
import {
  adjustIconStrokes,
  applyRootTint,
  resolveRootStrokeWidthUnits,
  scaleRootStrokeWidth,
  tintIconArtwork,
} from "./icon-style";
import { iconEmbedPlan } from "./icon-fit";
import { renderCustomArtwork } from "./custom-template";
import { heroEnabled, heroIconBoxSize, heroUsableRect, resolveHeroIconId } from "./hero-fit";

export interface RenderOptions {
  /** preview adds guides/highlights; export stays clean */
  mode?: "preview" | "export";
  showGuides?: boolean;
  highlightRegion?: RegionKey | null;
  selectedIconId?: string | null;
  /** index of cell icons should start from (sheet position) */
  quality?: "full" | "thumb";
}

interface Box {
  x: number;
  y: number;
  size: number;
}

/* ------------------------------------------------------------------ */
/* Per-cell overrides (skip / card color)                              */
/* ------------------------------------------------------------------ */

/** Is this icon's cell skipped on the sheet? (visual hole, export-safe) */
function isCellSkipped(sheet: Sheet, iconId: string): boolean {
  return sheet.cellOverrides?.[iconId]?.skip === true;
}

/** Per-cell card fill override (solid color) — null = sheet default. */
function cellCardColor(sheet: Sheet, iconId: string): string | null {
  const color = sheet.cellOverrides?.[iconId]?.cardColor;
  return typeof color === "string" && color.trim() !== "" ? color : null;
}

/** Per-cell card GRADIENT override (round 12) — null = no gradient. Wins
 *  over the solid override by renderer convention (the picker keeps the two
 *  mutually exclusive, this is just belt-and-braces for restored/edited
 *  data that carries both). */
function cellCardGradient(sheet: Sheet, iconId: string): GradientFill | null {
  const g = sheet.cellOverrides?.[iconId]?.cardGradient;
  if (!g || !g.from || !g.to || typeof g.angle !== "number") return null;
  return g;
}

/** Dashed-outline + diagonal-cross marker rects for skipped cells.
 *  Preview-mode only — never rendered into exports or overview thumbs. */
function skippedCellOverlays(
  sheet: Sheet,
  resolveBoxes: () => Array<{ x: number; y: number; w: number; h: number }>
): string[] {
  let skipped = 0;
  for (const id of sheet.iconIds) if (isCellSkipped(sheet, id)) skipped++;
  if (skipped === 0) return [];
  const parts: string[] = [];
  for (const b of resolveBoxes()) {
    const x = round(b.x);
    const y = round(b.y);
    const w = round(b.w);
    const h = round(b.h);
    parts.push(
      `<g id="SkippedCellMark"><rect x="${x + 2}" y="${y + 2}" width="${Math.max(0, w - 4)}" height="${Math.max(0, h - 4)}" fill="none" stroke="#78716C" stroke-width="2" stroke-dasharray="8 6" opacity="0.7" rx="6"/>` +
        `<line x1="${x + 6}" y1="${y + 6}" x2="${x + w - 6}" y2="${y + h - 6}" stroke="#78716C" stroke-width="2" opacity="0.5"/>` +
        `<line x1="${x + w - 6}" y1="${y + 6}" x2="${x + 6}" y2="${y + h - 6}" stroke="#78716C" stroke-width="2" opacity="0.5"/></g>`
    );
  }
  return parts;
}

/* ------------------------------------------------------------------ */
/* Rail resolution (user default sheets)                              */
/* ------------------------------------------------------------------ */

/** Design paint wins; sheets persisted before rails existed fall back to
 *  the owning template's rail paint. Returns null when the template has no
 *  rail (pre-rail templates render exactly as before). */
export function resolveRail(template: TemplateDef, design: SheetDesign): { geometry: TemplateRail; paint: RailStyle } | null {
  if (!template.rail) return null;
  const fallback = template.rail.defaults;
  const d = design.rail;
  const paint: RailStyle = d
    ? {
        visible: d.visible,
        from: d.from,
        to: d.to,
        angle: d.angle,
        ribbon: {
          visible: d.ribbon.visible,
          from: d.ribbon.from,
          to: d.ribbon.to,
          angle: d.ribbon.angle,
        },
        pills: {
          visible: d.pills.visible,
          color: d.pills.color,
          labelColor: d.pills.labelColor,
          labels: d.pills.labels,
        },
      }
    : fallback;
  return { geometry: template.rail, paint };
}

/* ------------------------------------------------------------------ */
/* Gradient helpers                                                    */
/* ------------------------------------------------------------------ */

/** userSpaceOnUse gradient endpoint pair for a bbox + angle.
 *  angle 0 = left→right, 90 = top→bottom, -45 = bottom-left → top-right. */
function gradientEndpoints(gradient: GradientFill, x: number, y: number, w: number, h: number) {
  const rad = (gradient.angle * Math.PI) / 180;
  const cx = x + w / 2;
  const cy = y + h / 2;
  const len = Math.abs(w * Math.cos(rad)) + Math.abs(h * Math.sin(rad));
  const dx = (Math.cos(rad) * len) / 2;
  const dy = (Math.sin(rad) * len) / 2;
  return { x1: round(cx - dx), y1: round(cy - dy), x2: round(cx + dx), y2: round(cy + dy) };
}

function linearGradientDef(id: string, gradient: GradientFill, x: number, y: number, w: number, h: number): string {
  const p = gradientEndpoints(gradient, x, y, w, h);
  return (
    `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${p.x1}" y1="${p.y1}" x2="${p.x2}" y2="${p.y2}">` +
    `<stop offset="0" stop-color="${gradient.from}"/><stop offset="1" stop-color="${gradient.to}"/>` +
    `</linearGradient>`
  );
}

/* ------------------------------------------------------------------ */
/* Region resolution with sheet geometry overrides                     */
/* ------------------------------------------------------------------ */

export function resolveRegion(
  template: TemplateDef,
  design: SheetDesign,
  key: RegionKey
): Rect {
  const base = template.regions[key];
  const ov = design.geometryOverrides[key];
  if (!ov) return { ...base };
  return {
    x: ov.x ?? base.x,
    y: ov.y ?? base.y,
    width: ov.width ?? base.width,
    height: ov.height ?? base.height,
  };
}

/* ------------------------------------------------------------------ */
/* Grid math — fully derived from the template, no capacity hacks      */
/* ------------------------------------------------------------------ */

export interface GridLayout {
  cell: number;
  gap: number;
  originX: number;
  originY: number;
  cols: number;
  rows: number;
  /** Present ONLY for user-imported templates: the exact detected slot
   *  rectangles (arbitrary positions/sizes — irregular grids, asymmetric
   *  layouts). Consumers place icons by slots[i] instead of lattice math. */
  slots?: Rect[];
}

export function computeGrid(template: TemplateDef, design: SheetDesign): GridLayout {
  /* user-imported template — the detected slots ARE the grid */
  if (template.sourceType === "custom" && template.custom) {
    const slots = template.custom.iconSlots;
    return {
      cell: slots.length ? Math.min(slots[0].width, slots[0].height) : 0,
      gap: 0,
      originX: slots.length ? slots[0].x : 0,
      originY: slots.length ? slots[0].y : 0,
      cols: slots.length,
      rows: 1,
      slots,
    };
  }
  const region = resolveRegion(template, design, "grid");
  const { cols, rows } = template.grid;
  const gap = design.spacing.gap;
  const cell = Math.min(
    (region.width - (cols - 1) * gap) / cols,
    (region.height - (rows - 1) * gap) / rows
  );
  const usedW = cols * cell + (cols - 1) * gap;
  const usedH = rows * cell + (rows - 1) * gap;
  return {
    cell,
    gap,
    cols,
    rows,
    originX: region.x + (region.width - usedW) / 2,
    originY: region.y + (region.height - usedH) / 2,
  };
}

/* ------------------------------------------------------------------ */
/* Text helpers                                                        */
/* ------------------------------------------------------------------ */

/** REAL text measurement (canvas measureText with the block's family /
 * weight / spacing / italic). Falls back to the conservative character
 * heuristic only outside the browser — the wrap quality upgrade applies
 * to every text block (round 17). */
function measureLine(line: string, style: TextStyle): number {
  return measureTextWidth(line, {
    fontFamily: style.fontFamily,
    fontSize: style.fontSize,
    fontWeight: style.fontWeight,
    letterSpacing: style.letterSpacing,
    italic: style.fontStyle === "italic",
  });
}

/** Wrap text to a max width. MANUAL line breaks (`\n`) are structural:
 *  each line is wrapped independently and every break is preserved —
 *  auto-wrapping may only ADD lines below a too-long manual line, never
 *  remove or merge the user's breaks. (round 17: real measurement.) */
export function wrapText(text: string, maxWidth: number, style: TextStyle): string[] {
  return wrapLinesToWidth(text, maxWidth, {
    fontFamily: style.fontFamily,
    fontSize: style.fontSize,
    fontWeight: style.fontWeight,
    letterSpacing: style.letterSpacing,
    italic: style.fontStyle === "italic",
  });
}

function renderTextBlock(
  rawText: string,
  region: Rect,
  style: TextStyle
): string {
  /* round 24 — visibility master switch: a hidden block renders NOTHING
   * (no <text> nodes in preview or export), identical to backgroundVisible
   * semantics. undefined → visible (legacy designs unchanged). */
  if (style.visible === false) return "";
  const text = style.uppercase ? rawText.toUpperCase() : rawText;
  const lines = wrapText(text, region.width, style);
  const anchorX =
    style.align === "start" ? region.x + style.offsetX
    : style.align === "middle" ? region.x + region.width / 2 + style.offsetX
    : region.x + region.width + style.offsetX;
  const anchor = style.align === "start" ? "start" : style.align === "middle" ? "middle" : "end";
  const fontStyleAttr = style.fontStyle === "italic" ? ` font-style="italic"` : "";
  const parts: string[] = [];
  lines.forEach((line, i) => {
    const y = region.y + style.offsetY + style.fontSize * (0.8 + i * style.lineHeight);
    parts.push(
      `<text x="${round(anchorX)}" y="${round(y)}" font-family="${escapeXml(style.fontFamily)}" font-size="${style.fontSize}" font-weight="${style.fontWeight}"${fontStyleAttr} letter-spacing="${style.letterSpacing}" fill="${style.color}" text-anchor="${anchor}" xml:space="preserve">${escapeXml(line)}</text>`
    );
  });
  return parts.join("");
}

/** SMART AUTO-FIT TITLE BLOCK (round 17). The font size and the line
 *  layout come from fitTitle() — bounded binary search over REAL text
 *  measurements inside the region's safe inset. The COMPLETE block is
 *  vertically centered in the safe area (balanced space above/below);
 *  horizontally it follows the style's alignment within the safe area.
 *  Manual line breaks are preserved verbatim; every other line is a
 *  natural word wrap. Falls back to the classic layout when the region
 *  is degenerate or the text empty. Zoom-safe by construction: all
 *  geometry is template units, so the exported SVG matches the preview
 *  exactly. */
function renderTitleBlock(
  rawText: string,
  region: Rect,
  style: TextStyle
): string {
  /* round 24 — visibility master switch (same semantics as every other
   * text block; checked BEFORE the fit engine so a hidden title costs
   * nothing and never emits <text> nodes). */
  if (style.visible === false) return "";
  const fit = fitTitle(rawText, region, style);
  if (!fit.fitted || fit.lines.length === 0) {
    return renderTextBlock(rawText, region, style);
  }
  const anchorX =
    style.align === "start" ? fit.safe.x + style.offsetX
    : style.align === "middle" ? fit.safe.x + fit.safe.width / 2 + style.offsetX
    : fit.safe.x + fit.safe.width + style.offsetX;
  const anchor = style.align === "start" ? "start" : style.align === "middle" ? "middle" : "end";
  const fontStyleAttr = style.fontStyle === "italic" ? ` font-style="italic"` : "";
  const blockTop = centeredBlockTop(fit, style.offsetY);
  const baselines = titleBaselines(blockTop, fit);
  const parts: string[] = [];
  fit.lines.forEach((line, i) => {
    parts.push(
      `<text x="${round(anchorX)}" y="${round(baselines[i])}" font-family="${escapeXml(style.fontFamily)}" font-size="${round(fit.fontSize)}" font-weight="${style.fontWeight}"${fontStyleAttr} letter-spacing="${style.letterSpacing}" fill="${style.color}" text-anchor="${anchor}" xml:space="preserve">${escapeXml(line)}</text>`
    );
  });
  return parts.join("");
}

/* ------------------------------------------------------------------ */
/* Icon embedding                                                      */
/* ------------------------------------------------------------------ */

function embedIcon(
  icon: IconEntry,
  /** SHEET-SCOPED embed uid ("sh12-c0" / "sh12-hero") — the namespaceIds()
   *  prefix that makes every id inside this embed (the icon's OWN
   *  defs / gradients / clipPaths AND the stroke engine's thinning masks
   *  ist1, ist2…) unique not only within the sheet but across ALL sheet
   *  SVGs rendered into one document (overview cards + multi-sheet
   *  artboards). The stroke engine generates deterministic ids only for
   *  its erosion masks — everything else is the icon's own ids, all
   *  namespaced, collision-free in every view. */
  uid: string,
  box: Box,
  iconStyle: SheetDesign["icon"],
  opts: { colorOverride?: string | null; cellOverride?: CellOverride } = {}
): string {
  const parsed = parseIcon(icon.svg);
  if (!parsed) return "";
  const [, , vbW, vbH] = parsed.viewBox;
  const vbX = parsed.viewBox[0];
  const vbY = parsed.viewBox[1];

  /* Per-icon stroke exception (round 9): the ONE resolver every consumer
   *  uses — preview, export and report can never disagree. No exception ⇒
   *  the SAME object reference (zero allocation, identical behavior). */
  const style = iconStyleForCell(iconStyle, opts.cellOverride);

  let content = parsed.inner;
  /* The source root <svg>'s presentation attributes are re-applied on the
   * wrapper below; this object is the WORKING copy that receives the
   * stroke/tint adjustments, so root + children always agree. */
  const rootStyle: Record<string, string> = { ...parsed.rootStyle };

  /* -- stroke: TWO MUTUALLY EXCLUSIVE controls, both in px ------------
   * Exactly ONE stroke system affects a rendering at a time (enforced HERE
   * at the engine level — computeStrokeAdjustment — so no state can ever
   * double-apply; the panel mirrors this by disabling the weight control
   * while uniform is ON).
   *
   * "Icon stroke weight" (uniform OFF — the ACTIVE system): strokeWeightPx,
   * −100…+100 canvas px, 0 = the EXACT original, is NOT a blind global
   * stroke-width: each icon is analyzed individually (analyzeNativeStroke —
   * cached, deterministic, pure analysis of the immutable source) and
   * receives its OWN factor against THIS embed's real scale via
   * computeStrokeAdjustment — the SAME computation the Appearance status
   * UI uses (one source of truth, the panel can never disagree with the
   * render):
   *     nativeVisual = rootWidth · embedScale      (canvas px)
   *     factor = clamp(1 + delta / nativeVisual, 0.25, 4)
   * so icons with native strokes of 2 / 4 / 8 px at +2 px land at ≈4 / ≈6 /
   * ≈10 px, and a 1 px icon at −20 px clamps safely to the 0.25 floor
   * while the UI keeps showing the requested adjustment — negative
   * widths, NaN and Infinity can never reach the SVG. delta = 0
   * short-circuits to factor 1 → byte-exact original.
   *
   * "Uniform stroke" (uniform ON — the ONLY active system): brings every
   * SUPPORTED icon toward ONE absolute target — factor = target /
   * nativeVisual per icon (the target is what the stroke should BECOME,
   * never an amount to add: Icon A native 1 → +4 at target 5, Icon B
   * native 8 → −3). The stored weight delta is PRESERVED but deliberately
   * ignored while uniform is ON — no hidden target+delta composition (the
   * old composition made weight +8 with target 5 silently render 13 px —
   * exactly the "the target looks additive" regression). Switching uniform
   * OFF reactivates the stored weight value unchanged. BIDIRECTIONAL,
   * both controls, both artwork classes, with ILLUSTRATOR stroke-weight
   * semantics: true strokes multiply their width (thinner below ×1 /
   * thicker above); fill-based artwork — bands AND solids — thickens via
   * a mirrored-fill paint-order stroke (factor > 1) and THINS via the
   * erosion mask (factor < 1): every mark keeps its own centerline and
   * lands its visible width exactly on factor·T̂ as ONE single thinner /
   * thicker line, never a hollowed double outline (only the artwork's
   * own paint and black/white mask luminance are used; no knockout, no
   * background dependency). HONEST LIMITS: unmeasurable icons
   * (text-only / degenerate shapes / non-scaling strokes) keep their
   * exact look, never faked; structurally unmeasurable leaves keep
   * their native weight — reported (computeStrokeAdjustment).
   * Non-destructive on every icon: every emitted `d` is a verbatim
   * substring of the immutable source, anchor counts never change, and
   * the export contains only the user's own elements plus ONE erosion
   * mask per thinned leaf (the thinning mechanism itself) — ungroup in
   * Illustrator reveals nothing but the original artwork plus that
   * mask group. Every render starts from the pristine cached parse, so
   * changes can never accumulate (0 → +20 → −10 → 0 always returns to
   * the exact original native values).
   *
   * LEGACY fallback (backward compatibility only — never reachable from
   * the current UI): designs saved before the px model may still carry
   * strokeWeightPct / weightScale (single-control % era). Those sheets keep
   * their EXACT saved multiplicative look via the dormant % path until the
   * first stroke edit migrates them (properties-panel clears the legacy
   * fields). Designs saved with strokeMode "normalize" map onto the
   * uniform-stroke feature above (effectiveUniformStroke/TargetPx) with
   * weight 0 — the legacy per-icon normalization math is IDENTICAL (factor
   * = targetRoot / nativeRoot), so the saved appearance is preserved
   * verbatim. BOTH eras flow through the SAME factor engine (one source of
   * truth); preview and export share this code verbatim. */
  /* The ONE shared branch gate (strokeRequestActive — the same derivation
   * computeStrokeAdjustment applies internally): the engine can never run
   * the weight branch while the UI shows Uniform ON, and a no-request
   * state short-circuits to factor 1 → byte-exact original WITHOUT paying
   * the per-icon analysis pass. P7: the factor AND the icon's effective
   * visual (ink) bounds come from THE shared plan (icon-fit.ts) — the
   * basis-corrected factor lands px targets at the artwork's true render
   * scale, and the fit below uses the ink bounds so the COMPLETE visible
   * artwork (geometry ± stroke expansion at this factor) stays inside the
   * embed box. Slot/cell/card geometry is never touched. */
  const embed = iconEmbedPlan(icon.svg, box.size, style);
  const factor = embed.plan.factor;
  /* Embedding correctness: a percentage root stroke-width would resolve
   * against the SHEET viewport once the icon is a <g> — resolve it against
   * the icon's OWN viewBox diagonal on EVERY embed (factor 1 included). */
  resolveRootStrokeWidthUnits(rootStyle, parsed.viewBox);
  if (factor !== 1) {
    content = adjustIconStrokes(content, rootStyle, parsed.viewBox, factor);
    scaleRootStrokeWidth(rootStyle, factor, parsed.viewBox);
  }

  /* -- color ---------------------------------------------------------
   * colorOverride (hero icon color) wins over the sheet's tint flag. */
  const tintColor =
    opts.colorOverride != null
      ? opts.colorOverride
      : effectiveTintIcons(style)
        ? style.tintColor
        : null;
  if (tintColor) {
    applyRootTint(rootStyle, tintColor);
    content = tintIconArtwork(content, rootStyle, tintColor);
  }

  content = namespaceIds(content, `${uid}_`);

  const rootAttrs = Object.entries(rootStyle)
    .map(([k, v]) => ` ${k}="${escapeXml(v)}"`)
    .join("");

  /* -- P7 fitting: the icon's EFFECTIVE VISUAL bounds (artwork geometry ±
   * the stroke expansion at the applied factor — the region the user
   * actually sees) are fitted into the embed box with a UNIFORM scale and
   * centered on BOTH axes. The declared viewBox is only the fallback for
   * honestly-unmeasurable icons (text/`use` artwork, em/ex strokes) — the
   * previous behavior, byte-exact. This is what keeps the artwork fully
   * visible at every stroke weight / uniform target: thickening grows the
   * ink → the fit scale compensates (containment); thinning shrinks it →
   * the artwork keeps filling its cell; artwork ≠ viewBox (0–24 artwork
   * on 48-unit viewBoxes, artwork poking past a 20-unit viewBox) renders
   * at its TRUE size, centered — never half-size in a corner, never
   * clipped at the box edge. Aspect ratio is always preserved. */
  const ink = embed.ink;
  const fitW = ink ? ink.width : vbW;
  const fitH = ink ? ink.height : vbH;
  const fitX = ink ? ink.x : vbX;
  const fitY = ink ? ink.y : vbY;
  const fitMax = Math.max(fitW, fitH);
  const scale =
    fitMax > 0 && Number.isFinite(fitMax)
      ? box.size / fitMax
      : box.size / (Math.max(vbW, vbH) || 24);
  const drawW = fitW * scale;
  const drawH = fitH * scale;
  const tx = box.x + (box.size - drawW) / 2 - fitX * scale;
  const ty = box.y + (box.size - drawH) / 2 - fitY * scale;
  return `<g${rootAttrs} transform="translate(${round(tx)} ${round(ty)}) scale(${round(scale, 4)})">${content}</g>`;
}

function shadowFilter(id: string, blur: number, dx: number, dy: number, strength: number, color: string): string {
  return (
    `<filter id="${id}" x="-40%" y="-40%" width="180%" height="180%">` +
    `<feDropShadow dx="${dx}" dy="${dy}" stdDeviation="${blur / 2}" flood-color="${color}" flood-opacity="${strength}"/>` +
    `</filter>`
  );
}

function round(n: number, digits = 2): number {
  const f = Math.pow(10, digits);
  return Math.round(n * f) / f;
}

/* ------------------------------------------------------------------ */
/* Custom (user-imported) template rendering                           */
/* ------------------------------------------------------------------ */

/** Universal template path: the uploaded SVG is the visual MASTER —
 *  embedded with its original viewBox, proportions and every decorative
 *  element intact. When the template carries a role-annotated copy (v3,
 *  universal editing), the artwork is a TRANSFORMED clone in which ONLY the
 *  marked elements (background / grid cells / mapped texts) receive the
 *  sheet's design diffs — zero diffs renders the template exactly as
 *  uploaded. The renderer then places the hero icon and the grid icons on
 *  top; nothing is invented. */
function renderCustomSheet(
  sheet: Sheet,
  template: TemplateDef,
  icons: Record<string, IconEntry>,
  options: RenderOptions
): string {
  const custom = template.custom!;
  const design = sheet.design;
  const mode = options.mode ?? "preview";
  const W = template.width;
  const H = template.height;
  const rid = `sh${sheet.id.replace(/\D/g, "") || "0"}`;

  /* -- original artwork (transformed when the template is annotated) --- */
  const parsed = parseIcon(custom.sourceSvg);
  let artworkInner = parsed ? parsed.inner : "";
  if (custom.editableSvg) {
    const transformed = renderCustomArtwork(sheet, template);
    if (transformed != null) artworkInner = transformed;
  }
  const artwork = namespaceIds(artworkInner, `${rid}t_`);
  /* re-apply the source root <svg>'s whitelisted presentation attributes on
   * the wrapper group so inherited fills/strokes/etc. survive embedding —
   * the template's look must stay EXACTLY as uploaded (visual master). */
  const artworkRootAttrs = parsed
    ? Object.entries(parsed.rootStyle)
        .map(([k, v]) => ` ${k}="${escapeXml(v)}"`)
        .join("")
    : "";
  const parts: string[] = [`<g id="TemplateArtwork"${artworkRootAttrs}>${artwork}</g>`];

  /* -- hero icon + optional hero card (v3) ----------------------------
   * P5: the ONE shared fitting engine (hero-fit.ts) drives placement —
   * the same math the properties panel previews and the builder preview
   * use, so preview and final output can never disagree. The CARD is
   * fixed (hero.cardSize / the detected slot); Hero Icon Scale changes
   * ONLY the icon artwork, centered on the slot. The icon may outgrow
   * the card above 100% (drawn on top, never clipped). */
  const heroSlot = custom.heroSlot;
  const hero = design.hero;
  const heroIconId = resolveHeroIconId(sheet);
  const heroIcon = heroIconId ? icons[heroIconId] ?? null : null;
  const useCard = hero.customHeroCard === true;
  const heroBase = useCard
    ? Math.max(hero.cardSize, 1)
    : heroSlot
      ? Math.max(Math.min(heroSlot.width, heroSlot.height), 1)
      : 0;
  if (heroSlot && heroIcon && heroBase > 0 && heroEnabled(hero)) {
    const cardSize = useCard ? heroBase : 0;
    const cardCx = heroSlot.x + heroSlot.width / 2 + hero.cardOffsetX;
    const cardCy = heroSlot.y + heroSlot.height / 2 + hero.cardOffsetY;
    if (useCard && hero.card.visible && cardSize > 0) {
      let filterAttr = "";
      if (hero.shadow) {
        parts.push(
          `<defs>${shadowFilter(`${rid}-heroShadow`, hero.shadowBlur, hero.shadowX, hero.shadowY, hero.shadowStrength, hero.shadowColor)}</defs>`
        );
        filterAttr = ` filter="url(#${rid}-heroShadow)"`;
      }
      parts.push(
        `<g id="HeroCard"><rect x="${round(cardCx - cardSize / 2)}" y="${round(cardCy - cardSize / 2)}" width="${round(cardSize)}" height="${round(cardSize)}" rx="${hero.card.radius}" fill="${hero.card.color}" fill-opacity="${hero.card.opacity}"${hero.card.borderWidth > 0 ? ` stroke="${hero.card.borderColor}" stroke-width="${hero.card.borderWidth}"` : ""}${filterAttr}/></g>`
      );
    }
    /* P5 fitting flow: card/slot bounds → usable area (− iconPadding) →
     * square embed size (uniform viewBox scale fits both axes) → centered
     * on the usable center (+ the icon's own offsets). */
    const heroBounds: Rect = useCard
      ? { x: cardCx - heroBase / 2, y: cardCy - heroBase / 2, width: heroBase, height: heroBase }
      : heroSlot;
    const usable = heroUsableRect(heroBounds, hero);
    const heroIconSize = heroIconBoxSize(usable, hero);
    const box: Box = {
      x: usable.x + (usable.width - heroIconSize) / 2 + hero.offsetX,
      y: usable.y + (usable.height - heroIconSize) / 2 + hero.offsetY,
      size: heroIconSize,
    };
    parts.push(
      `<g id="HeroIcon">${embedIcon(heroIcon, `${rid}-hero`, box, design.icon, {
        colorOverride: hero.iconColor ?? null,
        cellOverride: sheet.cellOverrides?.[heroIcon.id],
      })}</g>`
    );
  }

  /* -- icons into the detected slots ---------------------------------- */
  const slots = custom.iconSlots;
  const iconScale = design.spacing.iconScale ?? 0.8;
  const cellParts: string[] = [];
  for (let i = 0; i < slots.length; i++) {
    const iconId = sheet.iconIds[i];
    if (!iconId) continue;
    const icon = icons[iconId];
    if (!icon) continue;
    /* per-icon skip: the slot stays EMPTY (the template's own artwork is
     *  the visual master — nothing is erased, the icon just isn't drawn) */
    if (isCellSkipped(sheet, iconId)) continue;
    const slot = slots[i];
    const size = Math.min(slot.width, slot.height) * iconScale;
    const box: Box = {
      x: slot.x + (slot.width - size) / 2,
      y: slot.y + (slot.height - size) / 2,
      size,
    };
    cellParts.push(`<g id="Cell-${i + 1}">${embedIcon(icon, `${rid}-c${i}`, box, design.icon, {
      cellOverride: sheet.cellOverrides ?.[iconId],
    })}</g>`);
  }
  parts.push(`<g id="IconGrid">${cellParts.join("")}</g>`);

  /* -- preview-only overlays ------------------------------------------ */
  if (mode === "preview") {
    const overlays: string[] = [];
    if (options.showGuides) {
      overlays.push(
        `<g id="GridGuides">${slots
          .map(
            (s) =>
              `<rect x="${round(s.x)}" y="${round(s.y)}" width="${round(s.width)}" height="${round(s.height)}" fill="none" stroke="#3B82F6" stroke-width="1" stroke-dasharray="6 6" opacity="0.55"/>`
          )
          .join("")}</g>`
      );
    }
    if (heroSlot && options.highlightRegion === "hero") {
      overlays.push(
        `<rect x="${round(heroSlot.x - 8)}" y="${round(heroSlot.y - 8)}" width="${round(heroSlot.width + 16)}" height="${round(heroSlot.height + 16)}" fill="#3B82F6" fill-opacity="0.08" stroke="#3B82F6" stroke-width="2" stroke-dasharray="8 6"/>`
      );
    }
    if (options.selectedIconId) {
      const idx = sheet.iconIds.indexOf(options.selectedIconId);
      if (idx >= 0 && idx < slots.length) {
        const s = slots[idx];
        overlays.push(
          `<rect x="${round(s.x - 4)}" y="${round(s.y - 4)}" width="${round(s.width + 8)}" height="${round(s.height + 8)}" fill="none" stroke="#F97316" stroke-width="3" rx="6"/>`
        );
      }
    }
    /* skipped-cell markers: dashed outline + diagonal cross so the hole is
     * obvious in the edit view (never in export / overview thumbs) */
    overlays.push(...skippedCellOverlays(sheet, () => {
      const out: Array<{ x: number; y: number; w: number; h: number }> = [];
      sheet.iconIds.forEach((id, i) => {
        if (isCellSkipped(sheet, id) && i < slots.length) {
          const s = slots[i];
          out.push({ x: s.x, y: s.y, w: s.width, h: s.height });
        }
      });
      return out;
    }));
    if (overlays.length) parts.push(`<g id="PreviewOverlays">${overlays.join("")}</g>`);
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="${escapeXml(custom.viewBox)}" shape-rendering="geometricPrecision">` +
    parts.join("") +
    `</svg>`
  );
}

/* ------------------------------------------------------------------ */
/* THE renderer                                                        */
/* ------------------------------------------------------------------ */

export function renderSheet(
  sheet: Sheet,
  template: TemplateDef,
  icons: Record<string, IconEntry>,
  options: RenderOptions = {}
): string {
  /* user-imported template → universal slot renderer (original SVG is the
   * visual master; the classic path below is untouched for official ones) */
  if (template.sourceType === "custom" && template.custom) {
    return renderCustomSheet(sheet, template, icons, options);
  }

  const design = sheet.design;
  const mode = options.mode ?? "preview";
  const quality = options.quality ?? "full";
  const W = template.width;
  const H = template.height;
  const defs: string[] = [];
  const body: string[] = [];

  /* Every render emits def ids scoped to the sheet ("sh12-railGrad" …).
   * Inline SVGs share one document — a fixed id like "cardShadow" would let
   * the first sheet on the page win every url(#…) lookup and bleed its
   * filters/gradients into all other sheets (thumbnails + preview).
   * Scoping by sheet id keeps each sheet self-contained; concurrent renders
   * of the SAME sheet produce identical defs, so id reuse there is harmless. */
  const rid = `sh${sheet.id.replace(/\D/g, "") || "0"}`;

  /* -- Background -------------------------------------------------- */
  if (design.backgroundVisible !== false) {
    if (design.bgGradient) {
      /* two-stop gradient replaces the solid fill; the def id is scoped to
       * the sheet exactly like rail/card gradients so inline thumbnails on
       * the same page never cross-contaminate url(#…) lookups */
      const bgGradId = `${rid}-bgGrad`;
      defs.push(linearGradientDef(bgGradId, design.bgGradient, 0, 0, W, H));
      body.push(
        `<g id="Background"><rect x="0" y="0" width="${W}" height="${H}" fill="url(#${bgGradId})"/></g>`
      );
    } else {
      body.push(
        `<g id="Background"><rect x="0" y="0" width="${W}" height="${H}" fill="${design.background}"/></g>`
      );
    }
  }

  /* -- Left rail (user default sheets) ------------------------------- */
  const rail = resolveRail(template, design);
  if (rail && rail.paint.visible) {
    const g = rail.geometry;
    const p = rail.paint;
    const railGradId = `${rid}-railGrad`;
    defs.push(linearGradientDef(railGradId, { from: p.from, to: p.to, angle: p.angle }, 0, 0, g.width, H));
    /* rail hugs the left edge, spans full height, rounded OUTER corners */
    const r = Math.min(g.radius, g.width / 2, H / 2);
    const railPath =
      `M${round(g.width)},0 L${round(g.width)},${H} L${round(r)},${H} ` +
      `Q0,${H} 0,${round(H - r)} L0,${round(r)} Q0,0 ${round(r)},0 Z`;
    const railParts: string[] = [
      `<path d="${railPath}" fill="url(#${railGradId})"/>`
    ];
    if (p.ribbon.visible) {
      const rb = g.ribbon;
      const ribbonGradId = `${rid}-ribbonGrad`;
      defs.push(
        linearGradientDef(ribbonGradId, { from: p.ribbon.from, to: p.ribbon.to, angle: p.ribbon.angle }, rb.x, rb.y, rb.w, rb.h)
      );
      /* flag shape: rectangle with a chevron notch cut into the right edge */
      const ribbonPath =
        `M${round(rb.x)},${round(rb.y)} H${round(rb.x + rb.w)} ` +
        `L${round(rb.x + rb.w - rb.notch)},${round(rb.y + rb.h / 2)} ` +
        `L${round(rb.x + rb.w)},${round(rb.y + rb.h)} H${round(rb.x)} Z`;
      railParts.push(`<path d="${ribbonPath}" fill="url(#${ribbonGradId})"/>`);
    }
    body.push(`<g id="LeftRail">${railParts.join("")}</g>`);
  }

  /* -- Hero ---------------------------------------------------------- */
  const heroRegion = resolveRegion(template, design, "hero");
  const hero = design.hero;
  /* The hero CARD is a fixed container: its size, background, border and
   * position are independent of the icon scale. P5: the same shared
   * fitting engine as custom templates (hero-fit.ts) drives the icon —
   * card bounds → usable area (− padding) → uniform scale → centered —
   * and the enabled/displayMode gate decides whether a hero renders at
   * all. Hero Icon Scale changes ONLY the icon artwork, centered on the
   * (fixed) card's center — the icon may outgrow the card above 100% and
   * is simply drawn larger on top; nothing is clipped (no clip region). */
  const heroCardSize = hero.cardSize;
  const heroCardCenterX = heroRegion.x + hero.cardOffsetX + hero.cardSize / 2;
  const heroCardCenterY = heroRegion.y + hero.cardOffsetY + hero.cardSize / 2;
  const heroCardX = heroCardCenterX - heroCardSize / 2;
  const heroCardY = heroCardCenterY - heroCardSize / 2;
  const heroIconId = resolveHeroIconId(sheet);
  const heroIcon: IconEntry | null = heroIconId ? icons[heroIconId] ?? null : null;

  const heroParts: string[] = [];
  if (heroEnabled(hero)) {
    if (hero.card.visible) {
      let filterAttr = "";
      if (hero.shadow) {
        defs.push(
          shadowFilter(`${rid}-heroShadow`, hero.shadowBlur, hero.shadowX, hero.shadowY, hero.shadowStrength, hero.shadowColor)
        );
        filterAttr = ` filter="url(#${rid}-heroShadow)"`;
      }
      heroParts.push(
        `<rect x="${round(heroCardX)}" y="${round(heroCardY)}" width="${round(heroCardSize)}" height="${round(heroCardSize)}" rx="${hero.card.radius}" fill="${hero.card.color}" fill-opacity="${hero.card.opacity}"${hero.card.borderWidth > 0 ? ` stroke="${hero.card.borderColor}" stroke-width="${hero.card.borderWidth}"` : ""}${filterAttr}/>`
      );
    }
    if (heroIcon) {
      /* P5 fitting flow — identical to the custom-template path. */
      const heroBounds: Rect = { x: heroCardX, y: heroCardY, width: heroCardSize, height: heroCardSize };
      const usable = heroUsableRect(heroBounds, hero);
      const heroIconSize = heroIconBoxSize(usable, hero);
      const iconBox: Box = {
        x: usable.x + (usable.width - heroIconSize) / 2 + hero.offsetX,
        y: usable.y + (usable.height - heroIconSize) / 2 + hero.offsetY,
        size: heroIconSize,
      };
      /* dedicated hero icon color (design.hero.iconColor) overrides the
       * sheet-wide icon tint — the hero icon artwork only, never the card */
      heroParts.push(
        `<g id="HeroIcon">${embedIcon(heroIcon, `${rid}-hero`, iconBox, design.icon, {
          colorOverride: hero.iconColor ?? null,
          cellOverride: sheet.cellOverrides ?.[heroIcon.id],
        })}</g>`
      );
    } else {
      // dashed placeholder so hero position is visible
      heroParts.push(
        `<rect x="${round(heroCardX)}" y="${round(heroCardY)}" width="${round(heroCardSize)}" height="${round(heroCardSize)}" rx="${hero.card.radius}" fill="none" stroke="${design.typography.volume.color}" stroke-width="2" stroke-dasharray="10 8" opacity="0.6"/>`
      );
    }
  }
  body.push(`<g id="Hero">${heroParts.join("")}</g>`);

  /* -- Typography ---------------------------------------------------- */
  const typographyParts: string[] = [];
  typographyParts.push(
    renderTextBlock(formatVolume(sheet.volume), resolveRegion(template, design, "volume"), design.typography.volume)
  );
  /* the TITLE uses the smart auto-fit engine unless the design explicitly
   *  turned it off (typography.category.autoFit === false → classic fixed
   *  size, top-anchored layout, exactly as before) */
  const categoryStyle = design.typography.category;
  const categoryRegion = resolveRegion(template, design, "category");
  typographyParts.push(
    categoryStyle.autoFit !== false
      ? renderTitleBlock(sheet.category, categoryRegion, categoryStyle)
      : renderTextBlock(sheet.category, categoryRegion, categoryStyle)
  );
  typographyParts.push(
    renderTextBlock(design.captionText, resolveRegion(template, design, "caption"), design.typography.caption)
  );
  /* Thumbnails ("thumb" quality) omit micro footer lines — the one region
   * that renders as unreadable noise at card scale. The user default
   * templates stamp a large capacity line ("27 ICONS", 115px+) that IS
   * part of the sheet's identity and stays legible, so anything that big
   * still renders. Exports always stay "full". */
  if (quality === "full" || design.typography.footer.fontSize >= 40) {
    const footerText =
      design.footerText ||
      `${template.capacity} ICONS · ${W} × ${H} · SVG VECTOR`;
    typographyParts.push(
      renderTextBlock(footerText, resolveRegion(template, design, "footer"), design.typography.footer)
    );
  }
  body.push(`<g id="Typography">${typographyParts.join("")}</g>`);

  /* -- Format pills (user default sheets) ---------------------------- */
  if (rail && rail.paint.pills.visible) {
    const pg = rail.geometry.pills;
    const pp = rail.paint.pills;
    const labels = pp.labels.filter((l) => l.trim().length > 0);
    const pillFontSize = round(pg.h * 0.4375);
    const pillParts: string[] = [];
    labels.forEach((label, i) => {
      const px = pg.x + i * (pg.w + pg.gap);
      pillParts.push(
        `<rect x="${round(px)}" y="${round(pg.y)}" width="${round(pg.w)}" height="${round(pg.h)}" rx="${pg.radius}" fill="${pp.color}"/>`
      );
      pillParts.push(
        `<text x="${round(px + pg.w / 2)}" y="${round(pg.y + pg.h * 0.656)}" font-family="Arial, Helvetica, sans-serif" font-size="${pillFontSize}" font-weight="700" fill="${pp.labelColor}" text-anchor="middle" xml:space="preserve">${escapeXml(label.trim())}</text>`
      );
    });
    body.push(`<g id="FormatPills">${pillParts.join("")}</g>`);
  }

  /* -- Icon grid ------------------------------------------------------ */
  const grid = computeGrid(template, design);
  const card = design.card;
  const gridParts: string[] = [];

  if (card.shadow) {
    defs.push(
      shadowFilter(`${rid}-cardShadow`, card.shadowBlur, card.shadowX, card.shadowY, card.shadowStrength, card.shadowColor)
    );
  }

  /* showEmptyCells → draw the full template frame (the default-sheet look);
   * otherwise cards render only where icons live. */
  const slots = Math.min(
    sheet.iconIds.length,
    grid.cols * grid.rows
  );
  const totalSlots = card.showEmptyCells ? grid.cols * grid.rows : slots;
  for (let i = 0; i < totalSlots; i++) {
    const iconId = sheet.iconIds[i];
    const icon = iconId ? icons[iconId] : undefined;
    const col = i % grid.cols;
    const row = Math.floor(i / grid.cols);
    const cellX = grid.originX + col * (grid.cell + grid.gap);
    const cellY = grid.originY + row * (grid.cell + grid.gap);
    const cellSize = grid.cell;

    /* per-icon skip: the whole cell (card + artwork) becomes a hole —
     * showEmptyCells keeps drawing never-assigned slots, but a skipped
     * ASSIGNED icon is explicitly excluded from preview AND export */
    if (iconId && isCellSkipped(sheet, iconId)) continue;

    const parts: string[] = [];
    if (card.visible) {
      const pad = cellSize * design.spacing.cellPadding;
      const cardX = cellX + pad;
      const cardY = cellY + pad;
      const cardSize = cellSize - pad * 2;
      let fill: string;
      const perCellGradient = iconId ? cellCardGradient(sheet, iconId) : null;
      const perCellColor = iconId ? cellCardColor(sheet, iconId) : null;
      if (perCellGradient) {
        /* per-cell gradient overrides BOTH the sheet color and gradient */
        const cellPGradId = `${rid}-cellPGrad-${i}`;
        defs.push(
          linearGradientDef(cellPGradId, perCellGradient, round(cardX), round(cardY), round(cardSize), round(cardSize))
        );
        fill = `url(#${cellPGradId})`;
      } else if (perCellColor) {
        /* per-cell solid color overrides BOTH the sheet color and gradient */
        fill = perCellColor;
      } else if (card.gradient) {
        const cellGradId = `${rid}-cellGrad-${i}`;
        defs.push(
          linearGradientDef(cellGradId, card.gradient, round(cardX), round(cardY), round(cardSize), round(cardSize))
        );
        fill = `url(#${cellGradId})`;
      } else {
        fill = card.color;
      }
      parts.push(
        `<rect x="${round(cardX)}" y="${round(cardY)}" width="${round(cardSize)}" height="${round(cardSize)}" rx="${card.radius}" fill="${fill}" fill-opacity="${card.opacity}"${card.borderWidth > 0 ? ` stroke="${card.borderColor}" stroke-width="${card.borderWidth}"` : ""}${card.shadow ? ` filter="url(#${rid}-cardShadow)"` : ""}/>`
      );
    }
    if (icon) {
      const iconSize =
        cellSize * (1 - design.spacing.cellPadding * 2) * (design.spacing.iconScale ?? 0.86);
      const box: Box = {
        x: cellX + (cellSize - iconSize) / 2,
        y: cellY + (cellSize - iconSize) / 2,
        size: iconSize,
      };
      parts.push(embedIcon(icon, `${rid}-c${i}`, box, design.icon, {
        cellOverride: sheet.cellOverrides ?.[iconId],
      }));
    }
    gridParts.push(`<g id="Cell-${i + 1}">${parts.join("")}</g>`);
  }
  body.push(`<g id="IconGrid">${gridParts.join("")}</g>`);

  /* -- Preview-only overlays ------------------------------------------ */
  if (mode === "preview") {
    const overlays: string[] = [];
    if (options.showGuides) {
      const guideParts: string[] = [];
      for (let i = 0; i < grid.cols * grid.rows; i++) {
        const col = i % grid.cols;
        const row = Math.floor(i / grid.cols);
        guideParts.push(
          `<rect x="${round(grid.originX + col * (grid.cell + grid.gap))}" y="${round(grid.originY + row * (grid.cell + grid.gap))}" width="${round(grid.cell)}" height="${round(grid.cell)}" fill="none" stroke="#3B82F6" stroke-width="1" stroke-dasharray="6 6" opacity="0.55"/>`
        );
      }
      overlays.push(`<g id="GridGuides">${guideParts.join("")}</g>`);
    }
    if (options.highlightRegion) {
      const region = resolveRegion(template, design, options.highlightRegion);
      overlays.push(
        `<rect x="${round(region.x - 8)}" y="${round(region.y - 8)}" width="${round(region.width + 16)}" height="${round(region.height + 16)}" fill="#3B82F6" fill-opacity="0.08" stroke="#3B82F6" stroke-width="2" stroke-dasharray="8 6"/>`
      );
    }
    if (options.selectedIconId) {
      const idx = sheet.iconIds.indexOf(options.selectedIconId);
      if (idx >= 0 && idx < grid.cols * grid.rows) {
        const col = idx % grid.cols;
        const row = Math.floor(idx / grid.cols);
        overlays.push(
          `<rect x="${round(grid.originX + col * (grid.cell + grid.gap) - 4)}" y="${round(grid.originY + row * (grid.cell + grid.gap) - 4)}" width="${round(grid.cell + 8)}" height="${round(grid.cell + 8)}" fill="none" stroke="#F97316" stroke-width="3" rx="6"/>`
        );
      }
    }
    /* skipped-cell markers: dashed outline + diagonal cross so the hole is
     * obvious in the edit view (never in export / overview thumbs) */
    overlays.push(...skippedCellOverlays(sheet, () => {
      const out: Array<{ x: number; y: number; w: number; h: number }> = [];
      sheet.iconIds.forEach((id, i) => {
        if (isCellSkipped(sheet, id) && i < grid.cols * grid.rows) {
          const col = i % grid.cols;
          const row = Math.floor(i / grid.cols);
          out.push({
            x: grid.originX + col * (grid.cell + grid.gap),
            y: grid.originY + row * (grid.cell + grid.gap),
            w: grid.cell,
            h: grid.cell,
          });
        }
      });
      return out;
    }));
    if (overlays.length) body.push(`<g id="PreviewOverlays">${overlays.join("")}</g>`);
  }

  const defsXml = defs.length ? `<defs>${defs.join("")}</defs>` : "";
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" shape-rendering="geometricPrecision">` +
    defsXml +
    body.join("") +
    `</svg>`
  );
}
