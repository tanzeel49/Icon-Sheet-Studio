/**
 * ICON SHEET STUDIO — Sample icon pack.
 * Generates a varied, deterministic set of stroke-based AND fill-based
 * (solid-mark) SVG icons as File objects, flowing through the SAME import
 * pipeline as uploads (validation, stable ids, immutable sources). Mixed
 * viewBox sizes exercise stroke normalization paths; the fill-based
 * samples (solid silhouettes / bold capsules / bands / dots / primitives)
 * exercise the fill-outline + solid stroke paths end-to-end — a weight
 * request thins/grows them as ONE single line per mark (Illustrator
 * stroke-weight semantics), never converting them to hollow outlines.
 * Round 19: em/ex-stroked samples demonstrate the HONEST unmeasurable
 * path (relative stroke units cannot be resolved without a font context —
 * the engine keeps them native and reports "unmeasurable"), and the
 * default 64-icon pick now spreads EVENLY across the whole shape array so
 * every family (media, communication, devices…) appears in the demo
 * library — the first-64 cut used to leave 17 shapes permanently unloaded.
 */

/** One sample shape — stroke mode (d), solid-fill mode (fillD), a
 *  primitive solid (prim), or a stroked path plus a solid child leaf
 *  (solidChild — mixed artwork in ONE icon). */
interface SampleShape {
  name: string;
  /** stroke-based path data (the classic outline samples). */
  d?: string;
  /** fill-based path data — solid marks, no stroke declarations. */
  fillD?: string;
  /** element-level primitive solid (circle / rect leaf). */
  prim?: "circle" | "rect";
  /** append a solid dot leaf to a stroke-based icon (mixed artwork). */
  solidChild?: boolean;
  /** relative-unit (em) stroke path — honestly unmeasurable: standalone
   *  SVG measurement has no font context, so the engine keeps the leaf
   *  native under every request and reports "unmeasurable" (round 19). */
  emD?: string;
  /** relative-unit (ex) stroke path — same honest-unmeasurable demo. */
  exD?: string;
}

