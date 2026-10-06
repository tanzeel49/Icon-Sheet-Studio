"use client";

/**
 * ICON SHEET STUDIO — Command Palette (round 7, Ctrl+K / ⌘K).
 * The pro-tool quick-action hub: one input searching EVERYTHING —
 * commands, sheets, icons and tags — with grouped, keyboard-driven
 * results (↑/↓ move, Enter run, Esc close).
 *
 * Search strategy: case-insensitive substring scoring — exact prefix
 * beats word-start beats plain containment. Empty input shows the
 * command group (the always-useful actions), recently-inspected icons
 * and recent context. A leading "#" token scopes icon results (round 9):
 *   "#2 arrow"      → arrow icons on Sheet 02         (round 8)
 *   "#navigation"   → icons tagged navigation
 *   "#unassigned"   → icons not yet on any sheet
 * each scope leads with a one-shot command row (jump to the sheet /
 * focus the library filter) so an empty rest + Enter still does the
 * useful thing.
 *
 * Side effects all flow through the store: sheet jumps use
 * setActiveSheet + setViewMode, icon results open the shell-mounted
 * inspector (openInspector), tag results filter the library (focusTag),
 * file-level commands are injected by the shell via the `commands` prop
 * so this file owns no dialogs directly.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { JSX, ReactNode } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Search,
  Layers,
  Eye,
  EyeOff,
  Palette,
  Eraser,
  Grid3x3,
  Undo2,
  Redo2,
  Tags,
  FileDown,
  HardDriveDownload,
  FileSpreadsheet,
  Shuffle,
  Copy,
  Keyboard,
  CornerDownLeft,
  ArrowUp,
  ArrowDown,
  ChevronLeft,
  ChevronRight,
  CheckCheck,
  XCircle,
  Sheet as SheetIcon,
  Tag as TagIcon,
  Image as ImageIcon,
  History,
  HeartPulse,
  FolderOpen,
  Activity,
} from "lucide-react";
import { toast } from "sonner";
import { useStudio, getSheetCapacity } from "@/lib/studio/store";
import { sheetTitle } from "@/lib/studio/types";
import { loadRecentIconIds, clearRecentIconIds } from "./icon-inspector";
import { computeHealthReport } from "@/lib/studio/health";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export interface PaletteCommand {
  id: string;
  label: string;
  /** short explanation shown under the label */
  hint?: string;
  icon: typeof Eye;
  /** disabled commands render greyed and are skipped by keyboard nav */
  disabled?: boolean;
  run: () => void;
}

interface PaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** shell-provided commands (export dialog, help, samples…) */
  commands: PaletteCommand[];
}

type Item =
  | { type: "command"; score: number; command: PaletteCommand }
  | { type: "sheet"; score: number; sheetId: string; label: string; sub: string; filled: number; capacity: number }
  | { type: "icon"; score: number; iconId: string; fileName: string; title?: string; tags: string[]; assignment: string | null }
  | { type: "tag"; score: number; tag: string; count: number };

/* recently-inspected icons shown on the empty query (own group, lives
 * between commands and sheets) */
interface RecentIconItem {
  type: "recent-icon";
  score: number;
  iconId: string;
  fileName: string;
  title?: string;
  tags: string[];
  assignment: string | null;
}

type ItemOrRecent = Item | RecentIconItem;
const GROUP_ORDER: ItemOrRecent["type"][] = ["command", "recent-icon", "sheet", "tag", "icon"];
const GROUP_META: Record<ItemOrRecent["type"], { title: string; icon: typeof Eye }> = {
  command: { title: "Commands", icon: Keyboard },
  "recent-icon": { title: "Recently inspected", icon: History },
  sheet: { title: "Sheets", icon: SheetIcon },
  tag: { title: "Tags", icon: TagIcon },
  icon: { title: "Icons", icon: ImageIcon },
};

/* scoped search: a leading "#…" token narrows icon results.
 * "#2 arrow" → icons on Sheet 02 matching "arrow"
 * "#navigation arrow" → tagged-navigation icons matching "arrow"
 * "#unassigned" → icons on no sheet (pseudo-scope; a REAL tag named
 * "unassigned" wins over the pseudo-scope). */
const SCOPE_RE = /^#(\S+)\s*(.*)$/;

type Scope =
  | { kind: "sheet"; sheetIndex: number; label: string; rest: string }
  | { kind: "tag"; tag: string; label: string; rest: string }
  | { kind: "unassigned"; label: string; rest: string }
  | { kind: "invalid"; typed: string; sheetNumber: number | null; suggestion: string | null; rest: string };

function parseScope(raw: string, ctx: { sheetCount: number; tags: Set<string> }): Scope | null {
  const m = raw.trim().match(SCOPE_RE);
  if (!m) return null;
  const token = m[1];
  const rest = m[2].trim().toLowerCase();
  if (/^\d+$/.test(token)) {
    const num = parseInt(token, 10);
    const idx = num - 1;
    if (idx >= 0 && idx < ctx.sheetCount) {
      return { kind: "sheet", sheetIndex: idx, label: `Sheet ${String(num).padStart(2, "0")}`, rest };
    }
    return { kind: "invalid", typed: token, sheetNumber: num, suggestion: null, rest };
  }
  const lower = token.toLowerCase();
  if (ctx.tags.has(lower)) return { kind: "tag", tag: lower, label: `#${lower}`, rest };
  if (lower === "unassigned") return { kind: "unassigned", label: "#unassigned", rest };
  /* suggestion: shortest real tag CONTAINING the typed token */
  const candidates = [...ctx.tags].filter((t) => t.includes(lower)).sort((a, b) => a.length - b.length);
  return { kind: "invalid", typed: token, sheetNumber: null, suggestion: candidates[0] ?? null, rest };
}

/* scoring: 0 = no match; higher = better */
function scoreText(haystack: string, q: string): number {
  const h = haystack.toLowerCase();
  if (!q) return 1;
  const idx = h.indexOf(q);
  if (idx < 0) return 0;
  if (idx === 0) return 3; // prefix
  const before = h[idx - 1];
  if (before === " " || before === "-" || before === "_" || before === ".") return 2; // word start
  return 1; // containment
}

