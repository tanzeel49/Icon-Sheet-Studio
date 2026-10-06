"use client";

/**
 * ICON SHEET STUDIO — TEMPLATE BUILDER (Phase 1) · centralized state.
 *
 * One zustand store owns the builder universe:
 *   · docs[]            — every BuilderDocument draft (docs are data)
 *   · activeDocId       — which doc the editor shows (null → draft list)
 *   · selection[]       — live element selection
 *   · past/future       — STRUCTURED undo history: logical document
 *                         snapshots (never DOM, never screenshots), with
 *                         coalescing keys so typing/dragging bursts undo
 *                         as one step, and a byte-budget eviction so big
 *                         imported SVGs can't balloon memory.
 *
 * Persistence: the SAME IndexedDB database as the studio, additive
 * `builderDocs` store (v4). Writes are debounced (700 ms) and only ever
 * target the docs that actually changed; the save state
 * (unsaved/saving/saved/error) is exposed to the UI and "saved" is set
 * ONLY after IndexedDB confirms the write.
 */

import { create } from "zustand";
import {
  HISTORY_LIMIT,
  createElement,
  newId,
  type BuilderArtboard,
  type BuilderDocument,
  type BuilderElement,
  type BuilderRole,
  type ElementProperties,
} from "./types";
import {
  alignElements,
  distributeElements,
  elementsBBox,
  type AlignMode,
  type DistributeAxis,
  type GeometryPatch,
} from "./geometry";
import { sanitizeDocument, type ValidationIssue } from "./validation";
import { compileBuilderDocument } from "./publish";
import { useStudio } from "@/lib/studio/store";
import type { CustomTemplateRecord } from "@/lib/studio/types";
import {
  deleteBuilderDoc,
  loadBuilderDocs,
  loadBuilderMeta,
  putBuilderDoc,
  putBuilderMeta,
} from "@/lib/studio/idb";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export type BuilderSaveState = "idle" | "unsaved" | "saving" | "saved" | "error";

interface HistoryEntry {
  doc: BuilderDocument;
  label: string;
  /** coalescing key (typing/drag bursts) */
  key?: string;
  docId: string;
  at: number;
}

export interface CreateDocumentOptions {
  name: string;
  width: number;
  height: number;
  background: string;
}

/** Result of publishing a draft into the Template Library. */
export interface PublishResult {
  ok: boolean;
  recordId?: string;
  recordName?: string;
  /** true when an existing record was updated in place (re-publish) */
  updated?: boolean;
  /** blocking issues when ok === false — surfaced verbatim to the user */
  issues: ValidationIssue[];
}

/** Result of opening a published template for re-editing. */
export interface EditPublishedResult {
  ok: boolean;
  reason?: "not-found" | "no-builder-source" | "corrupt";
  docId?: string;
}

interface BuilderStore {
  hydrated: boolean;
  docs: BuilderDocument[];
  activeDocId: string | null;
  selection: string[];
  past: HistoryEntry[];
  future: HistoryEntry[];
  saveState: BuilderSaveState;
  saveError: string | null;
  /** corruption-repair notes from the last hydrate (surfaced once) */
  loadNotes: string[];

  hydrate(): Promise<void>;

  createDocument(opts: CreateDocumentOptions): string;
  openDocument(id: string): void;
  closeDocument(): void;
  deleteDocument(id: string): void;
  renameDocument(id: string, name: string): void;

  /** compile the ACTIVE document and register it in the Template Library.
   *  First save creates a new record; later saves UPDATE that record in
   *  place (same id → existing sheets keep working). Never saves an
   *  invalid template — returns the blocking issues instead. */
  publishDocument(docId: string): PublishResult;
  /** reconstruct an editable draft from a published record's embedded
   *  BuilderDocument (never reverse-engineered from the rendered SVG) */
  editPublishedTemplate(recordId: string): EditPublishedResult;
  /** reset the active document's layout to the default builder
   *  configuration (undoable — flows through commit) */
  resetLayout(): void;