const SHAPES: SampleShape[] = [
  { name: "arrow-up", d: "M12 19V5M5 12l7-7 7 7" },
  { name: "arrow-down", d: "M12 5v14M19 12l-7 7-7-7" },
  { name: "arrow-left", d: "M19 12H5M12 5l-7 7 7 7" },
  { name: "arrow-right", d: "M5 12h14M12 5l7 7-7 7" },
  { name: "arrow-diagonal", d: "M7 17L17 7M9 7h8v8" },
  { name: "solid-arrow-right", fillD: "M3.5 10.75h10.5v2.5H3.5zM14 6l7 6-7 6z" },
  /* round 19 · relative-unit strokes — the honest unmeasurable demo: the
   * engine cannot resolve em/ex without a font context, so these keep
   * their native look under every request and surface as "unmeasurable"
   * in the stroke report / a "—" badge in the library audit. */
  { name: "em-stroke-star", emD: "M12 3l2.7 5.7 6.3.8-4.6 4.3 1.2 6.2-5.6-3-5.6 3 1.2-6.2L3 9.5l6.3-.8z" },
  { name: "ex-stroke-check", exD: "M4 12l5 5L20 6" },
  { name: "chevron-up", d: "M6 15l6-6 6 6" },
  { name: "chevron-down", d: "M6 9l6 6 6-6" },
  { name: "chevron-right", d: "M9 6l6 6-6 6" },
  { name: "chevron-left", d: "M15 6l-6 6 6 6" },
  { name: "chevrons-up", d: "M6 13l6-6 6 6M6 19l6-6 6 6" },
  { name: "circle", d: "M12 3a9 9 0 100 18 9 9 0 000-18z" },
  { name: "circle-solid-dot", d: "M12 3a9 9 0 100 18 9 9 0 000-18z", solidChild: true },
  { name: "circle-dot", d: "M12 3a9 9 0 100 18 9 9 0 000-18zM12 10a2 2 0 100 4 2 2 0 000-4z" },
  { name: "solid-person", fillD: "M12 5a3.4 3.4 0 100 6.8 3.4 3.4 0 000-6.8zM6.5 21a5.5 5.5 0 0111 0z" },
  { name: "solid-target", fillD: "M12 2.5a9.5 9.5 0 100 19 9.5 9.5 0 000-19zM12 5a7 7 0 110 14 7 7 0 010-14zM12 9.8a2.2 2.2 0 100 4.4 2.2 2.2 0 000-4.4z" },
  { name: "solid-circle", prim: "circle" },
  { name: "square", d: "M4 4h16v16H4z" },
  { name: "solid-square", prim: "rect" },
  { name: "rounded-square", d: "M5 4h14a1 1 0 011 1v14a1 1 0 01-1 1H5a1 1 0 01-1-1V5a1 1 0 011-1z" },
  { name: "triangle", d: "M12 4l9 16H3z" },
  { name: "diamond", d: "M12 3l9 9-9 9-9-9z" },
  { name: "hexagon", d: "M12 3l8 4.5v9L12 21l-8-4.5v-9z" },
  { name: "octagon", d: "M8 3h8l5 5v8l-5 5H8l-5-5V8z" },
  { name: "pentagon", d: "M12 3l9 6.5-3.5 10.5h-11L3 9.5z" },
  { name: "star", d: "M12 3l2.7 5.7 6.3.8-4.6 4.3 1.2 6.2-5.6-3-5.6 3 1.2-6.2L3 9.5l6.3-.8z" },
  { name: "solid-star", fillD: "M12 3l2.7 5.7 6.3.8-4.6 4.3 1.2 6.2-5.6-3-5.6 3 1.2-6.2L3 9.5l6.3-.8z" },
  { name: "heart", d: "M12 20s-7-4.5-9-9a5 5 0 019-3 5 5 0 019 3c-2 4.5-9 9-9 9z" },
  { name: "solid-heart", fillD: "M12 20s-7-4.5-9-9a5 5 0 019-3 5 5 0 019 3c-2 4.5-9 9-9 9z" },
  { name: "moon", d: "M20 13A8 8 0 1111 4a6.5 6.5 0 009 9z" },
  { name: "sun", d: "M12 7a5 5 0 100 10 5 5 0 000-10zM12 2v2M12 20v2M4 12H2M22 12h-2M5 5l1.5 1.5M17.5 17.5L19 19M19 5l-1.5 1.5M6.5 17.5L5 19" },
  { name: "cloud", d: "M7 18a4 4 0 01-.5-8 6 6 0 0111.4 1.5A3.5 3.5 0 0117 18H7z" },
  { name: "drop", d: "M12 3s6 6.5 6 11a6 6 0 01-12 0c0-4.5 6-11 6-11z" },
  { name: "zap", d: "M13 2L4 14h6l-1 8 9-12h-6z" },
  { name: "check", d: "M4 12l5 5L20 6" },
  { name: "check-circle", d: "M12 3a9 9 0 100 18 9 9 0 000-18zM8 12l3 3 5-6" },
  { name: "check-square", d: "M5 4h14a1 1 0 011 1v14a1 1 0 01-1 1H5a1 1 0 01-1-1V5a1 1 0 011-1zM8 12l3 3 5-6" },
  { name: "x", d: "M6 6l12 12M18 6L6 18" },
  { name: "x-circle", d: "M12 3a9 9 0 100 18 9 9 0 000-18zM9 9l6 6M15 9l-6 6" },
  { name: "plus", d: "M12 5v14M5 12h14" },
  { name: "minus", d: "M5 12h14" },
  { name: "divide", d: "M12 5v.01M12 19v.01M5 12h14" },
  { name: "equal", d: "M5 9h14M5 15h14" },
  { name: "slash", d: "M19 5L5 19" },
  { name: "home", d: "M4 11l8-7 8 7v8a1 1 0 01-1 1h-5v-6h-4v6H5a1 1 0 01-1-1z" },
  { name: "building", d: "M5 21V5a1 1 0 011-1h8a1 1 0 011 1v16M15 9h4a1 1 0 011 1v11M8 8h4M8 12h4M8 16h4" },
  { name: "grid", d: "M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z" },
  { name: "layers", d: "M12 3l9 5-9 5-9-5zM3 13l9 5 9-5" },
  { name: "folder", d: "M3 7a1 1 0 011-1h5l2 2h9a1 1 0 011 1v9a1 1 0 01-1 1H4a1 1 0 01-1-1z" },
  { name: "file", d: "M6 3h8l4 4v14H6zM14 3v4h4" },
  { name: "book", d: "M4 5a1 1 0 011-1h6v17H5a1 1 0 01-1-1zM20 5a1 1 0 00-1-1h-6v17h6a1 1 0 001-1z" },
  { name: "bookmark", d: "M7 3h10a1 1 0 011 1v17l-6-4-6 4V4a1 1 0 011-1z" },
  { name: "tag", d: "M3 11l8-8h8v8l-8 8zM16 7v.01" },
  { name: "clock", d: "M12 3a9 9 0 100 18 9 9 0 000-18zM12 7v5l3 3" },
  { name: "calendar", d: "M5 5h14a1 1 0 011 1v14a1 1 0 01-1 1H5a1 1 0 01-1-1V6a1 1 0 011-1zM4 10h16M8 3v4M16 3v4" },
  { name: "bell", d: "M6 16V11a6 6 0 0112 0v5l2 3H4zM10 22a2.4 2.4 0 004 0" },
  { name: "search", d: "M11 4a7 7 0 100 14 7 7 0 000-14zM20 20l-4-4" },
  { name: "settings-gear", d: "M12 9a3 3 0 100 6 3 3 0 000-6zM12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" },
  { name: "user", d: "M12 4a4 4 0 100 8 4 4 0 000-8zM5 21a7 7 0 0114 0" },
  { name: "solid-user", fillD: "M12 4a4 4 0 100 8 4 4 0 000-8zM5 21a7 7 0 0114 0z" },
  { name: "solid-bars-bold", fillD: "M8.5 8h7a2.5 2.5 0 010 5h-7a2.5 2.5 0 010-5zM8.5 15h9a2.5 2.5 0 010 5h-9a2.5 2.5 0 010-5z" },
  { name: "solid-user-circle", fillD: "M12 0.5a11.5 11.5 0 100 23 11.5 11.5 0 000-23zM12 4a8 8 0 110 16 8 8 0 010-16zM12 5.4a2 2 0 100 4 2 2 0 000-4zM9.9 11.5v3a2.1 2.1 0 014.2 0v-3a2.1 2.1 0 01-4.2 0z" },
  { name: "users", d: "M9 4a4 4 0 100 8 4 4 0 000-8zM2 21a7 7 0 0114 0M17 5a3.5 3.5 0 010 7M18 13a6 6 0 014 8" },
  { name: "lock", d: "M6 11h12a1 1 0 011 1v8a1 1 0 01-1 1H6a1 1 0 01-1-1v-8a1 1 0 011-1zM8 11V7a4 4 0 018 0v4" },
  { name: "unlock", d: "M6 11h12a1 1 0 011 1v8a1 1 0 01-1 1H6a1 1 0 01-1-1v-8a1 1 0 011-1zM8 11V7a4 4 0 017.5-2" },
  { name: "key", d: "M15 3a6 6 0 00-5.6 8.2L3 17.6V21h3.4l1-1v-2h2v-2h2l1.4-1.4A6 6 0 1015 3zm1 3.5a1.5 1.5 0 110 3 1.5 1.5 0 010-3z" },
  { name: "mail", d: "M3 6h18a1 1 0 011 1v10a1 1 0 01-1 1H3a1 1 0 01-1-1V7a1 1 0 011-1zM2 8l10 6 10-6" },
  { name: "phone", d: "M6 3h4l2 5-2.5 1.5a11 11 0 005 5L16 12l5 2v4a2 2 0 01-2 2A16 16 0 013 5a2 2 0 012-2z" },
  { name: "camera", d: "M4 8h3l2-3h6l2 3h3a1 1 0 011 1v10a1 1 0 01-1 1H4a1 1 0 01-1-1V9a1 1 0 011-1zM12 11a3.5 3.5 0 100 7 3.5 3.5 0 000-7z" },
  { name: "image", d: "M4 4h16a1 1 0 011 1v14a1 1 0 01-1 1H4a1 1 0 01-1-1V5a1 1 0 011-1zM4 16l5-5 4 4 3-3 4 4M9 8a1.2 1.2 0 100 2.4A1.2 1.2 0 009 8z" },
  { name: "music", d: "M9 18a2.5 2.5 0 100-5 2.5 2.5 0 000 5zM19 16a2.5 2.5 0 100-5 2.5 2.5 0 000 5zM11.5 15.5V5l10-2v11.5" },
  { name: "play", d: "M7 4l13 8-13 8z" },
  { name: "solid-play", fillD: "M7 4l13 8-13 8z" },
  { name: "pause", d: "M7 4h3v16H7zM14 4h3v16h-3z" },
  { name: "stop", d: "M6 6h12v12H6z" },
  { name: "skip-forward", d: "M5 5l10 7-10 7zM19 5v14" },
  { name: "mic", d: "M12 3a3 3 0 013 3v6a3 3 0 01-6 0V6a3 3 0 013-3zM6 11a6 6 0 0012 0M12 17v4M9 21h6" },
  { name: "wifi", d: "M2.5 9a15 15 0 0119 0M6 12.5a10 10 0 0112 0M9.5 16a5 5 0 015 0M12 19.5v.01" },
  { name: "battery", d: "M3 8h15a1 1 0 011 1v6a1 1 0 01-1 1H3a1 1 0 01-1-1V9a1 1 0 011-1zM21 11v2M5 11v2M8 11v2" },
  { name: "eye", d: "M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6zM12 9a3 3 0 100 6 3 3 0 000-6z" },
  { name: "paperclip", d: "M21 11.5l-8.5 8.5a5.5 5.5 0 01-8-7.5L13 4a3.7 3.7 0 015.5 5L10.5 17.5a1.8 1.8 0 01-2.5-2.5L15 8" },
];

