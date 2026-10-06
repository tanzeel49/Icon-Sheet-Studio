/**
 * ICON SHEET STUDIO — Core data models
 * Single source of truth. Sheets OWN their icon ids; the icon library is
 * an immutable map of id → source SVG (never modified by rendering).
 */

import type { BuilderDocument } from "@/lib/builder/types";

export type IconColorMode = "native" | "tint";
export type TextAlign = "start" | "middle" | "end";

/** LEGACY stroke-mode discriminator from the old two-mode stroke UI. */
export type StrokeMode = "native" | "normalize";

/* STROKE MODEL — TWO px controls, MUTUALLY EXCLUSIVE (exactly ONE is
 * active per rendering; the engine enforces it and the UI mirrors it by
 * disabling the weight control while uniform is ON).
 *
 * 1 · "Icon stroke weight" (strokeWeightPx, −100…+100 SHEET-CANVAS px,
 *    default 0) — the ACTIVE system while uniform stroke is OFF: one
 *    plain adjustment value — negative = thinner, 0 = the EXACT
 *    original/native look, positive = thicker. The px value is NOT a
 *    blind global stroke-width: it is the user's desired VISUAL
 *    adjustment relative to EACH icon's OWN native/effective stroke,
 *    which the engine measures individually (analyzeNativeStroke —
 *    cached, pure analysis of the immutable source). Per icon embed:
 *        nativeVisual_i = rootWidth_i · embedScale_i   (canvas px)
 *        factor_i = clamp(1 + strokeWeightPx / nativeVisual_i, 0.25, 4)
 *    so icons with native strokes of 2 px / 4 px / 8 px at +2 px land at
 *    ≈4 / ≈6 / ≈10 px — each adjusted against its own baseline, never one
 *    blind value. Unsafe requests clamp per icon (native 1 px at −20 px →
 *    the 0.25 floor) while the UI keeps showing the requested adjustment;
 *    no negative widths, NaN or Infinity can ever reach the SVG.
 *
 * 2 · "Uniform stroke" (uniformStroke, optional, default OFF; +
 *    uniformTargetPx 0.5…100 canvas px) — while ON it is the ONLY active
 *    system: bring every SUPPORTED icon toward ONE absolute target width
 *    — per icon factor = target / nativeVisual (the target is what the
 *    stroke should BECOME, never an amount to add; the required
 *    correction is target − native per icon). The stored weight delta is
 *    PRESERVED but deliberately IGNORED while uniform is ON (no hidden
 *    target+delta composition — the old composition rendered weight +8
 *    with target 5 as 13 px, exactly the "the target looks additive"
 *    regression); switching uniform OFF reactivates the stored weight
 *    unchanged. Exposed as a checkbox + target, never as a mode selector.
 *    Unmeasurable icons (text-only / degenerate shapes) honestly keep
 *    their exact original look in both modes.
 *
 * 0 px / OFF always reproduces the pristine source byte-for-byte: every
 * render recomputes from the immutable original SVG (original → +20 →
 * −10 → 0 restores the exact original — no accumulation, ever), and the
 * adjustment is expressed purely as appearance overrides (stroke-width
 * scaling / mirrored-fill dilation stroke) on the user's own elements —
 * never as regenerated geometry, never via masks (Adobe Illustrator
 * releases SVG mask content as real editable objects after ungroup).
 * Tint (tintIcons + tintColor) is an independent, equally
 * non-destructive appearance override.
 *
 * Legacy persistence — designs saved by older UIs may still carry:
 *   · strokeWeightPct  (single-control % era) → the renderer's dormant
 *     fallback keeps the EXACT saved multiplicative look until the first
 *     stroke edit; the slider shows a median-derived px equivalent so the
 *     first drag migrates continuously (stroke-migration.ts).
 *   · strokeMode "normalize" + normalizeTargetPx (two-mode era) → maps
 *     EXACTLY onto the uniform-stroke feature (uniform ON, same target,
 *     weight 0) — appearance preserved verbatim, honestly reflected by the
 *     UI (checkbox ON, target shown).
 *   · weightScale (multiplier era) → hydrates through the % fallback.
 *   · colorMode "tint" (tint segmented-control era) → read-time fallback
 *     onto tintIcons until the first tint edit.
 * New writes only ever set the current fields and delete the legacy ones. */

/* Stroke control ranges (UI + persistence clamps — one source of truth). */
export const STROKE_WEIGHT_PX_MIN = -100;
export const STROKE_WEIGHT_PX_MAX = 100;
/** Per-icon factor clamp for the weight path: keeps every icon visibly
 *  present (0.25 = the accepted −100 % floor of the previous era) and
 *  stops absurd blowups (4 = "much thicker", never a total blob). */
export const STROKE_WEIGHT_FACTOR_MIN = 0.25;
export const STROKE_WEIGHT_FACTOR_MAX = 4;
/** Uniform target range, in SHEET-CANVAS px. The 0.5 minimum is a REAL
 *  representable target (the mandatory “target 0.5 px” test): the UI
 *  slider steps in 0.5 increments and the stored value keeps one
 *  decimal — a sub-1 px target must thin thick icons, never silently
 *  round up to 1. */
export const UNIFORM_TARGET_PX_MIN = 0.5;
export const UNIFORM_TARGET_PX_MAX = 100;
export const UNIFORM_TARGET_PX_DEFAULT = 2;

/* ------------------------------------------------------------------ */
/* Typography                                                          */
/* ------------------------------------------------------------------ */

