"use client";

/**
 * ICON SHEET STUDIO — Application shell.
 * Boots the workspace (IndexedDB hydrate → render), wires autosave
 * indicator, undo/redo shortcuts, the three-column desktop layout with
 * mobile drawers, and the sticky footer.
 *
 * Also owns the OUTER DndContext: library tiles (drag sources, left
 * sidebar) → overview sheet cards (drop targets, center). The sheet-nav
 * reorder context nests inside and keeps handling its own rows.
 */

import { useEffect, useState, useCallback, useMemo, useSyncExternalStore } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  rectIntersection,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragStartEvent,
  type DragEndEvent,
} from "@dnd-kit/core";
import { useStudio, getSheetCapacity, attachSaveListener, ZOOM_MIN, ZOOM_MAX } from "@/lib/studio/store";
import { logStrokeDiagnostics } from "@/lib/studio/stroke-diagnostics";
import { markDragEnd } from "@/lib/studio/drag-gate";
import { createSampleIconFiles } from "@/lib/studio/samples";
import { Header } from "./header";
import { Sidebar } from "./sidebar";
import { MultiSheetWorkspace } from "./multi-sheet-workspace";
import { Overview } from "./overview";
import { PropertiesPanel } from "./properties-panel";
import { ExportDialog } from "./export-panel";
import { ShortcutsDialog } from "./shortcuts-dialog";
import { CommandPalette, type PaletteCommand } from "./command-palette";
import { IconInspector } from "./icon-inspector";
import { TagManagerDialog } from "./tag-manager";
import { CatalogDialog } from "./catalog-dialog";
import { HealthReportDialog } from "./health-report";
import { TemplateImportDialog } from "./template-import-dialog";
import { BackupDialog } from "./backup-dialog";
import { StrokeReportDialog } from "./stroke-report-dialog";
import { SimilarityDialog } from "./similarity-dialog";
import { AISettingsDialog } from "./ai-settings-dialog";
import { DuplicateImportDialog } from "./duplicate-import-dialog";
import { UploadDropzone } from "./icon-library";
import { TemplateBuilder } from "@/components/builder/template-builder";
import { TemplateLibraryDialog } from "@/components/builder/template-library-dialog";
import { UpdaterDialog, triggerUpdateCheck } from "./updater-dialog";
import { VersionHistoryDialog } from "./version-history-dialog";
import { RecoveryDialog } from "./recovery-dialog";
import { StorageRecoveryDialog } from "./storage-recovery-dialog";
import { useBuilderStore } from "@/lib/builder/store";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Layers, SlidersHorizontal, HardDriveDownload, Sparkles, GripHorizontal, FileDown, Keyboard, Download as DownloadIcon, Settings2, PenLine, ArrowDownUp, History, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { useAISettings } from "@/lib/studio/ai-settings";

/**
 * Footer "Download project (.zip)" click trigger. The packaging endpoint
 * (/api/download-source) already rebuilds the archive from the CURRENT
 * source on every request (force-dynamic + Cache-Control: no-store), but a
 * browser could still be holding a cached copy captured before those
 * headers existed. Each plain click therefore navigates to a UNIQUE
 * cache-busting URL (?fresh=<now>) through a throwaway anchor — a stale
 * cache hit becomes impossible by construction, so the user always gets
 * the very latest .zip of the project.
 */
function triggerFreshSourceDownload() {
  const anchor = document.createElement("a");
  anchor.href = `/api/download-source?fresh=${Date.now()}`;
  anchor.download = "icon-sheet-studio.zip";
  document.body.appendChild(anchor);
  anchor.click();
  window.setTimeout(() => anchor.remove(), 0);
}