/** viewBox size variants to exercise normalization + fitting */
const VIEWBOXES = [24, 24, 24, 48, 20, 32];

/** Keyword → tag families so sample data exercises the tag workflow end-to-end. */
const TAG_RULES: [RegExp, string[]][] = [
  [/^(arrow|chevron)/, ["navigation"]],
  [/^(solid-)/, ["shapes"]],
  [/^(circle|square|rounded|triangle|diamond|hexagon|octagon|pentagon)/, ["shapes"]],
  [/^(check|x-|x$|plus|minus|divide|equal|slash)/, ["status"]],
  [/^(sun|moon|cloud|drop|zap)/, ["weather"]],
  [/^(play|pause|stop|skip|mic|music)/, ["media"]],
  [/^(mail|phone|bell|paperclip)/, ["communication"]],
  [/^(folder|file|book|bookmark|tag$)/, ["files"]],
  [/^(camera|image|wifi|battery|eye)/, ["devices"]],
  [/^(user|users|lock|unlock|key)/, ["access"]],
  [/^(clock|calendar)/, ["time"]],
  [/^(home|building|grid|layers|search|settings|star|heart)/, ["ui"]],
  [/^(em-stroke|ex-stroke)/, ["ui"]],
];

function tagsForName(name: string): string[] {
  const out: string[] = [];
  for (const [re, tags] of TAG_RULES) {
    if (re.test(name)) out.push(...tags);
  }
  return out;
}