export interface TextStyle {
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  letterSpacing: number; // px in canvas units
  lineHeight: number; // multiplier
  align: TextAlign;
  color: string;
  uppercase: boolean;
  offsetX: number; // px offset within its region
  offsetY: number;
  /** "italic" renders the style in italics (user default sheets stamp
   *  VOL labels in Arial Bold Italic). Optional: older designs hydrate
   *  as normal. */
  fontStyle?: "normal" | "italic";
  /** Smart Auto-Fit (round 17): when true, the renderer computes the
   *  font size AND line layout automatically so the block fits the text
   *  region's safe area (margins, balanced max size, whole-block vertical
   *  centering; manual \n breaks preserved). Honored on the CATEGORY
   *  (title) style — the other text roles render as before. Optional:
   *  older designs hydrate as ON (undefined → auto fit active). */
  autoFit?: boolean;
  /** Text-block visibility master switch (round 24): false removes the
   *  whole block from preview AND export — official templates skip the
   *  renderTextBlock call, custom templates hide the mapped text element
   *  via display:none. Optional: older designs hydrate as visible
   *  (undefined → shown), exactly like backgroundVisible. Lets a template
   *  ship without a volume label (the "Design Warsa Temp" family) while
   *  the user can still toggle it back on from the Typography panel. */
  visible?: boolean;
}

/* ------------------------------------------------------------------ */
/* Gradient fills (user default templates)                            */
/* ------------------------------------------------------------------ */

/** Two-stop linear gradient. angle in degrees, 0 = left→right,
 *  90 = top→bottom, -45 = bottom-left → top-right (screen coords). */
export interface GradientFill {
  from: string;
  to: string;
  angle: number;
}

/* ------------------------------------------------------------------ */
/* Cards (grid icon cards)                                             */
/* ------------------------------------------------------------------ */

export interface CardStyle {
  visible: boolean;
  color: string;
  opacity: number; // 0..1
  borderWidth: number;
  borderColor: string;
  radius: number;
  shadow: boolean;
  shadowStrength: number; // 0..1 → opacity
  shadowBlur: number;
  shadowX: number;
  shadowY: number;
  shadowColor: string;
  /** Optional gradient fill for grid cells (user default templates use a
   *  navy diagonal pair). When present it replaces the solid `color` fill.
   *  Optional: older designs hydrate as solid fills. */
  gradient?: GradientFill | null;
  /** Render the card for EVERY grid cell of the template capacity, not
   *  only assigned icons — the default-sheet look shows the full frame.
   *  Optional: older designs hydrate as false (cards only where icons are). */
  showEmptyCells?: boolean;
}

/* ------------------------------------------------------------------ */
/* Left rail (user default sheets)                                    */
/* ------------------------------------------------------------------ */

/** Colors/visibility of the left rail — the signature of the user's
 *  default sheets (navy gradient rail + blue VOL ribbon + format pills).
 *  Geometry lives on the TEMPLATE (TemplateRail); the design only owns
 *  the paint. Optional: older designs hydrate against template defaults. */
export interface RailStyle {
  visible: boolean;
  from: string; // rail gradient start
  to: string; // rail gradient end
  angle: number; // gradient angle, degrees
  ribbon: {
    visible: boolean;
    from: string;
    to: string;
    angle: number;
  };
  pills: {
    visible: boolean;
    color: string;
    labelColor: string;
    /** pill captions, e.g. ["AI", "SVG", "EPS", "PNG"] */
    labels: string[];
  };
}

export interface HeroCardStyle {
  visible: boolean;
  color: string;
  opacity: number;
  borderWidth: number;
  borderColor: string;
  radius: number;
}

/* ------------------------------------------------------------------ */
/* Hero                                                                */
/* ------------------------------------------------------------------ */

export interface HeroStyle {
  /** icon scale inside hero card, 0.1..1 */
  iconScale: number;
  offsetX: number;
  offsetY: number;
  /** hero card size in canvas px */
  cardSize: number;
  cardOffsetX: number;
  cardOffsetY: number;
  card: HeroCardStyle;
  shadow: boolean;
  shadowStrength: number;
  shadowBlur: number;
  shadowX: number;
  shadowY: number;
  shadowColor: string;
  /** Dedicated hero icon color — overrides the sheet's icon color/tint for
   *  the hero icon's artwork ONLY (never the hero card). Absent/null = the
   *  hero follows the normal icon color settings. Optional: older designs
   *  hydrate as "follow icons". */
  iconColor?: string | null;
  /** Custom templates only: opt-in to draw a hero card over the detected
   *  hero slot (off keeps the template's own artwork — the look of sheets
   *  saved before this flag). Absent/undefined = off. Official templates
   *  ignore this flag (their hero card is always design-driven). */
  customHeroCard?: boolean;
  /* ---- P5 · Hero Card complete control system (all additive & optional:
   *  designs saved before Phase 5 hydrate with the exact previous behavior
   *  — enabled defaults true, displayMode defaults "selected", padding
   *  defaults 0, customIconId defaults null). ---- */
  /** Master switch (P5). false → the sheet renders NO hero icon and NO
   *  hero card at all (a real layout change: the hero area shows the
   *  template's own artwork only; icons stay in their grid cells — never
   *  a blank hole). Absent = enabled (legacy sheets unchanged). */
  enabled?: boolean;
  /** WHICH icon the hero displays (P5):
   *    "selected" → the sheet's heroIconId (the classic behavior);
   *    "first"    → always the sheet's first icon (auto-follows content);
   *    "custom"   → the pinned customIconId (any library icon).
   *  Absent = "selected". */
  displayMode?: HeroDisplayMode;
  /** The pinned icon for displayMode "custom" (P5). Absent = null. */
  customIconId?: string | null;
  /** Padding between the hero card bounds and the icon artwork (P5, canvas
   *  px ≥ 0). The shared fitting math shrinks the usable area by this
   *  amount before scaling the icon — the icon can never enter the pad. */
  iconPadding?: number;
}

/** Which icon the hero area displays — see HeroStyle.displayMode (P5). */
export type HeroDisplayMode = "selected" | "first" | "custom";

