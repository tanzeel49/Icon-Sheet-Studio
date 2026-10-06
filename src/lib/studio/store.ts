/**
 * ICON SHEET STUDIO — Workspace store (single source of truth).
 *
 * Rules enforced here:
 *  · A sheet OWNS its iconIds (never derive membership from indices).
 *  · The icon library is immutable — imports add, nothing mutates sources.
 *  · All edits target ONE sheet (active sheet) unless an explicit
 *    apply-to-all / apply-to-selected action is invoked.
 *  · Undo/redo snapshots cover sheet structures — not the icon library.
 *  · Autosave is debounced and targeted (IndexedDB).
 */

"use client";

import { create } from "zustand";
import { toast } from "sonner";
import type { CellOverride, CustomTemplateRecord, DesignPresetIncludes, GradientFill, IconEntry, LibraryDensity, LibrarySortMode, LibraryTagLogic, Sheet, SheetDesign, TemplateLoadError, UserDesignPreset, WorkspaceSettings } from "./types";
import { buildSheetSnapshot, createDefaultDesign, customRecordVersion, getTemplate, setCustomTemplateRegistry, sheetTemplate } from "./templates";
import { normalizeVolume, sheetTitle, STROKE_WEIGHT_PX_MAX, STROKE_WEIGHT_PX_MIN, UNIFORM_TARGET_PX_MAX, UNIFORM_TARGET_PX_MIN } from "./types";
import { isValidSvg, nextId, hashSvgContent } from "./svg";
import { enrichCustomTemplateRecords } from "./custom-template";
import { validateCustomTemplateRecord } from "./template-file";
import { applyPresetToDesign, captureUserPreset } from "./design-preset";
import { buildWorkspaceBackup, parseWorkspaceBackup, serializeBackup } from "./backup";
import { Autosaver, loadIcons, loadMeta, loadSheets, loadCustomTemplates, loadDesignPresets, putDesignPreset, deleteDesignPresetRow, putCustomTemplate, deleteCustomTemplate as deleteCustomTemplateRow, clearAll, putIcons, putSheets, putSheet, putMeta, type SaveStatus } from "./idb";

/* ------------------------------------------------------------------ */
/* History                                                             */
/* ------------------------------------------------------------------ */

interface HistorySnapshot {
  sheets: Sheet[];
  categoryVolumes: Record<string, number>;
  activeSheetId: string | null;
  selectedSheetIds: string[];
  /** present ONLY on library-mutating history entries (delete-icons):
   *  the full icons map + order at snapshot time, so undo/redo can
   *  restore the library alongside the sheet structure. */
  icons?: Record<string, IconEntry>;
  iconOrder?: string[];
  /** present ONLY on tag-mutating history entries (tag add/remove/set,
   *  rename, merge, delete): undo/redo restore the EXACT icon entries
   *  from this snapshot — ids keep the snapshot's tags instead of the
   *  current ones, so the tag edit itself is reverted. Icons imported
   *  after the snapshot (absent from it) always keep their current
   *  entries in both directions. */
  tagOp?: boolean;
  /** ids the associated action REMOVED from the library. Explicit delta —
   *  lets redo remove exactly the action's icons while icons imported
   *  after the action survive both directions. */
  deletedIconIds?: string[];
}

interface HistoryEntry {
  label: string;
  time: number;
  state: HistorySnapshot;
}

const HISTORY_LIMIT = 80;
const COALESCE_MS = 900;

function snapshotOf(
  s: {
    sheets: Sheet[];
    categoryVolumes: Record<string, number>;
    activeSheetId: string | null;
    selectedSheetIds: string[];
    icons?: Record<string, IconEntry>;
    iconOrder?: string[];
  },
  includeIcons = false
): HistorySnapshot {
  const snap: HistorySnapshot = {
    sheets: structuredClone(s.sheets),
    categoryVolumes: structuredClone(s.categoryVolumes),
    activeSheetId: s.activeSheetId,
    selectedSheetIds: [...s.selectedSheetIds],
  };
  if (includeIcons) {
    snap.icons = s.icons ?? {};
    snap.iconOrder = s.iconOrder ?? [];
  }
  return snap;
}

/* ------------------------------------------------------------------ */
/* Library snapshot restore (undo/redo of delete-icons)                */
/* ------------------------------------------------------------------ */

/**
 * Merge a history snapshot's library back into the live state, writing the
 * patch into `patch` (icons + iconOrder) and queueing the IDB delta.
 *
 * undo direction (restoring the PRE-action state):
 *  · icons present in the snapshot but missing now → resurrected (put back).
 *    These are exactly the action's deleted icons — later imports survive.
 *  · nothing is removed: the pre-action library ∪ imports-since is the
 *    desired end state.
 * redo direction (re-applying the action, restoring the POST-action state):
 *  · icons in the snapshot's explicit deletedIconIds delta → removed now;
 *    icons imported since the action survive (not part of the delta).
 *
 * Ids present in both states keep the CURRENT entry, so tag edits made
 * after the snapshot survive the restore (NOT for tagOp entries — those
 * restore the snapshot's fields exactly, which is what reverts the edit).
 * Round 15: tagOp entries (the icon-FIELD-op family) now cover tags ·
 * title · description; the same-entry check compares all three fields.
 * The order merges the snapshot's positions with any icons imported since.
 */
function applyLibrarySnapshot(
  current: { icons: Record<string, IconEntry>; iconOrder: string[] },
  target: HistorySnapshot,
  patch: Partial<StudioState>,
  direction: "undo" | "redo"
): void {
  const targetIcons = target.icons ?? {};
  const targetOrder = target.iconOrder ?? [];
  const merged: Record<string, IconEntry> = { ...current.icons };

  if (target.tagOp) {
    /* Icon-FIELD operations (tags · title · description — round 15
     * generalized the tag-op family) change fields on EXISTING icons
     * (never membership).
     * Undo: restore the snapshot's entries exactly — resurrecting ids a
     * LATER action removed is a harmless safety net in linear undo. Redo:
     * only ids still in the library are restored (ids removed by later,
     * already-redone actions stay removed). Ids absent from the snapshot
     * (imported since) always keep their current entries. */
    for (const [id, entry] of Object.entries(targetIcons)) {
      const cur = merged[id];
      const fieldsDiffer =
        !cur ||
        (cur.tags ?? []).join("\u0000") !== (entry.tags ?? []).join("\u0000") ||
        cur.title !== entry.title ||
        cur.description !== entry.description;
      if (cur && !fieldsDiffer) continue;
      if (!cur && direction === "redo") continue;
      merged[id] = entry;
      pendingNewIcons.push(entry); // putIcons overwrites by id → IDB sync
    }
  } else if (direction === "undo") {
    for (const [id, entry] of Object.entries(targetIcons)) {
      if (!merged[id]) {
        merged[id] = entry; // resurrect (action-deleted icon)
        pendingNewIcons.push(entry);
      }
    }
  } else {
    for (const id of target.deletedIconIds ?? []) {
      if (merged[id]) {
        delete merged[id]; // re-apply the action's deletion
        pendingDeletedIconIds.push(id);
      }
    }
  }

  const targetOrderSet = new Set(targetOrder);
  const iconOrder = [
    ...targetOrder.filter((id) => merged[id]),
    ...current.iconOrder.filter((id) => merged[id] && !targetOrderSet.has(id)),
  ];

  patch.icons = merged;
  patch.iconOrder = iconOrder;
}

/* ------------------------------------------------------------------ */
/* Import report                                                       */
/* ------------------------------------------------------------------ */

/** How many recent import reports the session keeps viewable (ring buffer
 *  for the import-history popover — round 18). */
export const IMPORT_HISTORY_CAP = 8;

export interface ImportReport {
  imported: number;
  /** invalid files skipped by importFiles itself (not SVG / unreadable /
   *  invalid markup) — duplicate content is NEVER skipped here */
  skipped: number;
  /** library-duplicate files kept OUT of the import — ONLY possible when
   *  the user explicitly chose "Skip Duplicates" in the confirmation
   *  dialog (importWithDuplicateCheck filters them before the commit). */
  duplicates: number;
  /** library-duplicate files imported ANYWAY (the user chose "Add
   *  Duplicates") — they exist as separate, independent icon records */
  duplicatesImported: number;
  /** true when the user chose "Cancel" — NOTHING was imported, no
   *  library or state changes at all (the whole operation was aborted
   *  safely). */
  cancelled?: boolean;
  skipReasons: string[];
  /** epoch ms when the import finished — stamped by the store when the
   *  report is published to lastImportReport (round 17: powers the
   *  "Last import" summary card in the library panel). Older reports
   *  without it fall back to "just now". */
  finishedAt?: number;
}

/** Result of the PRE-IMPORT duplicate scan (detection ONLY — it never
 *  decides what gets imported; see importWithDuplicateCheck). */
export interface DuplicateScanResult {
  total: number;
  /** files that are readable valid SVGs (everything else would be skipped
   *  by importFiles anyway — the dialog only talks about these) */
  validFiles: number;
  /** every selected file whose content hash matches a LIBRARY icon.
   *  Batch-internal repeats are NOT library duplicates: per the data model
   *  the library freely holds multiple records with identical content, so
   *  every valid file listed here still imports unless the USER says no.
   *  svg carries the (content-identical) artwork so the ask dialog can
   *  show the actual glyph next to the names — round 14. */
  duplicates: { fileName: string; existingName: string; svg?: string }[];
}

/** Pending "Duplicate Icons Detected" question raised by
 *  importWithDuplicateCheck — rendered by the app-level
 *  DuplicateImportDialog and answered via resolveDuplicateAsk.
 *  THREE explicit outcomes (the user always controls the decision):
 *  "add"    — import everything, duplicates become separate records;
 *  "skip"   — import only the non-duplicate files;
 *  "cancel" — abort the ENTIRE import safely (nothing is imported,
 *             nothing is deleted, the library is unchanged). */
export type DuplicateAskPolicy = "add" | "skip" | "cancel";

export interface DuplicateAsk {
  scan: DuplicateScanResult;
  resolve: (policy: DuplicateAskPolicy) => void;
}

/** Content-hash index of the CURRENT library: hash → fileName of the first
 *  owner in library order. Pure read shared by the duplicate scan and the
 *  skip-filter in importWithDuplicateCheck — importFiles itself NEVER
 *  consults it (duplicate content is a user decision, not a pipeline one). */
function libraryHashIndex(s: { icons: Record<string, IconEntry>; iconOrder: string[] }): Map<string, string> {
  const seen = new Map<string, string>();
  for (const id of s.iconOrder) {
    const ic = s.icons[id];
    if (ic) seen.set(hashSvgContent(ic.svg), ic.fileName);
  }
  return seen;
}

/* Import serialization chain: while one import (incl. its pending duplicate
 * dialog) is in flight, the next import WAITS here. Prevents the single
 * duplicateAsk slot from being overwritten — which would orphan the first
 * decision promise and stick the first uploader's busy spinner forever. */
let importChain: Promise<unknown> = Promise.resolve();

/* ------------------------------------------------------------------ */
/* Store                                                               */
/* ------------------------------------------------------------------ */

/** Workspace zoom range — single source of truth for every zoom entry
 *  point (toolbar +/− buttons, presets dropdown, +/− keyboard shortcuts,
 *  Ctrl/⌘+wheel smooth zoom). zoom = 0 means "fit to screen"; any other
 *  value is a scale factor clamped to these bounds. Max raised 2.5 → 5
 *  (500%) so deeply zoomed inspection of fine linework is possible —
 *  the artboard width is uncapped above 1× and the canvas pans it. */
export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 5;

export interface StudioState {
  /* data */
  icons: Record<string, IconEntry>;
  iconOrder: string[];
  sheets: Sheet[];
  activeSheetId: string | null;
  selectedSheetIds: string[];
  categoryVolumes: Record<string, number>;
  settings: WorkspaceSettings;

  /* meta */
  hydrated: boolean;
  saveStatus: SaveStatus;
  lastImportReport: ImportReport | null;
  /** Ring buffer of the last IMPORT_HISTORY_CAP import reports (newest
   * first) — round 18. lastImportReport powers the dismissible "Last
   * import" card; this history keeps the session's earlier reports
   * viewable after that card is dismissed (the import-history popover).
   * Runtime-only like the report itself: never persisted. */
  importHistory: ImportReport[];
  /** Library stroke-weight audit armed (round 18 — lifted from the panel's
   * local state so the command palette can toggle it and it survives the
   * library tab unmounting, exactly like libraryFilter). Round 22: the
   * value ALSO mirrors into settings.strokeAudit so it persists across
   * reloads (hydrate seeds this field back). */
  strokeAudit: boolean;
  /** Unit the audit badges/census display: "root" = viewBox user units
   * (the inspector convention), "canvas" = the ACTIVE sheet's grid embed
   * box converted px (the stroke-report convention). Mirrors into
   * settings.strokeAuditUnit (round 22) — persisted across reloads. */
  strokeAuditUnit: "root" | "canvas";
  setStrokeAudit: (on: boolean) => void;
  setStrokeAuditUnit: (unit: "root" | "canvas") => void;
  past: HistoryEntry[];
  future: HistoryEntry[];

  /* ------- imported templates (universal template support) -------
   * Additive surface: official templates are compile-time constants and
   * never appear here. Records persist to IndexedDB; hydrate injects them
   * into the shared template registry (getTemplate/listTemplates). */
  customTemplates: CustomTemplateRecord[];
  /** custom-template records that failed structural validation at hydrate
   * (IndexedDB corruption / hand-edited backups). Quarantined OUT of the
   * registry so they can never crash a render, listed in the Template
   * Library with an explicit Remove action — never silent loss. */
  templateLoadErrors: TemplateLoadError[];
  /** permanently remove a quarantined (broken) record row */
  removeBrokenTemplateRecord: (id: string) => void;
  /** save a confirmed analysis (slots already validated by the dialog).
   *  opts.silent suppresses the built-in toast (the Template Builder
   *  publishes through here with its own, richer feedback). */
  importCustomTemplate: (
    record: Omit<CustomTemplateRecord, "id" | "createdAt">,
    opts?: { silent?: boolean }
  ) => CustomTemplateRecord;
  /** replace an existing record IN PLACE (same id — sheets keep their
   *  templateId reference) and bump its version. Phase 3 semantics: using
   *  sheets are NOT touched — they stay pinned to their snapshot version
   * until the user explicitly updates them (updateSheetTemplateToLatest). */
  updateCustomTemplateRecord: (record: CustomTemplateRecord) => boolean;
  renameCustomTemplate: (id: string, name: string) => void;
  /** removes the record from the library. Sheets that still use the
   *  template keep rendering from their embedded templateSnapshot —
   * deleting NEVER blanks an existing sheet. */
  deleteCustomTemplate: (id: string) => boolean;
  duplicateCustomTemplate: (id: string) => CustomTemplateRecord | null;
  /** re-pin a sheet's templateSnapshot to the live record's latest version
   * (explicit “Update to latest” — never automatic). Handles capacity
   * changes with the same overflow strategies as template switching.
   * Returns {ok, reason?, overflow?} for honest UI feedback. */
  updateSheetTemplateToLatest: (
    sheetId: string,
    overflowStrategy: "create-new" | "move-next"
  ) => { ok: boolean; reason?: "not-found" | "deleted" | "current"; overflow?: number };
  /** snapshot stamping used at every sheet-creation / template-switch site */
  stampSheetSnapshot: (sheetId: string) => void;

  /* ------- user-saved design presets (v3) -------
   * Reusable design snapshots (typography/colors/appearance/hero/layout).
   * NEVER carry icons/category/volume/template — applying one restyles the
   * target sheet's design only, capability-scoped per target template. */
  designPresets: UserDesignPreset[];
  /** capture the source sheet's current customization under a name */
  saveDesignPreset: (
    sourceSheetId: string,
    name: string,
    includes: DesignPresetIncludes
  ) => UserDesignPreset | null;
  renameDesignPreset: (id: string, name: string) => void;
  deleteDesignPreset: (id: string) => void;
  /** apply a preset to the CURRENT sheet (one undo entry, design only) */
  applyDesignPreset: (presetId: string, sheetId: string) => void;
  /** apply a preset to OTHER sheets (selected ids or every other sheet) */
  applyDesignPresetToSheets: (presetId: string, targetSheetIds: string[]) => void;

  /* ------- template import dialog (view state — never persisted) --- */
  templateImportOpen: boolean;
  openTemplateImport: () => void;
  closeTemplateImport: () => void;

  /* ------- lifecycle ------- */
  hydrate: () => Promise<void>;

  /* ------- workspace backup / restore (round 3) ------- */
  /** Backup dialog open state (shell-mounted; not persisted). */
  backupDialogOpen: boolean;
  setBackupDialogOpen: (open: boolean) => void;
  openBackupDialog: () => void;
  /** Serialize the ENTIRE workspace (icons, sheets, templates, presets,
   *  ordering, settings) as a pretty-printed backup JSON string. */
  buildBackupJson: () => string;
  /** Validate + apply a backup document, REPLACING the current workspace
   *  (IndexedDB is wiped, then rewritten from the backup). Returns the
   *  outcome — never throws. */
  restoreWorkspace: (json: string) => Promise<{ ok: boolean; error?: string; warnings: string[] }>;

