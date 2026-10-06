/**
 * ICON SHEET STUDIO — IndexedDB persistence.
 * Stores: icons (immutable sources), sheets, workspace meta,
 * custom templates (v2), design presets (v3), builder docs (v4).
 * Targeted writes — never reserializes the whole icon library for a
 * design tweak.
 */

import type { CustomTemplateRecord, IconEntry, Sheet, UserDesignPreset, WorkspaceSettings } from "./types";
import type { BuilderDocument } from "@/lib/builder/types";

const DB_NAME = "icon-sheet-studio";
const DB_VERSION = 4;
const STORE_ICONS = "icons";
const STORE_SHEETS = "sheets";
const STORE_META = "meta";
const STORE_TEMPLATES = "customTemplates";
const STORE_PRESETS = "designPresets";
const STORE_BUILDER_DOCS = "builderDocs";

export type SaveStatus = "idle" | "saving" | "saved" | "error";

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_ICONS)) db.createObjectStore(STORE_ICONS, { keyPath: "id" });
      if (!db.objectStoreNames.contains(STORE_SHEETS)) db.createObjectStore(STORE_SHEETS, { keyPath: "id" });
      if (!db.objectStoreNames.contains(STORE_META)) db.createObjectStore(STORE_META);
      /* v2 — user-imported SVG templates (universal template support).
       * Purely additive: existing stores + data are untouched. */
      if (!db.objectStoreNames.contains(STORE_TEMPLATES)) db.createObjectStore(STORE_TEMPLATES, { keyPath: "id" });
      /* v3 — user-saved design presets (save/apply/reuse). Additive. */
      if (!db.objectStoreNames.contains(STORE_PRESETS)) db.createObjectStore(STORE_PRESETS, { keyPath: "id" });
      /* v4 — Template Builder drafts (Phase 1). Additive: rows are
       * BuilderDocument records (keyPath id) plus one meta row
       * { id: "__builderMeta__", activeDocId, docOrder }. */
      if (!db.objectStoreNames.contains(STORE_BUILDER_DOCS)) db.createObjectStore(STORE_BUILDER_DOCS, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        req.onsuccess = () => resolve(req.result as T);
        req.onerror = () => reject(req.error);
      })
  );
}

/* ------------------------------------------------------------------ */
/* Read API                                                            */
/* ------------------------------------------------------------------ */

export async function loadIcons(): Promise<IconEntry[]> {
  return tx<IconEntry[]>(STORE_ICONS, "readonly", (s) => s.getAll());
}

export async function loadSheets(): Promise<Sheet[]> {
  const rows = await tx<Sheet[]>(STORE_SHEETS, "readonly", (s) => s.getAll());
  return rows.sort((a, b) => a.createdAt - b.createdAt);
}

export interface WorkspaceMeta {
  activeSheetId: string | null;
  iconOrder: string[];
  /** user's sheet order (ids); fallback to createdAt when absent */
  sheetOrder?: string[];
  categoryVolumes: Record<string, number>;
  settings: WorkspaceSettings;
}

export async function loadMeta(): Promise<WorkspaceMeta | null> {
  const row = await tx<WorkspaceMeta | undefined>(STORE_META, "readonly", (s) => s.get("workspace"));
  return row ?? null;
}

export async function loadCustomTemplates(): Promise<CustomTemplateRecord[]> {
  try {
    const rows = await tx<CustomTemplateRecord[]>(STORE_TEMPLATES, "readonly", (s) => s.getAll());
    return rows.sort((a, b) => a.createdAt - b.createdAt);
  } catch {
    /* DB created before v2 — no templates yet */
    return [];
  }
}

export async function putCustomTemplate(record: CustomTemplateRecord): Promise<void> {
  return tx<unknown>(STORE_TEMPLATES, "readwrite", (s) => s.put(record)).then(() => undefined);
}

export async function deleteCustomTemplate(id: string): Promise<void> {
  return tx<undefined>(STORE_TEMPLATES, "readwrite", (s) => s.delete(id)).then(() => undefined);
}

/* ------------------------------------------------------------------ */
/* User-saved design presets (v3)                                      */
/* ------------------------------------------------------------------ */