/* ------------------------------------------------------------------ */
/* Icon rendering                                                      */
/* ------------------------------------------------------------------ */

export interface IconStyle {
  /** LEGACY field from the old two-mode stroke UI ("Native" / "Normalize").
   *  OPTIONAL and never written by the current UI — new designs carry no
   *  stroke mode at all. Persisted records keep their value:
   *    · absent / "native"  → the single-control model applies directly;
   *    · "normalize"        → the renderer's legacy fallback preserves the
   *      sheet's EXACT saved appearance (per-icon normalization toward the
   *      stored target); the first stroke-slider edit migrates the design
   *      onto the single control and clears this field. */
  strokeMode?: StrokeMode;
  /** LEGACY field — the pre-target normalization weight as a PERCENTAGE of
   *  each icon's rendered size. Superseded by normalizeTargetPx (itself
   *  legacy now). Kept ONLY so older saved designs hydrate onto a real
   *  value (see effectiveNormalizeTargetPx) instead of jumping; no longer
   *  written by the current UI. */
  normalizeWeight?: number;
  /** LEGACY field — target stroke width in SHEET CANVAS px from the old
   *  "Normalize" mode. Consulted ONLY by the renderer's legacy fallback
   *  while strokeMode === "normalize" (exact appearance preservation for
   *  pre-simplification records) and by the migration display helper
   *  (stroke-migration.ts); cleared when the user first edits the single
   *  stroke control. */
  normalizeTargetPx?: number;
  /** LEGACY field — stroke multiplier (1 = untouched) superseded by
   *  strokeWeightPct (itself legacy now — superseded by strokeWeightPx).
 *  Kept so older saved designs migrate onto the bidirectional percentage
 *  scale ((factor−1)×100, see effectiveStrokeWeightPct) instead of jumping. */
  weightScale?: number;
  /** LEGACY field — the single-control-era RELATIVE weight as a percentage
   *  (−100…+100). Superseded by strokeWeightPx (canvas-px delta). Consulted
   *  ONLY by the renderer's dormant fallback while a pre-px design carries
   *  no current stroke field, and by the migration display helper
   *  (stroke-migration.ts); cleared when the user first edits any stroke
   *  control. New writes never set it. */
  strokeWeightPct?: number;
  /** THE stroke control — a single plain adjustment in SHEET-CANVAS px
   *  (−100…+100, default 0 = the exact original/native appearance) — the
   *  ACTIVE system while uniformStroke is OFF (mutual exclusion):
   *    · −100 … −1 → VISIBLY THINNER than each icon's own native look
   *    · 0         → exactly the original native appearance (always)
   *    · +1 … +100 → VISIBLY THICKER than each icon's own native look
   *  The value is the user's desired VISUAL adjustment, NOT a blind global
   *  stroke-width: every icon is analyzed individually (analyzeNativeStroke)
   *  and receives its OWN factor — 1 + delta / (nativeWidth · embedScale),
   *  clamped per icon to [0.25, 4] — so icons with native strokes of 2 / 4 /
   *  8 px at +2 px land at ≈4 / ≈6 / ≈10 px and a 1 px icon at −20 px clamps
   *  safely instead of producing an invalid width. While uniformStroke is
   *  ON the value is STORED but ignored (preserved for when uniform is
   *  switched back OFF — never reset, never composed into the target).
   *  The native baseline is
   *  ALWAYS the immutable original SVG: every render is recomputed from the
   *  pristine source (0 → +20 → −10 → 0 always returns to the exact
   *  original — no accumulation, ever). STRICTLY NON-DESTRUCTIVE — the
   *  output geometry is always byte-identical to the source (`d`, shape
   *  attributes, groups, transforms, viewBox untouched); the adjustment is
   *  expressed purely as appearance overrides:
   *    · Stroked artwork: every active stroke (attr / inline style /
   *      CSS / inherited / currentColor) multiplies by the factor —
   *      thinner below 0, thicker above.
   *    · Fill-based outline artwork (lines drawn as filled paths):
   *      thicker = a mirrored-fill stroke on the ORIGINAL geometry
   *      (Illustrator-clean paint attribute); thinner = honestly
   *      LIMITED (kept at native weight) — shrinking a filled outline
   *      would require masks (Illustrator releases their content as
   *      editable objects after ungroup) or destructive geometry, both
   *      forbidden; such icons are reported as limited. Icons that
   *      cannot be adjusted safely (e.g. text-only) keep their exact
   *      original look.
   *  Icon size, position, proportions, containers and hero card are never
   *  affected. Applied at render/export time only, always from the pristine
   *  source. */
  strokeWeightPx?: number;
  /** Optional "Uniform stroke" feature (default OFF): when ON it is the
   *  ONLY active stroke system (mutual exclusion — the stored weight delta
   *  is preserved but ignored, never composed into the target). Every
   *  SUPPORTED icon is analyzed individually and brought toward the
   *  ABSOLUTE target width (uniformTargetPx): per icon factor = target /
   *  nativeVisual, i.e. the required correction is target − native — NEVER
   *  target + native and never one shared adjustment. NOT a mode selector —
   *  a checkbox + target that can be toggled at any time; switching it OFF
   *  reactivates the stored weight value unchanged.
   *  Legacy designs saved with strokeMode "normalize" map onto this flag
   *  (read-time fallback) with their stored target. */
  uniformStroke?: boolean;

