/**
 * ICON SHEET STUDIO — Workspace backup & restore.
 *
 * The whole workspace is local-first (IndexedDB in this browser). A backup
 * serializes EVERYTHING — icons (with SVG sources), sheets (designs + icon
 * assignments), custom templates, user design presets, ordering and
 * workspace settings — into one JSON document that can be restored later
 * (same browser or a different machine).
 *
 * Restore is destructive-by-design: it REPLACES the current workspace
 * (validated first, confirmed second, then applied atomically).
 */

import type {
  CustomTemplateRecord,
  IconEntry,
  Sheet,
  SheetTemplateSnapshot,
  UserDesignPreset,
  WorkspaceSettings,
} from "./types";
import { normalizeVolume } from "./types";
import { listOfficialTemplates } from "./templates";
import { validateCustomTemplateRecord } from "./template-file";

export interface WorkspaceBackup {
  /** fixed marker — guards against restoring foreign JSON */
  app: "icon-sheet-studio";
  /** backup format version (bump on breaking changes) */
  version: 1;
  /** ISO timestamp of the export */
  exportedAt: string;
  icons: IconEntry[];
  sheets: Sheet[];
  iconOrder: string[];
  sheetOrder: string[];
  activeSheetId: string | null;
  categoryVolumes: Record<string, number>;
  settings: WorkspaceSettings;
  customTemplates: CustomTemplateRecord[];
  designPresets: UserDesignPreset[];
}

/** What the store needs to hand over for a backup. */
export interface BackupSource {
  icons: Record<string, IconEntry>;
  iconOrder: string[];
  sheets: Sheet[];
  activeSheetId: string | null;
  categoryVolumes: Record<string, number>;
  settings: WorkspaceSettings;
  customTemplates: CustomTemplateRecord[];
  designPresets: UserDesignPreset[];
}

export function buildWorkspaceBackup(src: BackupSource): WorkspaceBackup {
  return {
    app: "icon-sheet-studio",
    version: 1,
    exportedAt: new Date().toISOString(),
    icons: structuredClone(src.iconOrder.map((id) => src.icons[id]).filter((i): i is IconEntry => !!i)),
    sheets: structuredClone(src.sheets),
    iconOrder: [...src.iconOrder],
    sheetOrder: src.sheets.map((s) => s.id),
    activeSheetId: src.activeSheetId,
    categoryVolumes: structuredClone(src.categoryVolumes),
    settings: structuredClone(src.settings),
    customTemplates: structuredClone(src.customTemplates),
    designPresets: structuredClone(src.designPresets),
  };
}

/** Serialize a backup for download (pretty-printed for human inspection). */
export function serializeBackup(backup: WorkspaceBackup): string {
  return JSON.stringify(backup, null, 2);
}

/* ------------------------------------------------------------------ */
/* Parse + validate                                                    */
/* ------------------------------------------------------------------ */

export interface ParsedBackup {
  backup: WorkspaceBackup;
  /** non-fatal notes gathered during sanitization (dangling refs etc.) */
  warnings: string[];
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/**
 * Parse + validate a backup document. Throws an Error with a human-readable
 * message when the document is structurally unusable; returns warnings for
 * recoverable problems (dangling icon/template references get dropped).
 */
export function parseWorkspaceBackup(json: string): ParsedBackup {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error("This file is not valid JSON.");
  }
  const doc = asRecord(raw);
  if (doc.app !== "icon-sheet-studio") {
    throw new Error('This file is not an Icon Sheet Studio backup (missing "app" marker).');
  }
  if (doc.version !== 1) {
    throw new Error(`Unsupported backup version ${String(doc.version)} — expected 1.`);
  }

  const warnings: string[] = [];

  /* -- icons --------------------------------------------------------- */
  const iconMap = new Map<string, IconEntry>();
  for (const item of asArray(doc.icons)) {
    const r = asRecord(item);
    if (typeof r.id !== "string" || typeof r.svg !== "string" || typeof r.fileName !== "string") continue;
    iconMap.set(r.id, {
      id: r.id,
      fileName: r.fileName,
      svg: r.svg,
      createdAt: typeof r.createdAt === "number" ? r.createdAt : Date.now(),
      ...(Array.isArray(r.tags) ? { tags: r.tags.filter((t): t is string => typeof t === "string") } : {}),
    });
  }
  if (iconMap.size === 0 && asArray(doc.sheets).length > 0) {
    warnings.push("Backup contains no usable icons — sheets will render empty cells.");
  }

  /* -- custom templates (registered BEFORE sheets so ids resolve) -----
   * phase 3: every record goes through the ONE structural validator —
   * broken rows are dropped with an explicit warning (never silently,
   * never into the registry). Fixes the legacy check that read a
   * non-existent `svg` field and silently discarded EVERY custom
   * template (and every sheet using one) from restored backups. */
  const templateIds = new Set<string>(listOfficialTemplates().map((t) => t.id));
  const customTemplates: CustomTemplateRecord[] = [];
  const droppedTemplates: string[] = [];
  for (const item of asArray(doc.customTemplates)) {
    const r = asRecord(item);
    const label = typeof r.name === "string" && r.name.trim() ? r.name : typeof r.id === "string" ? r.id : "unnamed";
    const check = validateCustomTemplateRecord(item);
    if (!check.ok) {
      droppedTemplates.push(`“${label}” — ${check.reason ?? "corrupt data"}`);
      continue;
    }
    customTemplates.push(item as CustomTemplateRecord);
    if (typeof r.id === "string") templateIds.add(r.id);
  }
  if (droppedTemplates.length) {
    warnings.push(
      `Dropped ${droppedTemplates.length} unusable custom template${droppedTemplates.length === 1 ? "" : "s"} from this backup: ${droppedTemplates.join("; ")}.`
    );
  }

