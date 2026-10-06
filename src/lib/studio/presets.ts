/**
 * ICON SHEET STUDIO — Design presets.
 * One-click coherent artwork themes applied to the ACTIVE SHEET only,
 * through the standard updateSheetDesign action (one undo entry per apply).
 * Presets never touch icons, heroes, categories, volumes or geometry —
 * they restyle colors/typography/shape language only.
 *
 * Readability contract (round 14 fix): every preset must keep ALL sheet
 * text legible on whatever it renders against —
 *   · volume text sits ON the VOL ribbon → contrast ≥3:1 against the
 *     ribbon gradient (large bold text);
 *   · category / caption / footer sit on the left rail → contrast ≥3:1
 *     against the rail gradient;
 *   · pill labels sit on their pill chips;
 *   · hero card must contrast the icon paint: presets that keep icons
 *     native (dark sample strokes) use a LIGHT hero card; presets that
 *     tint icons light use a DARK hero card.
 * Typographic scale is PRESERVED: presets author family, weight, spacing
 * and color but never the font size — the sheet keeps its current (or
 * template-default) sizes, so text can never collapse to unreadable
 * dots on the wide default-sheet canvases (6000 × 2400+).
 */

import type { SheetDesign, TextStyle } from "./types";

export interface DesignPreset {
  id: string;
  name: string;
  /** swatches for the chip UI: [background, card, ink] */
  swatch: [string, string, string];
  apply: (d: SheetDesign) => void;
}

/** Merge preset typography onto the live style. Font size is intentionally
 *  NOT patched — the preset inherits the sheet's current scale so text
 *  stays exactly as readable as it was before the theme was applied. */
function typeScale(style: TextStyle, patch: Partial<TextStyle>): TextStyle {
  const { fontSize: _ignored, ...rest } = patch;
  return { ...style, ...rest };
}

/** Rail restyle helper — only touches designs that already own a rail. */
function rail(
  d: SheetDesign,
  opts: {
    from: string;
    to: string;
    ribbonFrom: string;
    ribbonTo: string;
    pill: string;
    pillLabel: string;
  }
): void {
  if (!d.rail) return;
  d.rail.from = opts.from;
  d.rail.to = opts.to;
  d.rail.ribbon.from = opts.ribbonFrom;
  d.rail.ribbon.to = opts.ribbonTo;
  d.rail.pills.color = opts.pill;
  d.rail.pills.labelColor = opts.pillLabel;
}