  /** "Uniform stroke" target width in SHEET-CANVAS px (0.5…100, default 2,
   *  one decimal) — what the stroke should BECOME (absolute), never an
   *  amount to add. Consulted only while uniformStroke is ON; preserved
   *  while OFF. Legacy designs read normalizeTargetPx through
   *  effectiveUniformTargetPx. */
  uniformTargetPx?: number;
  /** THE tint control — a simple on/off: false (default) keeps each icon's
   *  ORIGINAL SVG colors, true applies the single tintColor to the icon
   *  artwork (a non-destructive appearance override — fills AND strokes,
   *  including CSS-declared and default-black fills; url() paints and
   *  fill="none" outlines are respected; geometry never rewritten).
   *  Independent of the stroke controls: changing one never touches the
   *  other, and resetting one never resets the other. Legacy designs saved
   *  with colorMode "tint" hydrate as ON (read-time fallback) until the
   *  first tint edit. */
  tintIcons?: boolean;
  /** LEGACY field — the tint segmented control ("native"/"tint") from the
   *  pre-checkbox era. OPTIONAL and never written by the current UI;
   *  shadowed by tintIcons whenever that field is present (see
   *  effectiveTintIcons). */
  colorMode?: IconColorMode;
  /** tint color applied while tintIcons is ON. */
  tintColor: string;
}

/** Effective icon style for ONE cell embed: the sheet-wide style with the
 *  icon's per-cell stroke exceptions resolved in (round 9 target, round 12
 *  weight). Returns the sheet style object UNCHANGED (same reference —
 *  zero allocation) when the icon has no exception; otherwise a shallow
 *  copy where each exception field REPLACES its sheet-wide counterpart
 *  (clamped exactly like the sheet-wide control). Both fields are written
 *  "dormant-safe": uniformTargetPx is only consulted while uniformStroke
 *  is ON and strokeWeightPx only while it is OFF, so an icon may carry
 *  BOTH exceptions across mode switches and each stays inert until its
 *  mode is active — exactly the semantics the sheet-wide pair has. Every
 *  consumer of the stroke model that renders or analyzes a single embed —
 *  renderer embedIcon, panel previews, stroke diagnostics — resolves
 *  through this ONE helper so the per-icon values can never disagree
 *  between preview, export and report. Pure. */
export function iconStyleForCell(
  iconStyle: SheetDesign["icon"],
  override?: CellOverride
): SheetDesign["icon"] {
  const t = override?.strokeTargetPx;
  const w = override?.strokeWeightPx;
  const hasTarget = t != null && Number.isFinite(t);
  const hasWeight = w != null && Number.isFinite(w);
  if (!hasTarget && !hasWeight) return iconStyle;
  return {
    ...iconStyle,
    ...(hasTarget
      ? {
          uniformTargetPx: Math.min(
            UNIFORM_TARGET_PX_MAX,
            Math.max(UNIFORM_TARGET_PX_MIN, t)
          ),
        }
      : {}),
    ...(hasWeight
      ? {
          strokeWeightPx: Math.round(
            Math.min(STROKE_WEIGHT_PX_MAX, Math.max(STROKE_WEIGHT_PX_MIN, w))
          ),
        }
      : {}),
  };
}

/** Effective stroke-weight adjustment in SHEET-CANVAS px (−100…+100).
 *  Current designs store strokeWeightPx; designs without it are on a
 *  legacy render path (the renderer never consults this helper for them)
 *  and read as 0 — the UI derives their DISPLAY value through
 *  stroke-migration.ts instead. The result is always a finite integer. */
export function effectiveStrokeWeightPx(icon: IconStyle): number {
  const v = icon.strokeWeightPx;
  if (v == null || !Number.isFinite(v)) return 0;
  return Math.round(Math.min(STROKE_WEIGHT_PX_MAX, Math.max(STROKE_WEIGHT_PX_MIN, v)));
}

/** Effective "Uniform stroke" flag. Current designs store uniformStroke;
 *  legacy two-mode designs saved with strokeMode "normalize" map onto it
 *  (ON) so their saved appearance AND the UI checkbox stay honest. */
export function effectiveUniformStroke(icon: IconStyle): boolean {
  if (icon.uniformStroke != null) return icon.uniformStroke === true;
  return icon.strokeMode === "normalize";
}

/** Effective "Uniform stroke" target in sheet-canvas px. Current designs
 *  store uniformTargetPx (0.5…100, one decimal); legacy designs fall back
 *  onto the old normalize chain (normalizeTargetPx — a real px value,
 *  passed through; percentage-only records hydrate at the 2 px default
 *  because no mathematically derived mapping exists) until the user
 *  edits. */
export function effectiveUniformTargetPx(icon: IconStyle): number {
  const v = icon.uniformTargetPx;
  if (v != null && Number.isFinite(v)) {
    return Math.min(UNIFORM_TARGET_PX_MAX, Math.max(UNIFORM_TARGET_PX_MIN, v));
  }
  return effectiveNormalizeTargetPx(icon);
}

/** Effective tint flag: tintIcons wins when present; legacy designs saved
 *  with colorMode "tint" hydrate as ON until their first tint edit. */
export function effectiveTintIcons(icon: IconStyle): boolean {
  if (icon.tintIcons != null) return icon.tintIcons === true;
  return icon.colorMode === "tint";
}

/** LEGACY-SUPPORT (dormant % path): effective weight as a percentage.
 *  Read only for designs that predate strokeWeightPx — the renderer's
 *  dormant fallback and the migration display helper. */
export function effectiveStrokeWeightPct(icon: IconStyle): number {
  if (icon.strokeWeightPct != null) {
    return Math.round(Math.min(100, Math.max(-100, icon.strokeWeightPct)));
  }
  const legacy = icon.weightScale;
  if (legacy == null || legacy === 1) return 0;
  return Math.round(Math.min(100, Math.max(-100, (legacy - 1) * 100)));
}

