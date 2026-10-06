/**
 * ICON SHEET STUDIO — User-saved design presets (v3).
 *
 * A preset captures a sheet's CUSTOMIZATION (typography, colors,
 * appearance/stroke, hero settings, layout) as a reusable snapshot:
 *
 *  · SAVE     — `captureUserPreset` deep-copies the chosen design slices.
 *    Presets NEVER carry icons, category, volume, template choice or icon
 *    assignments — those are sheet content, not design.
 *
 *  · APPLY    — `applyPresetToDesign` merges the captured slices onto a
 *    target sheet's design, template-aware:
 *      – same template          → values copied verbatim;
 *      – different canvas size  → absolute-unit values (font sizes, gaps,
 *        hero card size…) are proportionally rescaled so the preset lands
 *        visually consistent instead of collapsing or exploding;
 *      – target lacks a feature (custom template with no rail / no mapped
 *        text / no footer) → ONLY that property is skipped, the rest of the
 *        application proceeds; the skipped list is reported back for the UI.
 *
 * Works across official templates, custom templates and mixed directions.
 */

import type {
  CardStyle,
  DesignPresetIncludes,
  HeroStyle,
  RailStyle,
  Sheet,
  SheetDesign,
  TemplateDef,
  TextStyle,
  UserDesignPreset,
} from "./types";
import { nextId } from "./svg";
import { getTemplate } from "./templates";

/* ------------------------------------------------------------------ */
/* Capture                                                             */
/* ------------------------------------------------------------------ */