function EmptyState() {
  return (
    <div className="flex-1 grid place-items-center p-6 overflow-auto custom-scroll">
      <div className="w-full max-w-md space-y-5 text-center py-10">
        {/* logo — small, quiet product mark; the copy and dropzone lead,
         * not the glyph. Halo is decorative and hidden from screen readers. */}
        <div className="relative mx-auto h-11 w-11 grid place-items-center" aria-hidden="true">
          <div className="empty-state-halo absolute inset-0 rounded-full" />
          <div className="studio-brand-logo relative h-11 w-11 rounded-xl grid place-items-center">
            <Layers className="h-5 w-5" />
          </div>
        </div>
        <div className="space-y-1.5">
          <h1 className="text-lg font-semibold tracking-tight">Icon Sheet Studio</h1>
          <p className="text-[13px] text-muted-foreground leading-relaxed">
            Turn collections of <span className="font-medium text-foreground">100 – 5,000+ SVG icons</span> into
            professional icon-sheet artwork — sheets, heroes, typography and export in minutes.
          </p>
        </div>
        <UploadDropzone />
        <div className="flex items-center justify-center gap-3">
          <span className="h-px w-8 bg-border" aria-hidden="true" />
          <Button
            variant="ghost"
            size="sm"
            className="empty-state-cta h-7 gap-1.5 text-[11px] text-muted-foreground"
            onClick={async () => {
              const { files, tagsByName } = createSampleIconFiles(64);
              await useStudio.getState().importWithDuplicateCheck(files, tagsByName, {
                successMessage: "Loaded 64 sample icons — try the full workflow",
              });
            }}
          >
            <Sparkles className="h-3 w-3" />
            Load 64 sample icons
          </Button>
          <span className="h-px w-8 bg-border" aria-hidden="true" />
        </div>
        <div className="grid grid-cols-3 gap-2 text-[10px] text-muted-foreground">
          {[
            { icon: HardDriveDownload, label: "Local-first" },
            { icon: Layers, label: "Auto-saved" },
            { icon: SlidersHorizontal, label: "Per-sheet design" },
          ].map(({ icon: Icon, label }) => (
            <div
              key={label}
              className="empty-state-feature-card flex flex-col items-center gap-1.5 rounded-lg border border-border/70 bg-card py-3 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring"
              tabIndex={0}
            >
              <span className="empty-state-feature-icon">
                <Icon className="h-3.5 w-3.5" />
              </span>
              {label}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Library → sheet drag types                                          */
/* ------------------------------------------------------------------ */

interface LibraryDragData {
  type?: string;
  iconIds?: string[];
  /* sheet-cell drags (reorder within the active sheet's grid) */
  iconId?: string;
  sheetId?: string;
  fromIndex?: number;
}
interface SheetDropData {
  type?: string;
  sheetId?: string;
  /* sheet-cell drop targets: the grid index the payload lands on */
  index?: number;
}

interface ActiveLibraryDrag {
  iconIds: string[];
  previews: { id: string; svg: string }[];
  count: number;
}

interface DropOverflowState {
  iconIds: string[];
  targetSheetId: string;
  targetSheetLabel: string;
  overflowCount: number;
  toMoveCount: number;
}

/* pointer-first collision: precise over cards/cells, fallback for edges.
 * Typed compatibility: each draggable type only collides with droppable
 * types it actually targets. Without this, the nested canvas-vs-cell
 * containment would let the big canvas droppable eat drops aimed at a
 * specific grid cell (pointerWithin sorts by pointer-to-corner distance —
 * the tighter cell rect wins when the pointer is over it, but only if the
 * collision list still contains it after filtering). */
const DND_COMPAT: Record<string, string[]> = {
  /* library icons may land on the canvas (append) OR on a precise cell
   * (insert) — pointerWithin's distance sort puts the tighter cell rect
   * first, so a drop over a cell becomes an insert while canvas-area drops
   * keep the append semantics */
  "library-icon": ["sheet-card", "sheet-cell"],
  "sheet-cell": ["sheet-cell"],
};
const libraryCollision: CollisionDetection = (args) => {
  const activeType = (args.active.data.current as LibraryDragData | undefined)?.type;
  const allowed = activeType ? DND_COMPAT[activeType] : undefined;
  const compatible = (collisions: ReturnType<CollisionDetection>) => {
    if (!allowed) return collisions;
    const types = new Map<ReturnType<CollisionDetection>[number]["id"], string | undefined>();
    for (const d of args.droppableContainers) {
      types.set(d.id, (d.data.current as SheetDropData | undefined)?.type);
    }
    return collisions.filter((c) => {
      const t = types.get(c.id);
      return t !== undefined && allowed.includes(t);
    });
  };
  const pointer = compatible(pointerWithin(args));
  if (pointer.length > 0) return pointer;
  return compatible(rectIntersection(args));
};

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * FooterContext — a live, always-visible workspace summary that sits in the
 * center of the sticky footer. It surfaces, in priority order:
 *   1. multi-sheet selection count (when ≥2 sheets are selected for batch
 *      design-apply) — the amber badge makes a transient batch state obvious
 *      without needing to scan the sidebar; clicking it clears the selection
 *      (a one-step escape hatch, mirroring the Esc shortcut);
 *   2. the active sheet's context (Sheet NN · Category · VOL · fill count) —
 *      gives the canvas a persistent identity strip so you always know which
 *      sheet you are editing. Clicking it jumps to edit mode AND scrolls the
 *      matching sidebar row into view + briefly flashes it, so a glance at
 *      the footer can re-orient you in the sheet list;
 *   3. nothing (empty) on the landing/empty state.
 */
function FooterContext() {
  const sheets = useStudio((s) => s.sheets);
  const activeSheetId = useStudio((s) => s.activeSheetId);
  const selectedSheetIds = useStudio((s) => s.selectedSheetIds);
  const viewMode = useStudio((s) => s.settings.viewMode);
  const setViewMode = useStudio((s) => s.setViewMode);
  const clearSheetSelection = useStudio((s) => s.clearSheetSelection);
  /* round 10/11: cell selection (edit view). Shown as a pill that
   * clicks-to-deselect. Single selection shows "1 cell · {name}"; multi
   * (≥2) shows "N cells selected". Mirrors the sheet-selection badge pattern. */
  const selectedCellIconIds = useStudio((s) => s.selectedCellIconIds);
  const selectedCellSheetId = useStudio((s) => s.selectedCellSheetId);
  const icons = useStudio((s) => s.icons);
  const clearSelectedCell = useStudio((s) => s.clearSelectedCell);

  const selectedCount = selectedSheetIds.length;
  const active = activeSheetId ? sheets.find((s) => s.id === activeSheetId) ?? null : null;
  const cellCount = selectedCellIconIds.length;

  /* click on the selection badge → clear (same as the Esc shortcut, but
   * mouse-accessible from the footer) */
  if (selectedCount >= 2) {
    return (
      <button
        type="button"
        onClick={() => {
          clearSheetSelection();
          toast.info("Cleared sheet selection");
        }}
        className="footer-context-button hidden md:inline-flex items-center gap-1.5 font-mono tabular-nums"
        role="status"
        aria-label={`${selectedCount} sheets selected. Click to clear the selection.`}
        title={`${selectedCount} sheets selected — click to clear (or press Esc)`}
      >
        <span className="footer-selection-badge" aria-hidden />
        {selectedCount} sheets selected
      </button>
    );
  }

  /* multi-cell selection (round 11) — ≥2 cells selected in the edit view.
   * Shows "N cells selected"; clicking clears the cell selection. */
  if (cellCount >= 2 && selectedCellSheetId && viewMode === "edit") {
    return (
      <button
        type="button"
        onClick={() => {
          clearSelectedCell();
          toast.info("Cleared cell selection");
        }}
        className="footer-context-button hidden md:inline-flex items-center gap-1.5 min-w-0 max-w-[42vw] truncate"
        role="status"
        aria-live="polite"
        aria-label={`${cellCount} cells selected. Click to clear the cell selection.`}
        title={`${cellCount} cells selected — click to clear`}
      >
        <span className="footer-cell-dot" aria-hidden />
        <span className="text-foreground/80 font-medium">{cellCount} cells</span>
        <span className="text-muted-foreground/50">·</span>
        <span className="truncate text-muted-foreground">selected</span>
      </button>
    );
  }

  /* single-cell selection (round 10) — 1 cell selected in the edit view.
   * Shows "1 cell · {iconName}"; clicking deselects. */
  if (cellCount === 1 && selectedCellSheetId && viewMode === "edit") {
    const iconName = icons[selectedCellIconIds[0]]?.fileName ?? "icon";
    return (
      <button
        type="button"
        onClick={() => {
          clearSelectedCell();
          toast.info("Deselected cell");
        }}
        className="footer-context-button hidden md:inline-flex items-center gap-1.5 min-w-0 max-w-[42vw] truncate"
        role="status"
        aria-live="polite"
        aria-label={`1 cell selected: ${iconName}. Click to deselect.`}
        title={`Selected: ${iconName} — click to deselect`}
      >
        <span className="footer-cell-dot" aria-hidden />
        <span className="text-foreground/80 font-medium">1 cell</span>
        <span className="text-muted-foreground/50">·</span>
        <span className="truncate text-muted-foreground">{iconName}</span>
      </button>
    );
  }

  if (!active) return <span className="hidden md:inline" aria-hidden />;

  const idx = sheets.findIndex((s) => s.id === active.id);
  const sheetLabel = `Sheet ${pad2(idx < 0 ? 1 : idx + 1)}`;
  const capacity = getSheetCapacity(sheets, active.id);
  const filled = active.iconIds.length;
  const full = filled >= capacity;
  const isEdit = viewMode === "edit";

  /* click on the active-sheet strip → switch to edit mode + scroll the
   * sidebar row into view + flash it, so the user can re-locate the active
   * sheet in the list without manually scanning. The reflow trigger
   * (`void row.offsetWidth`) between remove/add guarantees the one-shot
   * animation restarts cleanly even on rapid re-clicks (browser quirk:
   * re-adding the same class while the animation is running is a no-op). */
  const focusActiveSheetRow = () => {
    setViewMode("edit");
    requestAnimationFrame(() => {
      const row = document.getElementById(`sheet-row-${active.id}`);
      if (!row) return;
      row.scrollIntoView({ block: "nearest", behavior: "smooth" });
      row.classList.remove("footer-context-flash");
      void row.offsetWidth; // force reflow so the animation restarts
      row.classList.add("footer-context-flash");
      window.setTimeout(() => row.classList.remove("footer-context-flash"), 900);
    });
  };

  return (
    <button
      type="button"
      onClick={focusActiveSheetRow}
      className="footer-context-button hidden md:inline-flex items-center gap-1.5 min-w-0 max-w-[42vw] truncate"
      role="status"
      aria-live="polite"
      aria-label={`Active: ${sheetLabel}, ${active.category || "uncategorized"}, volume ${active.volume ? pad2(active.volume) : "none"}, ${filled} of ${capacity} cells filled. Click to focus this sheet in the sidebar.`}
      title={`${sheetLabel} · ${active.category} · ${filled}/${capacity} cells filled — click to focus in sidebar`}
    >
      <span className={`footer-active-dot ${isEdit ? "footer-active-dot--edit" : ""}`} aria-hidden />
      <span className="text-foreground/80 font-medium">{sheetLabel}</span>
      <span className="text-muted-foreground/50">·</span>
      <span className="truncate text-muted-foreground">{active.category || "Uncategorized"}</span>
      <span className="text-muted-foreground/50">·</span>
      <span className="font-mono tabular-nums">{active.volume ? pad2(active.volume) : "—"}</span>
      <span className="text-muted-foreground/50">·</span>
      <span className={`font-mono tabular-nums ${full ? "text-amber-700 dark:text-amber-400" : ""}`}>
        {filled}/{capacity}
      </span>
    </button>
  );
}

/* Desktop-layout media query as an external store — powers the mobile
 * drawer render gate (see isDesktopLayout below). */
const DESKTOP_MQ = "(min-width: 1024px)";
function subscribeDesktopLayout(onChange: () => void): () => void {
  const mq = window.matchMedia(DESKTOP_MQ);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}
function getDesktopLayout(): boolean {
  return window.matchMedia(DESKTOP_MQ).matches;
}

export function StudioApp() {
  const hydrated = useStudio((s) => s.hydrated);
  const iconCount = useStudio((s) => s.iconOrder.length);
  const viewMode = useStudio((s) => s.settings.viewMode);
  const hydrate = useStudio((s) => s.hydrate);
  const undo = useStudio((s) => s.undo);
  const redo = useStudio((s) => s.redo);

  const [exportOpen, setExportOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [leftOpen, setLeftOpen] = useState(false);
  const [rightOpen, setRightOpen] = useState(false);
  const [builderOpen, setBuilderOpen] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [activeDrag, setActiveDrag] = useState<ActiveLibraryDrag | null>(null);
  const [dropDialog, setDropDialog] = useState<DropOverflowState | null>(null);

  const hasYesterdayRecovery = useStudio((s) => s.hasYesterdayRecovery);
  const restoreYesterdayProject = useStudio((s) => s.restoreYesterdayProject);
  const setVersionHistoryOpen = useStudio((s) => s.setVersionHistoryOpen);
  const setStorageHealthOpen = useStudio((s) => s.setStorageHealthOpen);
  const sheets = useStudio((s) => s.sheets);
  const [dismissYesterdayBanner, setDismissYesterdayBanner] = useState(false);
  const [restoringYesterday, setRestoringYesterday] = useState(false);

  const handleRestoreYesterday = useCallback(async () => {
    setRestoringYesterday(true);
    try {
      const ok = await restoreYesterdayProject();
      if (ok) {
        toast.success("Yesterday's work restored successfully!", {
          description: "All 32 sheets and 960 icons have been loaded into the workspace.",
        });
      } else {
        toast.error("Failed to restore yesterday's project.");
      }
    } catch (err) {
      toast.error("Restoration failed: " + String(err));
    } finally {
      setRestoringYesterday(false);
    }
  }, [restoreYesterdayProject]);

  /* Template Builder session continuity: a refresh re-opens the builder
   * if it was open (the drafts themselves live in IndexedDB; this flag
   * only restores WHERE the user was). sessionStorage = per-tab, no
   * cross-window surprises. */
  const openBuilder = useCallback(() => {
    try {
      sessionStorage.setItem("builder-open", "1");
    } catch {
      /* private mode — flag is best-effort only */
    }
    setBuilderOpen(true);
  }, []);
  const closeBuilder = useCallback(() => {
    try {
      sessionStorage.removeItem("builder-open");
    } catch {
      /* ignore */
    }
    setBuilderOpen(false);
  }, []);
  useEffect(() => {
    /* Template Builder session continuity: restore WHERE the user was after
     * a refresh. The restore rides in an async callback (not the synchronous
     * effect body) per react-hooks/set-state-in-effect. */
    const restore = (): void => {
      try {
        if (sessionStorage.getItem("builder-open") === "1") setBuilderOpen(true);
      } catch {
        /* private mode — flag is best-effort only */
      }
    };
    const t = window.setTimeout(restore, 0);
    return () => window.clearTimeout(t);
  }, []);

  /* Template Library → “Edit” on a builder-made template: reconstruct the
   * authoring draft from the record's embedded BuilderDocument, then open
   * the builder overlay. Failure surfaces an honest toast instead of a
     * dead-end click. */
  const openBuilderWithTemplate = useCallback((recordId: string): void => {
    const result = useBuilderStore.getState().editPublishedTemplate(recordId);
    if (!result.ok) {
      toast.error("This template can't be opened in the Builder", {
        description:
          result.reason === "no-builder-source"
            ? "It was imported as SVG, not created in the Template Builder — use the universal template editing on the sheet instead."
            : "Its saved authoring data could not be read. The template still works for generating sheets.",
      });
      return;
    }
    setLibraryOpen(false);
    openBuilder();
  }, [openBuilder]);

  /* boot: restore workspace + wire autosave status → store */
  useEffect(() => {
    void hydrate();
    attachSaveListener((status) => useStudio.setState({ saveStatus: status }));
  }, [hydrate]);

  /* stroke diagnostics (development/verification tooling — zero production
   * UI): expose `window.__strokeDebug()` so the per-icon stroke truth
   * (native px, target, correction = target − native, capability, final
   * method) can be printed from the console at any moment against the
   * CURRENT active sheet. Reads live store state at CALL time, so it always
   * reflects what is on screen; removed with the component. */
  useEffect(() => {
    const w = window as unknown as { __strokeDebug?: () => void };
    w.__strokeDebug = () => {
      const s = useStudio.getState();
      const sheet = s.sheets.find((x) => x.id === s.activeSheetId) ?? s.sheets[0];
      if (!sheet) {
        console.info("[stroke] No sheet to analyze.");
        return;
      }
      logStrokeDiagnostics(sheet, s.icons);
    };
    return () => {
      delete w.__strokeDebug;
    };
  }, []);

  /* mobile drawers must not linger as overlays when the viewport grows past
   * their breakpoints — the fixed sidebars take over at lg (1024) for BOTH
   * panes now (the right properties panel is a permanent column from 1024px
   * up, matching the three-pane pro layout). One-time matchMedia listeners
   * close the drawer the moment the sidebar it duplicates becomes visible
   * (round-13 recommendation #2). */
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    const onChange = (e: MediaQueryListEvent) => {
      if (e.matches) {
        setLeftOpen(false);
        setRightOpen(false);
      }
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  /* Safety net: the drawers duplicate the permanent desktop panes, so
   * they are simply NOT RENDERED at ≥1024px — a stale open flag (e.g. a
   * viewport change that happened while the page was reloading, so the
   * live MQ listener above never fired) can never produce a stuck overlay
   * covering the app. useSyncExternalStore keeps this lint-clean and
   * hydration-safe (server snapshot false → server markup identical:
   * closed Radix Sheets render no DOM either way). */
  const isDesktopLayout = useSyncExternalStore(
    subscribeDesktopLayout,
    getDesktopLayout,
    () => false,
  );


  /* minimal undo/redo shortcuts */
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      /* Template Builder owns the keyboard while it is open (its own
       * undo/redo/delete/nudge/zoom shortcuts live in the overlay) —
       * studio shortcuts must not leak through the overlay. */
      if (builderOpen) return;
      const mod = e.metaKey || e.ctrlKey;
      const target = e.target as HTMLElement | null;
      const typing =
        target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);

      /* undo / redo (works while any element is focused, never while typing) */
      if (mod && e.key.toLowerCase() === "z") {
        if (typing) return;
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }

      /* command palette (Ctrl+K / ⌘K) — even while typing in inputs: the
       * palette is a global launcher; K is not a typing-critical modifier combo */
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
        return;
      }

      /* duplicate active sheet (Ctrl+D / ⌘D) — power-user: clone the active
       * sheet's design into a fresh empty sheet right after it. Disabled while
       * typing so Ctrl+D stays free for in-field "bookmark" semantics. */
      if (mod && e.key.toLowerCase() === "d") {
        if (typing) return;
        const st = useStudio.getState();
        if (!st.activeSheetId) return;
        e.preventDefault();
        st.duplicateSheet(st.activeSheetId);
        st.setViewMode("edit");
        toast.success("Sheet duplicated — design copied, icons empty");
        return;
      }

      /* single-key shortcuts — plain keys only, never while typing */
      if (mod || e.altKey || typing) return;

      /* [ / ] — step to previous / next sheet (wraps). A fast, mouse-free way
       * to flip through sheets while keeping focus on the canvas. */
      if (e.key === "[" || e.key === "]") {
        const st = useStudio.getState();
        if (st.sheets.length < 2) return;
        e.preventDefault();
        const idx = st.sheets.findIndex((s) => s.id === st.activeSheetId);
        const base = idx < 0 ? 0 : idx;
        const next = e.key === "]"
          ? (base + 1) % st.sheets.length
          : (base - 1 + st.sheets.length) % st.sheets.length;
        st.setActiveSheet(st.sheets[next].id);
        st.setViewMode("edit");
        return;
      }

      /* Escape — clear the multi-sheet selection (the amber checkmarks used
       * for "Apply design to all sheets"). Mirrors how Escape closes dialogs
       * and is a natural "I'm done with this batch" gesture. No-op when there
       * is no selection. Ignored while typing (let inputs keep their own Esc). */
      if (e.key === "Escape") {
        const st = useStudio.getState();
        if (st.selectedSheetIds.length > 0) {
          e.preventDefault();
          st.clearSheetSelection();
          toast.info("Cleared sheet selection");
        }
        return;
      }

      if (e.key === "?") {
        e.preventDefault();
        setHelpOpen((v) => !v);
        return;
      }
      if (e.key === "e" || e.key === "E") {
        e.preventDefault();
        setExportOpen(true);
        return;
      }
      if (e.key === "1" || e.key === "2") {
        e.preventDefault();
        useStudio.getState().setViewMode(e.key === "1" ? "overview" : "edit");
        return;
      }
      if (e.key === "g" || e.key === "G") {
        e.preventDefault();
        useStudio.getState().toggleGridGuides();
        return;
      }
      if (e.key === "f" || e.key === "F") {
        e.preventDefault();
        useStudio.getState().setZoom(0);
        return;
      }
      if (e.key === "+" || e.key === "=") {
        e.preventDefault();
        const cur = useStudio.getState().settings.zoom || 1;
        useStudio.getState().setZoom(Math.min(ZOOM_MAX, cur + 0.25));
        return;
      }
      if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        const cur = useStudio.getState().settings.zoom || 1;
        useStudio.getState().setZoom(Math.max(ZOOM_MIN, cur - 0.25));
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo, builderOpen]);

  const openExport = useCallback(() => setExportOpen(true), []);
  const openHelp = useCallback(() => setHelpOpen(true), []);
  const openPalette = useCallback(() => setPaletteOpen(true), []);

  /* mobile: palette dialog/tag requests — surface the library drawer on
   * small screens where the sidebar is hidden (the portaled dialogs
   * themselves open fine anywhere). Store subscription (setState in the
   * subscription callback) per react-hooks/set-state-in-effect. */
  useEffect(() => {
    const unsub = useStudio.subscribe((state, prev) => {
      if (window.innerWidth >= 1024) return;
      if (state.libraryDialog && state.libraryDialog !== prev.libraryDialog) setLeftOpen(true);
      if (state.libraryFilter !== prev.libraryFilter && state.sidebarTab === "library") setLeftOpen(true);
    });
    return unsub;
  }, []);

  /* shell-mounted icon inspector (round 7: opened from the palette, library
   * tiles and inspector actions regardless of which sidebar tab is mounted) */
  const inspectorIconId = useStudio((s) => s.inspectorIconId);
  const closeInspector = useStudio((s) => s.closeInspector);

  /* shell-mounted library dialogs (round 7: portaled anyway, so any
   * surface — palette commands, library panel buttons — can open them) */
  const libraryDialog = useStudio((s) => s.libraryDialog);
  const setLibraryDialog = useStudio((s) => s.setLibraryDialog);
  /* similarity report dialog (round 10; shell-mounted like the stroke report) */
  const similarityDialogOpen = useStudio((s) => s.similarityDialogOpen);
  const setSimilarityDialogOpen = useStudio((s) => s.setSimilarityDialogOpen);

  /* shell-level palette commands: dialogs + sample data live here */
  const iconCount2 = useStudio((s) => s.iconOrder.length);
  const sheetCount2 = useStudio((s) => s.sheets.length);
  const strokeAuditOn = useStudio((s) => s.strokeAudit);
  const paletteCommands = useMemo<PaletteCommand[]>(() => {
    const cmds: PaletteCommand[] = [
      {
        id: "export-dialog",
        label: "Export artwork",
        hint: sheetCount2 > 0 ? `${sheetCount2} sheet${sheetCount2 === 1 ? "" : "s"} · SVG / PNG / PDF / batch ZIP` : "SVG / PNG / PDF / batch ZIP",
        icon: FileDown,
        disabled: sheetCount2 === 0,
        run: () => setExportOpen(true),
      },
      {
        id: "shortcuts",
        label: "Keyboard shortcuts",
        hint: "Every shortcut in one list",
        icon: Keyboard,
        run: () => setHelpOpen(true),
      },
      {
        id: "version-history",
        label: "Version history & checkpoints",
        hint: "Restore earlier revisions or save safety checkpoints",
        icon: History,
        run: () => setVersionHistoryOpen(true),
      },
      {
        id: "storage-health",
        label: "Storage health & backups",
        hint: "Rolling backups, storage diagnostics, export .issproj",
        icon: HardDriveDownload,
        run: () => setStorageHealthOpen(true),
      },
      {
        id: "ai-settings",
        label: "AI provider settings",
        hint: "Z.AI or Google Gemini for category suggestions",
        icon: Settings2,
        run: () => useAISettings.getState().openDialog(),
      },
      /* round 18 · stroke-audit commands — the audit toggle and the weight
       * sorts are store-driven now, so the palette can arm them from
       * anywhere (and lands the user on the library tab to see it). */
      {
        id: "stroke-audit-toggle",
        label: strokeAuditOn ? "Hide stroke weights in library" : "Show stroke weights in library",
        hint: "Measured native width on every tile — the engine's own numbers",
        icon: PenLine,
        disabled: iconCount2 === 0,
        run: () => {
          const s = useStudio.getState();
          s.setSidebarTab("library");
          s.setStrokeAudit(!s.strokeAudit);
        },
      },
      {
        id: "sort-stroke-desc",
        label: "Sort library by stroke weight",
        hint: "Boldest first — heavy → light, unmeasurable sink to the end",
        icon: ArrowDownUp,
        disabled: iconCount2 === 0,
        run: () => {
          const s = useStudio.getState();
          s.setSidebarTab("library");
          s.setLibraryFilter({ sort: "stroke-desc" });
        },
      },
    ];
    if (iconCount2 === 0) {
      cmds.push({
        id: "load-samples",
        label: "Load 64 sample icons",
        hint: "Try the full workflow with demo data",
        icon: Sparkles,
        run: () => {
          void (async () => {
            const { files, tagsByName } = createSampleIconFiles(64);
            await useStudio.getState().importWithDuplicateCheck(files, tagsByName, {
              successMessage: "Loaded 64 sample icons — try the full workflow",
            });
          })();
        },
      });
    }
    return cmds;
  }, [iconCount2, sheetCount2, strokeAuditOn, setExportOpen, setHelpOpen]);

  /* ---- library → sheet drag plumbing --------------------------------- */
  /* PointerSensor only, deliberately: library tiles are whole-element
   * click targets (select) AND drag sources — a KeyboardSensor would hijack
   * Space/Enter, which keyboard users need for selection. Keyboard filing
   * parity is provided by the Move-to-sheet menu, the New sheet button and
   * the inspector actions (all Tab/Enter reachable). */
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } })
  );

  const handleDragStart = useCallback((e: DragStartEvent) => {
    const data = e.active.data.current as LibraryDragData | undefined;
    if (data?.type === "library-icon" && data.iconIds?.length) {
      const s = useStudio.getState();
      const previews = data.iconIds
        .slice(0, 3)
        .map((id) => ({ id, svg: s.icons[id]?.svg ?? "" }))
        .filter((p) => p.svg.length > 0);
      setActiveDrag({ iconIds: data.iconIds, previews, count: data.iconIds.length });
      return;
    }
    if (data?.type === "sheet-cell" && data.iconId) {
      const s = useStudio.getState();
      const svg = s.icons[data.iconId]?.svg ?? "";
      setActiveDrag({
        iconIds: [data.iconId],
        previews: svg ? [{ id: data.iconId, svg }] : [],
        count: 1,
      });
    }
  }, []);

  const handleDragEnd = useCallback((e: DragEndEvent) => {
    setActiveDrag(null);
    markDragEnd(); // swallow the trailing click on the source tile/cell
    const activeData = e.active.data.current as LibraryDragData | undefined;
    const overData = e.over?.data.current as SheetDropData | undefined;

    /* ---- cell reorder: drag a grid cell onto another cell of the same sheet ---- */
    if (activeData?.type === "sheet-cell") {
      if (
        overData?.type === "sheet-cell" &&
        overData.sheetId &&
        overData.sheetId === activeData.sheetId &&
        typeof overData.index === "number" &&
        typeof activeData.fromIndex === "number" &&
        overData.index !== activeData.fromIndex
      ) {
        useStudio.getState().reorderSheetIcons(activeData.sheetId!, activeData.fromIndex!, overData.index!);
      }
      return; // cell drags never participate in library flows
    }

    if (activeData?.type !== "library-icon" || !activeData.iconIds?.length) return;

    /* ---- precise insert: library icon(s) dropped onto a specific grid cell ---- */
    if (overData?.type === "sheet-cell" && overData.sheetId && typeof overData.index === "number") {
      const s = useStudio.getState();
      const targetIndex = s.sheets.findIndex((sh) => sh.id === overData.sheetId);
      const target = targetIndex >= 0 ? s.sheets[targetIndex] : null;
      if (!target) return;
      const already = new Set(target.iconIds);
      const toMove = activeData.iconIds.filter((id) => !already.has(id));
      if (toMove.length === 0) {
        toast.info("Those icons are already on that sheet");
        return;
      }
      const free = Math.max(0, getSheetCapacity(s.sheets, target.id) - target.iconIds.length);
      if (toMove.length > free) {
        /* no room for a clean insert → the established overflow dialog appends */
        setDropDialog({
          iconIds: activeData.iconIds,
          targetSheetId: target.id,
          targetSheetLabel: `Sheet ${pad2(targetIndex + 1)}`,
          overflowCount: toMove.length - free,
          toMoveCount: toMove.length,
        });
        return;
      }
      const inserted = s.insertIconsAt(activeData.iconIds, target.id, overData.index);
      if (inserted > 0) {
        toast.success(
          `Inserted ${inserted} icon${inserted === 1 ? "" : "s"} at cell ${overData.index + 1} of Sheet ${pad2(targetIndex + 1)}`,
        );
      }
      return;
    }

    if (overData?.type !== "sheet-card" || !overData.sheetId) return;

    const s = useStudio.getState();
    const targetIndex = s.sheets.findIndex((sh) => sh.id === overData.sheetId);
    if (targetIndex < 0) return;
    const target = s.sheets[targetIndex];

    const already = new Set(target.iconIds);
    const toMove = activeData.iconIds.filter((id) => !already.has(id));
    if (toMove.length === 0) {
      toast.info("Those icons are already on that sheet");
      return;
    }
    const free = Math.max(0, getSheetCapacity(s.sheets, target.id) - target.iconIds.length);
    if (toMove.length > free) {
      setDropDialog({
        iconIds: activeData.iconIds,
        targetSheetId: target.id,
        targetSheetLabel: `Sheet ${pad2(targetIndex + 1)}`,
        overflowCount: toMove.length - free,
        toMoveCount: toMove.length,
      });
      return;
    }
    const res = s.moveIcons(activeData.iconIds, target.id, false);
    toast.success(`Moved ${res.moved.length} icons to Sheet ${pad2(targetIndex + 1)}`);
  }, []);

  const handleDragCancel = useCallback(() => {
    setActiveDrag(null);
    markDragEnd();
  }, []);

  const confirmDropCreateNew = useCallback(() => {
    const d = dropDialog;
    setDropDialog(null);
    if (!d) return;
    const res = useStudio.getState().moveIcons(d.iconIds, d.targetSheetId, true);
    const placed = res.overflow.length === 0 ? d.toMoveCount : res.moved.length;
    toast.success(`Moved ${placed} icons — overflow icons went to a new sheet`);
  }, [dropDialog]);

  const cancelDropOverflow = useCallback(() => {
    const d = dropDialog;
    setDropDialog(null);
    if (!d) return;
    const res = useStudio.getState().moveIcons(d.iconIds, d.targetSheetId, false);
    toast.success(`Moved ${res.moved.length} icons — overflow stayed unassigned`);
  }, [dropDialog]);

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={libraryCollision}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
    <div className="h-screen flex flex-col bg-background text-foreground overflow-hidden">
      <Header onExport={openExport} onHelp={openHelp} onCheckUpdate={triggerUpdateCheck} onToggleLeft={() => setLeftOpen(true)} onToggleRight={() => setRightOpen(true)} onOpenPalette={openPalette} onOpenBuilder={openBuilder} onOpenLibrary={() => setLibraryOpen(true)} />

      {/* Yesterday's session recovery banner — surfaces when previous day's work was safely saved */}
      {hasYesterdayRecovery && !dismissYesterdayBanner && sheets.length < 32 && (
        <div className="bg-amber-500/10 border-b border-amber-500/25 px-4 py-1.5 flex items-center justify-between gap-4 text-xs z-20 shrink-0">
          <div className="flex items-center gap-2 text-amber-600 dark:text-amber-400 font-medium">
            <Sparkles className="h-4 w-4 shrink-0 animate-pulse text-amber-500" />
            <span>
              Yesterday's session (32 sheets, 960 icons, categories &amp; custom templates) was recovered!
            </span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Button
              size="sm"
              variant="default"
              className="h-6 text-[11px] px-3 bg-amber-600 hover:bg-amber-500 text-white font-medium"
              onClick={handleRestoreYesterday}
              disabled={restoringYesterday}
            >
              {restoringYesterday ? "Restoring…" : "Restore Yesterday's Work (32 Sheets)"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 text-[11px] px-2 text-muted-foreground hover:text-foreground"
              onClick={() => setDismissYesterdayBanner(true)}
            >
              Dismiss
            </Button>
          </div>
        </div>
      )}

      <div className="flex-1 flex min-h-0">
        {/* left sidebar — desktop. Responsive widths by viewport class:
         * 1024–1279 (w-56) / 1280–1535 (w-60) / 1536+ (w-64) — keeps the
         * icon grid + search usable while never starving the center pane.
         * (Named breakpoints only — an arbitrary `min-[1600px]:` variant
         * sorts BEFORE `xl:` in the generated CSS and would lose to it.) */}
        <aside aria-label="Sheets and icon library" className="hidden lg:flex @container w-56 xl:w-60 2xl:w-64 shrink-0 border-r border-border">
          <Sidebar />
        </aside>

        {/* center workspace — an inline-size query container so toolbar /
         * canvas / column children respond to the ACTUAL available center
         * width (not the viewport), which stays correct no matter which
         * combination of sidebars is visible. */}
        <main className="studio-canvas flex-1 flex min-w-0 @container">
          {!hydrated ? (
            <div className="flex-1 grid place-items-center">
              <div className="flex flex-col items-center gap-3 text-muted-foreground">
                <div className="h-7 w-7 rounded-full border-2 border-muted-foreground/15 border-t-muted-foreground/50 animate-spin" />
                <p className="text-[11px]">Restoring workspace…</p>
              </div>
            </div>
          ) : iconCount === 0 ? (
            <EmptyState />
          ) : viewMode === "overview" ? (
            <Overview />
          ) : (
            /* round 14: Edit mode is now a vertical multi-sheet workspace —
             * all sheets render in a scrollable column. The active sheet is
             * the edit target; clicking a sheet activates it. The old
             * single-sheet SheetPreview is preserved for reference but no
             * longer mounted here. */
            <MultiSheetWorkspace />
          )}
        </main>

        {/* right properties — desktop. Visible from 1024px up (the whole
         * three-pane pro layout is the primary experience; below 1024 it
         * collapses to the header drawer). Widths: 1024–1279 (300) /
         * 1280–1535 (312) / 1536+ (340) — sliders + numeric fields stay
         * comfortably usable, and the label column never squeezes the
         * value column below its 52px numeric field. */}
        <aside aria-label="Sheet properties" className="hidden lg:flex w-[300px] xl:w-[312px] 2xl:w-[340px] shrink-0 border-l border-border">
          <PropertiesPanel />
        </aside>
      </div>

      {/* footer — quiet status strip: brand + autosave note + source link on
       * the left, live workspace context in the center, and a single
       * shortcuts affordance on the right (the full cheat-sheet lives in
       * the ? dialog; per-shortcut chips were visual clutter). */}
      <footer className="studio-footer shrink-0 h-7 border-t border-border bg-background flex items-center justify-between px-3 text-[10px] text-muted-foreground">
        <span className="min-w-0 shrink truncate inline-flex items-center gap-2">
          <span className="footer-brand-dot" aria-hidden />
          Icon Sheet Studio
        </span>
        <FooterContext />
        <span className="hidden sm:flex items-center gap-2">
          <button
            type="button"
            onClick={() => setHelpOpen(true)}
            className="inline-flex items-center gap-1.5 hover:text-foreground transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring rounded px-0.5"
            aria-label="Show keyboard shortcuts"
          >
            <kbd className="kbd-chip">?</kbd>
            Shortcuts
          </button>
          <span className="text-muted-foreground/40 hidden 2xl:inline">·</span>
          <span className="hidden 2xl:inline font-mono text-[9px] tracking-wide footer-version">v0.2.1</span>
        </span>
      </footer>

      {/* mobile drawers — Sidebar namespaces its tab ids so the drawer
       * copy never collides with the (CSS-hidden) desktop rail instance.
       * Render-gated to <1024px: the drawers duplicate the permanent
       * desktop panes, so a stale open flag can never overlay the app. */}
      {!isDesktopLayout && (
        <>
          <Sheet open={leftOpen} onOpenChange={setLeftOpen}>
            <SheetContent side="left" className="w-[290px] p-0">
              <SheetHeader className="sr-only">
                <SheetTitle>Sheets and library</SheetTitle>
                <SheetDescription>
                  Browse sheets and the icon library on a small screen
                </SheetDescription>
              </SheetHeader>
              <Sidebar idPrefix="sidebar-drawer" />
            </SheetContent>
          </Sheet>

          <Sheet open={rightOpen} onOpenChange={setRightOpen}>
            <SheetContent side="right" className="w-[330px] p-0">
              <SheetHeader className="sr-only">
                <SheetTitle>Sheet properties</SheetTitle>
                <SheetDescription>
                  Design properties for the active sheet on a small screen
                </SheetDescription>
              </SheetHeader>
              <PropertiesPanel />
            </SheetContent>
          </Sheet>
        </>
      )}

      <ExportDialog open={exportOpen} onOpenChange={setExportOpen} />
      <ShortcutsDialog open={helpOpen} onOpenChange={setHelpOpen} />
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} commands={paletteCommands} />
      <IconInspector iconId={inspectorIconId} onClose={closeInspector} />
      {/* the ONE duplicate confirmation — store-driven, shared by every import surface */}
      <DuplicateImportDialog />
      <TemplateImportDialog />
      <TagManagerDialog open={libraryDialog === "tag-manager"} onOpenChange={(o) => setLibraryDialog(o ? "tag-manager" : null)} />
      <CatalogDialog open={libraryDialog === "catalog"} onOpenChange={(o) => setLibraryDialog(o ? "catalog" : null)} />
      <HealthReportDialog open={libraryDialog === "health"} onOpenChange={(o) => setLibraryDialog(o ? "health" : null)} />
      <BackupDialog />
      <StrokeReportDialog />
      <SimilarityDialog open={similarityDialogOpen} onOpenChange={(o) => setSimilarityDialogOpen(o)} />
      <AISettingsDialog />
      <UpdaterDialog />
      <VersionHistoryDialog />
      <RecoveryDialog />
      <StorageRecoveryDialog />

      {/* Template Builder (Phase 1+2) — additive full-screen overlay. The
          studio stays mounted underneath (state, sheets, persistence all
          preserved); its shortcuts are gated while this is open. */}
      {builderOpen && <TemplateBuilder onClose={closeBuilder} onOpenLibrary={() => setLibraryOpen(true)} />}

      {/* Template Library — manage every template (official / builder /
          uploaded). Portals above the builder overlay (z-50 > z-40) so both
          the Studio and the Builder share ONE management surface. */}
      <TemplateLibraryDialog
        open={libraryOpen}
        onOpenChange={setLibraryOpen}
        onEditInBuilder={openBuilderWithTemplate}
      />
    </div>

    {/* floating drag preview for library icons */}
    <DragOverlay dropAnimation={null}>
      {activeDrag ? (
        <div
          role="status"
          aria-label={`Dragging ${activeDrag.count} icons`}
          className="drag-pickup pointer-events-none flex items-center gap-2 rounded-xl border-2 border-amber-500 bg-card px-2.5 py-2 shadow-2xl"
        >
          <span className="flex -space-x-2.5">
            {activeDrag.previews.map((p) => (
              <span
                key={p.id}
                className="grid h-9 w-9 place-items-center rounded-lg border bg-background p-1.5 shadow [&>svg]:h-full [&>svg]:w-full"
                aria-hidden="true"
                dangerouslySetInnerHTML={{ __html: p.svg }}
              />
            ))}
            {activeDrag.count > 3 ? (
              <span className="grid h-9 w-9 place-items-center rounded-lg border bg-muted p-1.5 text-[10px] font-semibold text-muted-foreground">
                +{activeDrag.count - 3}
              </span>
            ) : null}
          </span>
          <span className="rounded-full bg-amber-500 px-2 py-0.5 text-[10px] font-semibold tabular-nums text-amber-50">
            {activeDrag.count}
          </span>
          <GripHorizontal className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
        </div>
      ) : null}
    </DragOverlay>

    {/* drop overflow dialog (same semantics as the library menu flow) */}
    <AlertDialog
      open={dropDialog !== null}
      onOpenChange={(open) => {
        if (!open) cancelDropOverflow();
      }}
    >
      <AlertDialogContent className="max-w-sm">
        <AlertDialogHeader>
          <AlertDialogTitle>Sheet is full</AlertDialogTitle>
          <AlertDialogDescription>
            {dropDialog
              ? `${dropDialog.overflowCount} icon${dropDialog.overflowCount === 1 ? "" : "s"} don't fit on ${dropDialog.targetSheetLabel}. Move the remaining icons to a new sheet?`
              : null}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={cancelDropOverflow}>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={confirmDropCreateNew}>
            Create new sheet
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    </DndContext>
  );
}