  /** THE single mutation path — history + persistence ride along. */
  commit(label: string, mutator: (doc: BuilderDocument) => void, key?: string): void;
  undo(): void;
  redo(): void;

  addElement(el: BuilderElement): void;
  updateElements(
    ids: string[],
    patch: Partial<BuilderElement> | ((el: BuilderElement) => Partial<BuilderElement>),
    opts?: { label?: string; key?: string }
  ): void;
  updateElementProps<P extends ElementProperties>(
    id: string,
    patch: Partial<P>,
    opts?: { label?: string; key?: string }
  ): void;
  deleteElements(ids: string[]): void;
  duplicateElements(ids: string[]): void;
  reorderElements(ids: string[], action: "up" | "down" | "front" | "back"): void;

  alignSelection(mode: AlignMode): void;
  distributeSelection(axis: DistributeAxis): void;

  setSelection(ids: string[]): void;
  toggleSelection(id: string): void;
  selectAll(): void;

  setArtboard(patch: Partial<BuilderArtboard>, key?: string): void;

  saveNow(): Promise<void>;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** array index is the z-order truth — keep the mirror field in sync */
function reindex(elements: BuilderElement[]): void {
  elements.forEach((el, i) => (el.zIndex = i));
}

/** cheap payload estimate — drives history eviction (bounds memory) */
function estimateDocBytes(doc: BuilderDocument): number {
  let bytes = 4096;
  for (const el of doc.elements) {
    bytes += 1024;
    const svg = el.type === "svg" ? (el.properties as { svg?: string }).svg : undefined;
    if (svg) bytes += svg.length;
    if (el.type === "text") bytes += (el.properties as { content?: string }).content?.length ?? 0;
  }
  return bytes;
}

const HISTORY_BYTES_BUDGET = 50 * 1024 * 1024; // 50 MB across past+future

function evictHistory(entries: HistoryEntry[]): HistoryEntry[] {
  let total = entries.reduce((a, e) => a + estimateDocBytes(e.doc), 0);
  let out = entries;
  while (out.length > 2 && (total > HISTORY_BYTES_BUDGET || out.length > HISTORY_LIMIT)) {
    total -= estimateDocBytes(out[0].doc);
    out = out.slice(1);
  }
  return out;
}

export function getActiveDoc(state: Pick<BuilderStore, "docs" | "activeDocId">): BuilderDocument | null {
  return state.docs.find((d) => d.id === state.activeDocId) ?? null;
}

export function getSelectedElements(state: Pick<BuilderStore, "docs" | "activeDocId" | "selection">): BuilderElement[] {
  const doc = getActiveDoc(state);
  if (!doc) return [];
  return doc.elements.filter((el) => state.selection.includes(el.id));
}

/* ------------------------------------------------------------------ */
/* Persistence engine (module-scoped — one timer, serial flushes)      */
/* ------------------------------------------------------------------ */

const SAVE_DEBOUNCE_MS = 700;

let saveTimer: ReturnType<typeof setTimeout> | null = null;
const dirtyDocs = new Set<string>();
const deletedDocs = new Set<string>();
let metaDirty = false;
let flushChain: Promise<void> = Promise.resolve();

function builderMetaRow(): { id: "__builderMeta__"; activeDocId: string | null; docOrder: string[] } {
  const st = useBuilderStore.getState();
  return { id: "__builderMeta__", activeDocId: st.activeDocId, docOrder: st.docs.map((d) => d.id) };
}

function doFlush(): Promise<void> {
  return (async () => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    const ids = [...dirtyDocs];
    dirtyDocs.clear();
    const deletes = [...deletedDocs];
    deletedDocs.clear();
    const withMeta = metaDirty;
    metaDirty = false;
    if (!ids.length && !deletes.length && !withMeta) return;

    useBuilderStore.setState({ saveState: "saving", saveError: null });
    try {
      const st = useBuilderStore.getState();
      for (const id of ids) {
        const doc = st.docs.find((d) => d.id === id);
        if (doc) await putBuilderDoc(doc);
      }
      for (const id of deletes) await deleteBuilderDoc(id);
      await putBuilderMeta(builderMetaRow());
      useBuilderStore.setState({ saveState: "saved" });
    } catch (err) {
      console.error("[builder] autosave failed", err);
      useBuilderStore.setState({
        saveState: "error",
        saveError: err instanceof Error ? err.message : "Persistence failed",
      });
    }
  })();
}