/** LEGACY-SUPPORT: effective normalize TARGET stroke width in sheet canvas
 *  px, read via effectiveUniformTargetPx for legacy two-mode designs and
 *  by the migration display helper. normalizeTargetPx was a REAL px value
 *  and passes through verbatim; records that only stored the old
 *  percentage-based normalizeWeight hydrate at the 2 px default — the old
 *  ×2.5 conversion multiplier was REMOVED (it was not mathematically
 *  derived from the icon coordinate system or a visual measurement, and
 *  the spec forbids magic multipliers). */
export function effectiveNormalizeTargetPx(icon: IconStyle): number {
  const v = icon.normalizeTargetPx;
  if (v != null && Number.isFinite(v)) {
    return Math.min(UNIFORM_TARGET_PX_MAX, Math.max(UNIFORM_TARGET_PX_MIN, v));
  }
  return 2;
}

/** LEGACY-SUPPORT (dormant % path): weight MULTIPLIER for the render
 *  engine (1 = native). The icon's own native stroke is the baseline:
 *  0% → ×1, −50% → ×0.5, +50% → ×1.5, −100% → ×0.25 floor, +100% → ×2
 *  cap. Never consulted once a design carries strokeWeightPx / uniformStroke. */
export function strokeWeightFactor(icon: IconStyle): number {
  const pct = effectiveStrokeWeightPct(icon);
  return Math.min(2, Math.max(0.25, 1 + pct / 100));
}

/* ------------------------------------------------------------------ */
/* Geometry                                                            */
/* ------------------------------------------------------------------ */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type RegionKey =
  | "grid"
  | "hero"
  | "category"
  | "volume"
  | "caption"
  | "footer";

export type GeometryOverrides = Partial<Record<RegionKey, Partial<Rect>>>;

/* ------------------------------------------------------------------ */
/* Sheet design                                                        */
/* ------------------------------------------------------------------ */

export interface SheetDesign {
  background: string;
  /** Optional two-stop gradient background (official templates only).
   *  When set, it replaces the solid background fill in preview AND export;
   *  null / undefined = solid `background` (legacy designs hydrate solid). */
  bgGradient?: GradientFill | null;
  /** Background visibility master switch — false removes the background
   *  entirely from preview AND export (official templates: the Background
   *  rect is not drawn; custom templates: the detected background element
   *  is hidden). Optional: older designs hydrate as true (visible). */
  backgroundVisible?: boolean;
  card: CardStyle;
  hero: HeroStyle;
  icon: IconStyle;
  typography: {
    category: TextStyle;
    volume: TextStyle;
    caption: TextStyle;
    footer: TextStyle;
  };
  captionText: string;
  footerText: string;
  spacing: {
    /** grid gap in canvas px */
    gap: number;
    /** padding inside each cell */
    cellPadding: number;
    /** icon size as a fraction of the inner cell box (0.1..1).
     *  Optional: designs created before this field hydrate at the
     *  historical default 0.86. */
    iconScale?: number;
  };
  /** Left rail paint (user default sheets). Optional: older designs fall
   *  back to the owning template's rail defaults at render time. */
  rail?: RailStyle;
  geometryOverrides: GeometryOverrides;
  /** Present on custom-template sheet designs created (or migrated) after
   *  universal custom-template editing. Absent → legacy placeholder design
   *  whose inert fields get re-stamped from the owning template's detected
   *  defaults at hydrate (one-time, visual no-op). */
  customDesignV2?: boolean;
}

/* ------------------------------------------------------------------ */
/* Icon library entry — IMMUTABLE source                               */
/* ------------------------------------------------------------------ */

export interface IconEntry {
  id: string;
  fileName: string;
  /** original, immutable source SVG */
  svg: string;
  createdAt: number;
  /** user tags — power library filtering & AI categorization.
   *  Optional: entries persisted before tags existed hydrate as untagged. */
  tags?: string[];
  /** Human metadata (round 15) — display title for this icon, independent
   *  of the file name. Surfaces in the inspector, the command palette and
   *  library tooltips; matched by library search; embedded as <title> in
   *  downloaded/copied SVGs. Optional: pre-round-15 entries hydrate
   *  without it; empty string is normalized away (never persisted). */
  title?: string;
  /** Human metadata (round 15) — free-form description of what the icon
   *  depicts or how it should be used. Matched by library search; embedded
   *  as <desc> in downloaded/copied SVGs (accessibility). Same lifecycle
   *  as title: optional, empty normalized away. */
  description?: string;
}

/** Library panel sort modes. "manual" = library order (order of upload /
 *  management), the long-standing default. "stroke-asc"/"stroke-desc"
 *  (round 17) sort by the MEASURED native stroke width — the same cached
 *  analyzeNativeStroke measurement the sheet renderer and inspector use —
 *  so inconsistent-weight icons surface at the ends of the list. */
export type LibrarySortMode =
  | "manual"
  | "name-asc"
  | "name-desc"
  | "newest"
  | "oldest"
  | "tags-desc"
  | "stroke-asc"
  | "stroke-desc";

/** Multi-tag filter combining logic. "and" requires an icon to carry EVERY
 *  selected tag; "or" matches on any one of them. */
export type LibraryTagLogic = "and" | "or";

/** Library tile density — drives the grid column count, tile size and the
 *  virtualization row stride (see DENSITY_PRESETS in icon-library.tsx). */
export type LibraryDensity = "compact" | "standard" | "large";

/* ------------------------------------------------------------------ */
/* Per-cell exceptions                                                 */
/* ------------------------------------------------------------------ */

/** Per-icon exceptions on ONE sheet's grid. Keyed by ICON id (not cell
 *  index): the override follows the icon when cells are reordered, and
 *  moving the icon to another sheet / deleting it simply drops the entry
 *  (the map is pruned on every edit). Design presets never capture these —
 *  they are per-sheet content decisions, not reusable paint. */
