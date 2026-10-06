/**
 * ICON SHEET STUDIO — AI Category Analyzer (backend, round 14).
 *
 * MULTI-STAGE SEMANTIC CLASSIFICATION PIPELINE.
 * The AI analyzes the ACTUAL RENDERED ICON ARTWORK, not the filenames:
 *
 *   1. Receive the sheet's UNIQUE icon SVG sources from the client
 *      (deduplicated by content hash, occurrence counts attached — a
 *      sheet of 30 copies of one gear + 10 others contributes ONE gear
 *      descriptor with multiplicity, never 30 independent votes).
 *   2. Rasterize batches of 24 icons into NUMBERED contact sheets
 *      (grid cells with borders + corner index labels so the VLM can
 *      enumerate reliably).
 *   3. PER-ICON VISUAL ANALYSIS — one parallel VLM call per contact
 *      sheet, each identifying what EVERY cell visually depicts
 *      (subject / keywords / domain / certainty).
 *   4. COLLECTION-LEVEL AGGREGATION — an LLM reasons over the per-icon
 *      descriptors: semantic clustering → shares → cross-cluster
 *      relationship analysis → 4-6 category candidates at different
 *      specificity levels → scoring → best pick → realistic confidence
 *      → explanation + theme breakdown.
 *   5. GENERIC GUARD — if the pick is a lazy fallback ("Miscellaneous
 *      Icons", "General Icons", …), a SECOND focused pass tries once
 *      more to find a meaningful professional umbrella; generic names
 *      are only accepted when that pass genuinely fails.
 *
 * PROVIDER PLUGGABLE (same engine, two transports): every AI call goes
 * through the AIProvider interface (src/lib/ai/provider.ts) — "zai"
 * (ambient server SDK, byte-identical legacy transport) or "gemini"
 * (Google generativelanguage REST API with the user's key from the
 * x-gemini-key request header). Both providers receive the SAME input
 * representation (the same numbered contact sheets), the SAME strong
 * prompts, and produce raw text parsed by the SAME extractors. Only the
 * selected provider is ever called — never both.
 *
 * Filenames/tags reach the model only as clearly-labeled SECONDARY
 * hints. Vision failure on ALL batches falls back to the old text-only
 * analysis; failure on SOME batches just reduces coverage.
 *
 * The AI NEVER silently mutates state — the frontend shows a suggestion
 * and the user explicitly applies it.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  AIProvider,
  AIProviderError,
  createProvider,
  effectiveGeminiModel,
  httpStatusForKind,
  ProviderId,
} from "@/lib/ai/provider";

interface AnalyzeBody {
  /** UNIQUE icon SVG sources for the sheet (client-deduplicated by
   *  content hash; the PRIMARY visual signal). */
  iconSvgs?: string[];
  /** occurrence count of each unique SVG in the whole sheet (parallel
   *  to iconSvgs). Missing → every icon counts once. */
  iconCounts?: number[];
  /** total icons on the sheet (unique + duplicates). */
  sheetCount?: number;
  /** filenames — SECONDARY hint only, explicitly marked unreliable. */
  iconNames?: string[];
  /** user tags on the sheet's icons — supporting taxonomy signal. */
  iconTags?: string[];
  /** AI provider to run the analysis with: "zai" (default) or "gemini". */
  provider?: string;
  /** Gemini model id (Gemini provider only; empty → recommended default). */
  geminiModel?: string;
}

/* ------------------------------------------------------------------ */
/* Geometry / limits                                                   */
/* ------------------------------------------------------------------ */

/** Icons per contact-sheet batch (6 cols × 4 rows). */
const BATCH_SIZE = 24;
/** Max unique icons analyzed visually (7 batches → 7 parallel VLM calls). */
const MAX_UNIQUE = 168;
const TILE = 80; // px per icon tile
const GAP = 8; // px between tiles
const PAD = 14; // px outer padding
const COLS = 6;

/** Per-call timeouts (ms) — keep large sheets from hanging the route. */
const VISION_TIMEOUT = 100_000;
const AGGREGATE_TIMEOUT = 120_000;
const GUARD_TIMEOUT = 60_000;

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

/** One per-icon visual descriptor produced by the per-batch VLM stage. */
interface IconDescriptor {
  subject: string;
  keywords: string[];
  domain: string;
  certainty: number;
  /** how many times this exact artwork occurs in the sheet. */
  occurs: number;
}

interface ThemeShare {
  name: string;
  share: number;
}

interface AggregateParsed {
  category: string;
  confidence: number;
  reasoning: string;
  alternatives: string[];
  themes: ThemeShare[];
}

/** Response of the successful pipeline (client-facing). */
interface CategoryResult {
  category: string;
  confidence: number;
  reasoning: string;
  alternatives: string[];
  themes: ThemeShare[];
  /** true when the category went through the generic-guard pass. */
  guarded: boolean;
  analyzed: { unique: number; total: number; batchesOk: number; batchesTotal: number };
  method: "visual" | "text";
  /** which AI provider produced the suggestion ("zai" | "gemini"). */
  provider?: ProviderId;
  /** Gemini model actually used (Gemini provider only). */
  model?: string;
}