export function captureUserPreset(
  sheet: Sheet,
  template: TemplateDef,
  name: string,
  includes: DesignPresetIncludes
): UserDesignPreset {
  const d = sheet.design;
  const data: UserDesignPreset["data"] = {};
  if (includes.typography) {
    data.typography = structuredClone(d.typography);
    data.captionText = d.captionText;
    data.footerText = d.footerText;
  }
  if (includes.colors) {
    data.background = d.background;
    /* gradient state is part of the colors slice — null means solid, so
     * applying the preset can turn a gradient target back to solid */
    data.bgGradient = d.bgGradient ? { ...d.bgGradient } : null;
    data.card = structuredClone(d.card);
    if (d.rail) data.rail = structuredClone(d.rail);
  }
  if (includes.appearance) data.icon = { ...d.icon };
  if (includes.hero) data.hero = structuredClone(d.hero);
  if (includes.layout) data.spacing = { ...d.spacing };
  return {
    id: nextId("pset"),
    name: name.trim(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    sourceTemplateId: sheet.templateId,
    sourceCanvas: { width: template.width, height: template.height },
    includes: { ...includes },
    data,
  };
}

/* ------------------------------------------------------------------ */
/* Apply                                                               */
/* ------------------------------------------------------------------ */

export interface PresetApplyReport {
  /** group labels actually applied (e.g. "typography", "colors") */
  applied: string[];
  /** human-readable skip notes (unsupported on the target template) */
  skipped: string[];
  /** true when absolute values were rescaled for the target canvas */
  rescaled: boolean;
}

/** Proportional scale between two canvases (1 = identical). */
function canvasRatio(
  preset: UserDesignPreset,
  targetTemplate: TemplateDef,
  sameTemplate: boolean
): number {
  if (sameTemplate) return 1;
  const srcH = preset.sourceCanvas.height;
  const dstH = targetTemplate.height;
  if (!srcH || !dstH) return 1;
  const ratio = dstH / srcH;
  if (!Number.isFinite(ratio) || ratio <= 0) return 1;
  if (ratio > 0.98 && ratio < 1.02) return 1;
  return Math.min(20, Math.max(0.05, ratio));
}

function scaledTextStyle(style: TextStyle, ratio: number): TextStyle {
  if (ratio === 1) return { ...style };
  return {
    ...style,
    fontSize: Math.max(6, Math.round(style.fontSize * ratio)),
    letterSpacing: Math.round(style.letterSpacing * ratio * 10) / 10,
    offsetX: Math.round(style.offsetX * ratio),
    offsetY: Math.round(style.offsetY * ratio),
  };
}

function scaledCard(card: CardStyle, ratio: number): CardStyle {
  if (ratio === 1) return { ...card, gradient: card.gradient ? { ...card.gradient } : null };
  return {
    ...card,
    borderWidth: Math.round(card.borderWidth * ratio),
    radius: Math.round(card.radius * ratio),
    shadowBlur: Math.round(card.shadowBlur * ratio),
    shadowX: Math.round(card.shadowX * ratio),
    shadowY: Math.round(card.shadowY * ratio),
    gradient: card.gradient ? { ...card.gradient } : null,
  };
}

function scaledHero(hero: HeroStyle, ratio: number): HeroStyle {
  if (ratio === 1) return { ...hero, card: { ...hero.card } };
  return {
    ...hero,
    cardSize: Math.max(60, Math.round(hero.cardSize * ratio)),
    offsetX: Math.round(hero.offsetX * ratio),
    offsetY: Math.round(hero.offsetY * ratio),
    cardOffsetX: Math.round(hero.cardOffsetX * ratio),
    cardOffsetY: Math.round(hero.cardOffsetY * ratio),
    /* P5: the hero icon padding scales with the canvas like every other
     * geometric hero value (absent on older presets → 0 × ratio = 0). */
    iconPadding: Math.round((hero.iconPadding ?? 0) * ratio),
    card: { ...hero.card, borderWidth: Math.round(hero.card.borderWidth * ratio) },
  };
}

/**
 * Merge a preset onto a target sheet's design (MUTATES `design` — callers
 * pass a structuredClone). The target sheet's icons, hero icon, category,
 * volume, template and icon assignments are never touched (they don't live
 * on the design). Returns what applied / what was skipped.
 */
export function applyPresetToDesign(
  design: SheetDesign,
  preset: UserDesignPreset,
  targetTemplate: TemplateDef
): PresetApplyReport {
  const report: PresetApplyReport = { applied: [], skipped: [], rescaled: false };
  const sameTemplate = preset.sourceTemplateId === targetTemplate.id;
  const ratio = canvasRatio(preset, targetTemplate, sameTemplate);
  report.rescaled = ratio !== 1;
  const isCustom = targetTemplate.sourceType === "custom";
  const customRoles = isCustom ? targetTemplate.custom?.roles : undefined;
  const d = preset.data;

  /* -- typography ------------------------------------------------------ */
  if (preset.includes.typography && d.typography) {
    const keys: Array<keyof SheetDesign["typography"]> = ["category", "volume", "caption", "footer"];
    let anyApplied = false;
    for (const key of keys) {
      const src = d.typography[key];
      if (!src) continue;
      /* skip only the text styles the target template cannot show */
      if (isCustom && !(key === "footer" ? false : customRoles?.text[key])) {
        report.skipped.push(
          `${key} text — this template has no detected ${key} text element`
        );
        continue;
      }
      design.typography[key] = scaledTextStyle(src, ratio);
      anyApplied = true;
    }
    if (d.captionText !== undefined) design.captionText = d.captionText;
    if (d.footerText !== undefined) {
      /* Capacity stamps ("27 ICONS") are template-owned text, exactly like
       * changeSheetTemplate treats them: if the preset captured the SOURCE
       * template's default stamp, re-stamp the TARGET template's capacity
       * instead of transplanting a wrong number. User-authored footer copy
       * (anything that is not the source template's default) carries over. */
      const sourceTemplate = getTemplate(preset.sourceTemplateId);
      const isSourceStamp =
        !sourceTemplate || d.footerText === sourceTemplate.defaults.footerText;
      if (isSourceStamp) {
        design.footerText = targetTemplate.defaults.footerText;
      } else {
        design.footerText = d.footerText;
      }
    }
    if (anyApplied) report.applied.push("typography");
  }

  /* -- colors ----------------------------------------------------------- */
  if (preset.includes.colors) {
    let anyApplied = false;
    if (d.background !== undefined) {
      if (isCustom && customRoles?.backgroundFill == null) {
        report.skipped.push("background — no background element detected");
      } else {
        design.background = d.background;
        anyApplied = true;
      }
    }
    if (d.bgGradient !== undefined) {
      if (isCustom) {
        if (d.bgGradient) report.skipped.push("background gradient — imported templates keep their own artwork");
      } else {
        design.bgGradient = d.bgGradient ? { ...d.bgGradient } : null;
        anyApplied = true;
      }
    }
    if (d.card) {
      if (isCustom && (customRoles?.cellCount ?? 0) === 0) {
        report.skipped.push("grid cards — no cell elements detected");
      } else {
        design.card = scaledCard(d.card, ratio);
        anyApplied = true;
      }
    }
    if (d.rail) {
      if (targetTemplate.rail) {
        design.rail = structuredClone(d.rail) as RailStyle;
        anyApplied = true;
      } else {
        report.skipped.push("left rail — this template has none");
      }
    }
    if (anyApplied) report.applied.push("colors");
  }

  /* -- appearance (stroke / tint) — supported everywhere ---------------- */
  if (preset.includes.appearance && d.icon) {
    design.icon = { ...d.icon };
    report.applied.push("appearance");
  }

  /* -- hero -------------------------------------------------------------- */
  if (preset.includes.hero && d.hero) {
    if (isCustom && !targetTemplate.custom?.heroSlot) {
      report.skipped.push("hero — no hero slot detected");
    } else {
      const hero = scaledHero(d.hero, ratio);
      /* keep the target's card-visibility semantics for custom templates:
       * a preset saved with an opt-in card carries it; presets saved from
       * official sheets (or card-less customs) don't force a card onto a
       * custom template's own hero artwork */
      if (isCustom && hero.customHeroCard !== true) hero.customHeroCard = design.hero.customHeroCard;
      design.hero = hero;
      report.applied.push("hero");
    }
  }

  /* -- layout ------------------------------------------------------------ */
  if (preset.includes.layout && d.spacing) {
    const spacing = { ...d.spacing };
    if (ratio !== 1 && spacing.gap) {
      spacing.gap = Math.max(0, Math.round(spacing.gap * ratio));
    }
    design.spacing = spacing;
    report.applied.push("layout");
  }

  return report;
}