export interface CellOverride {
  /** Skip this icon's cell ENTIRELY (card + artwork) in preview AND export —
   *  a visual hole without removing the icon from the sheet or its count. */
  skip?: boolean;
  /** Per-cell card fill — replaces the sheet-wide card color/gradient for
   *  this cell only (official templates). null/undefined = sheet default.
   *  Custom templates render their own artwork and ignore this field. */
  cardColor?: string | null;
  /** Per-cell card GRADIENT fill (round 12). Wins over cardColor when both
   *  are set (the picker keeps them mutually exclusive anyway). Setting one
   *  via the popover clears the other; null/undefined = no gradient override.
   *  Custom templates ignore this just like cardColor. */
  cardGradient?: GradientFill | null;
  /** Per-icon STROKE exception (round 9): overrides the sheet-wide UNIFORM
   *  target for this one icon (sheet-canvas px, 0.5–100, one decimal) —
   *  e.g. the sheet targets 2 px but a chunky logo icon stays at 6 px.
   *  null/undefined = the sheet-wide target. Consulted only while the
   *  sheet's uniform stroke is ON (preserved — never cleared — while OFF,
   *  the same semantics the sheet-wide target has for the weight value).
   *  Applies wherever the icon renders on THIS sheet (grid cell + hero
   *  embed — the map is keyed by icon id). Design presets never capture
   *  it (per-sheet content decision, like the other fields here); moving
   *  the icon to another sheet drops the entry with the map prune. */
  strokeTargetPx?: number | null;
  /** Per-icon WEIGHT exception (round 12) — the relative-mode twin of
   *  strokeTargetPx: overrides the sheet-wide strokeWeightPx for this one
   *  icon (sheet-canvas px, integer −100…+100, 0 = force this icon to its
   *  EXACT native weight even while the sheet adjusts others). null /
   *  undefined = the sheet-wide weight. Consulted only while uniform stroke
   *  is OFF (preserved while ON) — the mirrored semantics of the target
   *  exception, so an icon can carry both across mode switches. Same
   *  lifecycle: keyed by icon id, pruned on move/delete, never captured by
   *  design presets. */
  strokeWeightPx?: number | null;
}

/* ------------------------------------------------------------------ */
/* Sheet                                                               */
/* ------------------------------------------------------------------ */

export interface Sheet {
  id: string;
  templateId: string;
  /** Immutable snapshot of the CUSTOM template this sheet was created with
   * (or switched to). Pinned at stamp time — later template edits bump the
   * record's version and NEVER retroactively restyle this sheet; deleting
   * the template from the library leaves this snapshot rendering intact.
   * Official templates are immutable built-ins and never carry snapshots.
   * Optional: legacy sheets hydrate without one and are backfilled in-memory
   * from the current record version (§ phase-3 migration). */
  templateSnapshot?: SheetTemplateSnapshot;
  /** sheet-owned icon ids, in sheet order */
  iconIds: string[];
  heroIconId: string | null;
  category: string;
  /** EFFECTIVE volume number (manual override when volumeManual, else the
   *  automatic value). Always the rendered/exported one. */
  volume: number;
  /** True when the user MANUALLY typed this sheet's volume — a per-sheet
   *  override the automatic numbering must never clobber (generation,
   *  duplication, category changes, reordering). Reset Volume removes it.
   *  Optional: legacy sheets hydrate as automatic (false). */
  volumeManual?: boolean;
  /** The AUTOMATIC volume snapshot for this sheet — what Reset Volume
   *  restores. Equals `volume` while the sheet is automatic; frozen at the
   *  last automatic value while a manual override is active. Optional:
   *  legacy sheets hydrate with volumeAuto = volume. */
  volumeAuto?: number;
  /** optional user-facing display name — null/undefined falls back to the
   *  positional "Sheet NN" title. Optional: legacy sheets hydrate unnamed. */
  name?: string | null;
  /** per-icon cell exceptions (skip / card color). Optional: legacy sheets
   *  hydrate with none — every cell renders the sheet-wide design. */
  cellOverrides?: Record<string, CellOverride>;
  design: SheetDesign;
  createdAt: number;
  updatedAt: number;
  /** True for sheets created by the generator flows (Generate sheets,
  *  move-to-new-sheet, overflow sheets). Generated sheets whose icons are
  *  all removed are pruned automatically; manually created sheets
  *  (duplicates) are never auto-deleted. Optional: legacy sheets hydrate
  *  as generated when they contain icons. */
  generated?: boolean;
}

/* ------------------------------------------------------------------ */
/* Template                                                            */
/* ------------------------------------------------------------------ */

export interface TemplateGrid {
  cols: number;
  rows: number;
  gap: number;
}

export interface TemplateDef {
  id: string;
  name: string;
  capacity: number;
  width: number;
  height: number;
  grid: TemplateGrid;
  regions: Record<RegionKey, Rect>;
  /** Left rail geometry + fallback paint for sheets whose design has no
   *  rail of its own. Optional: templates without a rail render as before. */
  rail?: TemplateRail;
  /** initial design defaults for new sheets using this template */
  defaults: SheetDesign;
  builtIn: boolean;
  /** Where this template came from. Absent = official built-in (older data);
   *  "custom" = user-imported SVG template (universal template support). */
  sourceType?: "custom";
  /** Present ONLY on user-imported templates. The original SVG is the visual
   *  master — the renderer embeds it verbatim and only places icons into the
   *  detected slots. */
  custom?: TemplateCustomData;
}