function buildSvg(shape: SampleShape, size: number, stroke: number): string {
  /* Relative-unit samples (round 19) — the root stroke-width is declared
   * in em/ex, exactly like real-world packs targeting constant screen
   * weight. Browsers draw them at the ambient font size; the measurement
   * engine honestly reports them unmeasurable (no font context) and
   * never touches the leaf. */
  if (shape.emD != null || shape.exD != null) {
    const rel = shape.emD != null ? "0.11em" : "0.32ex";
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" fill="none" ` +
      `stroke="#1F1D17" stroke-width="${rel}" stroke-linecap="round" stroke-linejoin="round">` +
      `<path d="${shape.emD ?? shape.exD}"/>` +
      `</svg>`
    );
  }
  /* Fill-based samples — solid marks with NO stroke declarations: the
   * artwork class weight engine erodes/dilates as ONE single line per
   * mark (Illustrator stroke-weight semantics). */
  if (shape.fillD != null || shape.prim != null) {
    const inner =
      shape.prim === "circle"
        ? `<circle cx="12" cy="12" r="8.5"/>`
        : shape.prim === "rect"
          ? `<rect x="4.5" y="4.5" width="15" height="15"/>`
          : `<path d="${shape.fillD}"/>`;
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" fill="#1F1D17">` +
      inner +
      `</svg>`
    );
  }
  const sw = (stroke * size) / 24;
  /* mixed artwork: a stroked outline plus one solid dot leaf */
  const solid = shape.solidChild
    ? `<circle cx="12" cy="12" r="3.5" fill="#1F1D17" stroke="none"/>`
    : "";
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" fill="none" ` +
    `stroke="#1F1D17" stroke-width="${sw.toFixed(2)}" stroke-linecap="round" stroke-linejoin="round">` +
    `<path d="${shape.d ?? ""}"/>${solid}` +
    `</svg>`
  );
}

export function createSampleIconFiles(count = 64): { files: File[]; tagsByName: Record<string, string[]> } {
  const files: File[] = [];
  const tagsByName: Record<string, string[]> = {};
  /* round 19 · even coverage: when fewer icons are requested than the
   * shape array holds, the picks stride EVENLY across the whole array
   * (strictly increasing — unique shapes, so no duplicate-name imports)
   * and every family appears in the demo library; the old first-N cut
   * left the tail (media / communication / devices) permanently unloaded.
   * count ≥ SHAPES.length keeps the classic wrap + variant naming. */
  const stride = SHAPES.length / count;
  for (let i = 0; i < count; i++) {
    const shape = SHAPES[count >= SHAPES.length ? i % SHAPES.length : Math.floor(i * stride)];
    const size = VIEWBOXES[i % VIEWBOXES.length];
    const variant = Math.floor(i / SHAPES.length);
    const stroke = 1.5 + ((i * 7) % 10) / 10; // 1.5 .. 2.4 variety
    const name =
      variant === 0
        ? `${shape.name}.svg`
        : `${shape.name}-${String(variant + 1).padStart(2, "0")}.svg`;
    const tags = tagsForName(shape.name);
    if (tags.length > 0) tagsByName[name] = tags;
    files.push(
      new File([buildSvg(shape, size, stroke)], name, { type: "image/svg+xml" })
    );
  }
  return { files, tagsByName };
}