export async function loadDesignPresets(): Promise<UserDesignPreset[]> {
  try {
    const rows = await tx<UserDesignPreset[]>(STORE_PRESETS, "readonly", (s) => s.getAll());
    return rows.sort((a, b) => a.createdAt - b.createdAt);
  } catch {
    /* DB created before v3 — no presets yet */
    return [];
  }
}

export async function putDesignPreset(preset: UserDesignPreset): Promise<void> {
  return tx<unknown>(STORE_PRESETS, "readwrite", (s) => s.put(preset)).then(() => undefined);
}

export async function deleteDesignPresetRow(id: string): Promise<void> {
  return tx<undefined>(STORE_PRESETS, "readwrite", (s) => s.delete(id)).then(() => undefined);
}

/* ------------------------------------------------------------------ */
/* Template Builder drafts (v4) — additive, studio stores untouched     */
/* ------------------------------------------------------------------ */

export interface BuilderMetaRow {
  id: "__builderMeta__";
  activeDocId: string | null;
  docOrder: string[];
}

const BUILDER_META_KEY = "__builderMeta__";

export async function loadBuilderDocs(): Promise<BuilderDocument[]> {
  try {
    const rows = await tx<(BuilderDocument | BuilderMetaRow)[]>(STORE_BUILDER_DOCS, "readonly", (s) => s.getAll());
    const docs = rows.filter((r): r is BuilderDocument => r.id !== BUILDER_META_KEY);
    return docs.sort((a, b) => a.metadata.createdAt - b.metadata.createdAt);
  } catch {
    /* DB created before v4 — no builder docs yet */
    return [];
  }
}

export async function loadBuilderMeta(): Promise<BuilderMetaRow | null> {
  try {
    const row = await tx<BuilderMetaRow | undefined>(STORE_BUILDER_DOCS, "readonly", (s) => s.get(BUILDER_META_KEY));
    return row ?? null;
  } catch {
    return null;
  }
}

export async function putBuilderDoc(doc: BuilderDocument): Promise<void> {
  return tx<unknown>(STORE_BUILDER_DOCS, "readwrite", (s) => s.put(doc)).then(() => undefined);
}

export async function putBuilderMeta(meta: BuilderMetaRow): Promise<void> {
  return tx<unknown>(STORE_BUILDER_DOCS, "readwrite", (s) => s.put(meta)).then(() => undefined);
}

export async function deleteBuilderDoc(id: string): Promise<void> {
  return tx<undefined>(STORE_BUILDER_DOCS, "readwrite", (s) => s.delete(id)).then(() => undefined);
}

/* ------------------------------------------------------------------ */
/* Write API — targeted                                                */
/* ------------------------------------------------------------------ */

export async function putIcons(entries: IconEntry[]): Promise<void> {
  if (!entries.length) return;
  return tx<unknown>(STORE_ICONS, "readwrite", (s) => {
    for (const e of entries) s.put(e);
    return s.put(entries[0]);
  }).then(() => undefined);
}

export async function putSheet(sheet: Sheet): Promise<void> {
  return tx<unknown>(STORE_SHEETS, "readwrite", (s) => s.put(sheet)).then(() => undefined);
}

export async function putSheets(sheets: Sheet[]): Promise<void> {
  if (!sheets.length) return;
  return tx<unknown>(STORE_SHEETS, "readwrite", (s) => {
    for (const sh of sheets) s.put(sh);
    return s.put(sheets[0]);
  }).then(() => undefined);
}

export async function deleteIcons(ids: string[]): Promise<void> {
  if (!ids.length) return;
  return tx<unknown>(STORE_ICONS, "readwrite", (s) => {
    for (const id of ids) s.delete(id);
    return s.delete(ids[0]);
  }).then(() => undefined);
}

export async function deleteSheet(id: string): Promise<void> {
  return tx<undefined>(STORE_SHEETS, "readwrite", (s) => s.delete(id)).then(() => undefined);
}

export async function putMeta(meta: WorkspaceMeta): Promise<void> {
  // meta store uses out-of-line keys → explicit key required
  return tx<unknown>(STORE_META, "readwrite", (s) => s.put(meta, "workspace")).then(
    () => undefined
  );
}