function Highlight({ text, query }: { text: string; query: string }): JSX.Element {
  const q = query.trim().toLowerCase();
  if (!q) return <>{text}</>;
  const idx = text.toLowerCase().indexOf(q);
  if (idx < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, idx)}
      <span className="bg-amber-500/25 rounded-sm px-0.5 -mx-0.5 text-foreground font-semibold">
        {text.slice(idx, idx + q.length)}
      </span>
      {text.slice(idx + q.length)}
    </>
  );
}

/** the palette's own workspace commands (independent of dialogs) */
function useStoreCommands(): PaletteCommand[] {
  const sheets = useStudio((s) => s.sheets);
  const activeSheetId = useStudio((s) => s.activeSheetId);
  const canUndo = useStudio((s) => s.past.length > 0);
  const canRedo = useStudio((s) => s.future.length > 0);
  const undoDepth = useStudio((s) => s.past.length);
  const redoDepth = useStudio((s) => s.future.length);
  const unassignedCount = useStudio((s) => {
    const assigned = new Set<string>();
    for (const sh of s.sheets) for (const id of sh.iconIds) assigned.add(id);
    return s.iconOrder.filter((id) => !assigned.has(id)).length;
  });
  /* live library health (round 9) — same computation as the report dialog */
  const healthIssueCount = useStudio((s) =>
    computeHealthReport({ icons: s.icons, iconOrder: s.iconOrder, sheets: s.sheets }).issueCount,
  );
  /* live-count hints (round 8): every hint that CAN carry a number does */
  const iconCount = useStudio((s) => s.iconOrder.length);
  /* round 19 · import-audit command liveness — enables the moment the
   * session has at least one import report (the ring buffer's length). */
  const importCount = useStudio((s) => s.importHistory.length);
  const tagCount = useStudio((s) => {
    const tags = new Set<string>();
    for (const id of s.iconOrder) for (const t of s.icons[id]?.tags ?? []) tags.add(t);
    return tags.size;
  });
  /* edit-mode cell selection state (round 12) — drives the cell skip/color
   *  commands: live skip mode (all skipped → the command flips to Unskip),
   *  live custom-color count (enables the reset command). */
  const selectedCellIconIds = useStudio((s) => s.selectedCellIconIds);
  const selectedCellSheetId = useStudio((s) => s.selectedCellSheetId);
  const cellSkipMode = useStudio((s) => {
    if (!s.selectedCellSheetId || s.selectedCellIconIds.length === 0) return "none" as const;
    const overrides = s.sheets.find((sh) => sh.id === s.selectedCellSheetId)?.cellOverrides ?? {};
    const all = s.selectedCellIconIds.every((id) => overrides[id]?.skip === true);
    if (all) return "all" as const;
    return s.selectedCellIconIds.some((id) => overrides[id]?.skip === true) ? ("some" as const) : ("none" as const);
  });
  const cellColorCount = useStudio((s) => {
    if (!s.selectedCellSheetId) return 0;
    const overrides = s.sheets.find((sh) => sh.id === s.selectedCellSheetId)?.cellOverrides ?? {};
    return s.selectedCellIconIds.filter(
      (id) => overrides[id]?.cardColor != null || overrides[id]?.cardGradient != null,
    ).length;
  });
  /* round 12: custom fills (solid + gradient) on the ACTIVE sheet — powers
   *  the sheet-wide cleanup command */
  const sheetFillCount = useStudio((s) => {
    const sh = s.sheets.find((x) => x.id === s.activeSheetId);
    if (!sh) return 0;
    const ov = sh.cellOverrides ?? {};
    let n = 0;
    for (const id of sh.iconIds) {
      const o = ov[id];
      if (o && ((o.cardColor != null && o.cardColor.trim() !== "") || o.cardGradient != null)) n++;
    }
    return n;
  });

  return useMemo(() => {
    const s = useStudio.getState();
    const cmds: PaletteCommand[] = [
      {
        id: "view-overview",
        label: "Go to overview",
        hint: sheets.length > 0 ? `${sheets.length} sheet${sheets.length === 1 ? "" : "s"} at a glance` : "All sheets at a glance",
        icon: Eye,
        run: () => s.setViewMode("overview"),
      },
      {
        id: "view-edit",
        label: "Go to edit mode",
        hint: "Active sheet canvas",
        icon: Grid3x3,
        run: () => s.setViewMode("edit"),
      },
      {
        id: "new-sheet",
        label: "New sheet from unassigned icons",
        hint: unassignedCount > 0 ? `Files ${unassignedCount} unassigned icon${unassignedCount === 1 ? "" : "s"} into a fresh sheet` : "No unassigned icons right now",
        icon: Layers,
        disabled: unassignedCount === 0,
        run: () => {
          const ids = getUnassignedIds();
          if (ids.length === 0) return;
          const created = useStudio.getState().moveIconsToNewSheet(ids);
          if (created > 0) toast.success(`Created ${created} sheet${created === 1 ? "" : "s"} from ${ids.length} unassigned icons`);
        },
      },
      {
        id: "toggle-guides",
        label: "Toggle grid guides",
        hint: "Edit-mode cell overlay",
        icon: Grid3x3,
        run: () => s.toggleGridGuides(),
      },
      {
        id: "zoom-fit",
        label: "Zoom to fit",
        icon: Search,
        run: () => s.setZoom(0),
      },
      {
        id: "undo",
        label: "Undo",
        hint: undoDepth > 0 ? `${undoDepth} step${undoDepth === 1 ? "" : "s"} back` : undefined,
        icon: Undo2,
        disabled: !canUndo,
        run: () => s.undo(),
      },
      {
        id: "redo",
        label: "Redo",
        hint: redoDepth > 0 ? `${redoDepth} step${redoDepth === 1 ? "" : "s"} forward` : undefined,
        icon: Redo2,
        disabled: !canRedo,
        run: () => s.redo(),
      },
      {
        id: "library-tab",
        label: "Open icon library",
        hint: iconCount > 0 ? `${iconCount} icon${iconCount === 1 ? "" : "s"} · browse, tag and file` : "Browse, tag and file icons",
        icon: Layers,
        run: () => s.setSidebarTab("library"),
      },
      {
        id: "manage-tags",
        label: "Manage tags",
        hint: tagCount > 0 ? `${tagCount} tag${tagCount === 1 ? "" : "s"} · rename, merge or delete library-wide` : "Rename, merge or delete tags library-wide",
        icon: Tags,
        run: () => s.openLibraryDialog("tag-manager"),
      },
      {
        id: "health-report",
        label: "Library health report",
        hint:
          healthIssueCount > 0
            ? `${healthIssueCount} to review · untagged, unassigned, skips and layout checks`
            : "All clear — no issues detected",
        icon: HeartPulse,
        run: () => s.openLibraryDialog("health"),
      },
      {
        id: "export-catalog",
        label: "Export library catalog",
        hint: iconCount > 0 ? `JSON / CSV manifest of ${iconCount} icons` : "JSON / CSV metadata manifest of every icon",
        icon: FileDown,
        run: () => s.openLibraryDialog("catalog"),
      },
      {
        id: "workspace-backup",
        label: "Workspace backup & restore",
        hint: "Download the whole workspace as JSON — or bring one back",
        icon: HardDriveDownload,
        run: () => s.openBackupDialog(),
      },
      {
        id: "stroke-report",
        label: "Stroke report",
        hint: "Analyze per-icon stroke consistency for the active sheet",
        icon: Activity,
        run: () => s.openStrokeReport(),
      },
      {
        id: "similar-icons",
        label: "Find similar icons",
        hint: iconCount > 1 ? `Geometry scan of ${iconCount} icons — renamed copies and near-identical artwork` : "Geometry scan for near-identical artwork",
        icon: Copy,
        run: () => s.openSimilarityDialog(),
      },
      /* round 19 · the import audit reaches the palette: re-surfaces the
       * last import summary card (with its history popover + per-file skip
       * reasons) on the library panel. Disabled until the session has at
       * least one import. */
      {
        id: "import-history",
        label: "Review import history",
        hint:
          importCount > 0
            ? `${importCount} import${importCount === 1 ? "" : "s"} this session — lands on the library with the last summary card`
            : "No imports yet this session",
        icon: History,
        disabled: importCount === 0,
        run: () => {
          const ok = s.resurfaceImportReport();
          s.setSidebarTab("library");
          if (!ok) toast.info("Nothing imported yet this session");
        },
      },
    ];
    /* round 22 · sheet-scoped stroke report — one command per sheet (capped
     * at eight so a 50-sheet project doesn't flood the palette; the report's
     * own switcher pills cover any count). Opens the report analyzing THAT
     * sheet without activating it (openStrokeReportFor). */
    for (let i = 0; i < sheets.length && i < 8; i++) {
      const sh = sheets[i];
      const cat = sh.category?.trim();
      cmds.push({
        id: `stroke-report-sheet-${sh.id}`,
        label: `Stroke report · ${sheetLabel(i)}`,
        hint: `${sh.iconIds.length} icon${sh.iconIds.length === 1 ? "" : "s"}${cat ? ` · ${cat}` : ""} · analyzes without activating`,
        icon: Activity,
        run: () => s.openStrokeReportFor(sh.id),
      });
    }
    if (sheets.length > 0 && activeSheetId) {
      const idx = sheets.findIndex((sh) => sh.id === activeSheetId);
      if (idx >= 0) {
        const active = sheets[idx];
        const cap = getSheetCapacity(sheets, active.id);
        /* prev / next sheet — palette-discoverable counterparts to the [ / ]
         * keyboard shortcuts (round 3). Disabled when there is nowhere to go. */
        const canStep = sheets.length > 1;
        cmds.push(
          {
            id: "next-sheet",
            label: "Next sheet",
            hint: canStep ? `${sheetLabel((idx + 1) % sheets.length)} · shortcut ]` : "Only one sheet",
            icon: ChevronRight,
            disabled: !canStep,
            run: () => {
              const st = useStudio.getState();
              if (st.sheets.length < 2) return;
              const nIdx = (idx + 1) % st.sheets.length;
              st.setActiveSheet(st.sheets[nIdx].id);
              st.setViewMode("edit");
            },
          },
          {
            id: "previous-sheet",
            label: "Previous sheet",
            hint: canStep ? `${sheetLabel((idx - 1 + sheets.length) % sheets.length)} · shortcut [` : "Only one sheet",
            icon: ChevronLeft,
            disabled: !canStep,
            run: () => {
              const st = useStudio.getState();
              if (st.sheets.length < 2) return;
              const pIdx = (idx - 1 + st.sheets.length) % st.sheets.length;
              st.setActiveSheet(st.sheets[pIdx].id);
              st.setViewMode("edit");
            },
          },
          {
            id: "randomize-sheet",
            label: `Randomize ${sheetLabel(idx)}`,
            hint: `Shuffle ${active.iconIds.length} icons — hero stays`,
            icon: Shuffle,
            run: () => s.randomizeSheet(activeSheetId),
          },
          {
            id: "duplicate-sheet",
            label: `Duplicate ${sheetLabel(idx)}`,
            hint: `${active.iconIds.length}/${cap} cells · ${active.category} · design only`,
            icon: Copy,
            run: () => {
              s.duplicateSheet(activeSheetId);
              s.setViewMode("edit");
              toast.success("Sheet duplicated — design copied, icons empty");
            },
          },
        );
      }
    }
    /* batch-selection commands — surface the store's selectAllSheets /
     * clearSheetSelection in the palette so mouse-first users can discover
     * the multi-sheet "Apply design to all sheets" workflow. Both carry a
     * live count so the user knows the effect before running. */
    const selectedCount = s.selectedSheetIds.length;
    if (sheets.length >= 2) {
      cmds.push(
        {
          id: "select-all-sheets",
          label: "Select all sheets",
          hint: `Marks all ${sheets.length} sheets for batch design-apply`,
          icon: CheckCheck,
          run: () => {
            useStudio.getState().selectAllSheets();
            toast.success(`Selected all ${sheets.length} sheets`);
          },
        },
        {
          id: "clear-sheet-selection",
          label: "Clear sheet selection",
          hint: selectedCount > 0 ? `Deselects ${selectedCount} sheet${selectedCount === 1 ? "" : "s"} · Esc` : "Nothing selected right now",
          icon: XCircle,
          disabled: selectedCount === 0,
          run: () => {
            useStudio.getState().clearSheetSelection();
            toast.info("Cleared sheet selection");
          },
        },
      );
    }
    /* edit-mode cell commands (round 12): the palette can now drive per-cell
     * skip and card color for the CURRENT canvas selection — the same actions
     * as the floating bar, but discoverable + keyboard-driven from anywhere.
     * Always listed so the feature is learnable; enabled only while cells
     * are actually selected (the hints teach the workflow when disabled). */
    const hasCellSel = selectedCellIconIds.length > 0 && selectedCellSheetId !== null;
    const cellSelSheetIdx = sheets.findIndex((sh) => sh.id === selectedCellSheetId);
    const cellSelSheetLabel = hasCellSel && cellSelSheetIdx >= 0 ? sheetTitle(sheets[cellSelSheetIdx], cellSelSheetIdx) : "";
    const cellCountLabel =
      selectedCellIconIds.length === 0 ? "selected cells" : `${selectedCellIconIds.length} selected cell${selectedCellIconIds.length === 1 ? "" : "s"}`;
    cmds.push(
      {
        id: "cell-skip",
        label: cellSkipMode === "all" ? `Unskip ${cellCountLabel}` : `Skip ${cellCountLabel}`,
        hint: hasCellSel
          ? cellSkipMode === "all"
            ? `Renders again in preview & export · ${cellSelSheetLabel} · Ctrl Z undo`
            : cellSkipMode === "some"
              ? `Hides the cells from preview & export · ${cellSelSheetLabel} · icons stay on the sheet`
              : `Hidden from preview & export · ${cellSelSheetLabel} · icons stay on the sheet`
          : "Click cells on the canvas in Edit view to select them",
        icon: cellSkipMode === "all" ? Eye : EyeOff,
        disabled: !hasCellSel,
        run: () => {
          const st = useStudio.getState();
          if (!st.selectedCellSheetId || st.selectedCellIconIds.length === 0) return;
          const skipTo = cellSkipMode !== "all";
          st.setCellSkip(st.selectedCellSheetId, st.selectedCellIconIds, skipTo);
          const n = st.selectedCellIconIds.length;
          if (skipTo) {
            toast.info(`Skipped ${n} cell${n === 1 ? "" : "s"} — hidden from preview & export`, {
              description: "Icons stay on the sheet; Ctrl Z to undo",
            });
          } else {
            toast.success(`Restored ${n} cell${n === 1 ? "" : "s"} — renders in preview & export`);
          }
        },
      },
      {
        id: "cell-color",
        label: hasCellSel ? `Cell fill for ${cellCountLabel}…` : "Cell fill for selection…",
        hint: hasCellSel
          ? `Solid or gradient swatches · ${cellSelSheetLabel}`
          : "Click cells on the canvas in Edit view to select them",
        icon: Palette,
        disabled: !hasCellSel,
        run: () => {
          const st = useStudio.getState();
          if (!st.selectedCellSheetId || st.selectedCellIconIds.length === 0) return;
          st.setViewMode("edit");
          st.openCellColorPicker();
        },
      },
      {
        id: "cell-color-reset",
        label: "Reset cell fill to sheet design",
        hint:
          cellColorCount > 0
            ? `${cellColorCount} of ${selectedCellIconIds.length} selected cell${selectedCellIconIds.length === 1 ? "" : "s"} carry a custom fill`
            : hasCellSel
              ? "No custom fills in the selection"
              : "Click cells on the canvas in Edit view to select them",
        icon: Eraser,
        disabled: cellColorCount === 0,
        run: () => {
          const st = useStudio.getState();
          if (!st.selectedCellSheetId || st.selectedCellIconIds.length === 0) return;
          st.setCellCardColor(st.selectedCellSheetId, st.selectedCellIconIds, null);
          toast.info("Selected cells use the sheet design fill again");
        },
      },
    );
    /* sheet-wide fill cleanup (round 12) — one undoable step for every
     * custom cell fill on the active sheet. Skips are untouched. */
    if (sheets.length > 0) {
      const activeIdx = sheets.findIndex((sh) => sh.id === activeSheetId);
      const activeLabel = activeIdx >= 0 ? sheetTitle(sheets[activeIdx], activeIdx) : "";
      cmds.push({
        id: "sheet-fills-reset",
        label: "Reset all cell fills on active sheet",
        hint:
          sheetFillCount > 0
            ? `Clears ${sheetFillCount} custom fill${sheetFillCount === 1 ? "" : "s"} · ${activeLabel} · Ctrl Z undo`
            : `No custom fills on ${activeLabel || "the active sheet"}`,
        icon: Eraser,
        disabled: sheetFillCount === 0,
        run: () => {
          const st = useStudio.getState();
          if (!st.activeSheetId) return;
          const n = st.resetSheetCellFills(st.activeSheetId);
          if (n > 0) {
            toast.success(`Cleared ${n} custom fill${n === 1 ? "" : "s"} — cells use the sheet design again`, {
              description: "Ctrl Z to undo",
            });
          }
        },
      });
    }
    return cmds;
  }, [sheets, activeSheetId, canUndo, canRedo, undoDepth, redoDepth, unassignedCount, iconCount, tagCount, healthIssueCount, importCount, selectedCellIconIds, selectedCellSheetId, cellSkipMode, cellColorCount, sheetFillCount]);
}