  /* -- sheet template snapshots (phase 3) ---------------------------- *
   * An immutable snapshot lets a sheet survive a missing template record
   * (deleted from the library, or a backup that omits it) and pins it to
   * the revision it was created with. Malformed snapshots are dropped —
   * the sheet then falls back to live-record resolution. */
  const sanitizeSnapshot = (raw: unknown): SheetTemplateSnapshot | undefined => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    const s = raw as Record<string, unknown>;
    const check = validateCustomTemplateRecord(s.record);
    if (!check.ok) return undefined;
    if (typeof s.version !== "number" || !Number.isFinite(s.version) || s.version < 1) return undefined;
    if (typeof s.name !== "string" || !s.name.trim()) return undefined;
    return {
      version: Math.floor(s.version as number),
      name: s.name as string,
      record: s.record as CustomTemplateRecord,
    };
  };

  /* -- sheets --------------------------------------------------------- */
  const sheets: Sheet[] = [];
  const droppedSheets: string[] = [];
  for (const item of asArray(doc.sheets)) {
    const r = asRecord(item);
    if (typeof r.id !== "string" || typeof r.templateId !== "string" || !asRecord(r.design)) continue;
    /* phase 3 — sheets carrying a valid template snapshot survive even
     * when the template record itself is missing from this backup (their
     * snapshot renders standalone; §34 “never export only the id”). */
    const snapshot = sanitizeSnapshot(r.templateSnapshot);
    if (!templateIds.has(r.templateId) && !snapshot) {
      droppedSheets.push(typeof r.category === "string" && r.category ? r.category : r.id);
      continue;
    }
    const iconIds = asArray(r.iconIds).filter((id): id is string => typeof id === "string");
    const missing = iconIds.filter((id) => !iconMap.has(id));
    if (missing.length) warnings.push(`Sheet “${typeof r.category === "string" ? r.category : r.id}”: ${missing.length} icon${missing.length === 1 ? "" : "s"} missing from the backup were dropped.`);
    const restored = { ...(r as unknown as Sheet) };
    if (snapshot) restored.templateSnapshot = snapshot;
    else delete restored.templateSnapshot;
    sheets.push(restored);
  }
  if (droppedSheets.length) {
    warnings.push(`Dropped ${droppedSheets.length} sheet${droppedSheets.length === 1 ? "" : "s"} using templates that are not in this backup (e.g. “${droppedSheets[0]}”).`);
  }

  /* -- ordering ------------------------------------------------------- */
  const sheetIds = new Set(sheets.map((s) => s.id));
  let sheetOrder = asArray(doc.sheetOrder).filter(
    (id): id is string => typeof id === "string" && sheetIds.has(id)
  );
  for (const id of sheetIds) if (!sheetOrder.includes(id)) sheetOrder.push(id);
  const ordered = sheetOrder
    .map((id) => sheets.find((s) => s.id === id))
    .filter((s): s is Sheet => !!s);

  const iconOrder = asArray(doc.iconOrder).filter(
    (id): id is string => typeof id === "string" && iconMap.has(id)
  );

  /* -- volume fields (manual override feature) ----------------------- *
   * Hand-edited backups may carry garbage ("abc", -5, 2.5, 1e9) in
   * volume / volumeAuto, or a non-boolean volumeManual. Sanitize so a
   * restored project can never hold a corrupt sheet: manual sheets keep
   * their override + snapshot; everything else hydrates automatic with
   * volumeAuto === volume. */
  const orderedSheets = ordered.map((s) => {
    const volume = normalizeVolume(s.volume);
    if (s.volumeManual === true) {
      return { ...s, volume, volumeManual: true, volumeAuto: normalizeVolume(s.volumeAuto ?? volume) };
    }
    return { ...s, volume, volumeManual: false, volumeAuto: volume };
  });

  /* -- scalars --------------------------------------------------------- */
  const categoryVolumes: Record<string, number> = {};
  for (const [k, v] of Object.entries(asRecord(doc.categoryVolumes))) {
    if (typeof v === "number" && Number.isFinite(v)) categoryVolumes[k] = v;
  }
  const activeSheetId =
    typeof doc.activeSheetId === "string" && sheetIds.has(doc.activeSheetId)
      ? doc.activeSheetId
      : ordered[0]?.id ?? null;

  const designPresets: UserDesignPreset[] = [];
  for (const item of asArray(doc.designPresets)) {
    const r = asRecord(item);
    if (typeof r.id !== "string" || typeof r.name !== "string") continue;
    designPresets.push(r as unknown as UserDesignPreset);
  }

  const settings = asRecord(doc.settings);
  const backup: WorkspaceBackup = {
    app: "icon-sheet-studio",
    version: 1,
    exportedAt: typeof doc.exportedAt === "string" ? doc.exportedAt : new Date().toISOString(),
    icons: [...iconMap.values()],
    sheets: orderedSheets,
    iconOrder,
    sheetOrder,
    activeSheetId,
    categoryVolumes,
    settings: {
      viewMode: settings.viewMode === "edit" ? "edit" : "overview",
      showGridGuides: settings.showGridGuides === true,
      zoom: typeof settings.zoom === "number" && Number.isFinite(settings.zoom) ? settings.zoom : 0,
    },
    customTemplates,
    designPresets,
  };
  return { backup, warnings };
}