export async function clearAll(): Promise<void> {
  await openDb();
  const clears = [
    tx<undefined>(STORE_ICONS, "readwrite", (s) => s.clear()).then(() => undefined),
    tx<undefined>(STORE_SHEETS, "readwrite", (s) => s.clear()).then(() => undefined),
    tx<undefined>(STORE_META, "readwrite", (s) => s.clear()).then(() => undefined),
  ];
  /* v2/v3 stores are cleared only when they exist (older DBs) */
  try {
    await tx<undefined>(STORE_TEMPLATES, "readwrite", (s) => s.clear()).then(() => undefined);
    await tx<undefined>(STORE_PRESETS, "readwrite", (s) => s.clear()).then(() => undefined);
  } catch {
    /* ignore — store absent on pre-v2/v3 databases */
  }
  await Promise.all(clears);
}

/* ------------------------------------------------------------------ */
/* Debounced autosave controller                                       */
/* ------------------------------------------------------------------ */

export interface AutosaveTargets {
  sheets: Sheet[]; // sheets to persist (all — cheap: they're small)
  deletedSheetIds: string[];
  icons: IconEntry[]; // new/changed icons
  /** icon ids removed from the library (delete-icons action / undo-restore) */
  deletedIconIds?: string[];
  meta: WorkspaceMeta;
}

export class Autosaver {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: AutosaveTargets | null = null;
  private running = false;

  constructor(
    private onStatus: (status: SaveStatus) => void,
    private debounceMs = 700
  ) {}

  /**
   * MERGE into the pending target instead of replacing it. Callers pass
   * DELTAS (new/changed icons, deleted icon/sheet ids) — replacing an
   * un-flushed pending target would silently drop writes when two
   * mutations land within the debounce window (e.g. importing icons and
   * immediately creating a sheet: the sheet schedule replaced the icon
   * puts and the icons never reached IndexedDB → stale references after
   * reload). Merge semantics = "latest action wins", matching the
   * in-memory state:
   *   · icon/sheet PUTS: later entry wins per id
   *   · a later PUT of a pending-deleted id drops that delete (flush
   *     writes puts before deletes, so the delete would win otherwise)
   *   · a later DELETE of a pending-put id keeps both — flush's
   *     put→delete order then nets to deleted, as the user intended
   *   · meta: later snapshot wins wholesale
   */
  schedule(targets: AutosaveTargets) {
    if (this.pending) {
      const prev = this.pending;

      const iconMap = new Map(prev.icons.map((i) => [i.id, i]));
      for (const ic of targets.icons) iconMap.set(ic.id, ic);

      const sheetMap = new Map(prev.sheets.map((s) => [s.id, s]));
      for (const s of targets.sheets) sheetMap.set(s.id, s);

      const sheetDeletes = new Set(prev.deletedSheetIds);
      for (const id of targets.deletedSheetIds) sheetDeletes.add(id);
      for (const s of targets.sheets) sheetDeletes.delete(s.id);

      const iconDeletes = new Set(prev.deletedIconIds ?? []);
      for (const id of targets.deletedIconIds ?? []) iconDeletes.add(id);
      for (const ic of targets.icons) iconDeletes.delete(ic.id);

      this.pending = {
        sheets: Array.from(sheetMap.values()),
        deletedSheetIds: Array.from(sheetDeletes),
        icons: Array.from(iconMap.values()),
        deletedIconIds: Array.from(iconDeletes),
        meta: targets.meta,
      };
    } else {
      this.pending = targets;
    }
    this.onStatus("saving");
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), this.debounceMs);
  }

  async flush(): Promise<void> {
    if (this.running || !this.pending) return;
    this.running = true;
    const targets = this.pending;
    this.pending = null;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    try {
      if (targets.icons.length) await putIcons(targets.icons);
      if (targets.sheets.length) await putSheets(targets.sheets);
      for (const id of targets.deletedSheetIds) await deleteSheet(id);
      if (targets.deletedIconIds?.length) await deleteIcons(targets.deletedIconIds);
      await putMeta(targets.meta);
      this.onStatus("saved");
    } catch (err) {
      console.error("[studio] autosave failed", err);
      this.onStatus("error");
    } finally {
      this.running = false;
      if (this.pending) void this.flush();
    }
  }
}