function getUnassignedIds(): string[] {
  const s = useStudio.getState();
  const assigned = new Set<string>();
  for (const sh of s.sheets) for (const id of sh.iconIds) assigned.add(id);
  return s.iconOrder.filter((id) => !assigned.has(id));
}

function sheetLabel(index: number): string {
  const sheet = useStudio.getState().sheets[index];
  return sheetTitle(sheet, index);
}

/* ------------------------------------------------------------------ */
/* Palette                                                             */
/* ------------------------------------------------------------------ */

/* recently-run command ids (most-recent-first, capped). Persisted to
 * localStorage — pure UX memory, never workspace data. */
const RECENT_KEY = "iss-palette-recent";
const RECENT_MAX = 3;

function loadRecent(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const ids = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(ids) ? ids.filter((v) => typeof v === "string").slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

function saveRecent(id: string): void {
  try {
    const next = [id, ...loadRecent().filter((r) => r !== id)].slice(0, RECENT_MAX);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable (private mode) — recency just won't persist */
  }
}

export function CommandPalette({ open, onOpenChange, commands }: PaletteProps): JSX.Element {
  const sheets = useStudio((s) => s.sheets);
  const icons = useStudio((s) => s.icons);
  const iconOrder = useStudio((s) => s.iconOrder);
  const storeCommands = useStoreCommands();

  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [recent, setRecent] = useState<string[]>([]);
  const [recentIconIds, setRecentIconIds] = useState<string[]>([]);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  /* live tag set — the scope parser validates "#tag" tokens against it
   * (shared by the items memo, row highlighting and the scope chip) */
  const tagSet = useMemo(() => {
    const set = new Set<string>();
    for (const id of iconOrder) for (const t of icons[id]?.tags ?? []) set.add(t);
    return set;
  }, [icons, iconOrder]);
  const scopeCtx = useMemo(() => ({ sheetCount: sheets.length, tags: tagSet }), [sheets.length, tagSet]);

  /* reset on open — "adjust state during render" pattern (react.dev:
   * You Might Not Need an Effect) instead of a setState-in-effect */
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) {
      setQuery("");
      setActiveIndex(0);
      setRecent(loadRecent());
      setRecentIconIds(loadRecentIconIds());
    }
  }

  const allCommands = useMemo(() => {
    const merged = [...commands, ...storeCommands];
    /* with no query, recently-used commands float to the top */
    if (recent.length === 0) return merged;
    const rank = new Map(recent.map((id, i) => [id, i]));
    return [...merged].sort((a, b) => (rank.get(a.id) ?? 99) - (rank.get(b.id) ?? 99));
  }, [commands, storeCommands, recent]);

  /* ---- search ---- */
  const items = useMemo<ItemOrRecent[]>(() => {
    const q = query.trim().toLowerCase();
    const out: ItemOrRecent[] = [];

    /* all live tags — the scope parser validates "#tag" tokens against
     * this set (also reused for the tag group below) */
    const tagSet = new Set<string>();
    for (const id of iconOrder) for (const t of icons[id]?.tags ?? []) tagSet.add(t);

    /* scoped mode ("#2 arrow" / "#navigation" / "#unassigned"): icons in
     * the scope matching the rest-query only — commands/tags/sheets stand
     * aside, the scope chip explains. Each scope LEADS with a one-shot
     * command row so Enter on an empty rest still does the useful thing. */
    const scope = parseScope(query, { sheetCount: sheets.length, tags: tagSet });
    if (scope && scope.kind === "invalid") {
      return []; // no such sheet/tag — the scope chip shows the guidance
    }
    if (scope) {
      let scopedIds: string[] = [];
      let assignmentLabel = "";
      let scopeCommand: Item | null = null;

      if (scope.kind === "sheet") {
        const sheet = sheets[scope.sheetIndex];
        scopedIds = sheet.iconIds;
        assignmentLabel = sheetLabel(scope.sheetIndex);
        scopeCommand = {
          type: "command",
          score: 4,
          command: {
            id: `open-sheet:${scope.sheetIndex}`,
            label: `Open ${scope.label} in edit mode`,
            hint: `${sheet.iconIds.length} icons · jump to the canvas`,
            icon: SheetIcon,
            run: () => {
              const s = useStudio.getState();
              s.setActiveSheet(sheets[scope.sheetIndex].id);
              s.setViewMode("edit");
            },
          },
        };
      } else if (scope.kind === "tag") {
        for (const id of iconOrder) if ((icons[id]?.tags ?? []).includes(scope.tag)) scopedIds.push(id);
        assignmentLabel = `#${scope.tag}`;
        const tag = scope.tag; // stable capture for the closure
        scopeCommand = {
          type: "command",
          score: 4,
          command: {
            id: `focus-tag:${tag}`,
            label: `Focus library on #${tag}`,
            hint: `${scopedIds.length} icons · library chip filter`,
            icon: TagIcon,
            run: () => useStudio.getState().focusTag(tag),
          },
        };
      } else {
        /* unassigned pseudo-scope */
        const assigned = new Set<string>();
        for (const sh of sheets) for (const id of sh.iconIds) assigned.add(id);
        scopedIds = iconOrder.filter((id) => !assigned.has(id));
        assignmentLabel = "unassigned";
        scopeCommand = {
          type: "command",
          score: 4,
          command: {
            id: "view-unassigned",
            label: "View unassigned icons in library",
            hint: `${scopedIds.length} icons · ready to file`,
            icon: FolderOpen,
            run: () => {
              const s = useStudio.getState();
              s.setSidebarTab("library");
              s.setLibraryFilter({ query: "", tags: [], mode: "unassigned" });
            },
          },
        };
      }

      const iconItems: Item[] = [];
      for (const id of scopedIds) {
        const e = icons[id];
        if (!e) continue;
        /* round 15: metadata joined the match set — title scores like the
         * file name (it IS the display name), description like a tag */
        const score = scope.rest
          ? Math.max(
              scoreText(e.fileName, scope.rest),
              e.title ? scoreText(e.title, scope.rest) : 0,
              (e.tags ?? []).some((t) => t.includes(scope.rest)) ? 1 : 0,
              e.description?.toLowerCase().includes(scope.rest) ? 1 : 0
            )
          : 1;
        if (score > 0) {
          iconItems.push({ type: "icon", score, iconId: id, fileName: e.fileName, title: e.title, tags: e.tags ?? [], assignment: assignmentLabel });
        }
      }
      iconItems.sort((a, b) => b.score - a.score);
      const capped = iconItems.slice(0, 40);
      return scopeCommand ? [scopeCommand, ...capped] : capped;
    }

    /* commands */
    for (const c of allCommands) {
      const score = Math.max(scoreText(c.label, q), c.hint ? scoreText(c.hint, q) * 0.5 : 0);
      if (score > 0) out.push({ type: "command", score, command: c });
    }

    /* sheets */
    const assignmentByIcon = new Map<string, string>();
    sheets.forEach((sh, i) => {
      const label = sheetLabel(i);
      for (const id of sh.iconIds) if (!assignmentByIcon.has(id)) assignmentByIcon.set(id, label);
    });
    for (let i = 0; i < sheets.length; i++) {
      const sh = sheets[i];
      const label = sheetLabel(i);
      const capacity = getSheetCapacity(sheets, sh.id);
      const sub = `${sh.iconIds.length}/${capacity} cells · ${sh.category}`;
      const score = Math.max(scoreText(label, q), scoreText(sh.category ?? "", q) * 0.6);
      if (score > 0) out.push({ type: "sheet", score, sheetId: sh.id, label, sub, filled: sh.iconIds.length, capacity });
    }

    /* tags */
    const tagCounts = new Map<string, number>();
    for (const id of iconOrder) for (const t of icons[id]?.tags ?? []) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
    for (const [tag, count] of tagCounts) {
      const score = scoreText(tag, q);
      if (score > 0) out.push({ type: "tag", score, tag, count });
    }

    /* icons (limit: score-sorted top 40 — libraries can hold thousands) */
    if (q) {
      const iconItems: ItemOrRecent[] = [];
      for (const id of iconOrder) {
        const e = icons[id];
        if (!e) continue;
        /* round 15: title + description match too (title = display name,
         * description = semantic match like tags) */
        const score = Math.max(
          scoreText(e.fileName, q),
          e.title ? scoreText(e.title, q) : 0,
          (e.tags ?? []).some((t) => t.toLowerCase().includes(q)) ? 1 : 0,
          e.description?.toLowerCase().includes(q) ? 1 : 0
        );
        if (score > 0) {
          iconItems.push({
            type: "icon",
            score,
            iconId: id,
            fileName: e.fileName,
            title: e.title,
            tags: e.tags ?? [],
            assignment: assignmentByIcon.get(id) ?? null,
          });
        }
      }
      iconItems.sort((a, b) => b.score - a.score);
      out.push(...iconItems.slice(0, 40));
    } else {
      /* empty query — recently-inspected icons (stale ids pruned),
       * most-recent-first; the inspector writes this list on every open */
      for (const id of recentIconIds) {
        const e = icons[id];
        if (!e) continue;
        out.push({
          type: "recent-icon",
          score: 1,
          iconId: id,
          fileName: e.fileName,
          title: e.title,
          tags: e.tags ?? [],
          assignment: assignmentByIcon.get(id) ?? null,
        });
      }
    }

    /* order: groups in fixed order, best score first inside each group;
     * with no query, commands keep their given (priority) order */
    out.sort((a, b) => (a.type === b.type ? b.score - a.score : GROUP_ORDER.indexOf(a.type) - GROUP_ORDER.indexOf(b.type)));
    return out;
  }, [query, allCommands, sheets, icons, iconOrder, recentIconIds]);

  /* group boundaries for rendering */
  const groups = useMemo(() => {
    const g: { type: ItemOrRecent["type"]; items: ItemOrRecent[]; start: number }[] = [];
    let cursor = 0;
    for (const type of GROUP_ORDER) {
      const groupItems = items.filter((i) => i.type === type);
      if (groupItems.length > 0) {
        g.push({ type, items: groupItems, start: cursor });
        cursor += groupItems.length;
      }
    }
    return g;
  }, [items]);

  /* clamp selection when results shrink (render-time adjustment) */
  const [prevTotal, setPrevTotal] = useState(items.length);
  if (items.length !== prevTotal) {
    setPrevTotal(items.length);
    if (activeIndex > items.length - 1) setActiveIndex(0);
  }

  /* keep the active row in view */
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-palette-index="${activeIndex}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  function runItem(item: ItemOrRecent): void {
    if (item.type === "command") {
      if (item.command.disabled) return;
      item.command.run();
      saveRecent(item.command.id);
    } else if (item.type === "sheet") {
      const s = useStudio.getState();
      s.setActiveSheet(item.sheetId);
      s.setViewMode("edit");
    } else if (item.type === "tag") {
      useStudio.getState().focusTag(item.tag);
    } else {
      /* "icon" and "recent-icon" — both open the inspector */
      useStudio.getState().openInspector(item.iconId);
    }
    onOpenChange(false);
  }

  function onKeyDown(e: React.KeyboardEvent): void {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => {
        let next = i + 1;
        while (next < items.length) {
          const it = items[next];
          if (!(it.type === "command" && it.command.disabled)) break;
          next++;
        }
        return next >= items.length ? i : next;
      });
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => {
        let prev = i - 1;
        while (prev >= 0) {
          const it = items[prev];
          if (!(it.type === "command" && it.command.disabled)) break;
          prev--;
        }
        return prev < 0 ? i : prev;
      });
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = items[activeIndex];
      if (item) runItem(item);
    }
  }

  /* focus the input whenever the palette opens */
  useEffect(() => {
    if (open) {
      const t = window.setTimeout(() => inputRef.current?.focus(), 30);
      return () => window.clearTimeout(t);
    }
  }, [open]);

  const IconFor: Record<ItemOrRecent["type"], typeof Eye> = {
    command: Keyboard,
    "recent-icon": History,
    sheet: SheetIcon,
    tag: TagIcon,
    icon: ImageIcon,
  };

  function renderRow(item: ItemOrRecent, flatIndex: number): JSX.Element {
    const active = flatIndex === activeIndex;
    const disabled = item.type === "command" && item.command.disabled;
    const Icon = item.type === "command" ? item.command.icon : IconFor[item.type];

    let title: ReactNode;
    /* round 19 · QA fix: truncated text must stay fully readable — the
     * primary label and every truncating sub-line carry a native tooltip
     * with the untruncated string. */
    let titleText = "";
    let right: ReactNode = null;
    let sub: ReactNode = null;

    if (item.type === "command") {
      titleText = item.command.label;
      title = <Highlight text={item.command.label} query={query} />;
      const isRecent = query.trim() === "" && recent.includes(item.command.id);
      sub = (
        <span className="flex items-center gap-1.5 min-w-0">
          {item.command.hint ? <span className="hint-text truncate" title={item.command.hint}>{item.command.hint}</span> : null}
          {isRecent ? (
            <span className="shrink-0 inline-flex items-center gap-0.5 text-[9.5px] text-amber-600/90 dark:text-amber-400/90">
              <History className="h-2.5 w-2.5" aria-hidden="true" />
              recent
            </span>
          ) : null}
        </span>
      );
    } else if (item.type === "sheet") {
      titleText = item.label;
      title = (
        <>
          <Highlight text={item.label} query={query} />
          <span className="text-muted-foreground font-normal"> · {item.sub}</span>
        </>
      );
      right = <span className="kbd-chip shrink-0">edit</span>;
    } else if (item.type === "tag") {
      titleText = item.tag;
      title = <Highlight text={item.tag} query={query} />;
      right = (
        <span className="text-[10px] tabular-nums text-muted-foreground shrink-0">{item.count}</span>
      );
    } else {
      /* "icon" and "recent-icon" share the row shape; scope queries
       * highlight against the scope-rest text, not the raw "#…" prefix */
      const scope = parseScope(query, scopeCtx);
      const highlightQuery = scope && scope.kind !== "invalid" ? scope.rest : query;
      const isRecentIcon = item.type === "recent-icon";
      /* round 15: the title is the primary display name when present;
       * the file name demotes into the sub-line (still visible) */
      titleText = item.title ?? item.fileName;
      title = <Highlight text={item.title ?? item.fileName} query={highlightQuery} />;
      const nameLine = item.title ? (
        <span className="palette-name hint-text truncate font-mono" title={item.fileName}>{item.fileName}</span>
      ) : null;
      sub = item.assignment ? (
        <span className="hint-text">{item.assignment}</span>
      ) : (
        <span className="text-[10px] text-amber-600 dark:text-amber-400">unassigned</span>
      );
      const tagsLine =
        item.tags.length > 0 ? (
          <span className="hint-text truncate" title={item.tags.join(" · ")}>
            {item.tags.slice(0, 3).join(" · ")}
            {item.tags.length > 3 ? ` +${item.tags.length - 3}` : ""}
          </span>
        ) : null;
      /* round 15: file name + tags + assignment share the sub-line; the
       * name appears first when a title displaced it from the primary */
      if (nameLine || tagsLine) {
        sub = (
          <span className="flex items-center gap-1.5 min-w-0">
            {nameLine}
            {sub}
            {tagsLine}
          </span>
        );
      }
      right = (
        <span
          className={"palette-thumb shrink-0 pointer-events-none grid h-6 w-6 place-items-center rounded-md border border-border/60 bg-background text-muted-foreground"}
          aria-hidden="true"
          dangerouslySetInnerHTML={{ __html: icons[item.iconId]?.svg ?? "" }}
        />
      );
      if (isRecentIcon) {
        right = (
          <span className="flex items-center gap-1.5 shrink-0">
            {right}
            <span className="shrink-0 inline-flex items-center gap-0.5 text-[9.5px] text-amber-600/90 dark:text-amber-400/90">
              <History className="h-2.5 w-2.5" aria-hidden="true" />
            </span>
          </span>
        );
      }
    }

    return (
      <button
        type="button"
        role="option"
        aria-selected={active}
        data-palette-index={flatIndex}
        disabled={disabled}
        onMouseMove={() => setActiveIndex(flatIndex)}
        onClick={() => runItem(item)}
        className={`palette-row group relative w-full flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left outline-none transition-colors ${
          active ? "bg-muted/80 ring-1 ring-amber-500/40" : "hover:bg-muted/50"
        } ${disabled ? "opacity-45 cursor-not-allowed" : "cursor-pointer"}`}>
        <span
          className={`palette-ico shrink-0 grid h-6 w-6 place-items-center rounded-md ${
            active ? "bg-amber-500/15 text-amber-600 dark:text-amber-400" : "bg-muted/60 text-muted-foreground"
          }`}
        >
          <Icon className="h-3.5 w-3.5" />
        </span>
        <span className="flex-1 min-w-0 flex flex-col gap-0.5">
          <span className="truncate text-[12.5px] font-medium leading-tight" title={titleText || undefined}>{title}</span>
          {sub ? <span className="truncate text-[10.5px] leading-tight">{sub}</span> : null}
        </span>
        {right}
        {active && !disabled ? (
          <CornerDownLeft className="h-3 w-3 text-muted-foreground shrink-0" aria-hidden="true" />
        ) : null}
      </button>
    );
  }

  const total = items.length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="p-0 gap-0 overflow-hidden max-w-lg top-[18%] translate-y-0 sm:max-w-lg shadow-2xl"
        showCloseButton={false}
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>Command palette</DialogTitle>
          <DialogDescription>
            Search commands, sheets, tags and icons. Arrow keys move, Enter runs, Escape closes.
          </DialogDescription>
        </DialogHeader>

        {/* search input */}
        <div className="palette-search flex items-center gap-2.5 border-b border-border px-3.5 py-3">
          <Search className="palette-search-ico h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={onKeyDown}
            placeholder="Search everything… or scope with #2 / #tag"
            aria-label="Search commands, sheets, tags and icons — prefix with #N to scope to sheet N, #tag to scope to a tag, or #unassigned"
            className="w-full bg-transparent text-[13px] outline-none placeholder:text-muted-foreground/70"
            autoComplete="off"
            spellCheck={false}
          />
          {query ? (
            <button
              type="button"
              onClick={() => {
                setQuery("");
                setActiveIndex(0);
                inputRef.current?.focus();
              }}
              className="shrink-0 rounded-md px-1.5 py-0.5 text-[10px] hint-text hover:bg-muted/70 hover:text-foreground transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label="Clear search"
            >
              clear
            </button>
          ) : (
            <kbd className="kbd-chip shrink-0">esc</kbd>
          )}
        </div>

        {/* scope chip — explains the "#…" mode and offers an out */}
        {(() => {
          const scope = parseScope(query, scopeCtx);
          if (!scope) return null;
          const clearScope = () => {
            setQuery("");
            setActiveIndex(0);
            inputRef.current?.focus();
          };
          if (scope.kind === "invalid") {
            return (
              <div className="palette-scope" role="status">
                {scope.sheetNumber !== null ? (
                  <span className="palette-scope-label">
                    No Sheet {String(scope.sheetNumber).padStart(2, "0")} — this workspace has {sheets.length} sheet
                    {sheets.length === 1 ? "" : "s"}
                  </span>
                ) : (
                  <>
                    <span className="palette-scope-label">No tag “{scope.typed}”</span>
                    {scope.suggestion ? (
                      <button
                        type="button"
                        className="palette-scope-clear"
                        onClick={() => {
                          setQuery(`#${scope.suggestion}${scope.rest ? ` ${scope.rest}` : ""}`);
                          setActiveIndex(0);
                          inputRef.current?.focus();
                        }}
                        aria-label={`Use tag ${scope.suggestion} instead`}
                      >
                        use #{scope.suggestion}
                      </button>
                    ) : (
                      <span className="text-[10px] hint-text">
                        {tagSet.size > 0 ? `this library has ${tagSet.size} tags` : "no tags in this library yet"}
                      </span>
                    )}
                  </>
                )}
                <button type="button" className="palette-scope-clear" onClick={clearScope}>
                  clear
                </button>
              </div>
            );
          }
          /* valid scope — icon per kind, live count, rest-query note */
          const ScopeIcon = scope.kind === "sheet" ? SheetIcon : scope.kind === "tag" ? TagIcon : FolderOpen;
          const scopeCount =
            scope.kind === "sheet"
              ? sheets[scope.sheetIndex].iconIds.length
              : scope.kind === "tag"
                ? iconOrder.filter((id) => (icons[id]?.tags ?? []).includes(scope.tag)).length
                : (() => {
                    const assigned = new Set<string>();
                    for (const sh of sheets) for (const id of sh.iconIds) assigned.add(id);
                    return iconOrder.filter((id) => !assigned.has(id)).length;
                  })();
          const restNote = scope.rest
            ? `matching “${scope.rest}”`
            : scope.kind === "tag"
              ? "all tagged icons"
              : scope.kind === "unassigned"
                ? "ready to file"
                : "all cells";
          return (
            <div className="palette-scope" role="status">
              <ScopeIcon className="h-3 w-3 text-amber-600 dark:text-amber-400" aria-hidden="true" />
              <span className="palette-scope-label">{scope.kind === "unassigned" ? "Unassigned" : scope.label} — {scopeCount} icons</span>
              <span className="text-[10px] hint-text">{restNote}</span>
              <button type="button" className="palette-scope-clear" onClick={clearScope} aria-label="Clear scope and search">
                clear
              </button>
            </div>
          );
        })()}

        {/* results */}
        <div className="palette-list-wrap">
        <div ref={listRef} role="listbox" aria-label="Palette results" className="palette-scroll custom-scroll max-h-[52vh] overflow-y-auto p-1.5">
          {total === 0 ? (
            <div className="palette-empty flex flex-col items-center gap-2 px-6 py-10 text-center">
              <div className="studio-empty-glyph">
                <Search className="h-5 w-5" aria-hidden="true" />
              </div>
              {parseScope(query, scopeCtx) ? (
                <p className="text-[12px] font-medium">Nothing in that scope matches</p>
              ) : (
                <p className="text-[12px] font-medium">No matches for “{query.trim()}”</p>
              )}
              <p className="text-[10.5px] hint-text">
                Try an icon file name, a tag, a sheet number (e.g. “sheet 02”), a command like “export” — or scope with “#2 arrow” / “#navigation” to search one sheet or tag.
              </p>
            </div>
          ) : (
            groups.map((g) => {
              const GroupIcon = GROUP_META[g.type].icon;
              return (
                <div key={g.type} role="group" aria-label={GROUP_META[g.type].title} className="palette-group mb-1.5 last:mb-0">
                  <div className="flex items-center gap-1.5 px-2.5 pt-1.5 pb-1">
                    <GroupIcon className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
                    <span className="studio-group-label">
                      {GROUP_META[g.type].title}
                    </span>
                    <span className="palette-group-count">{g.items.length}</span>
                    {g.type === "recent-icon" ? (
                      <button
                        type="button"
                        className="palette-scope-clear ml-auto"
                        onClick={() => {
                          clearRecentIconIds();
                          setRecentIconIds([]);
                        }}
                        aria-label="Clear recently inspected icons"
                        title="Forget the recently inspected list"
                      >
                        clear
                      </button>
                    ) : null}
                  </div>
                  {g.items.map((item) => {
                    const flatIndex = g.start + g.items.indexOf(item);
                    return <div key={flatIndex}>{renderRow(item, flatIndex)}</div>;
                  })}
                </div>
              );
            })
          )}
        </div>
        <span className="palette-scroll-fade" aria-hidden="true" />
        </div>

        {/* footer */}
        <div className="studio-dlg-footer flex items-center justify-between gap-3 px-3.5 py-2">
          <span className="flex items-center gap-1.5 text-[10px] hint-text">
            <span className="flex items-center gap-1">
              <kbd className="kbd-chip"><ArrowUp className="h-2.5 w-2.5" aria-hidden="true" /></kbd>
              <kbd className="kbd-chip"><ArrowDown className="h-2.5 w-2.5" aria-hidden="true" /></kbd>
              navigate
            </span>
            <span className="text-muted-foreground/40">·</span>
            <span className="flex items-center gap-1">
              <kbd className="kbd-chip"><CornerDownLeft className="h-2.5 w-2.5" aria-hidden="true" /></kbd>
              run
            </span>
            {sheets.length > 0 || tagSet.size > 0 ? (
              <>
                <span className="text-muted-foreground/40 hidden sm:inline">·</span>
                <span className="hidden sm:inline items-center gap-1">
                  <kbd className="kbd-chip">#N · #tag</kbd>
                  scope
                </span>
              </>
            ) : null}
          </span>
          <span className="flex items-center gap-1.5 text-[10px] hint-text">
            <FileSpreadsheet className="h-3 w-3" aria-hidden="true" />
            {total} result{total === 1 ? "" : "s"}
            {query.trim() ? "" : " · everything searchable"}
          </span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