export const DESIGN_PRESETS: DesignPreset[] = [
  {
    id: "warm-paper",
    name: "Warm Paper",
    swatch: ["#F5F2EB", "#FFFFFF", "#1F1D17"],
    apply: (d) => {
      d.background = "#F5F2EB";
      /* themes define their own solid background — clear any user gradient */
      d.bgGradient = null;
      d.card = { ...d.card, color: "#FFFFFF", borderColor: "#E5E0D5", radius: 18, borderWidth: 0, opacity: 1, shadow: true, shadowStrength: 0.1, shadowBlur: 14, shadowX: 0, shadowY: 5, shadowColor: "#1F1D17", gradient: null };
      /* light hero card — icons keep their original colors on light cards */
      d.hero.card = { ...d.hero.card, color: "#FFFFFF", radius: 32, opacity: 1, borderWidth: 0, borderColor: "#E5E0D5" };
      d.hero.shadow = true;
      d.icon = { ...d.icon, tintIcons: false };
      delete d.icon.colorMode;
      d.typography.category = typeScale(d.typography.category, { color: "#FFFFFF", fontFamily: "Arial, Helvetica, sans-serif", fontWeight: 800, letterSpacing: -1, lineHeight: 1.08, uppercase: true });
      d.typography.volume = typeScale(d.typography.volume, { color: "#FFE9CB", fontFamily: "Arial, Helvetica, sans-serif", fontWeight: 700, letterSpacing: 3, lineHeight: 1, uppercase: true });
      d.typography.caption = typeScale(d.typography.caption, { color: "#CFC7B4", fontFamily: "Georgia, 'Times New Roman', serif", fontWeight: 400, letterSpacing: 0, lineHeight: 1.55 });
      d.typography.footer = typeScale(d.typography.footer, { color: "#FFFFFF", fontFamily: "Arial, Helvetica, sans-serif", fontWeight: 600, letterSpacing: 2.5, lineHeight: 1, uppercase: true });
      /* amber ribbon darkened so the cream VOL text keeps ≥3:1 across the gradient */
      rail(d, { from: "#C2610C", to: "#93380A", ribbonFrom: "#C2610C", ribbonTo: "#93380A", pill: "#55503F", pillLabel: "#F5F2EB" });
    },
  },
  {
    id: "midnight-ink",
    name: "Midnight Ink",
    swatch: ["#14161A", "#20242B", "#E8E6E1"],
    apply: (d) => {
      d.background = "#14161A";
      d.bgGradient = null;
      d.card = { ...d.card, color: "#20242B", borderColor: "#333945", radius: 18, borderWidth: 1, opacity: 1, shadow: true, shadowStrength: 0.35, shadowBlur: 18, shadowX: 0, shadowY: 6, shadowColor: "#000000", gradient: { from: "#242A33", to: "#171B21", angle: 0 } };
      d.hero.card = { ...d.hero.card, color: "#2E3440", radius: 32, opacity: 1, borderWidth: 1, borderColor: "#3A4150" };
      d.hero.shadow = true;
      d.hero.shadowStrength = 0.4;
      d.icon = { ...d.icon, tintIcons: true, tintColor: "#E8E6E1" };
      delete d.icon.colorMode;
      d.typography.category = typeScale(d.typography.category, { color: "#E8E6E1", fontFamily: "Arial, Helvetica, sans-serif", fontWeight: 800, letterSpacing: -1, lineHeight: 1.08, uppercase: true });
      /* near-white on the blue ribbon — the old gray was ~1.1:1 (invisible) */
      d.typography.volume = typeScale(d.typography.volume, { color: "#EDF2FD", fontFamily: "Arial, Helvetica, sans-serif", fontWeight: 700, letterSpacing: 5, lineHeight: 1, uppercase: true });
      d.typography.caption = typeScale(d.typography.caption, { color: "#9AA0AA", fontFamily: "Georgia, 'Times New Roman', serif", fontWeight: 400, letterSpacing: 0.3, lineHeight: 1.6 });
      d.typography.footer = typeScale(d.typography.footer, { color: "#D6D3CC", fontFamily: "Arial, Helvetica, sans-serif", fontWeight: 600, letterSpacing: 3, lineHeight: 1, uppercase: true });
      rail(d, { from: "#232830", to: "#12151A", ribbonFrom: "#3E82FB", ribbonTo: "#1F5FE0", pill: "#262B33", pillLabel: "#C9D4E8" });
    },
  },
  {
    id: "mono-noir",
    name: "Mono Noir",
    swatch: ["#FFFFFF", "#FAFAFA", "#0A0A0A"],
    apply: (d) => {
      d.background = "#FFFFFF";
      d.bgGradient = null;
      d.card = { ...d.card, color: "#FAFAFA", borderColor: "#E5E5E5", radius: 4, borderWidth: 1, opacity: 1, shadow: false, shadowStrength: 0, shadowBlur: 0, shadowX: 0, shadowY: 0, shadowColor: "#000000", gradient: null };
      /* light hero card + dark border — icons are tinted near-black, so a
       * black hero card made them invisible (was #141414) */
      d.hero.card = { ...d.hero.card, color: "#FAFAFA", radius: 6, opacity: 1, borderWidth: 2, borderColor: "#0A0A0A" };
      d.hero.shadow = false;
      d.icon = { ...d.icon, tintIcons: true, tintColor: "#0A0A0A" };
      delete d.icon.colorMode;
      d.typography.category = typeScale(d.typography.category, { color: "#FFFFFF", fontFamily: "Arial, Helvetica, sans-serif", fontWeight: 900, letterSpacing: -2, lineHeight: 1.05, uppercase: true });
      d.typography.volume = typeScale(d.typography.volume, { color: "#D9D9D9", fontFamily: "'Courier New', Courier, monospace", fontWeight: 700, letterSpacing: 6, lineHeight: 1, uppercase: true });
      d.typography.caption = typeScale(d.typography.caption, { color: "#8F8F8F", fontFamily: "'Courier New', Courier, monospace", fontWeight: 400, letterSpacing: 0.5, lineHeight: 1.6 });
      d.typography.footer = typeScale(d.typography.footer, { color: "#F2F2F2", fontFamily: "'Courier New', Courier, monospace", fontWeight: 600, letterSpacing: 2, lineHeight: 1, uppercase: true });
      rail(d, { from: "#1A1A1A", to: "#000000", ribbonFrom: "#3D3D3D", ribbonTo: "#111111", pill: "#1F1F1F", pillLabel: "#EDEDED" });
    },
  },
  {
    id: "sage-studio",
    name: "Sage Studio",
    swatch: ["#E9EFE6", "#FFFFFF", "#223528"],
    apply: (d) => {
      d.background = "#E9EFE6";
      d.bgGradient = null;
      d.card = { ...d.card, color: "#FFFFFF", borderColor: "#D3DFCE", radius: 22, borderWidth: 0, opacity: 1, shadow: true, shadowStrength: 0.08, shadowBlur: 16, shadowX: 0, shadowY: 6, shadowColor: "#223528", gradient: null };
      d.hero.card = { ...d.hero.card, color: "#FFFFFF", radius: 36, opacity: 1, borderWidth: 2, borderColor: "#8FAF94" };
      d.hero.shadow = true;
      d.hero.shadowStrength = 0.14;
      d.icon = { ...d.icon, tintIcons: false };
      delete d.icon.colorMode;
      d.typography.category = typeScale(d.typography.category, { color: "#FFFFFF", fontFamily: "Verdana, Geneva, sans-serif", fontWeight: 800, letterSpacing: -0.5, lineHeight: 1.1, uppercase: true });
      /* sage ribbon darkened so the light VOL text keeps ≥3:1 */
      d.typography.volume = typeScale(d.typography.volume, { color: "#EEF5EE", fontFamily: "Verdana, Geneva, sans-serif", fontWeight: 700, letterSpacing: 2.5, lineHeight: 1, uppercase: true });
      d.typography.caption = typeScale(d.typography.caption, { color: "#A9BCA9", fontFamily: "Georgia, 'Times New Roman', serif", fontWeight: 400, letterSpacing: 0, lineHeight: 1.6 });
      d.typography.footer = typeScale(d.typography.footer, { color: "#FFFFFF", fontFamily: "Verdana, Geneva, sans-serif", fontWeight: 600, letterSpacing: 2, lineHeight: 1, uppercase: true });
      rail(d, { from: "#2C4234", to: "#182B1F", ribbonFrom: "#6E8F75", ribbonTo: "#4C664F", pill: "#2A3D30", pillLabel: "#DCE8DC" });
    },
  },
  {
    id: "sand-dune",
    name: "Sand Dune",
    swatch: ["#F0E7D8", "#FBF6EC", "#4A3F2F"],
    apply: (d) => {
      d.background = "#F0E7D8";
      d.bgGradient = null;
      d.card = { ...d.card, color: "#FBF6EC", borderColor: "#E3D5BE", radius: 26, borderWidth: 1, opacity: 1, shadow: true, shadowStrength: 0.07, shadowBlur: 18, shadowX: 0, shadowY: 7, shadowColor: "#4A3F2F", gradient: null };
      d.hero.card = { ...d.hero.card, color: "#FBF6EC", radius: 40, opacity: 1, borderWidth: 2, borderColor: "#C99A5B" };
      d.hero.shadow = true;
      d.hero.shadowStrength = 0.12;
      d.icon = { ...d.icon, tintIcons: false };
      delete d.icon.colorMode;
      d.typography.category = typeScale(d.typography.category, { color: "#FFFFFF", fontFamily: "'Trebuchet MS', sans-serif", fontWeight: 700, letterSpacing: 0, lineHeight: 1.1, uppercase: true });
      d.typography.volume = typeScale(d.typography.volume, { color: "#FFF6E8", fontFamily: "'Trebuchet MS', sans-serif", fontWeight: 700, letterSpacing: 3, lineHeight: 1, uppercase: true });
      d.typography.caption = typeScale(d.typography.caption, { color: "#C7B79D", fontFamily: "Georgia, 'Times New Roman', serif", fontWeight: 400, letterSpacing: 0.2, lineHeight: 1.5 });
      d.typography.footer = typeScale(d.typography.footer, { color: "#FFFFFF", fontFamily: "'Trebuchet MS', sans-serif", fontWeight: 600, letterSpacing: 2, lineHeight: 1, uppercase: true });
      rail(d, { from: "#5A4C38", to: "#33291B", ribbonFrom: "#B07E43", ribbonTo: "#83542A", pill: "#4A3F2F", pillLabel: "#F5EBDA" });
    },
  },
  {
    id: "blush-editorial",
    name: "Blush Editorial",
    swatch: ["#F7EFEA", "#FFFFFF", "#3D2B2B"],
    apply: (d) => {
      d.background = "#F7EFEA";
      d.bgGradient = null;
      d.card = { ...d.card, color: "#FFFFFF", borderColor: "#EBD9D1", radius: 16, borderWidth: 0, opacity: 1, shadow: true, shadowStrength: 0.09, shadowBlur: 12, shadowX: 0, shadowY: 4, shadowColor: "#3D2B2B", gradient: null };
      d.hero.card = { ...d.hero.card, color: "#FFFFFF", radius: 24, opacity: 1, borderWidth: 2, borderColor: "#D89A8C" };
      d.hero.shadow = true;
      d.hero.shadowStrength = 0.15;
      d.icon = { ...d.icon, tintIcons: false };
      delete d.icon.colorMode;
      d.typography.category = typeScale(d.typography.category, { color: "#FFFFFF", fontFamily: "Georgia, 'Times New Roman', serif", fontWeight: 700, letterSpacing: -0.5, lineHeight: 1.1, uppercase: true });
      d.typography.volume = typeScale(d.typography.volume, { color: "#FDF0EC", fontFamily: "Georgia, 'Times New Roman', serif", fontWeight: 600, letterSpacing: 2, lineHeight: 1, uppercase: true });
      d.typography.caption = typeScale(d.typography.caption, { color: "#C4A99F", fontFamily: "Georgia, 'Times New Roman', serif", fontWeight: 400, letterSpacing: 0.2, lineHeight: 1.65 });
      d.typography.footer = typeScale(d.typography.footer, { color: "#FFFFFF", fontFamily: "Georgia, 'Times New Roman', serif", fontWeight: 600, letterSpacing: 1.5, lineHeight: 1, uppercase: true });
      rail(d, { from: "#4E3A38", to: "#2E1F1E", ribbonFrom: "#B57164", ribbonTo: "#955246", pill: "#4A3330", pillLabel: "#F3E4DE" });
    },
  },
];