  /* ------- stroke report dialog (round 8; view state — not persisted) --- */
  /** Stroke report dialog open state (shell-mounted; not persisted). */
  strokeReportOpen: boolean;
  setStrokeReportOpen: (open: boolean) => void;
  openStrokeReport: () => void;
  closeStrokeReport: () => void;
  /** round 22 · open the report scoped to a specific sheet (the palette's
   * per-sheet commands use this). */
  openStrokeReportFor: (sheetId: string) => void;
  /** round 22 · sheet-scoped report: the sheet the dialog analyzes when set;
   * null = follow the ACTIVE sheet (the classic behavior). openStrokeReport
   * resets to null so every fresh open starts on the active sheet; the
   * dialog's own switcher pills drive it while open (runtime-only). */
  strokeReportSheetId: string | null;
  setStrokeReportSheet: (sheetId: string | null) => void;

  /* ------- similarity report dialog (round 10; view state — not persisted) --- */
  /** Visually-similar-icons dialog open state (shell-mounted; not persisted). */
  similarityDialogOpen: boolean;
  setSimilarityDialogOpen: (open: boolean) => void;
  openSimilarityDialog: () => void;
  closeSimilarityDialog: () => void;

  /* ------- icons ------- */
  /** Low-level COMMIT step: validate files and add them as icon records.
   *  It performs NO duplicate filtering whatsoever — duplicate content is
   *  identified by scanImportDuplicates and decided by the USER in
   *  importWithDuplicateCheck. Call importWithDuplicateCheck (not this)
   *  from any user-facing upload surface. */
  importFiles: (files: File[], tagHints?: Record<string, string[]>) => Promise<ImportReport>;
  /** THE import pipeline every upload surface goes through:
   *  validate → detect library duplicates → ASK ("Duplicate Icons
   *  Detected" dialog, store-held so no surface can bypass it) → import
   *  per the user's THREE-WAY choice. "Add Duplicates" imports EVERY
   *  file — duplicates become separate, independent records; "Skip
   *  Duplicates" imports only the non-duplicate files; "Cancel" aborts
   *  the entire import safely (no files imported, existing icons never
   *  touched). No dialog appears when there are no duplicates. Imports
   *  are SERIALIZED — a second upload waits for the pending dialog to be
   *  answered instead of overwriting it (the single duplicateAsk slot can
   *  never orphan a pending decision). */
  importWithDuplicateCheck: (
    files: File[],
    tagHints?: Record<string, string[]>,
    opts?: { successMessage?: string },
  ) => Promise<ImportReport>;
  /** Answer the pending duplicate question ([Add Duplicates] /
   *  [Skip Duplicates] / [Cancel] buttons; ESC and outside-click =
   *  Cancel — the safest default: the ENTIRE import is aborted, nothing
   *  is imported, nothing is deleted). */
  resolveDuplicateAsk: (policy: DuplicateAskPolicy) => void;
  /** Dismiss the "Last import" summary card (round 17) — clears the
   *  runtime-only lastImportReport so the library panel's import summary
   *  goes away. Never touches any persisted data (the report itself is
   *  session-only and never saved to IndexedDB). */
  dismissImportReport: () => void;
  /** round 19 · palette entry point for the import audit: re-surface the
   *  most recent import report card (the history ring buffer's newest
   * entry) when the card was dismissed. Returns true when a card is (now)
   * visible. Runtime-only state, no persistence. */
  resurfaceImportReport: () => boolean;
  /** Pending duplicate question state (drives the app-level dialog). */
  duplicateAsk: DuplicateAsk | null;
  /** Pre-import duplicate scan — reads + hashes the files WITHOUT importing
   *  anything. Detection ONLY: it identifies and reports which files match
   *  library icons so the user can decide; it never removes anything.
   *  Mirrors importFiles' validation rules exactly (extension,
   *  readability, isValidSvg). */
  scanImportDuplicates: (files: File[]) => Promise<DuplicateScanResult>;
  /** Batch tag edit — icon sources stay immutable, only the tag list changes.
   *  Undoable since round 6: each edit pushes a tag history entry whose
   *  undo/redo restores the affected icons' exact tag lists. */
  updateIconTags: (iconIds: string[], mode: "add" | "remove" | "set", tags: string[]) => void;
  /** Per-icon metadata edit (round 15) — title + description live on the
   *  library entry, never on the immutable SVG source. Patch fields with
   *  undefined = "leave unchanged"; "" = clear the field. Trimming and
   *  length caps are applied here (title 80, description 280). Undoable:
   *  pushes an icon-field history entry (restore-exactly semantics, the
   *  tag-op family). Returns true when anything actually changed. */
  updateIconMeta: (
    iconId: string,
    patch: { title?: string; description?: string }
  ) => boolean;
  /** Remove icons from the library ENTIRELY — pulls them off every sheet
   *  (hero cleared if the hero icon is deleted). Fully undoable: the history
   *  entry carries the library state. Returns ids removed + sheets touched. */
  deleteIcons: (iconIds: string[]) => { removed: string[]; sheetsTouched: string[] };
  /** Pull icons OFF their sheets back into the unassigned pool — icons stay
   *  in the library (the inverse of moveIcons, which only files INTO sheets).
   *  Hero cleared if the hero icon is unassigned. Undoable (sheet-structure
   *  history only — the library itself is unchanged). */
  unassignIcons: (iconIds: string[]) => { removed: string[]; sheetsTouched: string[] };
  /** Consolidate duplicates: replace EVERY sheet placement of `fromId` with
   *  `toId` (the keeper). When the keeper is already on a sheet that also
   *  holds `fromId`, the duplicate occurrence is dropped instead (a sheet
   *  never renders the same icon twice — the cell count of that sheet can
   *  shrink). The source icon's cell overrides are dropped (the keeper
   *  keeps its own); the hero follows the replacement. Icons stay in the
   *  library — `fromId` simply becomes unassigned. Undoable (sheet-
   *  structure history only — the library itself is unchanged). Returns
   *  placements replaced + occurrences merged away + sheets touched. */
  replaceIconEverywhere: (fromId: string, toId: string) => { replaced: number; merged: number; sheetsTouched: string[] };
  /** One group's bulk-dedupe step for consolidateSimilarGroups: every
   *  `otherIds` placement becomes a `keeperId` placement (merged away when
   *  the keeper already occupies the sheet), and the others are then
   *  DELETED from the library — the one-click finish of the find → review
   *  → consolidate → delete dedupe loop. */
  consolidateSimilarGroups: (
    plan: { keeperId: string; otherIds: string[] }[]
  ) => {
    groups: number;
    iconsDeleted: number;
    placementsReplaced: number;
    duplicatesMerged: number;
    sheetsTouched: number;
  };
  /** Rename (or MERGE, when newName already exists) a tag across the entire
   *  library. Returns affected icon count + whether it merged into an
   *  existing tag. Undoable (round 6): reverting restores the exact tag
   *  lists of every affected icon. */
  renameTag: (oldName: string, newName: string) => { icons: number; merged: boolean };
  /** Delete a tag from every icon that has it. Returns affected icon count.
   *  Undoable (round 6). */
  deleteTag: (name: string) => number;
  /** Bulk-merge several tags onto ONE target (target may be one of the
   *  sources — it survives; the rest disappear into it). Returns affected
   *  icon count + whether the target already existed. Undoable (round 6). */
  mergeTags: (sourceNames: string[], targetName: string) => { icons: number; merged: boolean; target: string };
  /** Bulk-delete several tags from every icon. Returns affected icon count.
   *  Undoable (round 6). */
  deleteTags: (names: string[]) => number;

  /* ------- sheets ------- */
  generateSheets: (templateId: string) => number;
  deleteSheet: (sheetId: string) => void;
  setActiveSheet: (sheetId: string) => void;
  toggleSheetSelected: (sheetId: string) => void;
  selectAllSheets: () => void;
  clearSheetSelection: () => void;

  /* ------- editing (active-sheet scoped) ------- */
  updateSheetDesign: (sheetId: string, label: string, updater: (design: SheetDesign) => void) => void;
  setCategory: (sheetId: string, category: string, autoVolume?: boolean) => void;
  /** Set the sheet's volume number. `manual` (default true) records a
   *  per-sheet USER override the automatic numbering never clobbers;
   *  `manual: false` writes an automatic value (section reset → VOL. 01).
   *  Both are undoable and clamped to 1..9999. */
  setVolume: (sheetId: string, volume: number, manual?: boolean) => void;
  /** Remove THIS sheet's manual volume override and restore its automatic
   *  volume (the volumeAuto snapshot). No-op on automatic sheets; the
   *  category-wide counter and every other sheet are untouched. Undoable. */
  resetSheetVolume: (sheetId: string) => void;
  /** Rename the sheet for display (falls back to "Sheet NN" when empty).
   *  Undoable like the other sheet edits. */
  renameSheet: (sheetId: string, name: string) => void;
  resetCategoryVolume: (category: string) => void;
  setHero: (sheetId: string, iconId: string | null) => void;
  /** Per-cell exceptions (skip / card color) — keyed by icon id, so they
   *  follow icons across reorders. Both actions are undoable and prune
   *  entries for icons no longer on the sheet. */
  setCellSkip: (sheetId: string, iconIds: string[], skip: boolean) => void;
  setCellCardColor: (sheetId: string, iconIds: string[], color: string | null) => void;
  /** Per-cell card GRADIENT fill (round 12). Mutually exclusive with the
   *  solid color in practice: setting a gradient clears cardColor, and
   *  setCellCardColor clears the gradient. null removes the override. */
  setCellCardGradient: (sheetId: string, iconIds: string[], gradient: GradientFill | null) => void;
  /** Per-cell STROKE exception (round 9): a per-icon uniform-stroke target
   *  that overrides the sheet-wide target for the given icons (0.5–100
   *  canvas px, one decimal; null clears the exception so the cells follow
   *  the sheet target again). Preserved while uniform stroke is OFF — the
   *  same semantics the sheet-wide target has. Undoable, pruned like the
   *  other cell overrides. */
  setCellStrokeTarget: (sheetId: string, iconIds: string[], targetPx: number | null) => void;
  /** Per-cell WEIGHT exception (round 12): a per-icon relative stroke
   *  adjustment that overrides the sheet-wide weight for the given icons
   *  (integer −100…+100 canvas px; 0 pins an icon to its exact native
   *  weight; null clears the exception so the cells follow the sheet
   *  weight again). Consulted only while uniform stroke is OFF — the
   *  mirrored semantics of setCellStrokeTarget. Undoable, pruned like the
   *  other cell overrides. */
  setCellStrokeWeight: (sheetId: string, iconIds: string[], weightPx: number | null) => void;
  /** Sheet-wide cleanup (round 9, extended round 12): remove EVERY stroke
   *  exception on one sheet — uniform targets AND relative weights — in a
   *  single undoable step (all cells follow the sheet-wide stroke controls
   *  again). Returns the number of icons whose exceptions were cleared. */
  resetSheetCellStrokes: (sheetId: string) => number;
  /** Sheet-wide cleanup (round 12): remove EVERY custom cell fill override
   *  (solid + gradient) on one sheet in a single undoable step. Skips are
   *  untouched. Returns the number of cells that carried a custom fill. */
  resetSheetCellFills: (sheetId: string) => number;
  randomizeSheet: (sheetId: string) => void;
  moveSheet: (sheetId: string, direction: -1 | 1) => void;
  /** Drag-and-drop reorder: move a sheet to an absolute index. */
  reorderSheet: (sheetId: string, toIndex: number) => void;
  /** Reorder icons WITHIN one sheet's grid (drag a cell onto another cell,
   *  or Alt+Arrow nudge). One undoable history entry. */
  reorderSheetIcons: (sheetId: string, fromIndex: number, toIndex: number) => void;
  /** Insert library icons at a precise grid position (library drag dropped
   *  onto a specific cell). Returns the number actually inserted; callers
   *  fall back to the append/overflow flow when it returns 0. */
  insertIconsAt: (iconIds: string[], targetSheetId: string, index: number) => number;
  /** New sheet right after the source with the same design/template/category (empty icons). */
  duplicateSheet: (sheetId: string) => void;

  /* ------- structure ------- */
  moveIcons: (iconIds: string[], targetSheetId: string, createOverflowSheet: boolean) => { moved: string[]; overflow: string[] };
  /** "New sheet from selection" — creates fresh sheet(s) (chunked by capacity)
   *  and moves the icons there, pulling them out of any current sheet. */
  moveIconsToNewSheet: (iconIds: string[], templateId?: string) => number;
  changeSheetTemplate: (sheetId: string, templateId: string, strategy: "move-next" | "create-new") => void;
  applyDesignToSheets: (targetSheetIds: string[], sourceSheetId: string) => void;

  /* ------- settings ------- */
  setViewMode: (mode: WorkspaceSettings["viewMode"]) => void;
  toggleGridGuides: () => void;
  setZoom: (zoom: number) => void;
  /** Persist last-used export dialog settings (scope/format/scale/transparent). */
  setExportPrefs: (prefs: Partial<NonNullable<WorkspaceSettings["export"]>>) => void;

  /* ------- UI navigation (round 7: command palette coordination) -------
   * Pure view state — never persisted, never in history snapshots. */
  /** Active left-sidebar tab. Controlled here so any surface (command
   *  palette, import report…) can switch it programmatically. */
  sidebarTab: "sheets" | "library";
  setSidebarTab: (tab: "sheets" | "library") => void;
  /** Icon inspector dialog (shell-mounted so any surface — palette,
   *  library tiles — can open it regardless of which tab is mounted). */
  inspectorIconId: string | null;
  openInspector: (iconId: string) => void;
  closeInspector: () => void;
  /** Edit-view cell selection (round 10, extended to multi in round 11).
   *  Lifted from SheetPreview's local useState into the store so the footer
   *  context strip can surface a "N cells selected" indicator and so the
   *  selection survives canvas re-renders. Tracks BOTH the iconIds and the
   *  sheetId they belong to, so switching sheets clears the selection
   *  automatically. Multi-cell: plain click replaces; ctrl/cmd-click
   *  toggles one; shift-click extends a range from the last anchor. Not
   *  persisted (pure view state, like inspectorIconId). */
  selectedCellIconIds: string[];
  selectedCellSheetId: string | null;
  /** the icon the last plain/ctrl click landed on — used as the shift-click
   *  range anchor. null when the selection is empty. */
  selectedCellAnchorIconId: string | null;
  setSelectedCell: (sheetId: string, iconId: string | null) => void;
  toggleCellInSelection: (sheetId: string, iconId: string) => void;
  rangeSelectCells: (sheetId: string, toIconId: string) => void;
  clearSelectedCell: () => void;
  /** Cell-color popover coordination (round 12): the command palette can
   *  request the floating bar's cell-color popover for the CURRENT cell
   *  selection. Pure view state — the flag is cleared whenever the selection
   *  empties, the sheet switches, or the canvas leaves Edit view, so the
   *  popover can never re-open on a stale selection later. */
  cellColorPickerOpen: boolean;
  openCellColorPicker: () => void;
  closeCellColorPicker: () => void;
  /** Library panel filter state — lifted into the store (round 7) so the
   *  command palette can drive it AND so it survives the library tab
   *  unmounting (Radix Tabs unmounts inactive content). Not persisted. */
  libraryFilter: { query: string; tags: string[]; tagLogic: LibraryTagLogic; mode: "all" | "unassigned"; sort: LibrarySortMode };
  setLibraryFilter: (patch: Partial<StudioState["libraryFilter"]>) => void;
  /** Library tile density (persisted in settings; hydrates as "standard"). */
  setLibraryDensity: (density: LibraryDensity) => void;
  /** Which library-level dialog is open (tag manager / catalog export /
   * health report) — all are portaled dialogs mounted at the shell, so any
   * surface can open them. Not persisted. */
  libraryDialog: "tag-manager" | "catalog" | "health" | null;
  openLibraryDialog: (dialog: "tag-manager" | "catalog" | "health") => void;
  setLibraryDialog: (dialog: "tag-manager" | "catalog" | "health" | null) => void;
  /** Palette shorthand: filter the library by one tag. */
  focusTag: (tag: string) => void;

  /* ------- history ------- */
  undo: () => void;
  redo: () => void;
}

/* ------------------------------------------------------------------ */
/* Autosave plumbing                                                   */
/* ------------------------------------------------------------------ */

let autosaver: Autosaver | null = null;
let pendingNewIcons: IconEntry[] = [];
let pendingDeletedSheetIds: string[] = [];
let pendingDeletedIconIds: string[] = [];
let saveListener: ((status: SaveStatus) => void) | null = null;

function getAutosaver(): Autosaver {
  if (!autosaver) {
    autosaver = new Autosaver((status) => saveListener?.(status));
  }
  return autosaver;
}

/** Wire the store's saveStatus to autosave events (called once from page). */
export function attachSaveListener(listener: (status: SaveStatus) => void) {
  saveListener = listener;
}

function scheduleSave(state: StudioState) {
  getAutosaver().schedule({
    sheets: state.sheets,
    deletedSheetIds: pendingDeletedSheetIds,
    icons: pendingNewIcons,
    deletedIconIds: pendingDeletedIconIds,
    meta: {
      activeSheetId: state.activeSheetId,
      iconOrder: state.iconOrder,
      sheetOrder: state.sheets.map((s) => s.id),
      categoryVolumes: state.categoryVolumes,
      settings: state.settings,
    },
  });
  pendingNewIcons = [];
  pendingDeletedSheetIds = [];
  pendingDeletedIconIds = [];
}

function stampSheet(sheet: Sheet): Sheet {
  return { ...sheet, updatedAt: Date.now() };
}

