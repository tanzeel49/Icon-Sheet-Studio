"use client";

/**
 * ICON SHEET STUDIO — P5 · THE shared hero fitting engine.
 *
 * ONE module answers every hero-placement question in the app:
 *
 *   1. WHICH icon does the hero display?      → resolveHeroIconId()
 *   2. WHERE may the icon artwork land?        → heroUsableRect()
 *   3. HOW LARGE is the icon embed?            → heroIconBoxSize()
 *
 * The flow (mandated by the P5 spec — never a second implementation):
 *
 *   card bounds → inner usable area (− padding) → icon boundary size
 *   → uniform scale (viewBox aspect, fits BOTH axes) → centered → render
 *
 * Every consumer — the renderer's custom-template path, the renderer's
 * official-template path, the properties panel's live previews
 * (heroEmbedBoxSize) and the builder preview — derives its numbers from
 * HERE, so the preview can never disagree with the final sheet.
 *
 * Fitting guarantee: at iconScale ≤ 1 the icon artwork NEVER exceeds the
 * usable area (uniform scale means aspect is preserved — never distorted,
 * never cropped); the icon is centered on the usable area's center.
 * iconScale > 1 stays the explicit artistic oversize (drawn on top, the
 * existing documented feature — never silently clamped).
 */

import type { HeroStyle, Rect, Sheet } from "./types";

/* ------------------------------------------------------------------ */
/* 1 · Which icon the hero displays                                     */
/* ------------------------------------------------------------------ */

/** Master gate + display-mode resolution — the SINGLE decision point.
 *
 *   enabled === false (or displayMode unresolvable) → null (no hero icon)
 *   "selected" → the sheet's heroIconId (classic behavior)
 *   "first"    → always iconIds[0] — auto-follows content changes
 *   "custom"   → the pinned customIconId (any library icon)
 *
 * Absent fields hydrate to the exact legacy behavior (enabled, selected),
 * so designs saved before P5 render byte-identically. */
export function resolveHeroIconId(sheet: Sheet): string | null {
  const hero = sheet.design.hero;
  if (hero.enabled === false) return null;
  const mode = hero.displayMode ?? "selected";
  if (mode === "first") return sheet.iconIds[0] ?? null;
  if (mode === "custom") {
    const id = hero.customIconId;
    return typeof id === "string" && id.length > 0 ? id : null;
  }
  return sheet.heroIconId ?? null;
}

/** The hero system's effective master switch (absent = on, legacy). */
export function heroEnabled(hero: HeroStyle): boolean {
  return hero.enabled !== false;
}

/* ------------------------------------------------------------------ */
/* 2 · Where the icon may land                                          */
/* ------------------------------------------------------------------ */

/** Padding between the hero card bounds and the icon artwork (≥ 0, and
 *  never more than 45% of the smallest bound — a pad that swallowed the
 *  whole card would invert the rect; the clamp keeps the math honest). */
export function heroIconPadding(hero: HeroStyle, boundsWidth: number, boundsHeight: number): number {
  const raw = hero.iconPadding ?? 0;
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  const limit = Math.min(boundsWidth, boundsHeight) * 0.45;
  return Math.min(raw, Math.max(0, limit));
}

/** The usable icon area: the card bounds shrunk by the padding on every
 *  side. This is the region the icon artwork must fit inside. */
export function heroUsableRect(bounds: Rect, hero: HeroStyle): Rect {
  const pad = heroIconPadding(hero, bounds.width, bounds.height);
  const w = Math.max(1, bounds.width - pad * 2);
  const h = Math.max(1, bounds.height - pad * 2);
  return { x: bounds.x + pad, y: bounds.y + pad, width: w, height: h };
}

/* ------------------------------------------------------------------ */
/* 3 · How large the icon embed is                                      */
/* ------------------------------------------------------------------ */

/** Icon scale clamped exactly like the renderer always has. */
export function heroIconScaleClamped(hero: HeroStyle): number {
  return Math.min(Math.max(hero.iconScale, 0.05), 2.5);
}

/** The SQUARE embed-box size for the hero icon (the interface embedIcon
 *  consumes): the largest square that fits the usable area × iconScale.
 *  embedIcon's own uniform viewBox scaling + centering then guarantees the
 *  artwork fits BOTH axes of that square — aspect preserved, centered. */
export function heroIconBoxSize(usable: Rect, hero: HeroStyle): number {
  const fit = Math.min(usable.width, usable.height);
  return Math.max(1, fit) * heroIconScaleClamped(hero);
}