/* ------------------------------------------------------------------ */
/* sharp lazy singleton                                                */
/* ------------------------------------------------------------------ */

type SharpFn = typeof import("sharp");
let sharpPromise: Promise<SharpFn> | null = null;
/** Resolve sharp across CJS/ESM interop: `await import("sharp")` yields
 *  a namespace whose `.default` is the factory under both Node and Bun. */
function getSharp(): Promise<SharpFn> {
  if (!sharpPromise) {
    sharpPromise = import("sharp").then((mod) => {
      const m = mod as unknown as { default?: SharpFn };
      return m.default ?? (mod as unknown as SharpFn);
    });
  }
  return sharpPromise;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** Evenly sample `max` indices from `total` (first + last always in). */
function sampleIndices(total: number, max: number): number[] {
  if (total <= max) return Array.from({ length: total }, (_, i) => i);
  const out = new Set<number>();
  out.add(0);
  out.add(total - 1);
  const interior = max - 2;
  for (let i = 1; i <= interior; i++) {
    out.add(Math.round((i * (total - 1)) / (interior + 1)));
  }
  return [...out].sort((a, b) => a - b);
}

/** Race a promise against a timeout; the race observes the losing
 *  promise, so late failures never become unhandled rejections. */
async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Run an async mapper over items with bounded concurrency (the vision
 *  endpoint rate-limits fully-parallel calls — 2 at a time is the sweet
 *  spot between speed and 429s). */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) break;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

const RETRYABLE_RE = /429|rate.?limit|too many|5\d\d|timeout|econn/i;

/** Call with retry + exponential backoff for rate-limit style failures. */
async function withRetry<T>(
  label: string,
  attempts: number,
  fn: () => Promise<T>
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      if (!RETRYABLE_RE.test(msg) || attempt === attempts - 1) throw err;
      console.warn(`[analyze-category] ${label} retrying (attempt ${attempt + 2}): ${msg.slice(0, 120)}`);
      await new Promise((r) => setTimeout(r, 2500 * (attempt + 1)));
    }
  }
  throw lastErr;
}

/** Strip markdown code fences (```json … ```) from a model response. */
function stripFences(raw: string): string {
  return raw.replace(/```[a-zA-Z]*\s*/g, "").replace(/```/g, "").trim();
}

/** Index of the bracket at `start`'s MATCHING close bracket, scanning
 *  string-aware (brackets inside JSON string literals never count).
 *  -1 when the value never completes — the signature of a TRUNCATED
 *  response (the model hit its output-token ceiling mid-array). */