/** Extra data carried by user-imported (custom) templates. */
export interface TemplateCustomData {
  /** the ORIGINAL uploaded SVG source — preserved verbatim, never modified */
  sourceSvg: string;
  /** original viewBox string, e.g. "0 0 3600 2400" */
  viewBox: string;
  /** detected icon slots in viewBox coordinates, in sheet order
   *  (top-to-bottom, left-to-right). Length === capacity. */
  iconSlots: Rect[];
  /** detected hero slot, or null when no distinct hero area was found */
  heroSlot: Rect | null;
  createdAt: number;
  /** analysis provenance (for the template manager UI) */
  metadata: CustomTemplateMetadata;
  /** Role-annotated copy of the source SVG (geometry-identical; carries
   *  data-iss-role markers on the elements the editing system may touch).
   *  Absent on records saved before universal editing — the renderer then
   *  embeds the original verbatim and the Properties panel shows those
   *  controls as unavailable. */
  editableSvg?: string;
  /** Detected element roles + captured original styles (aligned with
   *  iconSlots). Absent on legacy records. */
  roles?: CustomTemplateRoles;
  /** Record revision this def was built from (1-based; sheets pin their own
   *  version via Sheet.templateSnapshot — staleness is detectable by
   *  comparing the two). */
  version: number;
}

export interface CustomTemplateMetadata {
  autoDetected: boolean;
  /** 0..1 — how confident the analyzer was in the slot detection */
  confidence: number;
  /** human-readable grid description, e.g. "9 × 8 grid" or "irregular layout" */
  gridDescription: string;
  /** short notes surfaced in the import dialog */
  notes?: string[];
  /** original file name of the upload */
  fileName?: string;
  /** validation warnings from the analyzer (detection reliability) */
  warnings?: string[];
  /** median slot gap, viewBox units (horizontal × vertical) */
  spacing?: { h: number; v: number } | null;
  /** number of editable text elements found in the template */
  textElements?: number;
  /** background element note, e.g. "3600 × 2400" (null = none detected) */
  background?: string | null;
  /** how many cell-size sections contributed slots (1 = uniform grid) */
  sections?: number;
}

/** Persisted shape of a user-imported template (IndexedDB). */
export interface CustomTemplateRecord {
  id: string;
  name: string;
  sourceSvg: string;
  width: number;
  height: number;
  viewBox: string;
  capacity: number;
  iconSlots: Rect[];
  heroSlot: Rect | null;
  grid: TemplateGrid;
  createdAt: number;
  metadata: CustomTemplateMetadata;
  /** role-annotated SVG + captured roles (additive; legacy records lack both) */
  editableSvg?: string;
  roles?: CustomTemplateRoles;
  /** Present only on BUILDER-published templates: the structured authoring
   *  document embedded at publish time so “Edit in Builder” reconstructs
   *  the exact editing state (never reverse-engineered from the artwork).
   *  Absent on uploaded-svg templates — that is the distinction the
   *  Template Library UI keys “Edit” on. */
  builderDoc?: BuilderDocument;
  /** Revision number, 1-based. Absent on legacy records = version 1.
   * Every library update (re-publish, republish-after-edit) bumps it;
   * sheets pin the version they were created with via templateSnapshot. */
  version?: number;
}

/** Per-sheet immutable copy of a custom template (phase 3 — sheet/template
 * version safety). Rendering, editing and export resolve a sheet through
 * `sheetTemplate()` (templates.ts): the snapshot wins whenever the live
 * record is missing (deleted from the library) or has moved to a newer
 * version. The embedded record intentionally carries NO builderDoc —
 * rendering/editing never need the authoring document, and “Edit in
 * Builder” always resolves through the live library record. */
export interface SheetTemplateSnapshot {
  /** record version captured at stamp time (1 for pre-versioning records) */
  version: number;
  /** display name captured at stamp time (fallback once the record is gone) */
  name: string;
  /** the full custom record minus builderDoc */
  record: Omit<CustomTemplateRecord, "builderDoc">;
}

/** A custom-template record that failed structural validation at hydrate
 * or import time (§ phase-3 error recovery). Broken records are excluded
 * from the registry so they can never crash a render, but stay listed in
 * the Template Library with an explicit Remove action — never silent loss. */
export interface TemplateLoadError {
  id: string;
  name: string;
  reason: string;
}

/* ------------------------------------------------------------------ */
/* Custom template property mapping (universal editing)               */
/* ------------------------------------------------------------------ */

/** Editing role a detected text element can be mapped to. "count" is the
 *  live icon counter ("30 ICONS") — builder templates only; records saved
 *  before it existed simply have no count capture. */
export type CustomTextRole = "category" | "volume" | "caption" | "count";

/** Captured paint of a detected grid-cell element (computed at import;
 *  colors normalized to hex where possible). */
export interface CustomCellPaint {
  fill: string;
  stroke: string;
  strokeWidth: number;
  opacity: number;
}

/** Captured style + content of a text element mapped to an editing role. */
export interface CustomTextStyleCapture {
  role: CustomTextRole;
  /** original text content (trimmed) — the template's own words */
  content: string;
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  letterSpacing: number;
  color: string;
  anchor: TextAlign;
  fontStyle: "normal" | "italic";
  /** measured box in viewBox units (wrap width reference) */
  rect: Rect;
  /** original x/y anchor attributes when numeric (offsets translate these) */
  xAttr: number | null;
  yAttr: number | null;
  /** the builder's Auto Fit choice for this text (absent on records saved
   *  before the flag existed — the studio then keeps its role default) */
  autoFit?: boolean;
}

/** Everything the editing system needs to know about a custom template's
 *  detected structure: which editing roles exist and what their original
 *  values were (so defaults render the template exactly as uploaded). */
export interface CustomTemplateRoles {
  /** detected background element's fill, or null when there is none */
  backgroundFill: string | null;
  /** per-slot captured paint of the backing cell element — aligned with
   *  iconSlots; null when a slot has no backing element (manual slots). */
  cellPaint: Array<CustomCellPaint | null>;
  /** text elements mapped to editing roles (at most one per role) */
  text: {
    category?: CustomTextStyleCapture;
    volume?: CustomTextStyleCapture;
    caption?: CustomTextStyleCapture;
    count?: CustomTextStyleCapture;
  };
  /** min(heroSlot.width, heroSlot.height) — hero-card sizing default */
  heroSlotSize: number | null;
  /** how many slots are backed by real template elements */
  cellCount: number;
}

