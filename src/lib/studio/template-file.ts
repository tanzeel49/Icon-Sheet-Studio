/**
 * ICON SHEET STUDIO — Custom template file format + record validation.
 *
 * Phase 3. Two jobs:
 *
 *  1. RECORD VALIDATION (shared by hydrate, workspace backup and the
 *     portable template file importer). One validator — every entry point
 *     trusts the same rules, so a broken record can never reach the
 *     registry from ANY direction (IndexedDB corruption, hand-edited
 *     backup, foreign template file).
 *
 *  2. PORTABLE TEMPLATE FILES (`.icon-template.json`). A single custom
 *     template — metadata, geometry, regions, typography, colors, grid
 *     configuration, decorative elements and (for builder-made templates)
 *     the embedded authoring document — exported as one self-contained
 *     JSON file that restores on any machine. Never exports project icons.
 */

import type { CustomTemplateRecord, CustomTemplateMetadata, Rect, TemplateGrid } from "./types";

/* ------------------------------------------------------------------ */
/* Record validation                                                   */
/* ------------------------------------------------------------------ */

export interface TemplateRecordCheck {
  ok: boolean;
  /** human-readable, actionable reason (only when !ok) */
  reason?: string;
  /** recoverable notes (never block registration on these) */
  warnings: string[];
}

const isFiniteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function isRect(v: unknown): v is Rect {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  return (
    isFiniteNumber(r.x) &&
    isFiniteNumber(r.y) &&
    isFiniteNumber(r.width) &&
    isFiniteNumber(r.height) &&
    r.width > 0 &&
    r.height > 0
  );
}

/**
 * Structural validation of a persisted/imported custom-template record.
 * `ok: false` ⇒ the record MUST NOT enter the registry (the library shows
 * it as broken with an explicit Remove action). `warnings` describe
 * repairs a sanitizer may apply (damaged builderDoc, invalid version).
 */
export function validateCustomTemplateRecord(record: unknown): TemplateRecordCheck {
  const warnings: string[] = [];
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return { ok: false, reason: "Not a template record.", warnings };
  }
  const r = record as Record<string, unknown>;

  if (typeof r.id !== "string" || !r.id.trim()) {
    return { ok: false, reason: "The template has no valid id.", warnings };
  }
  if (typeof r.name !== "string" || !r.name.trim()) {
    return { ok: false, reason: "The template has no valid name.", warnings };
  }
  if (typeof r.sourceSvg !== "string" || !r.sourceSvg.includes("<svg")) {
    return { ok: false, reason: "The template artwork is missing or is not SVG.", warnings };
  }
  if (!isFiniteNumber(r.width) || r.width <= 0 || r.width > 100000) {
    return { ok: false, reason: "The template artboard width is invalid.", warnings };
  }
  if (!isFiniteNumber(r.height) || r.height <= 0 || r.height > 100000) {
    return { ok: false, reason: "The template artboard height is invalid.", warnings };
  }
  if (typeof r.viewBox !== "string" || !r.viewBox.trim()) {
    return { ok: false, reason: "The template viewBox is invalid.", warnings };
  }
  if (typeof r.capacity !== "number" || !Number.isInteger(r.capacity) || r.capacity < 1 || r.capacity > 1000) {
    return { ok: false, reason: "The template icon capacity is invalid.", warnings };
  }
  if (!Array.isArray(r.iconSlots) || r.iconSlots.length !== r.capacity) {
    const found = Array.isArray(r.iconSlots) ? r.iconSlots.length : 0;
    return {
      ok: false,
      reason: `The template declares ${r.capacity as number} icon slots but carries ${found}.`,
      warnings,
    };
  }
  for (let i = 0; i < (r.iconSlots as unknown[]).length; i++) {
    if (!isRect((r.iconSlots as unknown[])[i])) {
      return { ok: false, reason: `Icon slot ${i + 1} has invalid geometry.`, warnings };
    }
  }
  if (r.heroSlot !== null && r.heroSlot !== undefined && !isRect(r.heroSlot)) {
    return { ok: false, reason: "The hero slot has invalid geometry.", warnings };
  }
  if (r.version !== undefined && (!isFiniteNumber(r.version) || r.version < 1)) {
    warnings.push("The template version number was invalid — it resets to 1.");
  }
  /* a damaged builderDoc never blocks registration: rendering only needs
   * the compiled artwork. The damaged authoring data is stripped so
   * “Edit in Builder” fails honestly instead of resurrecting garbage. */
  if (r.builderDoc !== undefined && r.builderDoc !== null) {
    const b = r.builderDoc as Record<string, unknown>;
    if (typeof b !== "object" || Array.isArray(b) || !Array.isArray(b.elements)) {
      warnings.push("The builder authoring data is damaged — the template keeps working but cannot be re-opened for editing.");
    }
  }
  return { ok: true, warnings };
}