/** Auto-remove GENERATED sheets that became empty because their icons were
 *  removed / deleted / moved away. Manually created sheets (duplicates —
 *  the only sheets that start empty on purpose) are never pruned. Queues
 *  the removed sheets' IndexedDB rows for deletion, fixes the active /
 *  selected sheet ids, and returns the adjusted state pieces. */
function pruneEmptyGenerated(
  sheets: Sheet[],
  touchedIds: string[],
  prevActiveSheetId: string | null,
  prevSelectedSheetIds: string[]
): { sheets: Sheet[]; activeSheetId: string | null; selectedSheetIds: string[]; removed: Sheet[] } {
  const touched = new Set(touchedIds);
  const doomedIds = new Set(
    sheets
      .filter((sh) => touched.has(sh.id) && sh.generated === true && sh.iconIds.length === 0)
      .map((sh) => sh.id)
  );
  if (doomedIds.size === 0) {
    return { sheets, activeSheetId: prevActiveSheetId, selectedSheetIds: prevSelectedSheetIds, removed: [] };
  }
  for (const id of doomedIds) pendingDeletedSheetIds.push(id);
  const next = sheets.filter((sh) => !doomedIds.has(sh.id));
  let activeSheetId = prevActiveSheetId;
  if (activeSheetId != null && doomedIds.has(activeSheetId)) {
    const idx = sheets.findIndex((sh) => sh.id === activeSheetId);
    activeSheetId = next[Math.min(idx, next.length - 1)]?.id ?? null;
  }
  const selectedSheetIds = prevSelectedSheetIds.filter((id) => !doomedIds.has(id));
  return {
    sheets: next,
    activeSheetId,
    selectedSheetIds,
    removed: sheets.filter((sh) => doomedIds.has(sh.id)),
  };
}

function announcePrunedSheets(removed: Sheet[]): void {
  if (removed.length === 0) return;
  toast.info(
    `Removed ${removed.length} empty generated sheet${removed.length > 1 ? "s" : ""}`,
    {
      description: "Generated sheets disappear once all their icons are gone. Ctrl ⇧ Z / Ctrl Z restores them.",
    }
  );
}

/** Next VOL number for a category. The remembered categoryVolumes counter
 * can go stale (e.g. a category renamed without auto-volume never registers
 * in the map), so also honour the volumes of the LIVE sheets in that
 * category — a new sheet must never duplicate an existing sheet's VOL. */
function nextVolumeFor(
  sheets: readonly Sheet[],
  categoryVolumes: Record<string, number>,
  category: string,
): number {
  let max = categoryVolumes[category] ?? 0;
  for (const sh of sheets) {
    if (sh.category === category && sh.volume > max) max = sh.volume;
  }
  return max + 1;
}

/** Human-readable preset apply result for toasts. */
function presetApplyDescription(report: {
  applied: string[];
  skipped: string[];
  rescaled: boolean;
}): string {
  const parts: string[] = [];
  if (report.applied.length) {
    parts.push(`Applied: ${report.applied.join(", ")}.`);
  }
  if (report.skipped.length) {
    parts.push(`Skipped on this template: ${report.skipped.join("; ")}.`);
  }
  if (report.rescaled) {
    parts.push("Values rescaled to this canvas size.");
  }
  if (!parts.length) parts.push("Nothing in this preset applies to this template.");
  return parts.join(" ");
}