function matchingClose(s: string, start: number): number {
  const open = s[start];
  if (open !== "[" && open !== "{") return -1;
  const close = open === "[" ? "]" : "}";
  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
    } else if (c === open) {
      depth++;
    } else if (c === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** One complete balanced span starting at `start`, parsed. undefined when
 *  the span is truncated (no matching close) or fails to parse. */
function parseSpan(s: string, start: number): unknown | undefined {
  const end = matchingClose(s, start);
  if (end === -1) return undefined;
  try {
    const v = JSON.parse(s.slice(start, end + 1));
    return v === null ? undefined : v;
  } catch {
    return undefined;
  }
}

/** Salvage every COMPLETE top-level item (string-aware, escape-aware) from
 *  a truncated or corrupt JSON ARRAY — the leading N descriptors of a
 *  batch the model ran out of tokens finishing. Prose between items is
 *  skipped. null when nothing complete is recoverable. */
function salvageArrayItems(s: string, arrayStart: number): unknown[] | null {
  const items: unknown[] = [];
  let i = arrayStart + 1;
  while (i < s.length) {
    const c = s[i];
    if (c === "{" || c === "[") {
      const end = matchingClose(s, i);
      if (end === -1) break; // truncated mid-item — nothing further is complete
      try {
        const v = JSON.parse(s.slice(i, end + 1));
        if (v !== null) items.push(v);
      } catch {
        // individually corrupt item — skip it, keep scanning
      }
      i = end + 1;
    } else if (c === "]") {
      break; // array closed after all (full parse already failed) — stop safely
    } else {
      i++; // separators / whitespace / stray prose between items
    }
  }
  return items.length > 0 ? items : null;
}

/** Extract the outermost JSON value from a model response — OBJECT or
 *  ARRAY. Robust against the three real-world response shapes:
 *  1. clean value (with or without markdown fences) → direct parse;
 *  2. TRUNCATED array (output-token ceiling) → the complete leading
 *     items are salvaged and returned as an array (cell numbers stay
 *     attached to every object, so occurrence counts remain correct);
 *  3. leading prose containing stray brackets → the bracket shape whose
 *     opener appears FIRST in the text is tried first, the other shape
 *     is the fallback.
 *  The old implementation failed case 2 silently: for a truncated array
 *  it sliced one inner object via first-{ / last-}, parsed it as a lone
 *  object, and parseVisionBatch discarded it — whole batches of visual
 *  descriptors vanished with only an "unparseable" console warn. */
function extractJson(raw: string): unknown {
  const stripped = stripFences(raw);
  const posArr = stripped.indexOf("[");
  const posObj = stripped.indexOf("{");
  if (posArr === -1 && posObj === -1) return null;

  const arrFirst = posArr !== -1 && (posObj === -1 || posArr < posObj);

  if (arrFirst) {
    const direct = parseSpan(stripped, posArr);
    if (direct !== undefined) return direct;
    // array intended but truncated/corrupt — salvage the complete items
    const salvaged = salvageArrayItems(stripped, posArr);
    if (salvaged !== null) {
      console.warn(
        `[analyze-category] salvaged ${salvaged.length} complete item${salvaged.length === 1 ? "" : "s"} from a truncated/corrupt array response`
      );
      return salvaged;
    }
    // maybe the '[' was prose and the '{' is the real response
    if (posObj !== -1) {
      const obj = parseSpan(stripped, posObj);
      if (obj !== undefined) return obj;
    }
    return null;
  }

  const direct = posObj !== -1 ? parseSpan(stripped, posObj) : undefined;
  if (direct !== undefined) return direct;
  // object truncated/corrupt — no top-level salvage possible for a lone
  // object; the '[' may be the real response ('{' was prose)
  if (posArr !== -1) {
    const arr = parseSpan(stripped, posArr);
    if (arr !== undefined) return arr;
    const salvaged = salvageArrayItems(stripped, posArr);
    if (salvaged !== null) {
      console.warn(
        `[analyze-category] salvaged ${salvaged.length} complete item${salvaged.length === 1 ? "" : "s"} from a truncated/corrupt array response`
      );
      return salvaged;
    }
  }
  return null;
}

const clamp01 = (n: unknown, fallback: number): number =>
  typeof n === "number" && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : fallback;

const cleanStr = (v: unknown, max: number): string =>
  typeof v === "string" ? v.trim().slice(0, max) : "";

/** Provider-config failures that will fail IDENTICALLY on every remaining
 *  call — degrading coverage (the legacy resilience path) is pointless,
 *  so they abort the analysis and surface to the user immediately.
 *  Only ever triggers for provider-CLASSIFIED errors (Gemini); raw Z.AI
 *  transport errors keep the exact legacy per-batch degradation. */
const FATAL_PROVIDER_KINDS = new Set(["invalid-key", "missing-key", "unsupported-model", "rate-limit"]);

/* ------------------------------------------------------------------ */
/* Stage 1 — numbered contact sheets (sharp)                           */
/* ------------------------------------------------------------------ */

/** Rasterize one SVG to a square PNG tile on white (null if invalid). */
async function rasterizeTile(sharp: SharpFn, svg: string): Promise<Buffer | null> {
  try {
    return await sharp(Buffer.from(svg))
      .resize(TILE, TILE, { fit: "contain", background: { r: 255, g: 255, b: 255, alpha: 1 } })
      .flatten({ background: { r: 255, g: 255, b: 255 } })
      .png()
      .toBuffer();
  } catch {
    return null;
  }
}

/** SVG overlay with light cell borders + corner index numbers, so the
 *  VLM can enumerate cells reliably. Rendered once per sheet. */
function buildOverlaySvg(count: number): string {
  const rows = Math.ceil(count / COLS);
  const W = PAD * 2 + COLS * TILE + (COLS - 1) * GAP;
  const H = PAD * 2 + rows * TILE + (rows - 1) * GAP;
  let cells = "";
  for (let i = 0; i < count; i++) {
    const c = i % COLS;
    const r = Math.floor(i / COLS);
    const x = PAD + c * (TILE + GAP);
    const y = PAD + r * (TILE + GAP);
    cells += `<rect x="${x}" y="${y}" width="${TILE}" height="${TILE}" fill="none" stroke="#e5e7eb" stroke-width="1" rx="2"/>`;
    cells += `<text x="${x + 3}" y="${y + 9}" font-family="DejaVu Sans Mono, monospace" font-size="8" fill="#9ca3af">${i + 1}</text>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${cells}</svg>`;
}

/** Build ONE numbered contact sheet from a batch of SVG sources. */
async function buildContactSheet(
  sharp: SharpFn,
  svgs: string[]
): Promise<{ png: Buffer; count: number } | null> {
  const tiles = await Promise.all(svgs.map((s) => rasterizeTile(sharp, s)));
  const valid = tiles.filter((t): t is Buffer => t !== null);
  if (valid.length === 0) return null;
  const count = valid.length;
  const rows = Math.ceil(count / COLS);
  const W = PAD * 2 + COLS * TILE + (COLS - 1) * GAP;
  const H = PAD * 2 + rows * TILE + (rows - 1) * GAP;

  const composites = valid.map((png, i) => {
    const c = i % COLS;
    const r = Math.floor(i / COLS);
    return { input: png, left: PAD + c * (TILE + GAP), top: PAD + r * (TILE + GAP) };
  });

  // borders + index numbers rendered on top of the icons
  try {
    const overlay = await sharp(Buffer.from(buildOverlaySvg(count))).png().toBuffer();
    composites.push({ input: overlay, left: 0, top: 0 });
  } catch {
    // numbers/borders are an enhancement — continue without them
  }

  const png = await sharp({ create: { width: W, height: H, channels: 3, background: { r: 255, g: 255, b: 255 } } })
    .composite(composites)
    .png()
    .toBuffer();

  return { png, count };
}

/* ------------------------------------------------------------------ */
/* Stage 2 — per-icon visual analysis (VLM, one call per batch)        */
/* ------------------------------------------------------------------ */

const PER_ICON_PROMPT =
  "You are a meticulous icon-artwork analyst. " +
  "The image is a CONTACT SHEET — a grid of rendered icon artwork from an icon collection. " +
  "The grid is filled in reading order (left→right, top→bottom). Each cell contains ONE icon; " +
  "cells have light borders and a small gray index number in the top-left corner. " +
  "The number labels the cell — it is NOT part of the icon artwork; ignore it when interpreting the icon.\n\n" +
  "TASK: For EVERY numbered cell, identify what the icon VISUALLY DEPICTS.\n" +
  "- subject: what the artwork literally shows (e.g. \"gear/cog with teeth around the rim\", \"flask with liquid\", \"ascending bar chart with arrow\")\n" +
  "- keywords: 2-5 semantic keywords for what it represents (e.g. \"settings, machinery, engineering\")\n" +
  "- domain: the best-fitting professional domain/industry — open vocabulary (e.g. \"Technology & IT\", \"Business & Finance\", \"Healthcare\", \"Science & Laboratory\", \"Media\", \"UI & Symbols\", \"Travel\", \"Food\", \"Engineering\")\n" +
  "- certainty: 0-1 confidence in your interpretation — use 0.4 or less for abstract/ambiguous shapes you cannot identify\n\n" +
  "STRICT RULES:\n" +
  "1. Interpret ONLY the drawn shapes. No filenames are shown — do not invent any.\n" +
  "2. Do NOT skip cells. Do NOT merge cells. One object per cell, in cell order.\n" +
  "3. Blank/empty cell → subject \"blank\", domain \"Unknown\", certainty 0.\n\n" +
  "Respond ONLY with compact JSON — an array with one object per cell, in cell order, no markdown fences:\n" +
  '[{"i":1,"subject":"...","keywords":["...","..."],"domain":"...","certainty":0.9}, ...]';

/** Parse one VLM batch response into descriptors; null when unusable. */
function parseVisionBatch(
  raw: string,
  occursForCell: (cell: number) => number
): IconDescriptor[] | null {
  const json = extractJson(raw);
  if (json === null) return null;
  let items: unknown[] | null = null;
  if (Array.isArray(json)) items = json;
  else if (typeof json === "object") {
    const o = json as Record<string, unknown>;
    if (Array.isArray(o.icons)) items = o.icons;
    else if (Array.isArray(o.cells)) items = o.cells;
    else if (Array.isArray(o.items)) items = o.items;
    // lone descriptor object — the model answered one cell without the
    // array brackets (or only one object survived extraction)
    else if (typeof (o.subject ?? o.description ?? o.depicts) === "string") items = [o];
  }
  if (!items || items.length === 0) return null;

  const out: IconDescriptor[] = [];
  let position = 0;
  for (const item of items) {
    position++;
    if (typeof item !== "object" || item === null) continue;
    const o = item as Record<string, unknown>;
    const subject = cleanStr(o.subject ?? o.description ?? o.depicts, 80);
    if (!subject || subject.toLowerCase() === "blank") continue;
    const keywords = Array.isArray(o.keywords)
      ? o.keywords.map((k) => cleanStr(k, 30)).filter(Boolean).slice(0, 5)
      : typeof o.keywords === "string"
        ? cleanStr(o.keywords, 80)
            .split(/[,;/]\s*/)
            .filter(Boolean)
            .slice(0, 5)
        : [];
    const cell = typeof o.i === "number" ? Math.round(o.i) : position;
    out.push({
      subject,
      keywords,
      domain: cleanStr(o.domain ?? o.category ?? o.field, 40) || "Unknown",
      certainty: clamp01(o.certainty ?? o.confidence, 0.6),
      occurs: cell >= 1 ? occursForCell(cell) : 1,
    });
    if (out.length >= BATCH_SIZE + 4) break;
  }
  return out.length > 0 ? out : null;
}

/** Run one VLM batch: contact sheet → per-icon descriptors. The SAME
 *  numbered contact sheet and the SAME prompt go to whichever provider
 *  is selected — the transport is the only difference. */
async function runVisionBatch(
  ai: AIProvider,
  png: Buffer,
  count: number,
  occursForCell: (cell: number) => number
): Promise<IconDescriptor[]> {
  const raw = await withRetry(
    `vision batch`,
    3,
    () => withTimeout(
      ai.complete({
        user: PER_ICON_PROMPT + `\n\nThis contact sheet contains ${count} icon cell${count === 1 ? "" : "s"}.`,
        imageBase64: png.toString("base64"),
        imageMime: "image/png",
        thinking: false,
        timeoutMs: VISION_TIMEOUT,
        json: true,
      }),
      VISION_TIMEOUT,
      "vision batch"
    )
  );
  const parsed = parseVisionBatch(raw, occursForCell);
  if (!parsed) {
    console.warn(
      "[analyze-category] batch response unparseable, excerpt:",
      raw.slice(0, 200).replace(/\s+/g, " ")
    );
  }
  return parsed ?? [];
}

/* ------------------------------------------------------------------ */
/* Stage 3 — collection-level aggregation (the intelligence step)      */
/* ------------------------------------------------------------------ */

const AGGREGATE_SYSTEM =
  "You are a senior icon-library taxonomist for a professional design studio. " +
  "You classify icon COLLECTIONS — never from filenames, always from what the icons " +
  "actually depict. You are rigorous, evidence-driven, and allergic to lazy generic labels.";

function buildAggregateUserMessage(
  descriptors: IconDescriptor[],
  tags: string[],
  names: string[],
  totalCount: number
): string {
  // occurrence-weighted domain histogram — a deterministic hint the LLM verifies
  const hist = new Map<string, number>();
  for (const d of descriptors) {
    const key = d.domain.toLowerCase();
    hist.set(key, (hist.get(key) ?? 0) + Math.max(1, d.occurs));
  }
  const histogram = [...hist.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([k, n]) => `${k} ×${n}`)
    .join(" · ");

  const avgCertainty =
    descriptors.reduce((s, d) => s + d.certainty, 0) / Math.max(1, descriptors.length);
  const compact = descriptors
    .map(
      (d) =>
        `{s:${JSON.stringify(d.subject)},k:${JSON.stringify(d.keywords.join(","))},dom:${JSON.stringify(d.domain)},c:${d.certainty.toFixed(2)},n:${d.occurs}}`
    )
    .join("\n");

  const nameHint =
    names.length > 0
      ? `\n\nIcon filenames — SECONDARY, UNRELIABLE (often generic like "mix-01"; use ONLY if they clearly carry real signal): ${names
          .slice(0, 60)
          .join(", ")}`
      : "";
  const tagHint =
    tags.length > 0 ? `\n\nUser-applied tags (supporting human signal): ${tags.join(", ")}` : "";

  return (
    `PER-ICON VISUAL ANALYSIS DATA — extracted by a vision model from the RENDERED ARTWORK ` +
    `of one icon sheet (total ${totalCount} icons on the sheet; ${descriptors.length} unique designs ` +
    `analyzed visually${totalCount > descriptors.length ? ", evenly sampled across the sheet" : ""}; ` +
    `identical duplicates collapsed — each design carries its occurrence count "n").\n\n` +
    `Descriptor key: s=subject (what is literally drawn), k=keywords (what it represents), ` +
    `dom=domain (the vision model's domain guess), c=certainty of that guess, n=occurrences in the sheet.\n\n` +
    `${compact}\n\n` +
    `Occurrence-weighted domain histogram (verify and correct this yourself — the vision model's ` +
    `domain guesses are noisy): ${histogram || "n/a"}\n\n` +
    `DUPLICATE RULE: semantic strength is measured in DISTINCT concepts, not raw occurrences — ` +
    `30 copies of one gear is ONE engineering concept (occurrences only refine share estimates). ` +
    `Average descriptor certainty: ${avgCertainty.toFixed(2)}.` +
    tagHint +
    nameHint +
    `\n\nYOUR TASK — collection-level semantic classification. Work through these steps IN ORDER ` +
    `and show each step briefly in "scratchpad":\n` +
    `1. CLUSTER: group the descriptors into semantic clusters; merge near-synonym domains (e.g. ` +
    `"engineering" + "tools" + "machinery" co-occurring → one Engineering & Mechanical cluster).\n` +
    `2. SHARES: estimate each cluster's share of the collection (occurrence-weighted, normalized to 100%).\n` +
    `3. RELATIONSHIPS: how do the clusters relate? Siblings under one professional domain? Adjacent/overlapping? Genuinely unrelated?\n` +
    `4. CANDIDATES: generate 4-6 category candidates at DIFFERENT specificity levels — one deliberately ` +
    `too narrow, one or two right-sized, one broader umbrella. Compound categories are encouraged when ` +
    `two strong clusters are related (e.g. "Technology & Business").\n` +
    `5. SCORE each candidate 0-100: coverage of the collection · strength of semantic relationships · ` +
    `specificity (specific enough to be useful, broad enough to represent the WHOLE collection — never ` +
    `myopic like "Gear Icons" for a set of gears+servers+code+databases) · professional naming quality.\n` +
    `6. SELECT the highest-scoring candidate.\n` +
    `7. CONFIDENCE (0-1) must be realistic and evidence-based — NEVER a default 0.9:\n` +
    `   - dominant cluster ≥70% with high certainty → 0.85-0.95\n` +
    `   - related multi-cluster collection under one umbrella → 0.70-0.85\n` +
    `   - mixed but partially related → 0.55-0.70\n` +
    `   - genuinely unrelated clusters or low average certainty → 0.40-0.60\n` +
    `8. GENERIC RULE: "Miscellaneous Icons", "General Icons", "Icon Collection", "Various Icons" are ` +
    `FORBIDDEN unless the clusters are genuinely unrelated AND no professional umbrella fits. ` +
    `A varied collection with related sub-clusters still deserves a real umbrella — being mixed is ` +
    `NOT a reason to be generic.\n` +
    `9. REASONING: 1-2 sentences naming the ACTUAL detected themes (e.g. \"Most icons represent ` +
    `settings, tools, networking and digital infrastructure, making Technology & IT the strongest ` +
    `overall category.\")\n` +
    `10. THEMES: the 3-6 semantic clusters with their shares (sum ≈ 1).\n` +
    `11. ALTERNATIVES: 1-3 runner-up candidates (named so the user can switch with one click).\n\n` +
    `Category name style: Title Case, max 4 words, professional icon-library naming ` +
    `("Business & Finance", "Science & Laboratory", "UI & Interface", "Engineering & Mechanical", …). ` +
    `You are NOT restricted to any list — create a better name when the evidence supports one.\n\n` +
    `Respond ONLY with compact JSON, no markdown fences:\n` +
    `{"scratchpad":"...","category":"...","confidence":0.0,"reasoning":"...",` +
    `"themes":[{"name":"...","share":0.0}],"alternatives":["..."],"candidates":[{"name":"...","score":0}]}`
  );
}

function parseAggregate(raw: string): AggregateParsed | null {
  const json = extractJson(raw);
  if (typeof json !== "object" || json === null) return null;
  const o = json as Record<string, unknown>;
  const category = cleanStr(o.category, 60);
  if (!category) return null;
  const themes: ThemeShare[] = Array.isArray(o.themes)
    ? o.themes
        .filter((t): t is Record<string, unknown> => typeof t === "object" && t !== null)
        .map((t) => ({ name: cleanStr(t.name, 28), share: clamp01(t.share, 0) }))
        .filter((t) => t.name.length > 0)
        .slice(0, 6)
    : [];
  themes.sort((a, b) => b.share - a.share);
  return {
    category,
    confidence: clamp01(o.confidence, 0.6),
    reasoning: cleanStr(o.reasoning, 400),
    alternatives: Array.isArray(o.alternatives)
      ? o.alternatives.map((a) => cleanStr(a, 60)).filter(Boolean).slice(0, 3)
      : [],
    themes,
  };
}

/** Chat completion with thinking enabled; degrades to disabled on error
 *  (with a short backoff so transient rate limits clear). Identical
 *  retry/timeout policy for BOTH providers. */
async function chatSmart(ai: AIProvider, system: string, user: string): Promise<string> {
  try {
    return await withRetry(
      "aggregation",
      3,
      () => withTimeout(
        ai.complete({ system, user, thinking: true, timeoutMs: AGGREGATE_TIMEOUT, json: true }),
        AGGREGATE_TIMEOUT,
        "aggregation"
      )
    );
  } catch {
    await new Promise((r) => setTimeout(r, 2000));
    return await withTimeout(
      ai.complete({ system, user, thinking: false, timeoutMs: AGGREGATE_TIMEOUT, json: true }),
      AGGREGATE_TIMEOUT,
      "aggregation (no thinking)"
    );
  }
}

/* ------------------------------------------------------------------ */
/* Stage 4 — generic guard                                             */
/* ------------------------------------------------------------------ */

const GENERIC_RE =
  /(miscellaneous|general\s*icons?|icon\s*collection|various\s*icons?|assorted\s*icons?|mixed\s*icons?|general\s*symbols?|symbol\s*collection|general\s*utility)/i;

interface GuardParsed {
  umbrella: string | null;
  confidence: number;
  reasoning: string;
}

async function runGenericGuard(
  ai: AIProvider,
  category: string,
  descriptors: IconDescriptor[],
  themes: ThemeShare[]
): Promise<GuardParsed | null> {
  // compact evidence for the re-check
  const hist = new Map<string, number>();
  for (const d of descriptors) {
    const key = d.domain.toLowerCase();
    hist.set(key, (hist.get(key) ?? 0) + Math.max(1, d.occurs));
  }
  const histogram = [...hist.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([k, n]) => `${k} ×${n}`)
    .join(" · ");
  const subjects = descriptors
    .slice(0, 40)
    .map((d) => d.subject)
    .join("; ");

  const system =
    "You are a senior icon-library taxonomist. A first-pass classifier proposed a GENERIC category " +
    "for an icon collection. Your job: make one final, honest attempt to find a meaningful " +
    "professional umbrella category from the visual evidence.";
  const user =
    `Proposed generic category: "${category}"\n\n` +
    `Visual evidence from the actual icon artwork:\n` +
    `- Detected themes: ${themes.map((t) => `${t.name} ${Math.round(t.share * 100)}%`).join(", ") || "n/a"}\n` +
    `- Domain histogram (occurrence-weighted): ${histogram || "n/a"}\n` +
    `- Sample of what the icons depict: ${subjects}\n\n` +
    `FINAL CHECK: can these icons reasonably be grouped under a meaningful PROFESSIONAL UMBRELLA ` +
    `category? Compound categories are fine when clusters are related (e.g. "Technology, Business & Utility"). ` +
    `A varied but related collection deserves a real umbrella. Return null ONLY when the semantic clusters ` +
    `are truly unrelated (e.g. food + medicine + sports with no dominant group) or the evidence is too weak.\n\n` +
    `Respond ONLY with compact JSON, no markdown fences:\n` +
    `{"umbrella":"..." or null,"confidence":0.0,"reasoning":"..."}`;

  try {
    const raw = await withTimeout(
      ai.complete({
        system,
        user,
        thinking: false,
        timeoutMs: GUARD_TIMEOUT,
        json: true,
      }),
      GUARD_TIMEOUT,
      "generic guard"
    );
    const json = extractJson(raw);
    if (typeof json !== "object" || json === null) return null;
    const o = json as Record<string, unknown>;
    const umbrella = cleanStr(o.umbrella, 60);
    return {
      umbrella: umbrella.length > 0 && !GENERIC_RE.test(umbrella) ? umbrella : null,
      confidence: clamp01(o.confidence, 0.7),
      reasoning: cleanStr(o.reasoning, 300),
    };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Text-only fallback (vision failed entirely)                         */
/* ------------------------------------------------------------------ */

async function textFallback(
  ai: AIProvider,
  names: string[],
  tags: string[],
  totalCount: number
): Promise<AggregateParsed | null> {
  const raw = await withTimeout(
    ai.complete({
      system:
        AGGREGATE_SYSTEM +
        " VISION ANALYSIS FAILED — you must fall back to filenames only. Filenames are often " +
        "generic/unreliable (mix-01, icon-23); treat them with suspicion and lower your confidence " +
        "accordingly. Apply the same classification methodology (clusters, candidates, scoring, " +
        "realistic confidence) to whatever signal the filenames carry.",
      user:
        buildAggregateUserMessage([], tags, names, Math.max(totalCount, names.length)) +
        `\n\n(No visual descriptors available — the ONLY evidence is the filenames and tags above. ` +
        `If the filenames carry no meaningful signal, return a broad utility category with confidence ≤ 0.5.)`,
      thinking: false,
      timeoutMs: AGGREGATE_TIMEOUT,
      json: true,
    }),
    AGGREGATE_TIMEOUT,
    "text fallback"
  );
  return parseAggregate(raw);
}

/* ------------------------------------------------------------------ */
/* Route                                                               */
/* ------------------------------------------------------------------ */

export async function POST(req: NextRequest) {
  let body: AnalyzeBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const svgs = (body.iconSvgs ?? []).filter((s) => typeof s === "string" && s.length > 0);
  const counts = (body.iconCounts ?? []).map((c) =>
    typeof c === "number" && Number.isFinite(c) && c > 0 ? Math.min(9999, Math.round(c)) : 1
  );
  const names = (body.iconNames ?? []).filter((n) => typeof n === "string").slice(0, 120);
  const tags = (body.iconTags ?? []).filter((t) => typeof t === "string").slice(0, 40);
  const totalCount =
    typeof body.sheetCount === "number" && body.sheetCount > 0
      ? Math.round(body.sheetCount)
      : svgs.reduce((s, _, i) => s + (counts[i] ?? 1), 0);

  if (svgs.length === 0 && names.length === 0) {
    return NextResponse.json({ error: "No icon artwork or names provided" }, { status: 400 });
  }

  // ---- provider selection (ONLY the selected provider is called) ----
  const providerId: ProviderId = body.provider === "gemini" ? "gemini" : "zai";
  /** user's Gemini key — request HEADER only, never logged, never
   *  persisted, never forwarded anywhere but Google's endpoint. */
  const geminiKey = req.headers.get("x-gemini-key") ?? "";
  const geminiModel =
    providerId === "gemini" ? effectiveGeminiModel(body.geminiModel) : undefined;

  // Evenly sample the unique icons (the client already deduplicated;
  // sample again defensively if over the visual-analysis budget).
  const indices = sampleIndices(svgs.length, MAX_UNIQUE);
  const sampledSvgs = indices.map((i) => svgs[i]);
  const sampledCounts = indices.map((i) => counts[i] ?? 1);

  try {
    // provider construction validates config (e.g. missing Gemini key)
    const ai = await createProvider({ id: providerId, geminiKey, geminiModel });

    // ---- STAGES 1+2: numbered contact sheets → per-batch VLM ----
    let descriptors: IconDescriptor[] = [];
    let batchesOk = 0;
    let batchesTotal = 0;
    /** last non-fatal provider-classified batch error — surfaces at the
     *  dead end instead of a generic 502 when EVERYTHING failed. */
    let lastBatchError: AIProviderError | null = null;

    if (sampledSvgs.length > 0) {
      const sharp = await getSharp();

      // chunk into batches of BATCH_SIZE
      const batches: { svgs: string[]; counts: number[] }[] = [];
      for (let i = 0; i < sampledSvgs.length; i += BATCH_SIZE) {
        batches.push({
          svgs: sampledSvgs.slice(i, i + BATCH_SIZE),
          counts: sampledCounts.slice(i, i + BATCH_SIZE),
        });
      }
      batchesTotal = batches.length;

      // rasterize + model analysis with bounded concurrency (the vision
      // endpoints rate-limit fully-parallel calls; Gemini free tier gets a
      // gentler limit); per-batch failures are skipped — EXCEPT fatal
      // provider-config errors, which abort (they cannot recover)
      const results = await mapLimit(batches, ai.maxConcurrency, async (batch) => {
        try {
          const sheet = await buildContactSheet(sharp, batch.svgs);
          if (!sheet) return { descs: [] as IconDescriptor[] };
          const occursForCell = (cell: number) =>
            cell >= 1 && cell <= batch.counts.length ? (batch.counts[cell - 1] ?? 1) : 1;
          const descs = await runVisionBatch(ai, sheet.png, sheet.count, occursForCell);
          return { descs };
        } catch (err) {
          if (
            err instanceof AIProviderError &&
            FATAL_PROVIDER_KINDS.has(err.kind)
          ) {
            throw err; // invalid key / bad model / exhausted quota — abort now
          }
          if (err instanceof AIProviderError) lastBatchError = err;
          console.warn(
            "[analyze-category] batch failed:",
            err instanceof Error ? err.message : err
          );
          return { descs: [] as IconDescriptor[] };
        }
      });
      for (const r of results) {
        descriptors.push(...r.descs);
        if (r.descs.length > 0) batchesOk++;
      }
    }

    // ---- STAGES 3 (+4): aggregation + generic guard ----
    if (descriptors.length > 0) {
      const raw = await chatSmart(ai, AGGREGATE_SYSTEM, buildAggregateUserMessage(descriptors, tags, names, totalCount));
      const parsed = parseAggregate(raw);
      if (parsed) {
        let final: AggregateParsed = parsed;
        let guarded = false;

        // STAGE 4 — one more focused pass before allowing a generic label
        if (GENERIC_RE.test(parsed.category)) {
          const guard = await runGenericGuard(ai, parsed.category, descriptors, parsed.themes);
          if (guard && guard.umbrella) {
            final = {
              ...parsed,
              category: guard.umbrella,
              // rescued umbrella — second-pass result; cap the confidence
              confidence: Math.min(guard.confidence, 0.85),
              reasoning: guard.reasoning || parsed.reasoning,
            };
            guarded = true;
          } else {
            // genuinely generic — keep it, but clamp the confidence honestly
            final = { ...parsed, confidence: Math.min(parsed.confidence, 0.68) };
            guarded = true;
          }
        }

        const result: CategoryResult = {
          category: final.category,
          confidence: final.confidence,
          reasoning: final.reasoning,
          alternatives: final.alternatives,
          themes: final.themes,
          guarded,
          analyzed: {
            unique: descriptors.length,
            total: totalCount,
            batchesOk,
            batchesTotal,
          },
          method: "visual",
          provider: ai.id,
          ...(ai.id === "gemini" ? { model: geminiModel } : {}),
        };
        return NextResponse.json(result);
      }
      console.warn("[analyze-category] aggregation unparseable, falling back to text");
    }

    // ---- FALLBACK: text-only (filenames + tags) ----
    if (names.length > 0) {
      const result = await textFallback(ai, names, tags, totalCount);
      if (result) {
        return NextResponse.json({
          category: result.category,
          confidence: Math.min(result.confidence, 0.6),
          reasoning: result.reasoning,
          alternatives: result.alternatives,
          themes: result.themes,
          guarded: false,
          analyzed: { unique: 0, total: totalCount, batchesOk: 0, batchesTotal: 0 },
          method: "text",
          provider: ai.id,
          ...(ai.id === "gemini" ? { model: geminiModel } : {}),
        } satisfies CategoryResult);
      }
    }

    // every vision batch failed AND the text fallback is impossible/failed —
    // prefer the provider-classified reason over the generic message
    if (descriptors.length === 0 && batchesTotal > 0 && lastBatchError) {
      throw lastBatchError;
    }

    return NextResponse.json(
      { error: "AI category analysis failed (no valid response)", provider: ai.id },
      { status: 502 }
    );
  } catch (err) {
    // provider-classified failure → friendly, actionable payload
    if (err instanceof AIProviderError) {
      return NextResponse.json(
        { error: err.message, kind: err.kind, provider: err.providerId },
        { status: httpStatusForKind(err.kind) }
      );
    }
    console.error("[analyze-category] failed", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Category analysis failed" },
      { status: 500 }
    );
  }
}