/**
 * Sanitize a record from an UNTRUSTED source (template file import).
 * Returns a clean allow-listed record, or null + error when unusable.
 * Warnings describe every repair that was made — the importer surfaces
 * them so nothing is silently altered.
 */
export function sanitizeImportedTemplateRecord(raw: unknown): {
  record: CustomTemplateRecord | null;
  error?: string;
  warnings: string[];
} {
  const check = validateCustomTemplateRecord(raw);
  if (!check.ok) {
    return { record: null, error: check.reason ?? "This template is not usable.", warnings: check.warnings };
  }
  const r = raw as Record<string, unknown>;
  const warnings = [...check.warnings];

  const grid: TemplateGrid =
    r.grid && typeof r.grid === "object" && !Array.isArray(r.grid) && isFiniteNumber((r.grid as Record<string, unknown>).gap)
      ? {
          cols: isFiniteNumber((r.grid as Record<string, unknown>).cols) ? Math.max(1, Math.floor((r.grid as Record<string, unknown>).cols as number)) : (r.capacity as number),
          rows: isFiniteNumber((r.grid as Record<string, unknown>).rows) ? Math.max(1, Math.floor((r.grid as Record<string, unknown>).rows as number)) : 1,
          gap: (r.grid as Record<string, unknown>).gap as number,
        }
      : { cols: r.capacity as number, rows: 1, gap: 0 };

  const metadata: CustomTemplateMetadata =
    r.metadata && typeof r.metadata === "object" && !Array.isArray(r.metadata)
      ? (r.metadata as CustomTemplateMetadata)
      : { autoDetected: true, confidence: 0, gridDescription: `${grid.rows} × ${grid.cols} grid` };

  const builderDocOk =
    r.builderDoc !== undefined && r.builderDoc !== null
      ? typeof r.builderDoc === "object" && !Array.isArray(r.builderDoc) && Array.isArray((r.builderDoc as Record<string, unknown>).elements)
      : false;

  const record: CustomTemplateRecord = {
    id: r.id as string,
    name: r.name as string,
    sourceSvg: r.sourceSvg as string,
    width: r.width as number,
    height: r.height as number,
    viewBox: r.viewBox as string,
    capacity: r.capacity as number,
    iconSlots: (r.iconSlots as Rect[]).map((s) => ({ x: s.x, y: s.y, width: s.width, height: s.height })),
    heroSlot: isRect(r.heroSlot) ? { ...(r.heroSlot as Rect) } : null,
    grid,
    createdAt: isFiniteNumber(r.createdAt) ? (r.createdAt as number) : Date.now(),
    metadata,
    ...(typeof r.editableSvg === "string" ? { editableSvg: r.editableSvg } : {}),
    ...(r.roles && typeof r.roles === "object" && !Array.isArray(r.roles) ? { roles: r.roles as CustomTemplateRecord["roles"] } : {}),
    ...(builderDocOk ? { builderDoc: r.builderDoc as CustomTemplateRecord["builderDoc"] } : {}),
    ...(isFiniteNumber(r.version) && (r.version as number) >= 1 ? { version: Math.floor(r.version as number) } : {}),
  };
  return { record, warnings };
}

/* ------------------------------------------------------------------ */
/* Portable template file (.icon-template.json)                        */
/* ------------------------------------------------------------------ */

export const TEMPLATE_FILE_EXTENSION = ".icon-template.json";

export interface TemplateFile {
  /** fixed marker — guards against foreign JSON */
  app: "icon-sheet-studio-template";
  /** file format version (bump on breaking changes) */
  version: 1;
  exportedAt: string;
  /** the complete template definition — self-contained, no project icons */
  template: CustomTemplateRecord;
}

export function serializeTemplateFile(record: CustomTemplateRecord): string {
  const file: TemplateFile = {
    app: "icon-sheet-studio-template",
    version: 1,
    exportedAt: new Date().toISOString(),
    template: record,
  };
  return JSON.stringify(file, null, 2);
}

/** Parse + validate a portable template file. Throws an Error with a
 * human-readable message when the file is unusable; warnings describe
 * any repairs the sanitizer applied. */
export function parseTemplateFile(json: string): { record: CustomTemplateRecord; warnings: string[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error("This file is not valid JSON.");
  }
  const doc = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  if (doc.app !== "icon-sheet-studio-template") {
    throw new Error('This file is not an Icon Sheet Studio template (missing "app" marker).');
  }
  if (doc.version !== 1) {
    throw new Error(`Unsupported template file version ${String(doc.version)} — expected 1.`);
  }
  const { record, error, warnings } = sanitizeImportedTemplateRecord(doc.template);
  if (!record) {
    throw new Error(error ?? "The template inside this file is not usable.");
  }
  return { record, warnings };
}