/** Turn internal history labels ("design:card.color") into readable words. */
function humanizeLabel(label: string): string {
  const cleaned = label
    .replace(/^(design|geometry|typography|sheet|icons):/i, "")
    .replace(/^preset:/i, "Preset ")
    .replace(/[:.-]/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "change";
  // title-case each word for toast readability
  return cleaned
    .split(" ")
    .map((w) => (w.charAt(0) === ":" ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}

/* ------------------------------------------------------------------ */
/* Store implementation                                                */
/* ------------------------------------------------------------------ */

export const useStudio = create<StudioState>((set, get) => {
  /** Push current sheet-structure state onto the undo stack (coalesced).
   *  opts.includeIcons also snapshots the library; opts.deletedIconIds
   *  records the action's explicit library delta (delete-icons);
   *  opts.tagOp marks tag-mutating entries whose undo/redo restore the
   *  snapshot's icon entries exactly (reverting the tag edit itself). */
  function pushHistory(label: string, opts?: { includeIcons?: boolean; deletedIconIds?: string[]; tagOp?: boolean }) {
    const s = get();
    const top = s.past[s.past.length - 1];
    if (top && top.label === label && Date.now() - top.time < COALESCE_MS) return;
    const state = snapshotOf(s, opts?.includeIcons === true);
    if (opts?.deletedIconIds?.length) state.deletedIconIds = opts.deletedIconIds;
    if (opts?.tagOp) state.tagOp = true;
    const past = [...s.past, { label, time: Date.now(), state }];
    if (past.length > HISTORY_LIMIT) past.shift();
    set({ past, future: [] });
  }

  function mapSheet(sheetId: string, fn: (sheet: Sheet) => Sheet): Sheet[] {
    return get().sheets.map((sh) => (sh.id === sheetId ? stampSheet(fn(sh)) : sh));
  }

  /** Per-cell override editing: apply `fn` to each target icon's current
   *  override, drop entries that became empty, and prune any entry for an
   *  icon that is no longer on the sheet (moved away / deleted earlier). */
  function patchCellOverrides(
    sheet: Sheet,
    iconIds: string[],
    fn: (cur: CellOverride) => CellOverride
  ): Record<string, CellOverride> {
    const overrides: Record<string, CellOverride> = { ...sheet.cellOverrides };
    for (const id of iconIds) overrides[id] = fn(overrides[id] ?? {});
    const inSheet = new Set(sheet.iconIds);
    for (const key of Object.keys(overrides)) {
      if (!inSheet.has(key) || isEmptyCellOverride(overrides[key])) delete overrides[key];
    }
    return overrides;
  }

  function isEmptyCellOverride(o: CellOverride): boolean {
    /* round 12: a gradient override keeps the entry alive exactly like a
     *  solid color one (so pruned/cleanup logic treats both fills alike);
     *  round 9/12: stroke exceptions (target + weight) do the same */
    const hasColor = o.cardColor != null && o.cardColor.trim() !== "";
    const hasGradient = o.cardGradient != null;
    const hasStroke =
      (o.strokeTargetPx != null && Number.isFinite(o.strokeTargetPx)) ||
      (o.strokeWeightPx != null && Number.isFinite(o.strokeWeightPx));
    return o.skip !== true && !hasColor && !hasGradient && !hasStroke;
  }

  return {
    icons: {},
    iconOrder: [],
    sheets: [],
    activeSheetId: null,
    selectedSheetIds: [],
    categoryVolumes: {},
    settings: { viewMode: "overview", showGridGuides: false, zoom: 0 },

    hydrated: false,
    saveStatus: "idle",
    lastImportReport: null,
    importHistory: [],
    strokeAudit: false,
    strokeAuditUnit: "root",
    /* pending "Duplicate Icons Detected" question (not persisted) */
    duplicateAsk: null,
    past: [],
    future: [],

    /* imported templates */
    customTemplates: [],
    templateLoadErrors: [],
    /* user-saved design presets (v3) */
    designPresets: [],
    templateImportOpen: false,
    /* workspace backup dialog (round 3; not persisted) */
    backupDialogOpen: false,
    /* stroke report dialog (round 8; not persisted) */
    strokeReportOpen: false,
    /* round 22 · sheet-scoped report (null = follow the active sheet) */
    strokeReportSheetId: null,
    /* similarity report dialog (round 10; not persisted) */
    similarityDialogOpen: false,
    /* UI navigation (not persisted) */
    sidebarTab: "sheets",
    libraryFilter: { query: "", tags: [], tagLogic: "or", mode: "all", sort: "manual" },
    libraryDialog: null,
    inspectorIconId: null,
    /* edit-view cell selection (round 10/11; not persisted) */
    selectedCellIconIds: [],
    selectedCellSheetId: null,
    selectedCellAnchorIconId: null,
    cellColorPickerOpen: false,

    /* ---------------- lifecycle ---------------- */

    hydrate: async () => {
      if (get().hydrated) return;
      try {
        const [icons, sheets, meta, rawCustomTemplates, designPresets] = await Promise.all([
          loadIcons(),
          loadSheets(),
          loadMeta(),
          loadCustomTemplates(),
          loadDesignPresets(),
        ]);
        /* legacy custom-template records (saved before universal editing)
         * gain role annotations in memory — slots/cells/background are
         * matched from the STORED user-confirmed geometry, texts stay
         * unmapped so legacy sheets render byte-identically. Enriched
         * records are persisted back so the next hydrate is a pure load. */
        const enriched = enrichCustomTemplateRecords(rawCustomTemplates);
        /* phase 3 — structural quarantine: a corrupt record can never enter
         * the registry (one bad row must not prevent the app from loading).
         * Broken rows stay in IndexedDB and surface in the Template Library
         * with an explicit Remove action — never silent loss. */
        const templateLoadErrors: TemplateLoadError[] = [];
        const validRecords: CustomTemplateRecord[] = [];
        for (const record of enriched.records) {
          const check = validateCustomTemplateRecord(record);
          if (check.ok) {
            validRecords.push(record);
          } else {
            templateLoadErrors.push({
              id: record.id,
              name: typeof record.name === "string" && record.name.trim() ? record.name : "Unnamed template",
              reason: check.reason ?? "The template data is corrupt.",
            });
            console.warn(`[studio] custom template "${String(record.name)}" quarantined: ${check.reason}`);
          }
        }
        const customTemplates = validRecords;
        for (const record of enriched.changed) void putCustomTemplate(record);
        /* inject imported templates into the shared registry BEFORE any
         * getTemplate call below (migration, capacity math) so they resolve
         * for every consumer from the very first render */
        setCustomTemplateRegistry(customTemplates);
        const iconMap: Record<string, IconEntry> = {};
        for (const ic of icons) iconMap[ic.id] = ic;
        const order = meta?.iconOrder?.filter((id) => iconMap[id]) ?? icons.map((i) => i.id);
        // restore user's sheet order; sheetOrder is the authoritative LIVE SET —
        // records left in IDB by an undone create (orphaned) are excluded.
        let orderedSheets = sheets;
        if (meta?.sheetOrder) {
          const orderSet = new Set(meta.sheetOrder);
          const pos = new Map(meta.sheetOrder.map((id, i) => [id, i]));
          orderedSheets = sheets
            .filter((s) => orderSet.has(s.id))
            .sort((a, b) => (pos.get(a.id) ?? 1e12 + a.createdAt) - (pos.get(b.id) ?? 1e12 + b.createdAt));
        }
        /* phase 3 — snapshot backfill (§ migration): every custom-template
         * sheet gains an immutable templateSnapshot pinned to the CURRENT
         * record version, so subsequent library edits/deletions can never
         * retroactively change or break it. In-memory only; persisted by
         * the next regular save. Runs BEFORE the design migrations so they
         * resolve the sheet's pinned template (identical today — correct
         * by construction once versions diverge). */
        const recordById = new Map(customTemplates.map((r) => [r.id, r]));
        orderedSheets = orderedSheets.map((s) => {
          if (s.templateSnapshot) return s;
          const rec = recordById.get(s.templateId);
          if (!rec) return s;
          return { ...s, templateSnapshot: buildSheetSnapshot(rec) };
        });
        /* Default-template migration (user sheets): designs persisted before
         * the user's 8 default templates shipped have no `rail` - they belong
         * to the old warm-paper design language. Re-stamp them with the owning
         * template's defaults so every sheet opens in the user's design.
         * One-time: migrated designs carry rail + gradient, so this never re-fires. */
        orderedSheets = orderedSheets.map((s) => {
          const tpl = sheetTemplate(s);
          if (tpl?.rail && !s.design.rail) {
            return { ...s, design: structuredClone(tpl.defaults) };
          }
          /* Custom-template migration (universal editing, v3): designs saved
           * before this system carry placeholder values for fields that were
           * previously INERT on custom sheets (card paint, typography,
           * background…). Those fields are now live, so they are re-stamped
           * from the owning template's DETECTED defaults (= the template's own
           * paint/typography ⇒ rendering is a visual no-op). The fields that
           * DID render before — icon appearance, spacing.iconScale, hero
           * scale/offsets — are preserved exactly. One-time: the marker
           * customDesignV2 prevents a re-fire. */
          if (tpl?.sourceType === "custom" && !s.design.customDesignV2) {
            const fresh = structuredClone(tpl.defaults);
            return {
              ...s,
              design: {
                ...fresh,
                icon: s.design.icon,
                spacing: {
                  ...fresh.spacing,
                  iconScale: s.design.spacing.iconScale ?? fresh.spacing.iconScale,
                },
                hero: {
                  ...fresh.hero,
                  iconScale: s.design.hero.iconScale,
                  offsetX: s.design.hero.offsetX,
                  offsetY: s.design.hero.offsetY,
                },
                customDesignV2: true,
              },
            };
          }
          return s;
        });
        /* Legacy sheets predate the `generated` marker. A sheet holding
         * icons was necessarily produced by a generator flow → prunable
         * when emptied. Empty legacy sheets are treated as manually
         * created (duplicates start empty on purpose) and are never
         * auto-removed. Backfill is in-memory only. */
        orderedSheets = orderedSheets.map((s) =>
          s.generated === undefined ? { ...s, generated: s.iconIds.length > 0 } : s
        );
        /* Manual-volume backfill: sheets saved before the feature carry no
         * volumeManual/volumeAuto markers — nothing could be manual back
         * then, so the current volume IS the automatic one. Sanitizes the
         * number itself (garbage persisted values can never corrupt a
         * sheet). In-memory only; persisted on the next save. */
        orderedSheets = orderedSheets.map((s) => {
          const volume = normalizeVolume(s.volume);
          if (s.volumeManual === true) {
            return { ...s, volume, volumeManual: true, volumeAuto: normalizeVolume(s.volumeAuto ?? volume) };
          }
          return { ...s, volume, volumeManual: false, volumeAuto: volume };
        });
        set({
          icons: iconMap,
          iconOrder: order,
          sheets: orderedSheets,
          activeSheetId: meta?.activeSheetId && orderedSheets.some((s) => s.id === meta.activeSheetId) ? meta.activeSheetId : orderedSheets[0]?.id ?? null,
          selectedSheetIds: [],
          categoryVolumes: meta?.categoryVolumes ?? {},
          settings: meta?.settings ?? { viewMode: "overview", showGridGuides: false, zoom: 0 },
          /* round 22: the stroke audit armed/unit hydrate from the persisted
           * settings (absent fields keep the false/"root" defaults, so older
           * workspaces migrate without any rewrite) */
          strokeAudit: meta?.settings?.strokeAudit ?? false,
          strokeAuditUnit: meta?.settings?.strokeAuditUnit ?? "root",
          customTemplates,
          templateLoadErrors,
          designPresets,
          hydrated: true,
        });
      } catch (err) {
        console.error("[studio] hydrate failed", err);
        set({ hydrated: true });
      }
    },

    /* ---------------- workspace backup / restore ---------------- */

    setBackupDialogOpen: (open) => set({ backupDialogOpen: open }),
    openBackupDialog: () => set({ backupDialogOpen: true }),

    /* ---------------- stroke report dialog (round 8) ---------------- */

    setStrokeReportOpen: (open) => set({ strokeReportOpen: open }),
    /* round 22 · every fresh open starts on the ACTIVE sheet; the dialog's
     * switcher pills set the scope while it stays open */
    openStrokeReport: () => set({ strokeReportOpen: true, strokeReportSheetId: null }),
    closeStrokeReport: () => set({ strokeReportOpen: false }),
    setStrokeReportSheet: (sheetId) => set({ strokeReportSheetId: sheetId }),
    openStrokeReportFor: (sheetId) => set({ strokeReportOpen: true, strokeReportSheetId: sheetId }),

    /* ---------------- similarity report dialog (round 10) ---------------- */

    setSimilarityDialogOpen: (open) => set({ similarityDialogOpen: open }),
    openSimilarityDialog: () => set({ similarityDialogOpen: true }),
    closeSimilarityDialog: () => set({ similarityDialogOpen: false }),

    buildBackupJson: () => {
      const s = get();
      return serializeBackup(
        buildWorkspaceBackup({
          icons: s.icons,
          iconOrder: s.iconOrder,
          sheets: s.sheets,
          activeSheetId: s.activeSheetId,
          categoryVolumes: s.categoryVolumes,
          settings: s.settings,
          customTemplates: s.customTemplates,
          designPresets: s.designPresets,
        })
      );
    },

    restoreWorkspace: async (json) => {
      let parsed: ReturnType<typeof parseWorkspaceBackup>;
      try {
        parsed = parseWorkspaceBackup(json);
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : "Could not read this backup.", warnings: [] };
      }
      const { backup, warnings } = parsed;
      if (backup.icons.length === 0 && backup.sheets.length === 0) {
        return { ok: false, error: "This backup contains no icons and no sheets — nothing to restore.", warnings };
      }
      try {
        /* flush any in-flight autosave so nothing overwrites the restore */
        await getAutosaver().flush();
        /* wipe + rewrite IndexedDB from the backup document */
        await clearAll();
        if (backup.icons.length) await putIcons(backup.icons);
        if (backup.sheets.length) await putSheets(backup.sheets);
        for (const t of backup.customTemplates) await putCustomTemplate(t);
        for (const p of backup.designPresets) await putDesignPreset(p);
        setCustomTemplateRegistry(backup.customTemplates);
        await putMeta({
          activeSheetId: backup.activeSheetId,
          iconOrder: backup.iconOrder,
          sheetOrder: backup.sheetOrder,
          categoryVolumes: backup.categoryVolumes,
          settings: backup.settings,
        });
        /* in-memory state follows the persisted state — fresh start:
         * no history, no selections, no open dialogs */
        pendingNewIcons = [];
        pendingDeletedSheetIds = [];
        pendingDeletedIconIds = [];
        const iconMap: Record<string, IconEntry> = {};
        for (const ic of backup.icons) iconMap[ic.id] = ic;
        /* phase 3 — snapshot backfill on restore: sheets from older backups
         * (or hand-edited ones) gain a snapshot pinned to the restored
         * record's current version, exactly like hydrate. */
        const restoredRecordById = new Map(backup.customTemplates.map((r) => [r.id, r]));
        const restoredSheets = backup.sheets.map((sh) => {
          if (sh.templateSnapshot) return sh;
          const rec = restoredRecordById.get(sh.templateId);
          if (!rec) return sh;
          return { ...sh, templateSnapshot: buildSheetSnapshot(rec) };
        });
        if (restoredSheets.some((sh, i) => sh !== backup.sheets[i])) {
          await putSheets(restoredSheets);
        }
        set({
          icons: iconMap,
          iconOrder: backup.iconOrder.filter((id) => iconMap[id]),
          sheets: restoredSheets,
          activeSheetId: backup.activeSheetId,
          selectedSheetIds: [],
          categoryVolumes: backup.categoryVolumes,
          settings: backup.settings,
          /* round 22: audit follows the restored workspace's settings */
          strokeAudit: backup.settings?.strokeAudit ?? false,
          strokeAuditUnit: backup.settings?.strokeAuditUnit ?? "root",
          customTemplates: backup.customTemplates,
          templateLoadErrors: [],
          designPresets: backup.designPresets,
          past: [],
          future: [],
          lastImportReport: null,
          importHistory: [],
          duplicateAsk: null,
          sidebarTab: "sheets",
          libraryFilter: { query: "", tags: [], tagLogic: "or", mode: "all", sort: "manual" },
          libraryDialog: null,
          inspectorIconId: null,
          templateImportOpen: false,
          backupDialogOpen: false,
          strokeReportOpen: false,
          strokeReportSheetId: null,
          similarityDialogOpen: false,
          selectedCellIconIds: [],
          selectedCellSheetId: null,
          selectedCellAnchorIconId: null,
          cellColorPickerOpen: false,
        });
        return { ok: true, warnings };
      } catch (err) {
        console.error("[studio] restore failed", err);
        return { ok: false, error: "Restoring failed while writing to the browser database. Your previous workspace may be partially intact — re-import the backup or download it again.", warnings };
      }
    },

    /* ---------------- imported templates ---------------- */

    importCustomTemplate: (partial, opts) => {
      const record: CustomTemplateRecord = {
        ...structuredClone(partial),
        id: nextId("tpl"),
        createdAt: Date.now(),
      };
      const customTemplates = [...get().customTemplates, record];
      setCustomTemplateRegistry(customTemplates);
      set({ customTemplates, templateImportOpen: false });
      void putCustomTemplate(record);
      if (!opts?.silent) {
        toast.success(`Template “${record.name}” imported — ${record.capacity} slots ready`);
      }
      return record;
    },

    updateCustomTemplateRecord: (record) => {
      const s = get();
      const existing = s.customTemplates.find((t) => t.id === record.id);
      if (!existing) return false;
      /* phase 3 — the update bumps the record's revision. Using sheets are
       * deliberately NOT touched: they stay pinned to the snapshot version
       * they were created with (no retroactive restyling — §48) and can
       * move forward explicitly via updateSheetTemplateToLatest. */
      const version = customRecordVersion(existing) + 1;
      const next: CustomTemplateRecord = { ...record, version };
      const customTemplates = s.customTemplates.map((t) => (t.id === record.id ? next : t));
      setCustomTemplateRegistry(customTemplates);
      set({ customTemplates });
      void putCustomTemplate(next);
      return true;
    },

    renameCustomTemplate: (id, name) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      const s = get();
      const customTemplates = s.customTemplates.map((t) => {
        if (t.id !== id) return t;
        const next = { ...t, name: trimmed };
        /* keep an embedded builder draft's name in sync so re-publishing
         * from the builder cannot resurrect the old name */
        if (next.builderDoc) next.builderDoc = { ...next.builderDoc, name: trimmed };
        return next;
      });
      setCustomTemplateRegistry(customTemplates);
      set({ customTemplates });
      const record = customTemplates.find((t) => t.id === id);
      if (record) void putCustomTemplate(record);
    },

    deleteCustomTemplate: (id) => {
      const s = get();
      const inUse = s.sheets.filter((sh) => sh.templateId === id);
      /* phase 3 — deleting a template in use is ALLOWED: every using sheet
       * carries an immutable templateSnapshot and keeps rendering exactly
       * as before (§17/§18). Sheets without a snapshot (pre-phase-3 data
       * that never hydrated the backfill) keep rendering only if the record
       * is still resolvable — otherwise they are flagged for the user. */
      const unprotected = inUse.filter((sh) => !sh.templateSnapshot);
      const customTemplates = s.customTemplates.filter((t) => t.id !== id);
      setCustomTemplateRegistry(customTemplates);
      set({ customTemplates });
      void deleteCustomTemplateRow(id);
      if (inUse.length > 0) {
        toast.success("Template deleted", {
          description:
            unprotected.length > 0
              ? `${inUse.length} sheet${inUse.length === 1 ? "" : "s"} keep their layout — ${unprotected.length} could not be pinned to a snapshot and should be switched to another template.`
              : `${inUse.length} sheet${inUse.length === 1 ? "" : "s"} keep their layout via the embedded template snapshot.`,
        });
      } else {
        toast.success("Template deleted");
      }
      return true;
    },

    duplicateCustomTemplate: (id) => {
      const s = get();
      const source = s.customTemplates.find((t) => t.id === id);
      if (!source) return null;
      /* de-duplicate the copy's name ("Wide Grid", "Wide Grid 2", …) */
      let name = `${source.name} copy`;
      let n = 2;
      while (s.customTemplates.some((t) => t.name === name)) name = `${source.name} copy ${n++}`;
      const record: CustomTemplateRecord = {
        ...structuredClone(source),
        id: nextId("tpl"),
        name,
        createdAt: Date.now(),
        /* a duplicate is a brand-new template: revision restarts at 1,
         * entirely independent of the source's version history */
        version: 1,
      };
      /* a duplicated BUILDER template must be fully independent: its
       * embedded authoring document gets a fresh doc id (and the copy's
       * name) so editing the duplicate never touches the original draft */
      if (record.builderDoc) {
        record.builderDoc = { ...structuredClone(record.builderDoc), id: nextId("doc"), name };
      }
      const customTemplates = [...s.customTemplates, record];
      setCustomTemplateRegistry(customTemplates);
      set({ customTemplates });
      void putCustomTemplate(record);
      toast.success(`Duplicated as “${record.name}”`);
      return record;
    },

    openTemplateImport: () => set({ templateImportOpen: true }),
    closeTemplateImport: () => set({ templateImportOpen: false }),

    removeBrokenTemplateRecord: (id) => {
      const s = get();
      if (!s.templateLoadErrors.some((e) => e.id === id)) return;
      set({ templateLoadErrors: s.templateLoadErrors.filter((e) => e.id !== id) });
      /* the quarantined row was never in the registry — removing it only
       * clears the IDB row (and any draft that still points at it simply
       * re-publishes as a fresh record) */
      void deleteCustomTemplateRow(id);
    },

    stampSheetSnapshot: (sheetId) => {
      const s = get();
      const sheet = s.sheets.find((sh) => sh.id === sheetId);
      if (!sheet) return;
      const record = s.customTemplates.find((r) => r.id === sheet.templateId);
      if (!record) return;
      const snapshot = buildSheetSnapshot(record);
      if (sheet.templateSnapshot?.version === snapshot.version) return;
      const sheets = s.sheets.map((sh) =>
        sh.id === sheetId ? stampSheet({ ...sh, templateSnapshot: snapshot }) : sh
      );
      set({ sheets });
      scheduleSave(get());
    },

    updateSheetTemplateToLatest: (sheetId, overflowStrategy) => {
      const s = get();
      const sheet = s.sheets.find((sh) => sh.id === sheetId);
      if (!sheet) return { ok: false, reason: "not-found" as const };
      const record = s.customTemplates.find((r) => r.id === sheet.templateId);
      if (!record) return { ok: false, reason: "deleted" as const };
      const live = getTemplate(record.id);
      const liveVersion = customRecordVersion(record);
      const pinned = sheet.templateSnapshot?.version ?? 0;
      if (!live || liveVersion <= pinned) return { ok: false, reason: "current" as const };

      pushHistory("update-template");
      /* design restarts from the latest version's defaults with the
       * canvas-independent fields carried over — the same semantics as
       * switching TO a custom template (changeSheetTemplate): typography/
       * card/background values are canvas-absolute and were authored for
       * the previous revision. Icon appearance, hero scale/offsets and
       * icon-color edits survive. */
      const design = {
        ...structuredClone(live.defaults),
        icon: sheet.design.icon,
        hero: {
          ...structuredClone(live.defaults.hero),
          iconScale: sheet.design.hero.iconScale,
          offsetX: sheet.design.hero.offsetX,
          offsetY: sheet.design.hero.offsetY,
          ...(sheet.design.hero.iconColor != null ? { iconColor: sheet.design.hero.iconColor } : {}),
        },
        spacing: {
          ...structuredClone(live.defaults.spacing),
          iconScale: sheet.design.spacing.iconScale ?? live.defaults.spacing.iconScale,
        },
      };

      const keep = sheet.iconIds.slice(0, live.capacity);
      const extras = sheet.iconIds.slice(live.capacity);
      const snapshot = buildSheetSnapshot(record);
      let sheets = s.sheets.map((sh) =>
        sh.id === sheetId
          ? stampSheet({
              ...sh,
              templateSnapshot: snapshot,
              iconIds: keep,
              heroIconId: sh.heroIconId && keep.includes(sh.heroIconId) ? sh.heroIconId : keep[0] ?? null,
              design,
            })
          : sh
      );

      if (extras.length === 0) {
        set({ sheets });
        scheduleSave(get());
        return { ok: true, overflow: 0 };
      }

      if (overflowStrategy === "create-new") {
        const vol = nextVolumeFor(s.sheets, s.categoryVolumes, sheet.category);
        const idx = sheets.findIndex((sh) => sh.id === sheetId);
        const overflowSheet: Sheet = stampSheet({
          id: nextId("sh"),
          /* the overflow sheet follows the SAME latest template — with its
           * own snapshot of the same version */
          templateId: record.id,
          templateSnapshot: structuredClone(snapshot),
          iconIds: extras,
          heroIconId: extras[0] ?? null,
          category: sheet.category,
          volume: vol,
          volumeAuto: vol,
          volumeManual: false,
          design: structuredClone(design),
          createdAt: Date.now(),
          updatedAt: Date.now(),
          generated: true,
        });
        sheets = [...sheets.slice(0, idx + 1), overflowSheet, ...sheets.slice(idx + 1)];
        set({ sheets, categoryVolumes: { ...s.categoryVolumes, [sheet.category]: vol } });
        scheduleSave(get());
        return { ok: true, overflow: extras.length };
      }

      /* move-next: spill into later sheets with free capacity (same
       * strategy family as changeSheetTemplate) */
      let remaining = [...extras];
      let mutated = [...sheets];
      for (let i = 0; i < mutated.length && remaining.length; i++) {
        const cand = mutated[i];
        if (cand.id === sheetId) continue;
        if (cand.category !== sheet.category && cand.iconIds.length) continue;
        const cap = sheetTemplate(cand)?.capacity ?? cand.iconIds.length;
        const free = cap - cand.iconIds.length;
        if (free <= 0) continue;
        const fitting = remaining.slice(0, free);
        remaining = remaining.slice(fitting.length);
        mutated = mutated.map((sh) =>
          sh.id === cand.id ? stampSheet({ ...sh, iconIds: [...sh.iconIds, ...fitting] }) : sh
        );
      }
      if (remaining.length) {
        const vol = nextVolumeFor(s.sheets, s.categoryVolumes, sheet.category);
        mutated.push(
          stampSheet({
            id: nextId("sh"),
            templateId: record.id,
            templateSnapshot: structuredClone(snapshot),
            iconIds: remaining,
            heroIconId: remaining[0] ?? null,
            category: sheet.category,
            volume: vol,
            volumeAuto: vol,
            volumeManual: false,
            design: structuredClone(design),
            createdAt: Date.now(),
            updatedAt: Date.now(),
            generated: true,
          })
        );
        set({ sheets: mutated, categoryVolumes: { ...s.categoryVolumes, [sheet.category]: vol } });
      } else {
        set({ sheets: mutated });
      }
      scheduleSave(get());
      return { ok: true, overflow: extras.length };
    },

    /* ---------------- user-saved design presets ---------------- */

    saveDesignPreset: (sourceSheetId, name, includes) => {
      const s = get();
      const sheet = s.sheets.find((sh) => sh.id === sourceSheetId);
      if (!sheet) return null;
      const template = sheetTemplate(sheet);
      if (!template) return null;
      const trimmed = name.trim();
      if (!trimmed) return null;
      /* de-duplicate the name ("Poster Look", "Poster Look 2", …) */
      let unique = trimmed;
      let n = 2;
      while (s.designPresets.some((p) => p.name === unique)) unique = `${trimmed} ${n++}`;
      const preset = captureUserPreset(sheet, template, unique, includes);
      const designPresets = [...s.designPresets, preset];
      set({ designPresets });
      void putDesignPreset(preset);
      const groups = Object.entries(includes)
        .filter(([, on]) => on)
        .map(([k]) => k)
        .join(", ");
      toast.success(`Preset “${preset.name}” saved`, {
        description: groups
          ? `Includes ${groups}. Apply it to this or any other sheet — icons, category and volume are never touched.`
          : "Apply it to this or any other sheet — icons, category and volume are never touched.",
      });
      return preset;
    },

    renameDesignPreset: (id, name) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      const s = get();
      const designPresets = s.designPresets.map((p) =>
        p.id === id ? { ...p, name: trimmed, updatedAt: Date.now() } : p
      );
      if (designPresets.every((p, i) => p === s.designPresets[i])) return;
      set({ designPresets });
      const preset = designPresets.find((p) => p.id === id);
      if (preset) void putDesignPreset(preset);
    },

    deleteDesignPreset: (id) => {
      const s = get();
      const preset = s.designPresets.find((p) => p.id === id);
      if (!preset) return;
      const designPresets = s.designPresets.filter((p) => p.id !== id);
      set({ designPresets });
      void deleteDesignPresetRow(id);
      toast.success(`Preset “${preset.name}” deleted`);
    },

    applyDesignPreset: (presetId, sheetId) => {
      const s = get();
      const preset = s.designPresets.find((p) => p.id === presetId);
      const sheet = s.sheets.find((sh) => sh.id === sheetId);
      if (!preset || !sheet) return;
      const template = sheetTemplate(sheet);
      if (!template) return;
      pushHistory("apply-preset");
      const design = structuredClone(sheet.design);
      const report = applyPresetToDesign(design, preset, template);
      set({ sheets: mapSheet(sheetId, (sh) => ({ ...sh, design })) });
      scheduleSave(get());
      toast.success(`Preset “${preset.name}” applied to this sheet`, {
        description: presetApplyDescription(report),
      });
    },

    applyDesignPresetToSheets: (presetId, targetSheetIds) => {
      const s = get();
      const preset = s.designPresets.find((p) => p.id === presetId);
      if (!preset || targetSheetIds.length === 0) return;
      const targets = s.sheets.filter((sh) => targetSheetIds.includes(sh.id));
      if (targets.length === 0) return;
      pushHistory("apply-preset");
      const targetIds = new Set(targets.map((t) => t.id));
      const sheets = s.sheets.map((sh) => {
        if (!targetIds.has(sh.id)) return sh;
        const template = sheetTemplate(sh);
        if (!template) return sh;
        const design = structuredClone(sh.design);
        applyPresetToDesign(design, preset, template);
        return stampSheet({ ...sh, design });
      });
      set({ sheets });
      scheduleSave(get());
      toast.success(`Preset “${preset.name}” applied to ${targets.length} sheet${targets.length === 1 ? "" : "s"}`, {
        description: "Icons, categories, volumes and templates are never touched.",
      });
    },

    /* ---------------- icons ---------------- */

    /** Low-level commit: validate + add icon records. NO duplicate logic
     *  lives here (or anywhere below the ask-step) — several records with
     *  identical SVG content are legal library citizens, and whether a
     *  duplicate should be kept is exclusively the user's call, asked by
     *  importWithDuplicateCheck BEFORE this runs. */
    importFiles: async (files, tagHints) => {
      const report: ImportReport = { imported: 0, skipped: 0, duplicates: 0, duplicatesImported: 0, skipReasons: [] };
      const newIcons: IconEntry[] = [];
      for (const file of files) {
        if (!file.name.toLowerCase().endsWith(".svg")) {
          report.skipped++;
          report.skipReasons.push(`${file.name}: not an SVG file`);
          continue;
        }
        let text: string;
        try {
          text = await file.text();
        } catch {
          report.skipped++;
          report.skipReasons.push(`${file.name}: could not be read`);
          continue;
        }
        if (!isValidSvg(text)) {
          report.skipped++;
          report.skipReasons.push(`${file.name}: invalid SVG`);
          continue;
        }
        const entry: IconEntry = {
          id: nextId("ic"),
          fileName: file.name,
          svg: text,
          createdAt: Date.now(),
        };
        const hintTags = tagHints?.[file.name];
        if (hintTags?.length) {
          const cleaned = Array.from(
            new Set(hintTags.map((t) => t.trim().toLowerCase().replace(/\s+/g, "-")).filter(Boolean))
          );
          if (cleaned.length) entry.tags = cleaned;
        }
        newIcons.push(entry);
        report.imported++;
      }
      if (newIcons.length) {
        const cur = get();
        const icons = { ...cur.icons };
        for (const ic of newIcons) icons[ic.id] = ic;
        pendingNewIcons.push(...newIcons);
        set({ icons, iconOrder: [...cur.iconOrder, ...newIcons.map((i) => i.id)] });
        scheduleSave(get());
      }
      return report;
    },

    /** THE import pipeline (see the interface doc). Order is exactly:
     *  upload → parse/validate → DETECT duplicates → ASK → import per the
     *  user's choice. The skip policy is applied by FILTERING the file
     *  list here — never by rejecting files inside importFiles — so no
     *  code path can silently discard a duplicate. Imports are SERIALIZED
     *  through importChain: while a duplicate dialog is pending, a second
     *  upload WAITS (its busy spinner stays honest) instead of
     *  overwriting the single duplicateAsk slot and orphaning the first
     *  decision promise. */
    importWithDuplicateCheck: async (files, tagHints, opts) => {
      const run = async (): Promise<ImportReport> => {
        const list = Array.from(files);
        /* 1+2. detect (pure read — identifies, never removes) */
        const scan = await get().scanImportDuplicates(list);
        /* 3. ask — but only when duplicates were actually detected.
         *  THREE outcomes; "cancel" aborts the ENTIRE import safely. */
        let policy: DuplicateAskPolicy = "add";
        if (scan.duplicates.length > 0) {
          policy = await new Promise<DuplicateAskPolicy>((resolve) => {
            set({ duplicateAsk: { scan, resolve } });
          });
        }
        if (policy === "cancel") {
          /* Cancel — the import operation is aborted safely: NOTHING is
           *  imported (not even the unique files), nothing is deleted,
           *  the library and every sheet stay exactly as they were. */
          const cancelled: ImportReport = {
            imported: 0,
            skipped: 0,
            duplicates: 0,
            duplicatesImported: 0,
            cancelled: true,
            skipReasons: [],
            finishedAt: Date.now(),
          };
          set({
            lastImportReport: cancelled,
            importHistory: [cancelled, ...get().importHistory].slice(0, IMPORT_HISTORY_CAP),
          });
          toast.info(
            "Import cancelled — nothing was added, your library is unchanged",
          );
          return cancelled;
        }
        /* 4. apply the user's decision by filtering BEFORE the commit */
        let toImport = list;
        if (policy === "skip") {
          const lib = libraryHashIndex(get());
          const kept: File[] = [];
          for (const file of list) {
            let dupOfLibrary = false;
            if (file.name.toLowerCase().endsWith(".svg")) {
              try {
                const text = await file.text();
                if (isValidSvg(text) && lib.has(hashSvgContent(text))) dupOfLibrary = true;
              } catch {
                /* unreadable — leave it to importFiles' own skip+reason */
              }
            }
            if (!dupOfLibrary) kept.push(file);
          }
          toImport = kept;
        }
        /* 5. commit — importFiles cannot skip duplicate content by design */
        const report = await get().importFiles(toImport, tagHints);
        report.duplicates = policy === "skip" ? scan.duplicates.length : 0;
        report.duplicatesImported = policy === "add" ? scan.duplicates.length : 0;
        report.finishedAt = Date.now();
        if (report.imported > 0 || report.skipped > 0 || scan.duplicates.length > 0) {
          set({
            lastImportReport: report,
            importHistory: [report, ...get().importHistory].slice(0, IMPORT_HISTORY_CAP),
          });
        }
        /* 6. feedback — the SAME toasts for every import surface */
        if (report.imported > 0) {
          toast.success(opts?.successMessage ?? `Imported ${report.imported} SVG icon${report.imported === 1 ? "" : "s"}`);
        }
        if (report.duplicatesImported > 0) {
          toast.info(
            `Added ${report.duplicatesImported} duplicate ${report.duplicatesImported === 1 ? "icon" : "icons"} — separate records, existing icons untouched`,
          );
        }
        if (report.duplicates > 0) {
          toast.info(
            `${report.duplicates} duplicate ${report.duplicates === 1 ? "icon" : "icons"} skipped — you chose Skip Duplicates`,
          );
        }
        if (report.skipped > 0) {
          const shown = report.skipReasons.slice(0, 2).join(" · ");
          const more = report.skipReasons.length > 2 ? " …" : "";
          toast.warning(
            `${report.skipped} file${report.skipped === 1 ? "" : "s"} skipped — ${shown}${more}`,
          );
        }
        return report;
      };
      /* serialize: chain onto any in-flight import (incl. a pending
       * duplicate dialog) so the single ask slot is never overwritten */
      const next = importChain.then(run, run);
      importChain = next.catch(() => {
        /* the chain never breaks on a rejected import */
      });
      return next;
    },

    /** Answer the pending duplicate question. [Add Duplicates],
     *  [Skip Duplicates] and [Cancel] all land here; ESC / outside-click
     *  resolve "cancel" (the safest default — the ENTIRE import is
     *  aborted: nothing is imported, nothing is deleted, the existing
     *  library is unchanged). */
    resolveDuplicateAsk: (policy) => {
      const ask = get().duplicateAsk;
      if (!ask) return;
      set({ duplicateAsk: null });
      ask.resolve(policy);
    },

    /** Dismiss the library panel's "Last import" summary card — session-only
     *  state, no persistence. The import-history ring buffer is KEPT (the
     *  popover in the tools row stays available until the session ends or a
     *  backup restore resets it). */
    dismissImportReport: () => {
      if (!get().lastImportReport) return;
      set({ lastImportReport: null });
    },

    /** round 19 · "Review import history" palette command: bring the last
     *  import summary card back (it re-renders with its history popover +
     *  skip-reason tooltips). No-op-safe: returns whether a report card is
     *  visible after the call. */
    resurfaceImportReport: () => {
      const s = get();
      if (s.lastImportReport) return true;
      const newest = s.importHistory[0];
      if (!newest) return false;
      set({ lastImportReport: newest });
      return true;
    },

    /* round 18 · stroke-audit state (lifted store-level so the command
     * palette can drive it and it survives the library tab unmounting) */
    setStrokeAudit: (on) => {
      set({ strokeAudit: on, settings: { ...get().settings, strokeAudit: on } });
      /* round 22: the audit armed state is a workspace preference now —
       * persist alongside the other settings (debounced autosave) */
      scheduleSave(get());
    },
    setStrokeAuditUnit: (unit) => {
      set({ strokeAuditUnit: unit, settings: { ...get().settings, strokeAuditUnit: unit } });
      scheduleSave(get());
    },

    /** Pre-import duplicate scan — see the interface doc above. Pure read:
     *  no state changes, no history, no persistence. */
    scanImportDuplicates: async (files) => {
      const seen = libraryHashIndex(get());
      const result: DuplicateScanResult = { total: files.length, validFiles: 0, duplicates: [] };
      for (const file of files) {
        if (!file.name.toLowerCase().endsWith(".svg")) continue;
        let text: string;
        try {
          text = await file.text();
        } catch {
          continue;
        }
        if (!isValidSvg(text)) continue;
        result.validFiles++;
        const existingName = seen.get(hashSvgContent(text));
        if (existingName) {
          result.duplicates.push({ fileName: file.name, existingName, svg: text });
        }
      }
      return result;
    },

    updateIconTags: (iconIds, mode, tags) => {
      const s = get();
      const ids = iconIds.filter((id) => s.icons[id]);
      if (ids.length === 0) return;
      const cleanedInput = tags
        .map((t) => t.trim().toLowerCase().replace(/\s+/g, "-"))
        .filter((t) => t.length > 0 && t.length <= 24);
      if (cleanedInput.length === 0 && mode !== "set") return;
      const unique = Array.from(new Set(cleanedInput));
      const icons = { ...s.icons };
      let changed = 0;
      for (const id of ids) {
        const entry = icons[id];
        const current = entry.tags ?? [];
        let next: string[];
        if (mode === "set") {
          next = unique;
        } else if (mode === "add") {
          next = Array.from(new Set([...current, ...unique]));
        } else {
          const remove = new Set(unique);
          next = current.filter((t) => !remove.has(t));
        }
        if (next.join("\u0000") === current.join("\u0000")) continue;
        icons[id] = { ...entry, tags: next };
        pendingNewIcons.push(icons[id]); // putIcons overwrites by id → updates persist
        changed++;
      }
      if (changed === 0) return;
      // undoable since round 6 — one coalesced step per rapid edit burst
      pushHistory(`tag-${mode}`, { includeIcons: true, tagOp: true });
      set({ icons });
      scheduleSave(get());
    },

    updateIconMeta: (iconId, patch) => {
      const s = get();
      const entry = s.icons[iconId];
      if (!entry) return false;

      /** Normalize one field: trimmed, capped, "" → undefined (dropped). */
      const norm = (v: string | undefined, max: number): string | undefined => {
        if (v === undefined) return undefined;
        const t = v.trim().slice(0, max);
        return t.length > 0 ? t : undefined;
      };
      const nextTitle =
        patch.title === undefined
          ? entry.title
          : norm(patch.title, 80);
      const nextDescription =
        patch.description === undefined
          ? entry.description
          : norm(patch.description, 280);
      if (nextTitle === entry.title && nextDescription === entry.description) {
        return false; // no-op — no history noise
      }
      const updated: IconEntry = {
        ...entry,
        ...(nextTitle !== entry.title ? { title: nextTitle } : {}),
        ...(nextDescription !== entry.description ? { description: nextDescription } : {}),
      };
      pendingNewIcons.push(updated); // putIcons overwrites by id → persists
      // restore-exactly semantics (the tag-op family): undo reverts title/
      // description precisely, later imports stay untouched
      pushHistory("icon-meta", { includeIcons: true, tagOp: true });
      set({ icons: { ...s.icons, [iconId]: updated } });
      scheduleSave(get());
      return true;
    },

    deleteIcons: (iconIds) => {
      const s = get();
      const ids = iconIds.filter((id) => s.icons[id]);
      if (ids.length === 0) return { removed: [], sheetsTouched: [] };
      pushHistory("delete-icons", { includeIcons: true, deletedIconIds: ids });
      const remove = new Set(ids);
      const sheetsTouched: string[] = [];
      const mapped = s.sheets.map((sh) => {
        if (!sh.iconIds.some((id) => remove.has(id))) return sh;
        sheetsTouched.push(sh.id);
        const iconIds = sh.iconIds.filter((id) => !remove.has(id));
        const heroIconId = sh.heroIconId && remove.has(sh.heroIconId) ? null : sh.heroIconId;
        return stampSheet({ ...sh, iconIds, heroIconId });
      });
      /* generated sheets that just lost ALL their icons are removed — no
       * obsolete empty sheets are left behind (manual sheets survive) */
      const pruned = pruneEmptyGenerated(mapped, sheetsTouched, s.activeSheetId, s.selectedSheetIds);
      announcePrunedSheets(pruned.removed);
      const icons: Record<string, IconEntry> = {};
      for (const id of s.iconOrder) {
        const entry = s.icons[id];
        if (entry && !remove.has(id)) icons[id] = entry;
      }
      const iconOrder = s.iconOrder.filter((id) => !remove.has(id));
      pendingDeletedIconIds.push(...ids);
      set({
        sheets: pruned.sheets,
        icons,
        iconOrder,
        ...(pruned.removed.length
          ? { activeSheetId: pruned.activeSheetId, selectedSheetIds: pruned.selectedSheetIds }
          : {}),
      });
      scheduleSave(get());
      return { removed: ids, sheetsTouched };
    },

    unassignIcons: (iconIds) => {
      const s = get();
      const remove = new Set(iconIds.filter((id) => s.icons[id]));
      if (remove.size === 0) return { removed: [], sheetsTouched: [] };
      pushHistory("unassign-icons");
      const sheetsTouched: string[] = [];
      let removedFromSheets = 0;
      const mapped = s.sheets.map((sh) => {
        if (!sh.iconIds.some((id) => remove.has(id))) return sh;
        sheetsTouched.push(sh.id);
        const iconIds = sh.iconIds.filter((id) => !remove.has(id));
        removedFromSheets += sh.iconIds.length - iconIds.length;
        const heroIconId = sh.heroIconId && remove.has(sh.heroIconId) ? null : sh.heroIconId;
        return stampSheet({ ...sh, iconIds, heroIconId });
      });
      if (removedFromSheets === 0) {
        // nothing was on a sheet — drop the just-pushed history entry again
        set({ past: s.past, future: s.future });
        return { removed: [], sheetsTouched: [] };
      }
      /* generated sheets that just lost ALL their icons are removed */
      const pruned = pruneEmptyGenerated(mapped, sheetsTouched, s.activeSheetId, s.selectedSheetIds);
      announcePrunedSheets(pruned.removed);
      set({
        sheets: pruned.sheets,
        ...(pruned.removed.length
          ? { activeSheetId: pruned.activeSheetId, selectedSheetIds: pruned.selectedSheetIds }
          : {}),
      });
      scheduleSave(get());
      return { removed: [...remove], sheetsTouched };
    },

    replaceIconEverywhere: (fromId, toId) => {
      const s = get();
      if (fromId === toId || !s.icons[fromId] || !s.icons[toId]) {
        return { replaced: 0, merged: 0, sheetsTouched: [] };
      }
      if (!s.sheets.some((sh) => sh.iconIds.includes(fromId))) {
        return { replaced: 0, merged: 0, sheetsTouched: [] };
      }
      pushHistory("replace-icon");
      const sheetsTouched: string[] = [];
      let replaced = 0;
      let merged = 0;
      const mapped = s.sheets.map((sh) => {
        const occurrences = sh.iconIds.reduce((n, id) => (id === fromId ? n + 1 : n), 0);
        if (occurrences === 0) return sh;
        sheetsTouched.push(sh.id);
        /* keeper already on this sheet → the duplicate occurrences are
         * merged away (a sheet never renders the same icon twice) */
        const keeperOnSheet = sh.iconIds.includes(toId);
        const iconIds = keeperOnSheet
          ? sh.iconIds.filter((id) => id !== fromId)
          : sh.iconIds.map((id) => (id === fromId ? toId : id));
        if (keeperOnSheet) merged += occurrences;
        else replaced += occurrences;
        /* source's cell override is dropped — the keeper keeps its own */
        const cellOverrides = { ...sh.cellOverrides };
        delete cellOverrides[fromId];
        const heroIconId = sh.heroIconId === fromId ? toId : sh.heroIconId;
        return stampSheet({ ...sh, iconIds, heroIconId, cellOverrides });
      });
      if (sheetsTouched.length === 0) {
        // nothing was on a sheet — drop the just-pushed history entry again
        set({ past: s.past, future: s.future });
        return { replaced: 0, merged: 0, sheetsTouched: [] };
      }
      set({ sheets: mapped });
      scheduleSave(get());
      return { replaced, merged, sheetsTouched };
    },

    consolidateSimilarGroups: (plan) => {
      const s = get();
      /* validate the plan: keepers must exist; an other may never double as
       * another group's keeper (groups are disjoint by construction, but a
       * hand-built plan gets the guard anyway). */
      const keepers = new Set<string>();
      for (const g of plan) if (s.icons[g.keeperId]) keepers.add(g.keeperId);
      const replaceWith = new Map<string, string>();
      for (const g of plan) {
        if (!keepers.has(g.keeperId)) continue;
        for (const other of g.otherIds) {
          if (other === g.keeperId || keepers.has(other) || !s.icons[other]) continue;
          replaceWith.set(other, g.keeperId);
        }
      }
      if (replaceWith.size === 0) {
        return { groups: 0, iconsDeleted: 0, placementsReplaced: 0, duplicatesMerged: 0, sheetsTouched: 0 };
      }
      const deletedIds = [...replaceWith.keys()];
      /* ONE undo step for the whole bulk action — the entry carries the
       * library snapshot (icons resurrect on undo) and the deletion delta
       * (redo removes exactly these ids again). */
      pushHistory("consolidate-groups", { includeIcons: true, deletedIconIds: deletedIds });

      let replaced = 0;
      let merged = 0;
      const touched = new Set<string>();
      const mapped = s.sheets.map((sh) => {
        if (!sh.iconIds.some((id) => replaceWith.has(id))) return sh;
        touched.add(sh.id);
        /* `has` = pre-existing membership (a keeper already on the sheet
         * merges the other's occurrence away — replaceIconEverywhere's
         * semantics); `filled` = keeper slots a replacement already landed
         * in (two others of one group on the same sheet collapse to one). */
        const has = new Set(sh.iconIds);
        const filled = new Set<string>();
        const iconIds: string[] = [];
        for (const id of sh.iconIds) {
          const target = replaceWith.get(id);
          if (target === undefined) {
            iconIds.push(id);
            continue;
          }
          if (has.has(target) || filled.has(target)) {
            merged++;
            continue;
          }
          iconIds.push(target);
          filled.add(target);
          replaced++;
        }
        /* replaced sources' cell overrides are dropped — keepers keep their
         * own (same rule as replaceIconEverywhere). */
        const cellOverrides = { ...sh.cellOverrides };
        for (const id of deletedIds) delete cellOverrides[id];
        const heroIconId = sh.heroIconId ? (replaceWith.get(sh.heroIconId) ?? sh.heroIconId) : sh.heroIconId;
        return stampSheet({ ...sh, iconIds, heroIconId, cellOverrides });
      });

      /* the extras leave the library for good (undo resurrects them) */
      const icons: Record<string, IconEntry> = {};
      for (const id of s.iconOrder) {
        const entry = s.icons[id];
        if (entry && !replaceWith.has(id)) icons[id] = entry;
      }
      const iconOrder = s.iconOrder.filter((id) => !replaceWith.has(id));
      pendingDeletedIconIds.push(...deletedIds);
      set({ sheets: mapped, icons, iconOrder });
      scheduleSave(get());
      return {
        groups: new Set([...replaceWith.values()]).size,
        iconsDeleted: deletedIds.length,
        placementsReplaced: replaced,
        duplicatesMerged: merged,
        sheetsTouched: touched.size,
      };
    },

    renameTag: (oldName, newName) => {
      const s = get();
      const from = oldName.trim().toLowerCase().replace(/\s+/g, "-");
      const to = newName.trim().toLowerCase().replace(/\s+/g, "-");
      if (!from || !to || from === to) return { icons: 0, merged: false };
      const icons = { ...s.icons };
      let changed = 0;
      const merged = s.iconOrder.some((id) => icons[id]?.tags?.includes(to));
      for (const id of s.iconOrder) {
        const entry = icons[id];
        const current = entry.tags ?? [];
        if (!current.includes(from)) continue;
        const next = Array.from(new Set([...current.filter((t) => t !== from), to])).sort();
        icons[id] = { ...entry, tags: next };
        pendingNewIcons.push(icons[id]);
        changed++;
      }
      if (changed === 0) return { icons: 0, merged };
      pushHistory("rename-tag", { includeIcons: true, tagOp: true });
      set({ icons });
      scheduleSave(get());
      return { icons: changed, merged };
    },

    deleteTag: (name) => {
      const s = get();
      const target = name.trim().toLowerCase();
      if (!target) return 0;
      const icons = { ...s.icons };
      let changed = 0;
      for (const id of s.iconOrder) {
        const entry = icons[id];
        const current = entry.tags ?? [];
        if (!current.includes(target)) continue;
        const next = current.filter((t) => t !== target);
        icons[id] = next.length > 0 ? { ...entry, tags: next } : { ...entry, tags: [] };
        pendingNewIcons.push(icons[id]);
        changed++;
      }
      if (changed === 0) return 0;
      pushHistory("delete-tag", { includeIcons: true, tagOp: true });
      set({ icons });
      scheduleSave(get());
      return changed;
    },

    mergeTags: (sourceNames, targetName) => {
      const s = get();
      const target = targetName.trim().toLowerCase().replace(/\s+/g, "-");
      if (!target) return { icons: 0, merged: false, target };
      const sources = Array.from(
        new Set(
          sourceNames
            .map((n) => n.trim().toLowerCase().replace(/\s+/g, "-"))
            .filter((n) => n && n !== target),
        ),
      );
      if (sources.length === 0) return { icons: 0, merged: false, target };
      const sourceSet = new Set(sources);
      const icons = { ...s.icons };
      let changed = 0;
      /** "merged" = the target tag already existed before this call */
      const merged = s.iconOrder.some((id) => icons[id]?.tags?.includes(target));
      for (const id of s.iconOrder) {
        const entry = icons[id];
        const current = entry.tags ?? [];
        const hasSource = current.some((t) => sourceSet.has(t));
        const hasTarget = current.includes(target);
        if (!hasSource && !hasTarget) continue;
        const next = Array.from(
          new Set([...current.filter((t) => !sourceSet.has(t)), target]),
        ).sort();
        if (next.join("\u0000") === current.join("\u0000")) continue;
        icons[id] = { ...entry, tags: next };
        pendingNewIcons.push(icons[id]);
        changed++;
      }
      if (changed === 0) return { icons: 0, merged, target };
      pushHistory("merge-tags", { includeIcons: true, tagOp: true });
      set({ icons });
      scheduleSave(get());
      return { icons: changed, merged, target };
    },

    deleteTags: (names) => {
      const s = get();
      const targets = Array.from(
        new Set(names.map((n) => n.trim().toLowerCase()).filter(Boolean)),
      );
      if (targets.length === 0) return 0;
      const targetSet = new Set(targets);
      const icons = { ...s.icons };
      let changed = 0;
      for (const id of s.iconOrder) {
        const entry = icons[id];
        const current = entry.tags ?? [];
        if (!current.some((t) => targetSet.has(t))) continue;
        const next = current.filter((t) => !targetSet.has(t));
        icons[id] = next.length > 0 ? { ...entry, tags: next } : { ...entry, tags: [] };
        pendingNewIcons.push(icons[id]);
        changed++;
      }
      if (changed === 0) return 0;
      pushHistory("delete-tags", { includeIcons: true, tagOp: true });
      set({ icons });
      scheduleSave(get());
      return changed;
    },

    /* ---------------- sheets ---------------- */

    generateSheets: (templateId) => {
      const template = getTemplate(templateId);
      if (!template) return 0;
      const s = get();
      const assigned = new Set(s.sheets.flatMap((sh) => sh.iconIds));
      const unassigned = s.iconOrder.filter((id) => !assigned.has(id));
      if (unassigned.length === 0) return 0;

      pushHistory("generate-sheets");
      /* phase 3 — custom targets stamp an immutable snapshot on every
       * generated sheet: later library edits/deletions can never
       * retroactively change these sheets (§18/§48). */
      const targetRecord = template.sourceType === "custom"
        ? s.customTemplates.find((r) => r.id === templateId) ?? null
        : null;
      const sheets = [...s.sheets];
      let created = 0;
      for (let i = 0; i < unassigned.length; i += template.capacity) {
        const chunk = unassigned.slice(i, i + template.capacity);
        const vol = nextVolumeFor(s.sheets, s.categoryVolumes, "Icon Collection") + created;
        sheets.push(
          stampSheet({
            id: nextId("sh"),
            templateId,
            ...(targetRecord ? { templateSnapshot: buildSheetSnapshot(targetRecord) } : {}),
            iconIds: chunk,
            heroIconId: chunk[0] ?? null,
            category: "Icon Collection",
            volume: vol,
            volumeAuto: vol,
            volumeManual: false,
            design: structuredClone(template.defaults),
            createdAt: Date.now(),
            updatedAt: Date.now(),
            generated: true,
          })
        );
        created++;
      }
      const categoryVolumes = { ...s.categoryVolumes, "Icon Collection": (s.categoryVolumes["Icon Collection"] ?? 0) + created };
      const lastSheet = sheets[sheets.length - 1];
      set({ sheets, categoryVolumes, activeSheetId: lastSheet?.id ?? s.activeSheetId, settings: { ...s.settings, viewMode: "overview" } });
      scheduleSave(get());
      return created;
    },

    deleteSheet: (sheetId) => {
      const s = get();
      const sheet = s.sheets.find((sh) => sh.id === sheetId);
      if (!sheet) return;
      pushHistory("delete-sheet");
      const idx = s.sheets.findIndex((sh) => sh.id === sheetId);
      const sheets = s.sheets.filter((sh) => sh.id !== sheetId);
      pendingDeletedSheetIds.push(sheetId);
      const nextActive =
        s.activeSheetId === sheetId ? sheets[Math.min(idx, sheets.length - 1)]?.id ?? null : s.activeSheetId;
      set({
        sheets,
        activeSheetId: nextActive,
        selectedSheetIds: s.selectedSheetIds.filter((id) => id !== sheetId),
      });
      scheduleSave(get());
    },

    setActiveSheet: (sheetId) => {
      /* switching sheets clears the edit-view cell selection (round 10/11) —
       * a cell selection belongs to a specific sheet, so it must not linger
       * when the user navigates to a different sheet. The cell-color picker
       * request flag rides along (round 12). */
      const prev = get();
      set(
        prev.selectedCellSheetId && prev.selectedCellSheetId !== sheetId
          ? { activeSheetId: sheetId, selectedCellIconIds: [], selectedCellSheetId: null, selectedCellAnchorIconId: null, cellColorPickerOpen: false }
          : { activeSheetId: sheetId }
      );
      scheduleSave(get());
    },

    toggleSheetSelected: (sheetId) => {
      const s = get();
      const selected = s.selectedSheetIds.includes(sheetId)
        ? s.selectedSheetIds.filter((id) => id !== sheetId)
        : [...s.selectedSheetIds, sheetId];
      set({ selectedSheetIds: selected });
    },

    selectAllSheets: () => set({ selectedSheetIds: get().sheets.map((s) => s.id) }),

    clearSheetSelection: () => set({ selectedSheetIds: [] }),

    /* ---------------- editing ---------------- */

    updateSheetDesign: (sheetId, label, updater) => {
      pushHistory(label);
      const sheets = mapSheet(sheetId, (sheet) => {
        const design = structuredClone(sheet.design);
        updater(design);
        return { ...sheet, design };
      });
      set({ sheets });
      scheduleSave(get());
    },

    setCategory: (sheetId, category, autoVolume = true) => {
      const s = get();
      const sheet = s.sheets.find((sh) => sh.id === sheetId);
      if (!sheet || sheet.category === category) return;
      pushHistory("set-category");
      const trimmed = category.trim() || "Icon Collection";
      /* Volume/category independence (manual-volume spec): a MANUAL volume
       * is a per-sheet user decision and NEVER changes with the category.
       * Automatic volumes only re-assign when the caller explicitly opted
       * in (autoVolume) — every shipped UI path passes false, keeping the
       * two controls fully independent. */
      let volume = sheet.volume;
      let volumeAuto = sheet.volumeAuto;
      let categoryVolumes = s.categoryVolumes;
      if (autoVolume && !sheet.volumeManual) {
        volume = nextVolumeFor(s.sheets, s.categoryVolumes, trimmed);
        volumeAuto = volume;
        categoryVolumes = { ...s.categoryVolumes, [trimmed]: volume };
      }
      set({ sheets: mapSheet(sheetId, (sh) => ({ ...sh, category: trimmed, volume, volumeAuto })), categoryVolumes });
      scheduleSave(get());
    },

    setVolume: (sheetId, volume, manual = true) => {
      const s = get();
      const sheet = s.sheets.find((sh) => sh.id === sheetId);
      if (!sheet) return;
      const v = normalizeVolume(volume);
      /* no-op guard: same value AND same manual state → nothing to record
       * (avoids ghost undo entries). Retyping the same number on an
       * automatic sheet still flips it to manual — the user took ownership. */
      if (v === sheet.volume && sheet.volumeManual === manual) return;
      pushHistory("set-volume");
      set({
        sheets: mapSheet(sheetId, (sh) => ({
          ...sh,
          volume: v,
          volumeManual: manual,
          ...(manual ? {} : { volumeAuto: v }),
        })),
        /* keep the category counter ≥ v so future AUTOMATIC assignments
         * never collide with this number (nextVolumeFor also scans live
         * sheets, this just keeps the remembered counter honest) */
        categoryVolumes: { ...s.categoryVolumes, [sheet.category]: Math.max(s.categoryVolumes[sheet.category] ?? 0, v) },
      });
      scheduleSave(get());
    },

    resetSheetVolume: (sheetId) => {
      const s = get();
      const sheet = s.sheets.find((sh) => sh.id === sheetId);
      if (!sheet || !sheet.volumeManual) return; // automatic sheet → nothing to reset
      pushHistory("reset-volume");
      const restored = normalizeVolume(sheet.volumeAuto ?? sheet.volume);
      set({
        sheets: mapSheet(sheetId, (sh) => ({ ...sh, volume: restored, volumeManual: false, volumeAuto: restored })),
        categoryVolumes: { ...s.categoryVolumes, [sheet.category]: Math.max(s.categoryVolumes[sheet.category] ?? 0, restored) },
      });
      scheduleSave(get());
    },

    renameSheet: (sheetId, name) => {
      const s = get();
      const sheet = s.sheets.find((sh) => sh.id === sheetId);
      if (!sheet) return;
      const trimmed = name.trim().slice(0, 60);
      if ((sheet.name ?? null) === (trimmed || null)) return;
      pushHistory("sheet:name");
      set({ sheets: mapSheet(sheetId, (sh) => ({ ...sh, name: trimmed || null })) });
      scheduleSave(get());
    },

    resetCategoryVolume: (category) => {
      pushHistory("reset-volume");
      const s = get();
      const categoryVolumes = { ...s.categoryVolumes, [category]: 0 };
      // sheets of that category restart at sequential 1..n — including
      // manual overrides, which a counter reset releases back to automatic
      let n = 0;
      const sheets = s.sheets.map((sh) =>
        sh.category === category ? { ...sh, volume: ++n, volumeAuto: n, volumeManual: false } : sh
      );
      set({ sheets, categoryVolumes });
      scheduleSave(get());
    },

    setHero: (sheetId, iconId) => {
      const s = get();
      const sheet = s.sheets.find((sh) => sh.id === sheetId);
      if (!sheet) return;
      if (iconId && !sheet.iconIds.includes(iconId)) return; // hero must belong to the sheet
      pushHistory("set-hero");
      set({ sheets: mapSheet(sheetId, (sh) => ({ ...sh, heroIconId: iconId })) });
      scheduleSave(get());
    },

    setCellSkip: (sheetId, iconIds, skip) => {
      const s = get();
      const sheet = s.sheets.find((sh) => sh.id === sheetId);
      if (!sheet || iconIds.length === 0) return;
      const targets = iconIds.filter((id) => sheet.iconIds.includes(id));
      if (targets.length === 0) return;
      const alreadyAll = targets.every(
        (id) => sheet.cellOverrides?.[id]?.skip === true,
      );
      if (skip && alreadyAll) return; // no-op guard
      pushHistory("sheet:cell skip");
      set({
        sheets: mapSheet(sheetId, (sh) => ({
          ...sh,
          /* empty override objects are pruned inside patchCellOverrides */
          cellOverrides: patchCellOverrides(sh, targets, (cur) =>
            skip ? { ...cur, skip: true } : { ...cur, skip: undefined },
          ),
        })),
      });
      scheduleSave(get());
    },

    setCellCardColor: (sheetId, iconIds, color) => {
      const s = get();
      const sheet = s.sheets.find((sh) => sh.id === sheetId);
      if (!sheet || iconIds.length === 0) return;
      const targets = iconIds.filter((id) => sheet.iconIds.includes(id));
      if (targets.length === 0) return;
      /* no-op guard: setting the value the cells already carry (and no
       *  gradient to clear) would create a pointless history entry */
      const noop = targets.every(
        (id) =>
          (sheet.cellOverrides?.[id]?.cardColor ?? null) === color &&
          (sheet.cellOverrides?.[id]?.cardGradient ?? null) == null,
      );
      if (noop) return;
      pushHistory("sheet:cell color");
      set({
        sheets: mapSheet(sheetId, (sh) => ({
          ...sh,
          /* a solid pick replaces a gradient pick (mutually exclusive),
           *  and null (reset) clears BOTH fill overrides at once */
          cellOverrides: patchCellOverrides(sh, targets, (cur) => ({
            ...cur,
            cardColor: color,
            cardGradient: undefined,
          })),
        })),
      });
      scheduleSave(get());
    },

    setCellCardGradient: (sheetId, iconIds, gradient) => {
      const s = get();
      const sheet = s.sheets.find((sh) => sh.id === sheetId);
      if (!sheet || iconIds.length === 0) return;
      const targets = iconIds.filter((id) => sheet.iconIds.includes(id));
      if (targets.length === 0) return;
      const noop = targets.every((id) => {
        const cur = sheet.cellOverrides?.[id] ?? {};
        if (gradient == null) {
          return cur.cardGradient == null;
        }
        const g = cur.cardGradient;
        return (
          g != null &&
          g.from === gradient.from &&
          g.to === gradient.to &&
          g.angle === gradient.angle &&
          (cur.cardColor ?? null) == null
        );
      });
      if (noop) return;
      pushHistory("sheet:cell gradient");
      set({
        sheets: mapSheet(sheetId, (sh) => ({
          ...sh,
          cellOverrides: patchCellOverrides(sh, targets, (cur) => ({
            ...cur,
            cardGradient: gradient,
            /* a gradient pick replaces a solid pick (mutually exclusive) */
            cardColor: gradient ? null : cur.cardColor,
          })),
        })),
      });
      scheduleSave(get());
    },

    resetSheetCellFills: (sheetId) => {
      const s = get();
      const sheet = s.sheets.find((sh) => sh.id === sheetId);
      if (!sheet) return 0;
      const overrides = sheet.cellOverrides ?? {};
      const targets = Object.keys(overrides).filter(
        (id) =>
          sheet.iconIds.includes(id) &&
          ((overrides[id].cardColor != null && overrides[id].cardColor!.trim() !== "") ||
            overrides[id].cardGradient != null),
      );
      if (targets.length === 0) return 0;
      pushHistory("sheet:cell fills reset");
      set({
        sheets: mapSheet(sheetId, (sh) => ({
          ...sh,
          cellOverrides: patchCellOverrides(sh, targets, (cur) => ({
            ...cur,
            cardColor: null,
            cardGradient: undefined,
          })),
        })),
      });
      scheduleSave(get());
      return targets.length;
    },

    setCellStrokeTarget: (sheetId, iconIds, targetPx) => {
      const s = get();
      const sheet = s.sheets.find((sh) => sh.id === sheetId);
      if (!sheet || iconIds.length === 0) return;
      const targets = iconIds.filter((id) => sheet.iconIds.includes(id));
      if (targets.length === 0) return;
      /* normalize the stored value — clamped to the sheet-wide target range
       *  and kept to ONE decimal so the record stays tidy (the engine's
       *  effective read clamps again anyway; this is belt-and-suspenders) */
      const normalized =
        targetPx == null || !Number.isFinite(targetPx)
          ? null
          : Math.round(
              Math.min(UNIFORM_TARGET_PX_MAX, Math.max(UNIFORM_TARGET_PX_MIN, targetPx)) * 10
            ) / 10;
      /* no-op guard: writing the exception the cells already carry (or
       *  clearing cells that have none) would create a pointless undo step */
      const noop = targets.every((id) => {
        const cur = sheet.cellOverrides?.[id]?.strokeTargetPx ?? null;
        if (cur == null && normalized == null) return true;
        if (cur == null || normalized == null) return false;
        return Math.abs(cur - normalized) < 0.01;
      });
      if (noop) return;
      pushHistory("sheet:cell stroke");
      set({
        sheets: mapSheet(sheetId, (sh) => ({
          ...sh,
          cellOverrides: patchCellOverrides(sh, targets, (cur) => ({
            ...cur,
            strokeTargetPx: normalized,
          })),
        })),
      });
      scheduleSave(get());
    },

    setCellStrokeWeight: (sheetId, iconIds, weightPx) => {
      const s = get();
      const sheet = s.sheets.find((sh) => sh.id === sheetId);
      if (!sheet || iconIds.length === 0) return;
      const targets = iconIds.filter((id) => sheet.iconIds.includes(id));
      if (targets.length === 0) return;
      /* normalize: integer clamp to the sheet-wide weight range (the
       *  engine's effective read clamps again — belt-and-suspenders) */
      const normalized =
        weightPx == null || !Number.isFinite(weightPx)
          ? null
          : Math.round(
              Math.min(STROKE_WEIGHT_PX_MAX, Math.max(STROKE_WEIGHT_PX_MIN, weightPx))
            );
      /* no-op guard — identical semantics to setCellStrokeTarget */
      const noop = targets.every((id) => {
        const cur = sheet.cellOverrides?.[id]?.strokeWeightPx ?? null;
        return cur === normalized;
      });
      if (noop) return;
      pushHistory("sheet:cell weight");
      set({
        sheets: mapSheet(sheetId, (sh) => ({
          ...sh,
          cellOverrides: patchCellOverrides(sh, targets, (cur) => ({
            ...cur,
            strokeWeightPx: normalized,
          })),
        })),
      });
      scheduleSave(get());
    },

    resetSheetCellStrokes: (sheetId) => {
      const s = get();
      const sheet = s.sheets.find((sh) => sh.id === sheetId);
      if (!sheet) return 0;
      const overrides = sheet.cellOverrides ?? {};
      /* round 12: BOTH exception kinds count — uniform targets AND relative
       *  weights — so one tap really clears every stroke exception */
      const targets = Object.keys(overrides).filter(
        (id) =>
          sheet.iconIds.includes(id) &&
          ((overrides[id].strokeTargetPx != null &&
            Number.isFinite(overrides[id].strokeTargetPx!)) ||
            (overrides[id].strokeWeightPx != null &&
              Number.isFinite(overrides[id].strokeWeightPx!)))
      );
      if (targets.length === 0) return 0;
      pushHistory("sheet:cell strokes reset");
      set({
        sheets: mapSheet(sheetId, (sh) => ({
          ...sh,
          cellOverrides: patchCellOverrides(sh, targets, (cur) => ({
            ...cur,
            strokeTargetPx: null,
            strokeWeightPx: null,
          })),
        })),
      });
      scheduleSave(get());
      return targets.length;
    },

    randomizeSheet: (sheetId) => {
      pushHistory("randomize");
      set({
        sheets: mapSheet(sheetId, (sheet) => {
          // Fisher–Yates: every icon exactly once, hero & library order untouched
          const ids = [...sheet.iconIds];
          for (let i = ids.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [ids[i], ids[j]] = [ids[j], ids[i]];
          }
          return { ...sheet, iconIds: ids };
        }),
      });
      scheduleSave(get());
    },

    moveSheet: (sheetId, direction) => {
      const s = get();
      const idx = s.sheets.findIndex((sh) => sh.id === sheetId);
      const target = idx + direction;
      if (idx < 0 || target < 0 || target >= s.sheets.length) return;
      pushHistory("move-sheet");
      const sheets = [...s.sheets];
      const [moved] = sheets.splice(idx, 1);
      sheets.splice(target, 0, moved);
      set({ sheets });
      scheduleSave(get());
    },

    reorderSheet: (sheetId, toIndex) => {
      const s = get();
      const idx = s.sheets.findIndex((sh) => sh.id === sheetId);
      if (idx < 0) return;
      const target = Math.max(0, Math.min(toIndex, s.sheets.length - 1));
      if (idx === target) return;
      pushHistory("move-sheet");
      const sheets = [...s.sheets];
      const [moved] = sheets.splice(idx, 1);
      sheets.splice(target, 0, moved);
      set({ sheets });
      scheduleSave(get());
    },

    reorderSheetIcons: (sheetId, fromIndex, toIndex) => {
      const s = get();
      const sheet = s.sheets.find((sh) => sh.id === sheetId);
      if (!sheet) return;
      const n = sheet.iconIds.length;
      if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= n || toIndex >= n) return;
      pushHistory("reorder-icons");
      set({
        sheets: mapSheet(sheetId, (sh) => {
          const ids = [...sh.iconIds];
          const [moved] = ids.splice(fromIndex, 1);
          ids.splice(toIndex, 0, moved);
          return { ...sh, iconIds: ids };
        }),
      });
      scheduleSave(get());
    },

    insertIconsAt: (iconIds, targetSheetId, index) => {
      const s = get();
      const target = s.sheets.find((sh) => sh.id === targetSheetId);
      if (!target) return 0;
      const template = sheetTemplate(target);
      const capacity = template?.capacity ?? target.iconIds.length;
      const alreadyThere = new Set(target.iconIds);
      const toMove = iconIds.filter((id) => !alreadyThere.has(id) && s.icons[id]);
      if (toMove.length === 0) return 0;
      const free = capacity - target.iconIds.length;
      if (toMove.length > free) return 0; // caller falls back to the append/overflow flow

      pushHistory("move-icons");
      const at = Math.max(0, Math.min(index, target.iconIds.length));
      const movingSet = new Set(toMove);
      const sourceIds = s.sheets
        .filter((sh) => sh.id !== targetSheetId && sh.iconIds.some((id) => movingSet.has(id)))
        .map((sh) => sh.id);
      const mapped = s.sheets.map((sheet) => {
        if (sheet.id === targetSheetId) {
          const ids = [...sheet.iconIds];
          ids.splice(at, 0, ...toMove);
          return stampSheet({ ...sheet, iconIds: ids });
        }
        if (!sheet.iconIds.some((id) => movingSet.has(id))) return sheet;
        const remaining = sheet.iconIds.filter((id) => !movingSet.has(id));
        const updated = stampSheet({ ...sheet, iconIds: remaining });
        if (updated.heroIconId && !remaining.includes(updated.heroIconId)) {
          updated.heroIconId = remaining[0] ?? null;
        }
        return updated;
      });
      /* generated sheets emptied by the move are removed automatically */
      const pruned = pruneEmptyGenerated(mapped, sourceIds, s.activeSheetId, s.selectedSheetIds);
      announcePrunedSheets(pruned.removed);
      const sheets = pruned.sheets;
      set({
        sheets,
        ...(pruned.removed.length
          ? { activeSheetId: pruned.activeSheetId, selectedSheetIds: pruned.selectedSheetIds }
          : {}),
      });
      scheduleSave(get());
      return toMove.length;
    },

    duplicateSheet: (sheetId) => {
      const s = get();
      const source = s.sheets.find((sh) => sh.id === sheetId);
      if (!source) return;
      pushHistory("duplicate-sheet");
      const idx = s.sheets.findIndex((sh) => sh.id === sheetId);
      const vol = nextVolumeFor(s.sheets, s.categoryVolumes, source.category);
      const copy: Sheet = stampSheet({
        id: nextId("sh"),
        templateId: source.templateId,
        /* the duplicate inherits the source's pinned template revision —
         * same template, same version, independent sheet (§19) */
        ...(source.templateSnapshot ? { templateSnapshot: structuredClone(source.templateSnapshot) } : {}),
        // icons are owned exclusively per sheet — the duplicate starts empty
        iconIds: [],
        heroIconId: null,
        category: source.category,
        /* independent auto volume (never the source's manual override) —
         * the duplicate owns its own volume state from the start */
        volume: vol,
        volumeAuto: vol,
        volumeManual: false,
        /* the duplicate gets its own positional title — copying the name
         * would leave two identically-named sheets in the sidebar */
        name: null,
        design: structuredClone(source.design),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        /* duplicates are MANUAL sheets — never auto-removed even though they
         * start empty (auto-pruning only targets generated sheets) */
        generated: false,
      });
      const sheets = [...s.sheets];
      sheets.splice(idx + 1, 0, copy);
      set({
        sheets,
        categoryVolumes: { ...s.categoryVolumes, [source.category]: vol },
        activeSheetId: copy.id,
      });
      scheduleSave(get());
      const position = idx + 2;
      toast.success(`Duplicated to Sheet ${String(position).padStart(2, "0")}`, {
        description: "Same design, template and category — icons stay where they are.",
      });
    },

    /* ---------------- structure ---------------- */

    moveIcons: (iconIds, targetSheetId, createOverflowSheet) => {
      const s = get();
      const target = s.sheets.find((sh) => sh.id === targetSheetId);
      if (!target) return { moved: [], overflow: [] };
      const template = sheetTemplate(target);
      const capacity = template?.capacity ?? target.iconIds.length;

      const alreadyThere = new Set(target.iconIds);
      const toMove = iconIds.filter((id) => !alreadyThere.has(id));
      const free = capacity - target.iconIds.length;
      const fitting = toMove.slice(0, Math.max(0, free));
      const overflow = toMove.slice(Math.max(0, free));
      /* nothing fits AND no overflow sheet requested → no-op.
       * (drag-onto-a-full-sheet + "Create new sheet" relies on the overflow
       * sheet being created even when fitting.length === 0) */
      if (fitting.length === 0 && !(overflow.length > 0 && createOverflowSheet)) {
        return { moved: [], overflow };
      }

      pushHistory("move-icons");
      /* every icon in `relocated` ends up on the target or the overflow sheet,
       * so it must be pulled out of any other sheet (no duplicate ownership) */
      const relocated = createOverflowSheet ? toMove : fitting;
      const sourceIds = s.sheets
        .filter((sh) => sh.id !== targetSheetId && sh.iconIds.some((id) => relocated.includes(id)))
        .map((sh) => sh.id);
      const mapped = s.sheets.map((sheet) => {
        if (sheet.id === targetSheetId) {
          if (fitting.length === 0) return sheet;
          return stampSheet({ ...sheet, iconIds: [...sheet.iconIds, ...fitting] });
        }
        const removed = sheet.iconIds.filter((id) => !relocated.includes(id));
        if (removed.length === sheet.iconIds.length) return sheet;
        const updated = stampSheet({ ...sheet, iconIds: removed });
        // hero safety: if hero moved out, fall back to first remaining icon
        if (updated.heroIconId && !updated.iconIds.includes(updated.heroIconId)) {
          updated.heroIconId = updated.iconIds[0] ?? null;
        }
        return updated;
      });
      /* generated sheets emptied by the move are removed automatically */
      const pruned = pruneEmptyGenerated(mapped, sourceIds, s.activeSheetId, s.selectedSheetIds);
      announcePrunedSheets(pruned.removed);
      const sheets = pruned.sheets;

      if (overflow.length && createOverflowSheet) {
        const t = sheetTemplate(target);
        const vol = nextVolumeFor(s.sheets, s.categoryVolumes, target.category);
        sheets.push(
          stampSheet({
            id: nextId("sh"),
            templateId: target.templateId,
            /* overflow sheets keep the target's pinned revision (§19) */
            ...(target.templateSnapshot ? { templateSnapshot: structuredClone(target.templateSnapshot) } : {}),
            iconIds: overflow,
            heroIconId: overflow[0] ?? null,
            category: target.category,
            volume: vol,
            volumeAuto: vol,
            volumeManual: false,
            design: structuredClone(t?.defaults ?? createDefaultDesign()),
            createdAt: Date.now(),
            updatedAt: Date.now(),
            generated: true,
          })
        );
      }

      const categoryVolumes =
        overflow.length && createOverflowSheet
          ? { ...s.categoryVolumes, [target.category]: (s.categoryVolumes[target.category] ?? 0) + 1 }
          : s.categoryVolumes;

      set({
        sheets,
        categoryVolumes,
        ...(pruned.removed.length
          ? { activeSheetId: pruned.activeSheetId, selectedSheetIds: pruned.selectedSheetIds }
          : {}),
      });
      scheduleSave(get());
      return { moved: fitting, overflow: createOverflowSheet ? [] : overflow };
    },

    moveIconsToNewSheet: (iconIds, templateId) => {
      const s = get();
      const existing = iconIds.filter((id) => s.icons[id]);
      if (existing.length === 0) return 0;
      const tid = templateId ?? s.sheets[s.sheets.length - 1]?.templateId ?? "t50";
      const template = getTemplate(tid) ?? getTemplate("t50");
      if (!template) return 0;
      /* phase 3 — new sheets created here pin the target's current revision */
      const newSheetRecord = template.sourceType === "custom"
        ? s.customTemplates.find((r) => r.id === template.id) ?? null
        : null;

      pushHistory("move-icons");
      const movingSet = new Set(existing);
      // 1 · pull the icons out of any current sheet (hero safety applies)
      const sourceIds = s.sheets
        .filter((sh) => sh.iconIds.some((id) => movingSet.has(id)))
        .map((sh) => sh.id);
      let sheets = s.sheets.map((sheet) => {
        if (!sheet.iconIds.some((id) => movingSet.has(id))) return sheet;
        const remaining = sheet.iconIds.filter((id) => !movingSet.has(id));
        const updated = stampSheet({ ...sheet, iconIds: remaining });
        if (updated.heroIconId && !remaining.includes(updated.heroIconId)) {
          updated.heroIconId = remaining[0] ?? null;
        }
        return updated;
      });
      /* generated sheets emptied by the move are removed automatically */
      const pruned = pruneEmptyGenerated(sheets, sourceIds, s.activeSheetId, s.selectedSheetIds);
      announcePrunedSheets(pruned.removed);
      sheets = pruned.sheets;
      // 2 · create fresh sheet(s), chunked by template capacity
      const category = "Icon Collection";
      let created = 0;
      for (let i = 0; i < existing.length; i += template.capacity) {
        const chunk = existing.slice(i, i + template.capacity);
        const vol = nextVolumeFor(s.sheets, s.categoryVolumes, category) + created;
        sheets.push(
          stampSheet({
            id: nextId("sh"),
            templateId: template.id,
            ...(newSheetRecord ? { templateSnapshot: buildSheetSnapshot(newSheetRecord) } : {}),
            iconIds: chunk,
            heroIconId: chunk[0] ?? null,
            category,
            volume: vol,
            volumeAuto: vol,
            volumeManual: false,
            design: structuredClone(template.defaults),
            createdAt: Date.now(),
            updatedAt: Date.now(),
            generated: true,
          })
        );
        created++;
      }
      const lastSheet = sheets[sheets.length - 1];
      set({
        sheets,
        categoryVolumes: { ...s.categoryVolumes, [category]: (s.categoryVolumes[category] ?? 0) + created },
        activeSheetId: lastSheet?.id ?? s.activeSheetId,
      });
      scheduleSave(get());
      return created;
    },

    changeSheetTemplate: (sheetId, templateId, strategy) => {
      const s = get();
      const sheet = s.sheets.find((sh) => sh.id === sheetId);
      const template = getTemplate(templateId);
      if (!sheet || !template) return;
      if (sheet.templateId === templateId) return;

      const iconIds = [...sheet.iconIds];
      const keep = iconIds.slice(0, template.capacity);
      const extras = iconIds.slice(template.capacity);

      pushHistory("change-template");
      const oldTemplate = sheetTemplate(sheet);
      /* capacity stamps ("50 ICONS") are template-owned text: update the
       * stamp when it is still the old template's default; custom footer
       * copy written by the user survives untouched. */
      const stampedFooter =
        oldTemplate && sheet.design.footerText === oldTemplate.defaults.footerText
          ? template.defaults.footerText
          : sheet.design.footerText;
      /* Switching TO a custom template: typography/card/background values
       * are canvas-absolute and were authored for another template — on a
       * custom sheet those fields are LIVE (universal editing), so carrying
       * them would restyle the imported artwork with garbage values. They
       * restart from the target's detected defaults; icon appearance and
       * hero scale survive (canvas-independent). Official→official keeps the
       * historical whole-design carry-over, exactly as before. */
      const isTargetCustom = template.sourceType === "custom";
      const designForSwitch = isTargetCustom
        ? {
            ...structuredClone(template.defaults),
            icon: sheet.design.icon,
            hero: {
              ...structuredClone(template.defaults.hero),
              iconScale: sheet.design.hero.iconScale,
              offsetX: sheet.design.hero.offsetX,
              offsetY: sheet.design.hero.offsetY,
              /* canvas-independent hero icon color survives the switch */
              ...(sheet.design.hero.iconColor != null
                ? { iconColor: sheet.design.hero.iconColor }
                : {}),
            },
            spacing: {
              ...structuredClone(template.defaults.spacing),
              iconScale: sheet.design.spacing.iconScale ?? template.defaults.spacing.iconScale,
            },
          }
        : {
            ...sheet.design,
            footerText: stampedFooter,
            spacing: structuredClone(template.defaults.spacing),
            geometryOverrides: {},
          };
      let sheets = s.sheets.map((sh) => {
        if (sh.id !== sheetId) return sh;
        const switched = stampSheet({
          ...sh,
          templateId,
          /* phase 3 — switching pins the sheet to the target's CURRENT
           * revision (immutable snapshot): future edits to that template
           * never retroactively restyle this sheet. Switching to an
           * OFFICIAL template drops any previous custom snapshot (official
           * templates are immutable built-ins — nothing to pin). */
          ...(isTargetCustom ? { templateSnapshot: buildSheetSnapshot(s.customTemplates.find((r) => r.id === templateId)!) } : {}),
          iconIds: keep,
          // hero safety after trimming
          heroIconId: sh.heroIconId && keep.includes(sh.heroIconId) ? sh.heroIconId : keep[0] ?? null,
          /* design (colors/typography/cards) intentionally survives the
           * switch - but geometry does NOT: region overrides and grid
           * spacing are absolute canvas units, meaningless on a different
           * template (esp. across the default-sheet canvas families).
           * The new template's spacing + empty overrides take over. */
          design: designForSwitch,
        });
        if (!isTargetCustom && switched.templateSnapshot !== undefined) {
          delete switched.templateSnapshot;
        }
        return switched;
      });

      if (extras.length) {
        if (strategy === "create-new") {
          const vol = nextVolumeFor(s.sheets, s.categoryVolumes, sheet.category);
          const idx = sheets.findIndex((sh) => sh.id === sheetId);
          sheets.splice(idx + 1, 0, {
            id: nextId("sh"),
            templateId: sheet.templateId,
            /* the overflow sheet keeps the SOURCE sheet's template — clone
             * its pinned snapshot so it stays on the same revision (§19) */
            ...(sheet.templateSnapshot ? { templateSnapshot: structuredClone(sheet.templateSnapshot) } : {}),
            iconIds: extras,
            heroIconId: extras[0] ?? null,
            category: sheet.category,
            volume: vol,
            volumeAuto: vol,
            volumeManual: false,
            design: structuredClone(sheet.design),
            createdAt: Date.now(),
            updatedAt: Date.now(),
            generated: true,
          });
          set({ sheets, categoryVolumes: { ...s.categoryVolumes, [sheet.category]: vol } });
          scheduleSave(get());
          return;
        }
        // strategy === 'move-next': spill into later sheets with capacity
        let remaining = [...extras];
        let mutated = [...sheets];
        for (let i = 0; i < mutated.length && remaining.length; i++) {
          const cand = mutated[i];
          if (cand.id === sheetId) continue;
          if (cand.category !== sheet.category && cand.iconIds.length) continue;
          const cap = sheetTemplate(cand)?.capacity ?? cand.iconIds.length;
          const free = cap - cand.iconIds.length;
          if (free <= 0) continue;
          const fitting = remaining.slice(0, free);
          remaining = remaining.slice(free);
          mutated = mutated.map((sh) =>
            sh.id === cand.id ? stampSheet({ ...sh, iconIds: [...sh.iconIds, ...fitting] }) : sh
          );
        }
        if (remaining.length) {
          const vol = nextVolumeFor(s.sheets, s.categoryVolumes, sheet.category);
          mutated.push({
            id: nextId("sh"),
            templateId,
            ...(isTargetCustom ? { templateSnapshot: buildSheetSnapshot(s.customTemplates.find((r) => r.id === templateId)!) } : {}),
            iconIds: remaining,
            heroIconId: remaining[0] ?? null,
            category: sheet.category,
            volume: vol,
            volumeAuto: vol,
            volumeManual: false,
            design: structuredClone(sheet.design),
            createdAt: Date.now(),
            updatedAt: Date.now(),
          });
          set({ sheets: mutated, categoryVolumes: { ...s.categoryVolumes, [sheet.category]: vol } });
        } else {
          set({ sheets: mutated });
        }
        scheduleSave(get());
        return;
      }

      set({ sheets });
      scheduleSave(get());
    },

    applyDesignToSheets: (targetSheetIds, sourceSheetId) => {
      const s = get();
      const source = s.sheets.find((sh) => sh.id === sourceSheetId);
      if (!source || targetSheetIds.length === 0) return;
      pushHistory("apply-design");
      const sourceTemplate = sheetTemplate(source);
      const sourceIndex = s.sheets.findIndex((sh) => sh.id === sourceSheetId);
      const sourceTitle = sheetTitle(source, Math.max(sourceIndex, 0));
      /* official targets keep the historical whole-design copy. Custom
       * targets route through the preset engine (capability scoping +
       * canvas-ratio rescaling): a design authored on one canvas must not
       * restyle an imported template's artwork with out-of-scale values. */
      let applied = 0;
      let geometryAdjusted = 0;
      const sheets = s.sheets.map((sh) => {
        if (!targetSheetIds.includes(sh.id) || sh.id === sourceSheetId) return sh;
        const targetTemplate = sheetTemplate(sh);
        if (!targetTemplate) return sh;
        if (targetTemplate.sourceType === "custom" && sourceTemplate) {
          const design = structuredClone(sh.design);
          applyPresetToDesign(
            design,
            {
              id: "inline",
              name: source.category,
              createdAt: 0,
              updatedAt: 0,
              sourceTemplateId: source.templateId,
              sourceCanvas: { width: sourceTemplate.width, height: sourceTemplate.height },
              includes: {
                typography: true,
                colors: true,
                appearance: true,
                hero: true,
                layout: true,
              },
              data: {
                typography: source.design.typography,
                captionText: source.design.captionText,
                footerText: source.design.footerText,
                background: source.design.background,
                card: source.design.card,
                rail: source.design.rail,
                icon: source.design.icon,
                hero: source.design.hero,
                spacing: source.design.spacing,
              },
            },
            targetTemplate
          );
          applied++;
          return stampSheet({ ...sh, design });
        }
        /* official target — SAME resolved template → verbatim whole-design
         * copy (the historical behavior). DIFFERENT template → the design's
         * canvas-absolute fields must not transplant, exactly like
         * changeSheetTemplate: grid spacing and text-region geometry
         * overrides are authored for the source canvas, and the capacity
         * stamp footer ("30 ICONS") is template-owned text. Colors,
         * typography styles and card looks still carry over. */
        if (sourceTemplate && sourceTemplate.id !== targetTemplate.id) {
          const design = structuredClone(source.design);
          design.spacing = structuredClone(targetTemplate.defaults.spacing);
          design.geometryOverrides = {};
          if (design.footerText === sourceTemplate.defaults.footerText) {
            design.footerText = targetTemplate.defaults.footerText;
          }
          applied++;
          geometryAdjusted++;
          return stampSheet({ ...sh, design });
        }
        applied++;
        return stampSheet({ ...sh, design: structuredClone(source.design) });
      });
      set({ sheets });
      scheduleSave(get());
      toast.success(`Design applied to ${applied} sheet${applied === 1 ? "" : "s"}`, {
        description:
          `From “${sourceTitle}” — icons, heroes, categories and volumes are never copied.` +
          (geometryAdjusted > 0 ? ` Grid spacing was reset on ${geometryAdjusted} sheet${geometryAdjusted === 1 ? "" : "s"} using another template.` : ""),
      });
    },

    /* ---------------- settings ---------------- */

    setViewMode: (mode) => {
      set({
        settings: { ...get().settings, viewMode: mode },
        /* the cell-color popover only exists in Edit view — leaving it must
         * drop a pending open request so it can't auto-fire on return */
        cellColorPickerOpen: mode === "edit" ? get().cellColorPickerOpen : false,
      });
      scheduleSave(get());
    },

    /* ---------------- UI navigation (round 7) ---------------- */

    setSidebarTab: (tab) => set({ sidebarTab: tab }),
    openInspector: (iconId) => set({ inspectorIconId: iconId }),
    closeInspector: () => set({ inspectorIconId: null }),
    /* cell selection (round 10/11). Plain click → replace with one (or clear
     * if the same icon is clicked again). The anchor tracks the last
     * plain-clicked icon for shift-click range anchoring. */
    setSelectedCell: (sheetId, iconId) =>
      set(iconId === null
        ? { selectedCellIconIds: [], selectedCellSheetId: null, selectedCellAnchorIconId: null, cellColorPickerOpen: false }
        : { selectedCellIconIds: [iconId], selectedCellSheetId: sheetId, selectedCellAnchorIconId: iconId }),
    /* ctrl/cmd-click → toggle one cell in the selection. Sets the anchor to
     * the toggled icon so a following shift-click ranges from it. If the
     * sheet differs, the selection restarts on the new sheet with just
     * this icon. */
    toggleCellInSelection: (sheetId, iconId) => {
      const s = get();
      if (s.selectedCellSheetId !== sheetId) {
        set({ selectedCellIconIds: [iconId], selectedCellSheetId: sheetId, selectedCellAnchorIconId: iconId });
        return;
      }
      const has = s.selectedCellIconIds.includes(iconId);
      const next = has
        ? s.selectedCellIconIds.filter((id) => id !== iconId)
        : [...s.selectedCellIconIds, iconId];
      set({
        selectedCellIconIds: next,
        selectedCellSheetId: next.length > 0 ? sheetId : null,
        selectedCellAnchorIconId: has ? (s.selectedCellAnchorIconId === iconId ? null : s.selectedCellAnchorIconId) : iconId,
        cellColorPickerOpen: next.length > 0 ? s.cellColorPickerOpen : false,
      });
    },
    /* shift-click → range from the anchor to the clicked icon, inclusive,
     * using the active sheet's icon order. If no anchor exists (empty
     * selection or first interaction), falls back to selecting just the
     * clicked icon. The anchor stays at its current value so repeated
     * shift-clicks extend from the same origin. */
    rangeSelectCells: (sheetId, toIconId) => {
      const s = get();
      const sheet = s.sheets.find((sh) => sh.id === sheetId);
      if (!sheet) {
        set({ selectedCellIconIds: [toIconId], selectedCellSheetId: sheetId, selectedCellAnchorIconId: toIconId });
        return;
      }
      const order = sheet.iconIds;
      const anchorId = s.selectedCellAnchorIconId && s.selectedCellSheetId === sheetId && order.includes(s.selectedCellAnchorIconId)
        ? s.selectedCellAnchorIconId
        : toIconId;
      const fromIdx = order.indexOf(anchorId);
      const toIdx = order.indexOf(toIconId);
      if (fromIdx < 0 || toIdx < 0) {
        set({ selectedCellIconIds: [toIconId], selectedCellSheetId: sheetId, selectedCellAnchorIconId: toIconId });
        return;
      }
      const lo = Math.min(fromIdx, toIdx);
      const hi = Math.max(fromIdx, toIdx);
      const range = order.slice(lo, hi + 1);
      set({ selectedCellIconIds: range, selectedCellSheetId: sheetId, selectedCellAnchorIconId: anchorId });
    },
    clearSelectedCell: () => set({ selectedCellIconIds: [], selectedCellSheetId: null, selectedCellAnchorIconId: null, cellColorPickerOpen: false }),
    /* cell-color popover request (round 12) — see the interface comment */
    openCellColorPicker: () => set({ cellColorPickerOpen: true }),
    closeCellColorPicker: () => set({ cellColorPickerOpen: false }),
    setLibraryFilter: (patch) => set({ libraryFilter: { ...get().libraryFilter, ...patch } }),
    focusTag: (tag) =>
      set({ sidebarTab: "library", libraryFilter: { query: "", tags: [tag], tagLogic: get().libraryFilter.tagLogic, mode: "all", sort: get().libraryFilter.sort } }),
    openLibraryDialog: (dialog) => set({ sidebarTab: "library", libraryDialog: dialog }),
    setLibraryDialog: (dialog) => set({ libraryDialog: dialog }),

    toggleGridGuides: () => {
      const s = get();
      set({ settings: { ...s.settings, showGridGuides: !s.settings.showGridGuides } });
      scheduleSave(get());
    },

    setZoom: (zoom) => {
      set({ settings: { ...get().settings, zoom } });
      // zoom is part of WorkspaceSettings → persist (autosave is debounced,
      // so rapid zoom steps coalesce into one IndexedDB write)
      scheduleSave(get());
    },

    setExportPrefs: (prefs) => {
      const s = get();
      const next = { ...(s.settings.export ?? { scope: "active", format: "svg", scale: "2", transparent: false }), ...prefs };
      set({ settings: { ...s.settings, export: next } });
      scheduleSave(get());
    },

    setLibraryDensity: (density) => {
      if (get().settings.libraryDensity === density) return;
      /* density is part of WorkspaceSettings → persists across reloads;
       * optional field, so pre-existing persisted workspaces hydrate as
       * "standard" without any migration */
      set({ settings: { ...get().settings, libraryDensity: density } });
      scheduleSave(get());
    },

    /* ---------------- history ---------------- */

    undo: () => {
      const s = get();
      const entry = s.past[s.past.length - 1];
      if (!entry) return;
      const past = s.past.slice(0, -1);
      /* library-mutating entries capture the library in BOTH directions;
       * the counter-entry inherits the action's deleted-icon delta so a
       * later redo removes exactly those icons. */
      const restoresIcons = entry.state.icons !== undefined;
      const future = [
        { label: entry.label, time: Date.now(), state: snapshotOf(s, restoresIcons) },
        ...s.future,
      ].slice(0, HISTORY_LIMIT);
      if (restoresIcons && entry.state.deletedIconIds) {
        future[0].state.deletedIconIds = entry.state.deletedIconIds;
      }
      if (restoresIcons && entry.state.tagOp) {
        future[0].state.tagOp = true; // counter-entry re-applies tags exactly
      }
      const patch: Partial<StudioState> = {
        sheets: structuredClone(entry.state.sheets),
        categoryVolumes: structuredClone(entry.state.categoryVolumes),
        activeSheetId: entry.state.activeSheetId,
        selectedSheetIds: entry.state.selectedSheetIds,
        past,
        future,
      };
      if (restoresIcons) {
        applyLibrarySnapshot(s, entry.state, patch, "undo");
      }
      set(patch);
      scheduleSave(get());
      toast.info(`Undid ${humanizeLabel(entry.label) || "change"}`, { description: "Ctrl ⇧ Z to redo" });
    },

    redo: () => {
      const s = get();
      const entry = s.future[0];
      if (!entry) return;
      const future = s.future.slice(1);
      const restoresIcons = entry.state.icons !== undefined;
      const past = [...s.past, { label: entry.label, time: Date.now(), state: snapshotOf(s, restoresIcons) }].slice(-HISTORY_LIMIT);
      if (restoresIcons && entry.state.deletedIconIds) {
        past[past.length - 1].state.deletedIconIds = entry.state.deletedIconIds;
      }
      if (restoresIcons && entry.state.tagOp) {
        past[past.length - 1].state.tagOp = true; // counter-entry reverts tags exactly
      }
      const patch: Partial<StudioState> = {
        sheets: structuredClone(entry.state.sheets),
        categoryVolumes: structuredClone(entry.state.categoryVolumes),
        activeSheetId: entry.state.activeSheetId,
        selectedSheetIds: entry.state.selectedSheetIds,
        past,
        future,
      };
      if (restoresIcons) {
        applyLibrarySnapshot(s, entry.state, patch, "redo");
      }
      set(patch);
      scheduleSave(get());
      toast.info(`Redid ${humanizeLabel(entry.label) || "change"}`, { description: "Ctrl Z to undo" });
    },
  };
});

/* ------------------------------------------------------------------ */
/* Selectors                                                           */
/* ------------------------------------------------------------------ */

export function useActiveSheet(): Sheet | null {
  return useStudio((s) => (s.activeSheetId ? s.sheets.find((sh) => sh.id === s.activeSheetId) ?? null : null));
}

export function getSheetById(sheets: Sheet[], id: string | null): Sheet | null {
  if (!id) return null;
  return sheets.find((sh) => sh.id === id) ?? null;
}

export function getUnassignedIconIds(state: { sheets: Sheet[]; iconOrder: string[] }): string[] {
  const assigned = new Set(state.sheets.flatMap((s) => s.iconIds));
  return state.iconOrder.filter((id) => !assigned.has(id));
}

export function getSheetCapacity(sheets: Sheet[], sheetId: string): number {
  const sheet = sheets.find((s) => s.id === sheetId);
  if (!sheet) return 0;
  return sheetTemplate(sheet)?.capacity ?? sheet.iconIds.length;
}