function scheduleSave(docId?: string, withMeta = false): void {
  if (docId) dirtyDocs.add(docId);
  if (withMeta) metaDirty = true;
  useBuilderStore.setState({ saveState: "unsaved" });
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    flushChain = flushChain.then(() => doFlush());
  }, SAVE_DEBOUNCE_MS);
}

/* ------------------------------------------------------------------ */
/* Store                                                               */
/* ------------------------------------------------------------------ */

export const useBuilderStore = create<BuilderStore>()((set, get) => ({
  hydrated: false,
  docs: [],
  activeDocId: null,
  selection: [],
  past: [],
  future: [],
  saveState: "idle",
  saveError: null,
  loadNotes: [],

  hydrate: async () => {
    if (get().hydrated) return;
    const [rawDocs, meta] = await Promise.all([loadBuilderDocs(), loadBuilderMeta()]);
    const notes: string[] = [];
    const docs: BuilderDocument[] = [];
    let repairedAny = false;
    for (const raw of rawDocs) {
      const result = sanitizeDocument(raw);
      if (result.notes.length) {
        repairedAny = true;
        notes.push(...result.notes.map((n) => `"${raw.name ?? "Untitled"}": ${n}`));
      }
      if (result.doc) docs.push(result.doc);
    }
    const order = meta?.docOrder ?? [];
    docs.sort((a, b) => {
      const ia = order.indexOf(a.id);
      const ib = order.indexOf(b.id);
      return (
        (ia < 0 ? Number.MAX_SAFE_INTEGER : ia) - (ib < 0 ? Number.MAX_SAFE_INTEGER : ib) ||
        a.metadata.createdAt - b.metadata.createdAt
      );
    });
    const activeDocId =
      meta?.activeDocId && docs.some((d) => d.id === meta.activeDocId)
        ? meta.activeDocId
        : docs.length > 0
          ? docs[0].id
          : null;

    set({
      hydrated: true,
      docs,
      activeDocId,
      selection: [],
      past: [],
      future: [],
      loadNotes: notes,
      saveState: docs.length > 0 ? "saved" : "idle",
    });
    if (repairedAny) scheduleSave(undefined, true); // write repairs back
  },

  /* ------------------------- doc lifecycle ------------------------- */

  createDocument: ({ name, width, height, background }) => {
    const doc: BuilderDocument = {
      id: newId("doc"),
      name: name.trim() || "Untitled Template",
      version: 1,
      artboard: { width, height, background },
      elements: [],
      metadata: { createdAt: Date.now(), updatedAt: Date.now() },
    };
    doc.elements.push(createElement({ type: "background", artboard: doc.artboard }));
    reindex(doc.elements);
    set({
      docs: [...get().docs, doc],
      activeDocId: doc.id,
      selection: [],
      past: [],
      future: [],
    });
    scheduleSave(doc.id, true);
    return doc.id;
  },

  openDocument: (id) => {
    if (get().activeDocId === id) return;
    set({ activeDocId: id, selection: [], past: [], future: [] });
    scheduleSave(undefined, true);
  },

  closeDocument: () => {
    set({ activeDocId: null, selection: [], past: [], future: [] });
    scheduleSave(undefined, true);
  },

  deleteDocument: (id) => {
    const { docs, activeDocId } = get();
    const next = docs.filter((d) => d.id !== id);
    dirtyDocs.delete(id);
    deletedDocs.add(id);
    set({
      docs: next,
      activeDocId: activeDocId === id ? null : activeDocId,
      selection: [],
      past: [],
      future: [],
    });
    scheduleSave(undefined, true);
  },

  renameDocument: (id, name) => {
    const trimmed = name.trim().slice(0, 120);
    const { docs, activeDocId } = get();
    const idx = docs.findIndex((d) => d.id === id);
    if (idx < 0 || !trimmed) return;
    const nextDocs = docs.slice();
    nextDocs[idx] = { ...docs[idx], name: trimmed, metadata: { ...docs[idx].metadata, updatedAt: Date.now() } };
    set({ docs: nextDocs });
    scheduleSave(id, true);
  },

  /* --------------------- publish / re-edit ------------------------- */

  publishDocument: (docId) => {
    const { docs } = get();
    const idx = docs.findIndex((d) => d.id === docId);
    if (idx < 0) return { ok: false, issues: [{ level: "error", message: "No open document to save." }] };
    const doc = docs[idx];

    const name = doc.name.trim();
    if (!name) {
      return { ok: false, issues: [{ level: "error", message: "Template name is required — set a name before saving to the Template Library." }] };
    }

    const studio = useStudio.getState();
    const existingId = doc.metadata.publishedTemplateId ?? null;
    const existing = existingId ? studio.customTemplates.find((r) => r.id === existingId) ?? null : null;

    /* duplicate-name guard (the record being updated keeps its own name) */
    const clash = studio.customTemplates.find(
      (r) => r.id !== existing?.id && r.name.trim().toLowerCase() === name.toLowerCase()
    );
    if (clash) {
      return {
        ok: false,
        issues: [
          {
            level: "error",
            message: `A template named “${clash.name}” already exists in the Template Library — rename this template first.`,
          },
        ],
      };
    }

    const compiled = compileBuilderDocument(doc);
    if (!compiled.ok || !compiled.record) {
      return { ok: false, issues: compiled.errors.length ? compiled.errors : [{ level: "error", message: "The template could not be compiled." }] };
    }

    if (existing) {
      /* re-publish: SAME id → sheets keep their templateId reference (phase 3:
       * the update bumps the record's revision — pinned sheets are untouched
       * and can update explicitly). If the record vanished from the library
       * while this draft stayed open (deleted elsewhere), fall back to a
       * fresh import instead of reporting a phantom success. */
      const record: CustomTemplateRecord = {
        ...compiled.record,
        id: existing.id,
        createdAt: existing.createdAt,
      };
      const updated = useStudio.getState().updateCustomTemplateRecord(record);
      if (updated) {
        return { ok: true, recordId: record.id, recordName: record.name, updated: true, issues: compiled.warnings };
      }
      const imported = useStudio.getState().importCustomTemplate(compiled.record, { silent: true });
      /* link the draft to the NEW record (same as a first publish) */
      const fallbackDocs = get().docs.slice();
      const fi = fallbackDocs.findIndex((d) => d.id === docId);
      if (fi >= 0) {
        fallbackDocs[fi] = {
          ...fallbackDocs[fi],
          metadata: { ...fallbackDocs[fi].metadata, publishedTemplateId: imported.id, updatedAt: Date.now() },
        };
        set({ docs: fallbackDocs });
        scheduleSave(docId);
      }
      return { ok: true, recordId: imported.id, recordName: imported.name, updated: false, issues: compiled.warnings };
    }

    /* first publish — silent import, the builder UI owns the feedback */
    const record = useStudio.getState().importCustomTemplate(compiled.record, { silent: true });

    /* link the draft to the new record (non-history update, like rename) */
    const nextDocs = get().docs.slice();
    const i = nextDocs.findIndex((d) => d.id === docId);
    if (i >= 0) {
      nextDocs[i] = {
        ...nextDocs[i],
        metadata: { ...nextDocs[i].metadata, publishedTemplateId: record.id, updatedAt: Date.now() },
      };
      set({ docs: nextDocs });
      scheduleSave(docId);
    }
    return { ok: true, recordId: record.id, recordName: record.name, updated: false, issues: compiled.warnings };
  },

  editPublishedTemplate: (recordId) => {
    const record = useStudio.getState().customTemplates.find((r) => r.id === recordId) ?? null;
    if (!record) return { ok: false, reason: "not-found" };
    if (!record.builderDoc) return { ok: false, reason: "no-builder-source" };
    const sanitized = sanitizeDocument(structuredClone(record.builderDoc));
    const doc = sanitized.doc;
    if (!doc) return { ok: false, reason: "corrupt" };

    const { docs } = get();
    const existingIdx = docs.findIndex((d) => d.id === doc.id);
    let nextDocs: BuilderDocument[];
    if (existingIdx >= 0) {
      /* the draft still exists — resume IT (it may hold newer edits than
       * the published snapshot); just re-assert the publish link */
      nextDocs = docs.slice();
      nextDocs[existingIdx] = {
        ...docs[existingIdx],
        metadata: { ...docs[existingIdx].metadata, publishedTemplateId: recordId },
      };
    } else {
      /* draft was deleted — resurrect it from the embedded snapshot */
      doc.metadata.publishedTemplateId = recordId;
      nextDocs = [...docs, doc];
    }
    set({ docs: nextDocs, activeDocId: doc.id, selection: [], past: [], future: [] });
    scheduleSave(doc.id, true);
    return { ok: true, docId: doc.id };
  },

  resetLayout: () => {
    const { activeDocId } = get();
    if (!activeDocId) return;
    get().commit("Reset layout", (doc) => {
      doc.artboard = { width: 1200, height: 1200, background: "#FFFFFF" };
      doc.elements = [createElement({ type: "background", artboard: doc.artboard })];
      /* the publish link intentionally survives — the draft stays tied to
       * its library record; saving again simply updates that record */
    });
    set({ selection: [] });
  },

  /* --------------------------- history ----------------------------- */

  commit: (label, mutator, key) => {
    const { docs, activeDocId, past, future, selection } = get();
    const idx = docs.findIndex((d) => d.id === activeDocId);
    if (idx < 0) return;
    const before = docs[idx];
    const next = structuredClone(before);
    mutator(next);
    next.metadata.updatedAt = Date.now();
    reindex(next.elements);

    const last = past[past.length - 1];
    const coalesce =
      !!key && last?.key === key && last.docId === next.id && Date.now() - last.at < 1200;
    const nextPast = coalesce
      ? past
      : evictHistory([...past, { doc: before, label, key, docId: next.id, at: Date.now() }]);
    const nextDocs = docs.slice();
    nextDocs[idx] = next;

    set({
      docs: nextDocs,
      past: nextPast,
      future: key ? (coalesce ? future : []) : [],
      selection: selection.filter((id) => next.elements.some((el) => el.id === id)),
    });
    scheduleSave(next.id);
  },

  undo: () => {
    const { past, future, docs, activeDocId, selection } = get();
    if (past.length === 0) return;
    const entry = past[past.length - 1];
    if (entry.docId !== activeDocId) {
      set({ past: past.slice(0, -1) });
      return;
    }
    const idx = docs.findIndex((d) => d.id === activeDocId);
    if (idx < 0) return;
    const restored = structuredClone(entry.doc);
    const nextDocs = docs.slice();
    nextDocs[idx] = restored;
    set({
      docs: nextDocs,
      past: past.slice(0, -1),
      future: evictHistory([
        ...future,
        { doc: docs[idx], label: entry.label, docId: entry.docId, at: Date.now() },
      ]),
      selection: selection.filter((id) => restored.elements.some((el) => el.id === id)),
    });
    scheduleSave(restored.id);
  },

  redo: () => {
    const { past, future, docs, activeDocId, selection } = get();
    if (future.length === 0) return;
    const entry = future[future.length - 1];
    if (entry.docId !== activeDocId) {
      set({ future: future.slice(0, -1) });
      return;
    }
    const idx = docs.findIndex((d) => d.id === activeDocId);
    if (idx < 0) return;
    const restored = structuredClone(entry.doc);
    const nextDocs = docs.slice();
    nextDocs[idx] = restored;
    set({
      docs: nextDocs,
      past: evictHistory([...past, { doc: docs[idx], label: entry.label, docId: entry.docId, at: Date.now() }]),
      future: future.slice(0, -1),
      selection: selection.filter((id) => restored.elements.some((el) => el.id === id)),
    });
    scheduleSave(restored.id);
  },

  /* --------------------------- elements ---------------------------- */

  addElement: (el) => {
    get().commit(`Add ${el.name}`, (doc) => {
      doc.elements.push(el);
    });
    set({ selection: [el.id] });
  },

  updateElements: (ids, patch, opts) => {
    const idSet = new Set(ids);
    get().commit(opts?.label ?? "Edit elements", (doc) => {
      for (const el of doc.elements) {
        if (!idSet.has(el.id)) continue;
        const p = typeof patch === "function" ? patch(el) : patch;
        for (const [k, v] of Object.entries(p)) {
          if (v === undefined) continue;
          (el as unknown as Record<string, unknown>)[k] = v;
        }
      }
    }, opts?.key);
  },

  updateElementProps: (id, patch, opts) => {
    get().commit(opts?.label ?? "Change properties", (doc) => {
      const el = doc.elements.find((e) => e.id === id);
      if (!el) return;
      el.properties = { ...el.properties, ...patch } as ElementProperties;
      /* square-cell invariant: every write site funnels through here */
      if (el.type === "icon-grid") {
        const p = el.properties as import("./types").GridElementProperties;
        if (p.squareCells) {
          if ("cellWidth" in patch) p.cellHeight = p.cellWidth;
          else if ("cellHeight" in patch) p.cellWidth = p.cellHeight;
        }
      }
    }, opts?.key);
  },

  deleteElements: (ids) => {
    if (ids.length === 0) return;
    const idSet = new Set(ids);
    get().commit(`Delete ${ids.length} element${ids.length > 1 ? "s" : ""}`, (doc) => {
      doc.elements = doc.elements.filter((el) => !idSet.has(el.id));
    });
    set({ selection: [] });
  },

  duplicateElements: (ids) => {
    if (ids.length === 0) return;
    const doc0 = getActiveDoc(get());
    if (!doc0) return;
    const clones: BuilderElement[] = [];
    const newSelection: string[] = [];
    for (const id of ids) {
      const src = doc0.elements.find((e) => e.id === id);
      if (!src) continue;
      const clone = structuredClone(src);
      clone.id = newId("el");
      clone.name = `${src.name} copy`;
      clone.x = Math.round((src.x + 24) * 100) / 100;
      clone.y = Math.round((src.y + 24) * 100) / 100;
      clones.push(clone);
      newSelection.push(clone.id);
    }
    if (!clones.length) return;
    get().commit(`Duplicate ${clones.length} element${clones.length > 1 ? "s" : ""}`, (doc) => {
      doc.elements.push(...clones);
    });
    set({ selection: newSelection });
  },

  reorderElements: (ids, action) => {
    if (ids.length === 0) return;
    get().commit("Reorder layers", (doc) => {
      const idSet = new Set(ids);
      const selected = doc.elements.filter((el) => idSet.has(el.id)); // keeps relative order
      const rest = doc.elements.filter((el) => !idSet.has(el.id));
      if (action === "front") doc.elements = [...rest, ...selected];
      else if (action === "back") doc.elements = [...selected, ...rest];
      else {
        const dir = action === "up" ? 1 : -1;
        const arr = doc.elements.slice();
        // one swap step per selected element; swaps between two selected
        // neighbors are skipped (they keep their relative order)
        const moves: { el: BuilderElement; from: number; to: number }[] = [];
        for (let i = 0; i < arr.length; i++) {
          const el = arr[i];
          if (!idSet.has(el.id)) continue;
          const j = i + dir;
          if (j < 0 || j >= arr.length || idSet.has(arr[j].id)) continue;
          moves.push({ el, from: i, to: j });
        }
        // apply swaps from the far end first to keep indexes stable
        moves.sort((a, b) => (dir === 1 ? b.to - a.to : a.to - b.to));
        for (const m of moves) {
          const other = arr[m.to];
          arr[m.to] = m.el;
          arr[m.from] = other;
        }
        doc.elements = arr;
      }
    });
  },

  /* ------------------------- alignment ----------------------------- */

  alignSelection: (mode) => {
    const els = getSelectedElements(get());
    if (els.length === 0) return;
    const doc = getActiveDoc(get());
    if (!doc) return;
    const bounds =
      els.length > 1
        ? elementsBBox(els)!
        : { x: 0, y: 0, width: doc.artboard.width, height: doc.artboard.height };
    const patches = alignElements(els, mode, bounds);
    get().commit(`Align ${mode}`, (d) => {
      applyGeometryPatches(d, patches);
    });
  },

  distributeSelection: (axis) => {
    const els = getSelectedElements(get());
    if (els.length < 3) return;
    const patches = distributeElements(els, axis);
    if (patches.length === 0) return;
    get().commit(`Distribute ${axis}`, (d) => {
      applyGeometryPatches(d, patches);
    });
  },

  /* ------------------------- selection ----------------------------- */

  setSelection: (ids) => set({ selection: ids }),
  toggleSelection: (id) =>
    set((s) => ({
      selection: s.selection.includes(id) ? s.selection.filter((x) => x !== id) : [...s.selection, id],
    })),
  selectAll: () => {
    const doc = getActiveDoc(get());
    if (!doc) return;
    set({ selection: doc.elements.map((el) => el.id) });
  },

  /* -------------------------- artboard ----------------------------- */

  setArtboard: (patch, key) => {
    get().commit(
      "Artboard",
      (doc) => {
        if (patch.width !== undefined) doc.artboard.width = Math.round(patch.width);
        if (patch.height !== undefined) doc.artboard.height = Math.round(patch.height);
        if (patch.background !== undefined) {
          doc.artboard.background = patch.background;
          // keep the base background element in sync with the board
          for (const el of doc.elements) {
            if (el.type === "background") {
              el.properties = { ...(el.properties as { fill: string }), fill: patch.background };
            }
          }
        }
      },
      key
    );
  },

  /* ------------------------ persistence ---------------------------- */

  saveNow: () => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    flushChain = flushChain.then(() => doFlush());
    return flushChain;
  },
}));

function applyGeometryPatches(doc: BuilderDocument, patches: GeometryPatch[]): void {
  for (const patch of patches) {
    const el = doc.elements.find((e) => e.id === patch.id);
    if (!el) continue;
    if (patch.x !== undefined) el.x = patch.x;
    if (patch.y !== undefined) el.y = patch.y;
  }
}

/* ------------------------------------------------------------------ */
/* Convenience: build an element against the ACTIVE artboard           */
/* ------------------------------------------------------------------ */

export function insertElement(type: Parameters<typeof createElement>[0]["type"], extra?: Parameters<typeof createElement>[0]): BuilderElement {
  const doc = getActiveDoc(useBuilderStore.getState());
  if (!doc) throw new Error("No open document");
  const el = createElement({ ...(extra ?? {}), type, artboard: doc.artboard });
  useBuilderStore.getState().addElement(el);
  return el;
}

/** Role helpers used by the properties panel (role = semantic meaning). */
export function setElementRole(id: string, role: BuilderRole): void {
  useBuilderStore.getState().updateElements([id], { role }, { label: "Change role" });
}