/** Rail geometry in canvas units. The rail always hugs the left edge and
 *  spans the full canvas height; only its width and corner radius vary. */
export interface TemplateRail {
  width: number;
  /** outer (left) corner radius */
  radius: number;
  /** VOL ribbon — flag shape with a notch pointing into the right edge */
  ribbon: {
    x: number;
    y: number;
    w: number;
    h: number;
    /** depth of the right-edge chevron notch */
    notch: number;
  };
  /** format pill row (AI / SVG / EPS / PNG badges) */
  pills: {
    x: number;
    y: number;
    w: number;
    h: number;
    gap: number;
    radius: number;
  };
  /** fallback paint for sheets without design.rail (also the initial value) */
  defaults: RailStyle;
}

/* ------------------------------------------------------------------ */
/* User-saved design presets                                           */
/* ------------------------------------------------------------------ */

/** Which customization groups a saved preset carries. */
export interface DesignPresetIncludes {
  /** typography styles + caption/footer text */
  typography: boolean;
  /** background, grid-card paint, rail paint */
  colors: boolean;
  /** icon appearance: stroke weight, tint mode/color */
  appearance: boolean;
  /** hero settings (scale, offsets, card style) — never the hero icon */
  hero: boolean;
  /** spacing (icon scale, cell padding, grid gap) */
  layout: boolean;
}

/** A reusable design snapshot saved by the user. NEVER carries icons,
 *  category, volume, template choice or icon assignments — applying it
 *  only restyles the target sheet's design. */
export interface UserDesignPreset {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  /** template the preset was captured from (for cross-template scaling) */
  sourceTemplateId: string;
  /** canvas size of the source template at capture time */
  sourceCanvas: { width: number; height: number };
  includes: DesignPresetIncludes;
  /** captured design slices — only the groups included at save time */
  data: {
    typography?: SheetDesign["typography"];
    captionText?: string;
    footerText?: string;
    background?: string;
    /** captured gradient state — null = solid background (colors slice) */
    bgGradient?: GradientFill | null;
    card?: CardStyle;
    rail?: RailStyle;
    icon?: IconStyle;
    hero?: HeroStyle;
    spacing?: SheetDesign["spacing"];
  };
}

/* ------------------------------------------------------------------ */
/* Workspace                                                           */
/* ------------------------------------------------------------------ */

/** Last-used export dialog settings — restored on every export (round 3). */
export interface ExportPreferences {
  scope: "active" | "selected" | "all";
  format: "svg" | "png" | "pdf";
  /** raster scale as string ("1" | "2" | "3") — Select value type */
  scale: string;
  transparent: boolean;
  /** PDF metadata footer strip per page. Optional: older workspaces hydrate
   *  as ON (the footer's default state). */
  pdfFooter?: boolean;
}

export interface WorkspaceSettings {
  viewMode: "overview" | "edit";
  showGridGuides: boolean;
  zoom: number; // 0 = fit
  /** last-used export settings; optional for older persisted workspaces */
  export?: ExportPreferences;
  /** library tile density — optional for older persisted workspaces;
   *  hydrates as "standard" when absent */
  libraryDensity?: LibraryDensity;
  /** library stroke-weight audit armed (round 22 — moved from runtime-only
   *  state into settings so the audit survives reloads, exactly like
   *  libraryDensity). Absent = false on older workspaces. */
  strokeAudit?: boolean;
  /** unit the audit badges/census display: "root" = viewBox user units
   *  (the inspector convention), "canvas" = the active sheet's grid embed
   *  box converted px (the stroke-report convention). Absent = "root". */
  strokeAuditUnit?: "root" | "canvas";
}

export interface Workspace {
  icons: Record<string, IconEntry>;
  iconOrder: string[];
  sheets: Sheet[];
  activeSheetId: string | null;
  categoryVolumes: Record<string, number>;
  settings: WorkspaceSettings;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

export function sheetTitle(sheet: Sheet, index: number): string {
  const named = typeof sheet.name === "string" ? sheet.name.trim() : "";
  return named || `Sheet ${String(index + 1).padStart(2, "0")}`;
}

export function formatVolume(v: number): string {
  return `VOL. ${String(v).padStart(2, "0")}`;
}

/* ------------------------------------------------------------------ */
/* Manual volume numbers                                               */
/* ------------------------------------------------------------------ */

/** Highest allowed volume number — comfortably above any realistic
 *  sheet-per-project count (5,000+ icons / ~100 sheets). Two-digit
 *  display is a MINIMUM pad, never a cap: 100 → "VOL. 100". */
export const MAX_VOLUME = 9999;

/** Clamp any candidate volume into the valid positive-integer range
 *  1..9999. Tolerates garbage (NaN / strings / negatives / decimals) so
 *  state hydration, backup restore and field commits can never corrupt
 *  a sheet. */
export function normalizeVolume(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(MAX_VOLUME, Math.max(1, Math.round(n)));
}

/** The numeric text shown in the editable Volume field — the "01" of
 *  "VOL. 01" (the renderer adds the prefix). */
export function formatVolumeNumber(v: number): string {
  return String(normalizeVolume(v)).padStart(2, "0");
}

/** Parse typed/pasted volume text. Accepts optional spaces and leading
 *  zeros (" 07 " → 7); rejects letters, signs, decimals and empty —
 *  returns null so the caller can restore the previous valid value. */
export function parseVolumeText(text: string): number | null {
  const t = text.trim();
  if (!/^\d{1,6}$/.test(t)) return null;
  return normalizeVolume(t);
}
