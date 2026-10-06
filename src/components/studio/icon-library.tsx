"use client";

/**
 * ICON SHEET STUDIO — Icon library (sidebar "Library" tab).
 *
 * Exports:
 *  · UploadDropzone     — SVG import (drag & drop + file picker), compact + full variants.
 *  · IconLibraryPanel   — searchable / filterable / TAG-filterable icon grid with
 *                         multi-select, batch tag editing, "new sheet from selection",
 *                         move-to-sheet flow (overflow → create-new-sheet dialog) and
 *                         drag-INTO-sheet sources (drop targets are the overview cards).
 *
 * Performance: the grid virtualizes when the filtered list exceeds 200 items —
 * only the visible row window (+ overscan) is mounted, with pixel-exact spacer
 * divs (row stride = 48px tile + 6px grid gap = 54px) so scrolling never jitters.
 * The scroll range state only updates when the visible row bounds change.
 *
 * Overflow flow note: the frozen store's moveIcons(target, createOverflowSheet)
 * creates the overflow sheet only when a single call both fits some icons AND
 * overflows. So this panel predicts overflow BEFORE moving (selection vs free
 * capacity), opens the dialog, and then performs exactly one moveIcons call:
 *   · "Create new sheet" → moveIcons(selection, target, true)  (fitting → target,
 *     overflow → freshly created sheet with same template/category).
 *   · "Cancel"           → moveIcons(selection, target, false) (fitting move,
 *     overflow icons stay unassigned).
 * End states are identical to the two-step flow, with one clean undo entry.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import { toast } from "sonner";
import {
  ArrowDownUp,
  ArrowRightLeft,
  Check,
  ChevronDown,
  CircleCheck,
  FileBox,
  FileDown,
  FolderMinus,
  History,
  ListPlus,
  Loader2,
  Maximize2,
  PenLine,
  Ruler,
  Rows3,
  ScanSearch,
  Search,
  SearchX,
  SquarePlus,
  Tag as TagIcon,
  Tags,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useDraggable } from "@dnd-kit/core";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
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
import { cn } from "@/lib/utils";
import {
  getSheetCapacity,
  getUnassignedIconIds,
  useStudio,
  type ImportReport,
} from "@/lib/studio/store";
import { justDragged } from "@/lib/studio/drag-gate";
import { iconMatchesLibraryFilter, libraryFilterIsEmpty } from "@/lib/studio/filter";
import { similarityGroupCount } from "@/lib/studio/similarity";
import { analyzeNativeStroke } from "@/lib/studio/icon-style";
import { representativeGridIconBox } from "@/lib/studio/stroke-migration";
import { iconFitBasis } from "@/lib/studio/icon-fit";
import { styledIconPreviewSvg } from "@/lib/studio/icon-preview";
import type { IconEntry, LibraryDensity, LibrarySortMode, LibraryTagLogic } from "@/lib/studio/types";

/* ------------------------------------------------------------------ */
/* Live similarity count (round 13)                                    */
/* ------------------------------------------------------------------ */

/** Debounced, membership-cached count of similar-icon groups — powers the
 *  library toolbar chip. The 200ms debounce keeps rapid import/delete
 *  batches from rescanning per event; similarityGroupCount itself returns
 *  the cached count in O(n) whenever the library membership did not
 *  change (tag edits, sheet moves, selection changes). */
function useSimilarityCount(): number {
  const icons = useStudio((s) => s.icons);
  const iconOrder = useStudio((s) => s.iconOrder);
  const [count, setCount] = useState(0);
  useEffect(() => {
    const t = window.setTimeout(() => setCount(similarityGroupCount(icons, iconOrder)), 200);
    return () => window.clearTimeout(t);
  }, [icons, iconOrder]);
  return count;
}

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

/** Row overscan rendered below the viewport (covers fast scroll + rounding). */
const OVERSCAN_ROWS = 3;
/** Switch from plain rendering to windowed virtualization above this count. */
const VIRTUALIZE_THRESHOLD = 200;

/** Tile density presets — each density swaps the column count, the tile box
 *  class and the exact virtualization row stride (tile + gap-1.5 = 6px).
 *  "standard" is byte-identical to the pre-density layout (4 × 48px + 6).
 *  The density itself is persisted (settings.libraryDensity), so it
 *  survives reloads without any migration — older workspaces hydrate as
 *  "standard" via the ?? fallback.
 *
 *  Responsive tile widths: `w-full max-w-10/12/16` keeps the ROW height
 *  pixel-exact (virtualization stride unchanged) while letting tiles shrink
 *  a few px inside narrower sidebars (grid cells are 1fr) instead of
 *  overflowing the grid — fixed `w-10` tiles would force 5×40+4×6=224px of
 *  min-content and clip at the 224px lg-breakpoint sidebar. */
const DENSITY_PRESETS: Record<
  LibraryDensity,
  { cols: number; rowH: number; tileClass: string; label: string; hint: string }
> = {
  compact: { cols: 5, rowH: 46, tileClass: "h-10 w-full max-w-10", label: "Compact", hint: "5 columns · 40px tiles" },
  standard: { cols: 4, rowH: 54, tileClass: "h-12 w-full max-w-12", label: "Standard", hint: "4 columns · 48px tiles" },
  large: { cols: 3, rowH: 70, tileClass: "h-16 w-full max-w-16", label: "Large", hint: "3 columns · 64px tiles" },
};

/** Sort menu options — "manual" (library order) is the default and keeps
 *  the pre-sort behavior byte-identical. The stroke modes (round 17) sort
 *  by the measured native stroke width — the SAME cached
 *  analyzeNativeStroke measurement the renderer/inspector/report use. */
const SORT_OPTIONS: { value: LibrarySortMode; label: string; hint: string }[] = [
  { value: "manual", label: "Library order", hint: "Upload / management order" },
  { value: "name-asc", label: "Name A → Z", hint: "File name, ascending" },
  { value: "name-desc", label: "Name Z → A", hint: "File name, descending" },
  { value: "newest", label: "Newest first", hint: "Recently added icons" },
  { value: "oldest", label: "Oldest first", hint: "First added icons" },
  { value: "tags-desc", label: "Most tagged", hint: "Tag count, then name" },
  { value: "stroke-desc", label: "Boldest stroke first", hint: "Measured native weight, heavy → light" },
  { value: "stroke-asc", label: "Finest stroke first", hint: "Measured native weight, light → heavy" },
];

const SORT_LABEL = new Map(SORT_OPTIONS.map((o) => [o.value, o.label] as const));

/** Numeric-aware name collation so "icon-2" sorts before "icon-10". */
const nameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Is this sort mode driven by the measured stroke width? */
function isStrokeSort(mode: LibrarySortMode): mode is "stroke-asc" | "stroke-desc" {
  return mode === "stroke-asc" || mode === "stroke-desc";
}

/** One measured library icon: `root` = native stroke width in root user
 *  units (the inspector's "N px" readout, same analyzeNativeStroke cache),
 *  `maxDim` = the icon's FIT BASIS — max(ink bounds) at factor 1, the
 *  viewBox's larger dimension as the honest fallback (the divisor the
 *  canvas-px conversion needs — root · embedBox / basis, the identical
 *  math the renderer's embed plan uses). null root = no safely measurable
 *  stroke/outline artwork. Computed ONCE per audit activation over the
 *  whole library (analyzeNativeStroke + iconInkBounds are content-hash
 *  cached, so re-runs after edits only re-measure changed icons). */
interface MeasuredStroke {
  root: number | null;
  maxDim: number;
}

function measureStrokeWidths(
  iconOrder: string[],
  icons: Record<string, IconEntry>,
): Map<string, MeasuredStroke> {
  const map = new Map<string, MeasuredStroke>();
  for (const id of iconOrder) {
    const entry = icons[id];
    if (!entry) continue;
    const report = analyzeNativeStroke(entry.svg);
    const maxDim = iconFitBasis(entry.svg);
    map.set(id, { root: report.rootWidth > 0 ? report.rootWidth : null, maxDim });
  }
  return map;
}

function sortIconList(
  list: IconEntry[],
  mode: LibrarySortMode,
  /** DISPLAY stroke widths (root units or canvas px — whatever the badges
   *  currently show). Sorting follows the display unit so the visible badge
   * numbers are always in sort order. */
  strokeWidths: Map<string, number | null> | null,
): IconEntry[] {
  switch (mode) {
    case "name-asc":
      return list.sort((a, b) => nameCollator.compare(a.fileName, b.fileName));
    case "name-desc":
      return list.sort((a, b) => nameCollator.compare(b.fileName, a.fileName));
    case "newest":
      return list.sort((a, b) => b.createdAt - a.createdAt || nameCollator.compare(a.fileName, b.fileName));
    case "oldest":
      return list.sort((a, b) => a.createdAt - b.createdAt || nameCollator.compare(a.fileName, b.fileName));
    case "tags-desc":
      return list.sort(
        (a, b) => (b.tags?.length ?? 0) - (a.tags?.length ?? 0) || nameCollator.compare(a.fileName, b.fileName),
      );
    case "stroke-desc":
    case "stroke-asc": {
      /* unmeasurable icons sink to the END regardless of direction — they
       * have no weight to compare (the audit's "—" class). Sorts on the
       * ACTIVE display unit (round 18): the badge numbers users see are
       * exactly what's ordered — flipping units or the reference sheet
       * re-sorts coherently with the numbers shown. */
      const w = (id: string): number | null => strokeWidths?.get(id) ?? null;
      return list.sort((a, b) => {
        const wa = w(a.id);
        const wb = w(b.id);
        if (wa == null && wb == null) return nameCollator.compare(a.fileName, b.fileName);
        if (wa == null) return 1;
        if (wb == null) return -1;
        const cmp = wa - wb;
        if (cmp !== 0) return mode === "stroke-desc" ? -cmp : cmp;
        return nameCollator.compare(a.fileName, b.fileName);
      });
    }
    default:
      return list; /* manual = library order, untouched */
  }
}

/** Tag chips shown in the filter row (most frequent first). */
const MAX_TAG_CHIPS = 8;

type FilterMode = "all" | "unassigned";

interface OverflowDialogState {
  selection: string[];
  targetSheetId: string;
  targetSheetLabel: string;
  overflowCount: number;
  toMoveCount: number;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/* ------------------------------------------------------------------ */
/* UploadDropzone                                                      */
/* ------------------------------------------------------------------ */

export function UploadDropzone({ compact = false }: { compact?: boolean }): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const openPicker = useCallback(() => {
    inputRef.current?.click();
  }, []);

  /* The ENTIRE duplicate policy lives in the store pipeline
   * (importWithDuplicateCheck): detect → ASK via the app-level
   * "Duplicate Icons Detected" dialog → import per the user's choice.
   * This component only forwards the files — it can no longer bypass
   * (or duplicate) the ask-first contract, and neither can any other
   * upload surface. */
  const handleFiles = useCallback(async (files: FileList | File[]) => {
    const list = Array.from(files);
    if (list.length === 0) return;
    setBusy(true);
    try {
      await useStudio.getState().importWithDuplicateCheck(list);
    } finally {
      setBusy(false);
    }
  }, []);

  const fileInput = (
    <input
      ref={inputRef}
      type="file"
      multiple
      accept=".svg,image/svg+xml"
      className="hidden"
      aria-hidden="true"
      tabIndex={-1}
      onChange={(e) => {
        if (e.target.files && e.target.files.length > 0) void handleFiles(e.target.files);
        e.target.value = "";
      }}
    />
  );

  if (compact) {
    return (
      <>
        {fileInput}
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 shrink-0 gap-1.5 px-2.5 text-[11px]"
          onClick={openPicker}
          disabled={busy}
          title="Upload SVG icons to your library (drag & drop works too)"
          aria-label="Upload SVG icons"
        >
          {busy ? (
            <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
          ) : (
            <Upload className="h-3 w-3" aria-hidden="true" />
          )}
          Upload
        </Button>
      </>
    );
  }

  return (
    <div
      onClick={() => {
        if (!busy) openPicker();
      }}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        e.preventDefault();
        setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        if (busy) return;
        const files = e.dataTransfer.files;
        if (files.length > 0) void handleFiles(files);
      }}
      className={cn(
        "upload-dropzone group flex cursor-pointer select-none flex-col items-center justify-center gap-1 rounded-xl border bg-card p-8 text-center outline-none transition-[border-color,background-color,box-shadow] duration-150",
        "focus-within:ring-2 focus-within:ring-ring/40",
        dragging
          ? "border-dashed border-amber-500/80 bg-amber-500/[0.07] shadow-md"
          : "border-dashed border-border/90 dark:border-border hover:border-amber-500/50 hover:bg-amber-500/[0.04] hover:shadow-sm",
        busy && "pointer-events-none opacity-60",
      )}
    >
      {fileInput}
      {busy ? (
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-hidden="true" />
      ) : (
        <Upload className="h-5 w-5 text-muted-foreground/70 transition-[color,transform] duration-200 group-hover:scale-110 group-hover:-rotate-3 group-hover:text-amber-600 dark:group-hover:text-amber-400" aria-hidden="true" />
      )}
      <p className="text-[13px] font-medium">Drop SVG icons here</p>
      <p className="text-[11px] text-muted-foreground">
        or{" "}
        <span className="underline underline-offset-2 decoration-border transition-colors group-hover:decoration-muted-foreground">
          browse files
        </span>
      </p>
      <p className="pro-help mt-1">Duplicates? You decide — add or skip</p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Import summary card (round 17) — surfaces lastImportReport           */
/* ------------------------------------------------------------------ */

/** Compact relative-time label for the import's finishedAt stamp. */
function importAgoLabel(finishedAt: number | undefined): string {
  if (!finishedAt) return "earlier this session";
  const sec = Math.max(0, Math.round((Date.now() - finishedAt) / 1000));
  if (sec < 10) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

/* ------------------------------------------------------------------ */
/* Import history (round 18) — session ring buffer of past reports      */
/* ------------------------------------------------------------------ */

/** One history row: relative time + the same compact audit the summary
 *  card shows (imported / duplicates added / skipped), with the per-file
 *  skip reasons on hover exactly like the card. */
function ImportHistoryRow({ report }: { report: ImportReport }): JSX.Element {
  const cancelled = report.cancelled === true;
  const parts: string[] = [];
  if (report.imported > 0) parts.push(`${report.imported} imported`);
  if (report.duplicatesImported > 0)
    parts.push(`${report.duplicatesImported} duplicate${report.duplicatesImported === 1 ? "" : "s"} added`);
  if (report.duplicates > 0)
    parts.push(`${report.duplicates} duplicate${report.duplicates === 1 ? "" : "s"} skipped`);
  if (report.skipped > 0) parts.push(`${report.skipped} skipped`);
  const skipTitle =
    report.skipReasons.length > 0
      ? `Why files were skipped:\n${report.skipReasons.map((r) => `· ${r}`).join("\n")}`
      : undefined;
  return (
    <li className="flex items-baseline gap-2 py-1">
      <span className="w-[4.6rem] shrink-0 text-right text-[9.5px] uppercase tracking-wider text-muted-foreground/80">
        {importAgoLabel(report.finishedAt)}
      </span>
      {cancelled ? (
        <span className="text-[10.5px] text-muted-foreground">cancelled — nothing added</span>
      ) : (
        <span
          className="text-[10.5px] leading-relaxed text-foreground/85"
          title={skipTitle}
        >
          {parts.length > 0 ? (
            <>
              <span className="font-medium tabular-nums text-emerald-700 dark:text-emerald-400">
                {parts[0].match(/^\d+/)?.[0] ?? ""}
              </span>
              {parts[0].replace(/^\d+/, "")}
              {parts.length > 1 ? (
                <span className="text-muted-foreground"> · {parts.slice(1).join(" · ")}</span>
              ) : null}
            </>
          ) : (
            <span className="text-muted-foreground">no changes</span>
          )}
        </span>
      )}
    </li>
  );
}

/** The history list content shared by every access point (card header
 *  button + the collapsed strip). Newest first — the store keeps the ring
 *  buffer that way already. */
function ImportHistoryList({ history }: { history: ImportReport[] }): JSX.Element {
  return (
    <div className="flex flex-col">
      <p className="pro-label mb-1 flex items-center gap-1.5">
        <History className="h-3 w-3" aria-hidden="true" />
        Imports this session
      </p>
      <ul className="max-h-56 overflow-y-auto custom-scroll pr-1">
        {history.map((r, i) => (
          <ImportHistoryRow key={`${r.finishedAt ?? i}-${i}`} report={r} />
        ))}
      </ul>
      <p className="mt-1.5 border-t border-border/60 pt-1.5 text-[9.5px] text-muted-foreground/70">
        Session only — resets when the app reloads. Dismissed summaries stay here.
      </p>
    </div>
  );
}

/** Small clock button opening the history popover. `label` doubles as the
 *  accessible name; `className` positions it at each call site. */
function ImportHistoryPopover({
  history,
  className,
  label,
}: {
  history: ImportReport[];
  className?: string;
  label: string;
}): JSX.Element {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={label}
          title={label}
          className={cn(
            "grid size-4.5 place-items-center rounded-md text-muted-foreground/70 outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
            className,
          )}
        >
          <History className="h-2.5 w-2.5" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" side="bottom" className="w-72 p-2.5">
        <ImportHistoryList history={history} />
      </PopoverContent>
    </Popover>
  );
}

/** Slim strip shown where the summary card lives once the card has been
 *  dismissed but the session still has history — keeps the audit reachable
 *  without re-imposing the card. */
function CollapsedImportHistory(): JSX.Element | null {
  const report = useStudio((s) => s.lastImportReport);
  const history = useStudio((s) => s.importHistory);
  if (report || history.length === 0) return null;
  return (
    <div className="flex shrink-0 items-center gap-1.5 rounded-md border border-border/60 bg-muted/25 px-2 py-1 text-[10px] text-muted-foreground">
      <History className="h-3 w-3 shrink-0" aria-hidden="true" />
      <span className="tabular-nums">
        {history.length} import{history.length === 1 ? "" : "s"} this session
      </span>
      <span className="ml-auto">
        <ImportHistoryPopover history={history} label="View the session's import history" />
      </span>
    </div>
  );
}

/**
 * The store has kept a full ImportReport of every upload since round 4 —
 * but nothing ever READ it after the toasts faded (the "write-only state"
 * gap flagged in the phase-2 handover). This card surfaces the LAST report
 * persistently at the top of the library panel: what landed, what was
 * skipped (with the exact per-file reasons on hover), how duplicates were
 * resolved — the full audit of the most recent import at a glance.
 * Session-only (lastImportReport is runtime state, never persisted) and
 * user-dismissible via the X button (dismissImportReport store action).
 */
function ImportSummaryCard(): JSX.Element | null {
  const report = useStudio((s) => s.lastImportReport);
  const history = useStudio((s) => s.importHistory);
  const dismiss = useStudio((s) => s.dismissImportReport);
  if (!report) return null;

  const cancelled = report.cancelled === true;
  const ago = importAgoLabel(report.finishedAt);
  const skipTitle =
    report.skipReasons.length > 0
      ? `Why files were skipped:\n${report.skipReasons.map((r) => `· ${r}`).join("\n")}`
      : "Invalid files (not readable SVG) — nothing was imported from them";

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "studio-rise relative flex shrink-0 flex-col gap-1 rounded-lg border px-2.5 py-2 pr-7 shadow-xs shadow-black/5 dark:shadow-black/30",
        cancelled
          ? "border-border/70 bg-muted/40"
          : "border-emerald-600/25 bg-emerald-500/[0.05] dark:border-emerald-500/25 dark:bg-emerald-500/[0.07]",
      )}
    >
      <div className="flex items-center gap-1.5">
        {cancelled ? (
          <History className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />
        ) : (
          <CircleCheck className="h-3 w-3 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
        )}
        <span className="text-[11px] font-semibold tracking-tight">
          {cancelled ? "Import cancelled" : "Last import"}
        </span>
        <span className="hint-text text-[9.5px] uppercase tracking-wider">{ago}</span>
        {/* round 18 · session import history — the earlier reports stay
            viewable here after this card is dismissed */}
        {history.length > 1 ? (
          <ImportHistoryPopover
            history={history}
            className="ml-auto mr-4"
            label={`Import history — ${history.length - 1} earlier this session`}
          />
        ) : null}
      </div>
      {cancelled ? (
        <p className="text-[10.5px] leading-relaxed text-muted-foreground">
          Nothing was added — your library is unchanged.
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10.5px] leading-relaxed">
          {report.imported > 0 ? (
            <span className="font-medium tabular-nums text-emerald-700 dark:text-emerald-400">
              {report.imported} imported
            </span>
          ) : null}
          {report.duplicatesImported > 0 ? (
            <span className="tabular-nums text-muted-foreground">
              · {report.duplicatesImported} duplicate{report.duplicatesImported === 1 ? "" : "s"} added as copies
            </span>
          ) : null}
          {report.duplicates > 0 ? (
            <span className="tabular-nums text-muted-foreground">
              · {report.duplicates} duplicate{report.duplicates === 1 ? "" : "s"} skipped
            </span>
          ) : null}
          {report.skipped > 0 ? (
            <span
              className="tabular-nums text-amber-700 underline decoration-dotted decoration-amber-600/50 underline-offset-2 dark:text-amber-400"
              title={skipTitle}
            >
              · {report.skipped} skipped — hover for reasons
            </span>
          ) : null}
          {report.imported === 0 && report.skipped === 0 && report.duplicates === 0 && report.duplicatesImported === 0 ? (
            <span className="text-muted-foreground">No changes</span>
          ) : null}
        </div>
      )}
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss the import summary"
        title="Dismiss — this summary stays until the next import"
        className="absolute right-1.5 top-1.5 grid size-4.5 place-items-center rounded-md text-muted-foreground/70 outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <X className="h-2.5 w-2.5" aria-hidden="true" />
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Icon tile — click-to-select + drag-into-sheet source                */
/* ------------------------------------------------------------------ */

function IconTile({
  entry,
  selected,
  sheetIndex,
  dragIds,
  tileClass,
  index,
  cols,
  tabStop,
  strokeWidth,
  strokeUnitLabel,
  strokeHeavyAt,
  onNavigate,
  onRovingFocus,
  onToggle,
  onInspect,
}: {
  entry: IconEntry;
  selected: boolean;
  /** array index of the owning sheet, or null when unassigned */
  sheetIndex: number | null;
  /** drag payload: full selection when this tile is part of it, else just this icon */
  dragIds: string[];
  /** density-driven tile box ("h-10 w-10" | "h-12 w-12" | "h-16 w-16") —
   *  must stay in sync with DENSITY_PRESETS rowH (tile + 6px gap) */
  tileClass: string;
  /** position of this tile in the FILTERED list (not the DOM slice) — the
   *  keyboard walker resolves targets by this index so virtualization
   *  never breaks arrow navigation */
  index: number;
  /** grid column count for the active density (arrow up/down = one row) */
  cols: number;
  /** roving tabindex (round 12): exactly ONE tile in the grid is a Tab
   *  stop (the last focused one). Tab enters/leaves the grid once; arrows
   *  remain the fast path. Clicks and programmatic focus move the stop. */
  tabStop: boolean;
  /** round 17/18 stroke audit: the icon's measured native stroke width in
   *  the ACTIVE display unit (root user units, or canvas px via the active
   *  sheet's embed — see the panel's displayWidths) or null when
   *  unmeasurable — undefined = audit off, no badge rendered. */
  strokeWidth?: number | null;
  /** round 18: tooltip suffix naming the display unit + its reference
   *  ("root user units…" / "canvas px on Sheet NN's grid embed…"). */
  strokeUnitLabel?: string;
  /** round 18: amber heavy-outlier threshold in the ACTIVE unit (8 root
   *  units, or the embed-scaled equivalent in canvas px). */
  strokeHeavyAt?: number;
  onRovingFocus: (index: number) => void;
  /** keyboard walking: request focus for an ABSOLUTE filtered index (the
   *  parent clamps, scrolls virtual rows into the window, then focuses) */
  onNavigate: (target: number) => void;
  onToggle: (id: string) => void;
  onInspect: (id: string) => void;
}): JSX.Element {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `lib-${entry.id}`,
    data: { type: "library-icon", iconIds: dragIds },
  });

  /* P7 · full-visibility tile: the raw source svg clips at its own declared
   * viewBox (root svg overflow), so artwork extending past the viewBox was
   * cut off in the grid. The tile now renders through the shared preview
   * engine in ORIGINAL-LOOK mode (no stroke request, no tint) whose viewport
   * is the icon's measured ink bounds — the same region the sheet's embed
   * fits — so the library shows the COMPLETE artwork exactly as the sheet
   * will place it. Unmeasurable icons keep the raw fallback (as-authored). */
  const tileHtml = useMemo(
    () => styledIconPreviewSvg(entry, undefined, { size: 64 }),
    [entry],
  );

  const tags = entry.tags ?? [];
  /* round 15: a user-set title leads the tooltip; the file name stays
   * visible as the secondary identity (kept for screen-reader parity) */
  const displayName = entry.title ?? entry.fileName;
  const title =
    sheetIndex === null
      ? entry.title
        ? `${entry.title} (${entry.fileName}) — unassigned`
        : `${entry.fileName} — unassigned`
      : entry.title
        ? `${entry.title} (${entry.fileName}) — in Sheet ${pad2(sheetIndex + 1)}`
        : `${entry.fileName} — in Sheet ${pad2(sheetIndex + 1)}`;

  /* keyboard grid walking (round 8): arrows move focus by 1 / one full row
   *  (density-aware), Home/End jump to the list ends, I opens the inspector.
   *  Enter/Space keep their native button behavior (toggle selection) — the
   *  DndContext is PointerSensor-only, so no keyboard sensor competes. */
  function handleKeyDown(e: React.KeyboardEvent<HTMLButtonElement>): void {
    let target: number | null = null;
    switch (e.key) {
      case "ArrowLeft":
        target = index - 1;
        break;
      case "ArrowRight":
        target = index + 1;
        break;
      case "ArrowUp":
        target = index - cols;
        break;
      case "ArrowDown":
        target = index + cols;
        break;
      case "Home":
        target = 0;
        break;
      case "End":
        target = Number.POSITIVE_INFINITY;
        break;
      case "i":
      case "I":
        e.preventDefault();
        onInspect(entry.id);
        return;
      default:
        return;
    }
    e.preventDefault();
    if (target !== null) onNavigate(target);
  }

  return (
    <div className={cn("group/tile relative", tileClass)}>
      <button
        ref={setNodeRef}
        {...attributes}
        {...listeners}
        data-tile-index={index}
        type="button"
        tabIndex={tabStop ? 0 : -1}
        onFocus={() => onRovingFocus(index)}
        title={
          tags.length > 0
            ? `${title} · tags: ${tags.join(", ")} · arrows walk · Enter selects · I inspects`
            : `${title} · arrows walk · Enter selects · I inspects`
        }
        aria-label={`${title}${tags.length ? ` · tags ${tags.join(", ")}` : ""}${selected ? " (selected)" : ""}`}
        aria-pressed={selected}
        onClick={() => {
          if (justDragged()) return; // swallow the click that trails a drag
          onToggle(entry.id);
        }}
        onDoubleClick={() => {
          if (justDragged()) return;
          onInspect(entry.id);
        }}
        onKeyDown={handleKeyDown}
        className={cn(
          "h-full w-full touch-none cursor-grab overflow-hidden rounded-lg border bg-card p-[15%] outline-none transition-[color,background-color,border-color,box-shadow,transform] duration-150 active:cursor-grabbing",
          "hover:-translate-y-px hover:shadow-md hover:shadow-black/15 dark:hover:shadow-black/50 active:translate-y-0 active:shadow-none",
          "focus-visible:ring-2 focus-visible:ring-amber-500",
          selected
            ? "border-amber-500/80 bg-amber-500/10 ring-2 ring-amber-500/35"
            : "border-border/60 dark:border-border hover:border-amber-500/50 dark:hover:border-amber-500/60",
          isDragging && "opacity-40",
        )}
      >
        <span
          className="block h-full w-full text-foreground transition-transform duration-150 ease-out group-hover/tile:scale-[1.04] [&>svg]:block [&>svg]:h-full [&>svg]:w-full"
          dangerouslySetInnerHTML={{ __html: tileHtml || entry.svg }}
        />
        {/* selection check (top-left): appears on the amber selected ring */}
        {selected ? (
          <span
            aria-hidden="true"
            className="absolute left-0.5 top-0.5 grid h-[15px] w-[15px] place-items-center rounded-full bg-amber-500 text-amber-50 shadow-sm"
          >
            <svg viewBox="0 0 24 24" className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth="4">
              <path d="M20 6L9 17l-5-5" />
            </svg>
          </span>
        ) : null}
        {/* assignment dot (top-right): amber = unassigned, muted = in a sheet */}
        <span
          aria-hidden="true"
          className={cn(
            "absolute right-1 top-1 h-1 w-1 rounded-full",
            sheetIndex === null ? "bg-amber-500" : "bg-muted-foreground/50",
          )}
        />
        {/* tag indicator (bottom-left): present only when the icon is tagged */}
        {tags.length > 0 ? (
          <span
            aria-hidden="true"
            className="absolute bottom-0.5 left-1 h-1.5 w-1.5 rounded-full border border-background bg-amber-700/80 dark:bg-amber-400/80"
          />
        ) : null}
        {/* round 17/18 stroke audit badge (top-center): the measured native
            stroke width in the ACTIVE display unit — root user units (the
            inspector's number) or canvas px via the active sheet's grid
            embed (the stroke report's number). "—" = no measurable stroke
            artwork. Rendered INSIDE the (overflow-hidden) tile so it can
            never leak outside the grid cell; only when the audit is on. */}
        {strokeWidth !== undefined ? (
          <span
            aria-hidden="true"
            className={cn(
              "absolute left-1/2 top-0 -translate-x-1/2 rounded-b-md border border-t-0 border-border/80 px-1 font-mono text-[8.5px] leading-[11px] tabular-nums",
              strokeWidth == null
                ? "bg-muted/85 text-muted-foreground/80"
                : strokeWidth >= (strokeHeavyAt ?? 8)
                  ? "border-amber-600/40 bg-amber-500/15 text-amber-800 dark:text-amber-300"
                  : "bg-background/85 text-muted-foreground",
            )}
            title={
              strokeWidth == null
                ? "No safely measurable stroke artwork (outline/fill analysis found no width)"
                : `Measured native stroke ≈ ${Math.round(strokeWidth * 10) / 10} ${strokeUnitLabel ?? "user units"} — the weight the uniform-stroke engine adjusts around`
            }
          >
            {strokeWidth == null ? "—" : String(Math.round(strokeWidth * 10) / 10)}
          </span>
        ) : null}
      </button>
      {/* inspect affordance (bottom-right, hover/focus revealed) — part of
          the roving pattern (round 12): tabbable only on the roving tile,
          so Tab walks the grid once instead of every tile's affordance.
          "I" on the focused tile remains the keyboard path. */}
      <button
        type="button"
        tabIndex={tabStop ? 0 : -1}
        onClick={(e) => {
          e.stopPropagation();
          onInspect(entry.id);
        }}
        aria-label={`Inspect ${displayName}`}
        title={`Inspect ${displayName}`}
        className={cn(
          "absolute bottom-0.5 right-0.5 z-10 grid h-[18px] w-[18px] place-items-center rounded-md border border-border bg-background/95 text-muted-foreground shadow-sm",
          "opacity-0 transition-all duration-150 hover:border-amber-500/60 hover:text-amber-600",
          "group-hover/tile:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-amber-500 outline-none",
        )}
      >
        <Maximize2 className="h-2.5 w-2.5" aria-hidden="true" />
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Tag editor popover (batch add / remove on the selection)            */
/* ------------------------------------------------------------------ */

function TagEditorPopover({
  selection,
  libraryTagCounts,
}: {
  selection: string[];
  libraryTagCounts: Map<string, number>;
}): JSX.Element {
  const icons = useStudio((s) => s.icons);
  const updateIconTags = useStudio((s) => s.updateIconTags);
  const [input, setInput] = useState("");
  const [open, setOpen] = useState(false);

  /* tags present on EVERY selected icon → removable batch chips */
  const commonTags = useMemo(() => {
    if (selection.length === 0) return [] as string[];
    let common = icons[selection[0]]?.tags ?? [];
    for (const id of selection.slice(1)) {
      const t = new Set(icons[id]?.tags ?? []);
      common = common.filter((tag) => t.has(tag));
      if (common.length === 0) break;
    }
    return [...common].sort();
  }, [selection, icons]);

  /* unused library tags → one-click suggestions */
  const suggestions = useMemo(() => {
    const common = new Set(commonTags);
    return [...libraryTagCounts.entries()]
      .filter(([tag]) => !common.has(tag))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([tag]) => tag);
  }, [libraryTagCounts, commonTags]);

  const parseInput = (raw: string): string[] =>
    raw
      .split(/[,\n]/)
      .map((t) => t.trim().toLowerCase().replace(/\s+/g, "-"))
      .filter(Boolean);

  const commitInput = () => {
    const tags = parseInput(input);
    if (tags.length === 0) return;
    updateIconTags(selection, "add", tags);
    setInput("");
    toast.success(`Tagged ${selection.length} icon${selection.length === 1 ? "" : "s"} — ${Array.from(new Set(tags)).join(", ")}`, { description: "Ctrl Z to undo" });
  };

  const addSuggestion = (tag: string) => {
    updateIconTags(selection, "add", [tag]);
    toast.success(`Tagged ${selection.length} icon${selection.length === 1 ? "" : "s"} — ${tag}`, { description: "Ctrl Z to undo" });
  };

  const removeCommon = (tag: string) => {
    updateIconTags(selection, "remove", [tag]);
    toast.info(`Removed "${tag}" from ${selection.length} icon${selection.length === 1 ? "" : "s"}`, { description: "Ctrl Z to undo" });
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-6 gap-1 px-2 text-[11px]"
              aria-label="Tag selected icons"
              title="Add or remove tags on the selected icons"
            >
              <TagIcon className="h-3 w-3" aria-hidden="true" />
              Tag
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent className="max-w-64">
          Labels you assign to icons — used for filtering the library, grouping
          icons onto sheets, and AI categorization.
        </TooltipContent>
      </Tooltip>
      <PopoverContent align="end" className="w-64 p-3" onOpenAutoFocus={(e) => e.preventDefault()}>
        <div className="space-y-2.5">
          <p className="text-[11px] font-semibold">
            Tag {selection.length} icon{selection.length === 1 ? "" : "s"}
          </p>
          <p className="pro-help">
            Tags are your own labels (e.g. “navigation”, “shapes”). Filter the
            library by tag, search them by name, or let AI use them to group
            icons onto sheets.
          </p>

          {/* add field */}
          <div className="relative">
            <TagIcon
              className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitInput();
                }
              }}
              placeholder="Add tags — Enter to apply"
              className="h-7 pl-7 text-[11px]"
              spellCheck={false}
              aria-label="New tags, comma separated"
            />
          </div>
          <p className="pro-help">
            Comma-separated, applies to the whole selection.
          </p>

          {/* common tags → removable */}
          {commonTags.length > 0 ? (
            <div className="space-y-1">
              <p className="pro-label">
                On all selected
              </p>
              <div className="flex flex-wrap gap-1">
                {commonTags.map((tag) => (
                  <button
                    key={tag}
                    type="button"
                    className="tag-chip shrink-0"
                    data-active="true"
                    onClick={() => removeCommon(tag)}
                    title={`Remove "${tag}" from the selection`}
                    aria-label={`Remove tag ${tag}`}
                  >
                    {tag}
                    <X className="h-2.5 w-2.5" aria-hidden="true" />
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {/* suggestions */}
          {suggestions.length > 0 ? (
            <div className="space-y-1">
              <p className="pro-label">
                Library tags
              </p>
              <div className="flex flex-wrap gap-1">
                {suggestions.map((tag) => (
                  <button
                    key={tag}
                    type="button"
                    className="tag-chip shrink-0"
                    onClick={() => addSuggestion(tag)}
                    title={`Add "${tag}" to the selection`}
                    aria-label={`Add tag ${tag}`}
                  >
                    <ListPlus className="h-2.5 w-2.5" aria-hidden="true" />
                    {tag}
                    <span className="tabular-nums hint-text">
                      {libraryTagCounts.get(tag)}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/* ------------------------------------------------------------------ */
/* IconLibraryPanel                                                    */
/* ------------------------------------------------------------------ */

export function IconLibraryPanel(): JSX.Element {
  const icons = useStudio((s) => s.icons);
  const iconOrder = useStudio((s) => s.iconOrder);
  const sheets = useStudio((s) => s.sheets);
  const hydrated = useStudio((s) => s.hydrated);
  const deleteIcons = useStudio((s) => s.deleteIcons);
  const unassignIcons = useStudio((s) => s.unassignIcons);
  const openInspector = useStudio((s) => s.openInspector);
  const openSimilarityDialog = useStudio((s) => s.openSimilarityDialog);
  /* round 13: live similar-groups badge — 0 renders nothing */
  const simCount = useSimilarityCount();

  const [selection, setSelection] = useState<string[]>([]);
  const [dialog, setDialog] = useState<OverflowDialogState | null>(null);
  const dialogRef = useRef<OverflowDialogState | null>(null);
  const [moreTagsOpen, setMoreTagsOpen] = useState(false);
  /* roving tabindex (round 12): the FILTERED index of the grid's single Tab
   *  stop. Tab enters the grid at this tile and leaves from it in one press;
   *  arrow walks / clicks / programmatic focus move the stop along. Derived
   *  clamp below keeps it valid when the filter shrinks the list. */
  const [rovingIndex, setRovingIndex] = useState(0);
  /* batch-delete confirm: stores the selection SIZE when armed — any
   * selection change disarms automatically (no effects needed) */
  const [deleteArm, setDeleteArm] = useState<number | null>(null);
  const deleteArmed = deleteArm !== null && deleteArm === selection.length;

  /* round 7: filter state lives in the STORE (survives the library tab
   * unmounting while the Sheets tab is active; the command palette drives
   * it via focusTag). Tag-manager / catalog dialogs likewise moved to the
   * shell. Local state remains only for ephemeral panel concerns.
   * Multi-tag (round 6 of review): tags[] + tagLogic (and/or) replace the
   * single activeTag — one selected tag behaves exactly like before. */
  const query = useStudio((s) => s.libraryFilter.query);
  const filterMode = useStudio((s) => s.libraryFilter.mode);
  const tags = useStudio((s) => s.libraryFilter.tags);
  const tagLogic = useStudio((s) => s.libraryFilter.tagLogic);
  const sort = useStudio((s) => s.libraryFilter.sort);
  const setLibraryFilter = useStudio((s) => s.setLibraryFilter);
  const setLibraryDialog = useStudio((s) => s.setLibraryDialog);
  const density = useStudio((s) => s.settings.libraryDensity ?? "standard");
  const setLibraryDensity = useStudio((s) => s.setLibraryDensity);
  const preset = DENSITY_PRESETS[density] ?? DENSITY_PRESETS.standard;
  const cols = preset.cols;
  const rowH = preset.rowH;
  const setQuery = useCallback((q: string) => setLibraryFilter({ query: q }), [setLibraryFilter]);
  const setFilterMode = useCallback((m: FilterMode) => setLibraryFilter({ mode: m }), [setLibraryFilter]);
  const setSort = useCallback((m: LibrarySortMode) => setLibraryFilter({ sort: m }), [setLibraryFilter]);
  const setTagLogic = useCallback(
    (l: LibraryTagLogic) => setLibraryFilter({ tagLogic: l }),
    [setLibraryFilter],
  );
  /** toggle one tag in/out of the multi-selection (order = click order). */
  const toggleTag = useCallback(
    (t: string) => {
      setLibraryFilter({
        tags: tags.includes(t) ? tags.filter((x) => x !== t) : [...tags, t],
      });
    },
    [setLibraryFilter, tags],
  );
  const clearTags = useCallback(() => setLibraryFilter({ tags: [] }), [setLibraryFilter]);
  /* stable dependency key for effects that must re-run when the tag SET
   * changes (arrays get a fresh reference even when contents are equal) */
  const tagsKey = tags.join("\u0000");

  /* ---- virtualization plumbing (density-aware: row stride follows the
   * active density preset so spacer divs stay pixel-exact at any size) ---- */
  const scrollRef = useRef<HTMLDivElement>(null);
  const [range, setRange] = useState({ start: 0, end: 24 });

  const measure = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const start = Math.floor(el.scrollTop / rowH);
    const end = Math.ceil((el.scrollTop + el.clientHeight) / rowH);
    setRange((prev) => (prev.start === start && prev.end === end ? prev : { start, end }));
  }, [rowH]);

  useEffect(() => {
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [measure]);

  /* density changes reshuffle rows — re-measure and hold the scroll anchor
   * near the same ROW (row index computed with the PREVIOUS stride, then
   * repositioned at the new one) so the viewport doesn't jump to the top */
  const prevRowHRef = useRef(rowH);
  useEffect(() => {
    const el = scrollRef.current;
    const prevRowH = prevRowHRef.current;
    prevRowHRef.current = rowH;
    if (!el || prevRowH === rowH) return;
    const anchorRow = Math.round(el.scrollTop / prevRowH);
    el.scrollTo({ top: anchorRow * rowH });
    measure();
  }, [rowH, measure]);

  const handleScroll = useCallback(
    (e: React.UIEvent<HTMLDivElement>) => {
      const el = e.currentTarget;
      const start = Math.floor(el.scrollTop / rowH);
      const end = Math.ceil((el.scrollTop + el.clientHeight) / rowH);
      setRange((prev) => (prev.start === start && prev.end === end ? prev : { start, end }));
    },
    [rowH],
  );

  /* reset scroll position whenever the filter narrows the list (or the
   * sort mode changes the ordering) — tagsKey re-runs on any tag SET change */
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
    measure();
  }, [query, filterMode, tagsKey, tagLogic, sort, measure]);

  /* ---- derived data ---- */
  const assignedByIcon = useMemo(() => {
    const map = new Map<string, number>();
    sheets.forEach((sheet, idx) => {
      for (const id of sheet.iconIds) {
        if (!map.has(id)) map.set(id, idx);
      }
    });
    return map;
  }, [sheets]);

  const unassignedSet = useMemo(
    () => new Set(getUnassignedIconIds({ sheets, iconOrder })),
    [sheets, iconOrder],
  );

  const libraryTagCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const id of iconOrder) {
      for (const tag of icons[id]?.tags ?? []) {
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }
    return counts;
  }, [iconOrder, icons]);

  /* Faceted chip counts (review round 7): with an ACTIVE filter (query /
   *  mode / tags) each chip shows how many icons of the CURRENT RESULT carry
   *  that tag — the classic faceted-search "refine" signal. With no filter
   *  the result set IS the library, so it degrades to the total count (the
   *  historic chip number). Computed from the same shared predicate the grid
   *  uses, so chip math can never drift from what the grid shows. */
  const facetTagCounts = useMemo(() => {
    const filter = { query, tags, tagLogic, mode: filterMode };
    if (libraryFilterIsEmpty(filter)) return libraryTagCounts;
    const counts = new Map<string, number>();
    for (const id of iconOrder) {
      const entry = icons[id];
      if (!entry) continue;
      if (!iconMatchesLibraryFilter(entry, id, filter, unassignedSet)) continue;
      for (const tag of entry.tags ?? []) {
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }
    return counts;
  }, [iconOrder, icons, query, tags, tagLogic, filterMode, unassignedSet, libraryTagCounts]);

  const topTags = useMemo(
    () => [...libraryTagCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_TAG_CHIPS).map(([t]) => t),
    [libraryTagCounts],
  );

  /* tags beyond the chip row — surfaced through the "+N more" popover */
  const hiddenTags = useMemo(
    () => [...libraryTagCounts.entries()].sort((a, b) => b[1] - a[1]).slice(MAX_TAG_CHIPS),
    [libraryTagCounts],
  );

  /* ---- round 17/18 · stroke-weight audit ----------------------------------
   * Armed via the store (round 18 — lifted from local state so the command
   * palette can toggle it and it survives the library tab unmounting) OR
   * auto-armed by the stroke sort modes. Measures every library icon ONCE
   * per activation via the engine's content-hash cache — the identical
   * numbers the inspector, stroke report and renderer base their math on.
   * Powers: the per-tile px badges (root units or canvas px), the
   * "Boldest/Finest first" sorts and the aggregate strip. */
  const showStrokeWidths = useStudio((s) => s.strokeAudit);
  const setStrokeAudit = useStudio((s) => s.setStrokeAudit);
  const strokeUnit = useStudio((s) => s.strokeAuditUnit);
  const setStrokeUnit = useStudio((s) => s.setStrokeAuditUnit);
  const activeSheetId = useStudio((s) => s.activeSheetId);
  const strokeAuditActive = showStrokeWidths || isStrokeSort(sort);
  const strokeWidths = useMemo(
    () => (strokeAuditActive && iconOrder.length > 0 ? measureStrokeWidths(iconOrder, icons) : null),
    [strokeAuditActive, iconOrder, icons],
  );
  /* round 18 · canvas-px reference: the ACTIVE sheet's grid embed box
   * (first sheet as fallback — the same "active, else first" selector the
   * stroke report uses). 0 = no usable sheet yet → the toggle disables. */
  const canvasRefSheet = useMemo(
    () => sheets.find((sh) => sh.id === activeSheetId) ?? sheets[0] ?? null,
    [sheets, activeSheetId],
  );
  const canvasRefBox = useMemo(
    () => (canvasRefSheet ? representativeGridIconBox(canvasRefSheet) : 0),
    [canvasRefSheet],
  );
  const canvasRefIndex = canvasRefSheet ? sheets.findIndex((sh) => sh.id === canvasRefSheet.id) : -1;
  const canvasAvailable = Number.isFinite(canvasRefBox) && canvasRefBox > 0;
  /* the DISPLAY map: root units, or the embed-converted canvas px — the
   * exact math the renderer's embed plan uses (root · box / fit basis) */
  const displayUnit: "root" | "canvas" = strokeUnit === "canvas" && canvasAvailable ? "canvas" : "root";
  const displayWidths = useMemo(() => {
    if (!strokeWidths) return null;
    if (displayUnit === "root") {
      const m = new Map<string, number | null>();
      for (const [id, v] of strokeWidths) m.set(id, v.root);
      return m;
    }
    const m = new Map<string, number | null>();
    for (const [id, v] of strokeWidths) {
      m.set(id, v.root != null && v.maxDim > 0 ? (v.root * canvasRefBox) / v.maxDim : null);
    }
    return m;
  }, [strokeWidths, displayUnit, canvasRefBox]);
  /* heavy-badge threshold: 8 in root units; in canvas px the same boldness
   * sits at 8 · embedBox/24 (a 24-unit viewBox reference — approximate by
   * design, it only picks the amber outlier class) */
  const heavyThreshold = displayUnit === "canvas" ? (8 * canvasRefBox) / 24 : 8;
  const unitTooltip =
    displayUnit === "canvas"
      ? `canvas px on Sheet ${pad2(canvasRefIndex + 1)}'s grid embed (${Math.round(canvasRefBox * 10) / 10}px box) — the stroke-report convention`
      : "root user units (viewBox) — the inspector convention";
  /* aggregate strip stats — computed from the DISPLAY map (root or canvas
   * px per the active unit; unmeasurable icons counted separately) */
  const strokeStats = useMemo(() => {
    if (!displayWidths) return null;
    const values: number[] = [];
    let unmeasurable = 0;
    for (const v of displayWidths.values()) {
      if (v == null) unmeasurable += 1;
      else values.push(v);
    }
    if (values.length === 0) return { min: null as number | null, max: null as number | null, median: null as number | null, unmeasurable };
    const sorted = [...values].sort((a, b) => a - b);
    return {
      min: sorted[0],
      max: sorted[sorted.length - 1],
      median: sorted[Math.floor(sorted.length / 2)],
      unmeasurable,
    };
  }, [displayWidths]);

  const filtered = useMemo(() => {
    /* single shared predicate (lib/studio/filter.ts) — the library grid, the
     * catalog dialog scope and the icon-inspector context all match icons
     * with the exact same semantics now */
    const filter = { query, tags, tagLogic, mode: filterMode };
    const out: IconEntry[] = [];
    for (const id of iconOrder) {
      const entry = icons[id];
      if (!entry) continue;
      if (!iconMatchesLibraryFilter(entry, id, filter, unassignedSet)) continue;
      out.push(entry);
    }
    /* sorting is view-only: it never rewrites iconOrder (drag sources,
     * sheets and undo history are untouched). Stroke sorts receive the
     * DISPLAY map (root or canvas px — the numbers on the badges) so the
     * visible order always matches the visible numbers. */
    return sortIconList(out, sort, displayWidths);
  }, [icons, iconOrder, filterMode, unassignedSet, tags, tagLogic, query, sort, displayWidths]);

  const totalRows = Math.ceil(filtered.length / cols);
  const virtual = filtered.length > VIRTUALIZE_THRESHOLD;
  const startRow = virtual ? Math.max(0, range.start - 1) : 0;
  const endRow = virtual
    ? Math.min(totalRows - 1, range.end + OVERSCAN_ROWS)
    : totalRows - 1;
  const visibleIcons = virtual
    ? filtered.slice(startRow * cols, (endRow + 1) * cols)
    : filtered;
  const topPad = virtual ? startRow * rowH : 0;
  const bottomPad = virtual ? Math.max(0, totalRows - 1 - endRow) * rowH : 0;
  /** keyboard walker index base: virtualized lists render a SLICE — the tile's
   *  absolute index in `filtered` is sliceOffset + DOM position */
  const indexBase = virtual ? startRow * cols : 0;
  /* render-time clamp: keeps the Tab stop inside the list when the filter
   *  shrinks it (no effect round-trips, just honest derivation) */
  const tabStopIndex = Math.min(rovingIndex, Math.max(0, filtered.length - 1));

  useEffect(() => {
    if (virtual) measure();
  }, [virtual, measure]);

  /* ---- keyboard grid walking (round 8) ----
   * Focus the tile at an ABSOLUTE index in `filtered`. Virtualized lists may
   * not have the target row mounted, so when it falls outside the rendered
   * window (or its buffer), the grid is scrolled to center that row FIRST —
   * the scroll event updates `range`, React mounts the row, and double rAF
   * guarantees the button exists before focus() runs. */
  const focusTile = useCallback(
    (target: number) => {
      if (filtered.length === 0) return;
      const clamped = Math.max(
        0,
        Math.min(Number.isFinite(target) ? target : filtered.length - 1, filtered.length - 1),
      );
      setRovingIndex(clamped); // the roving Tab stop follows the walker
      if (virtual) {
        const row = Math.floor(clamped / cols);
        const el = scrollRef.current;
        if (el) {
          const top = row * rowH;
          const lo = el.scrollTop;
          const hi = el.scrollTop + el.clientHeight - rowH;
          if (top < lo || top > hi) {
            el.scrollTo({ top: Math.max(0, top - el.clientHeight / 2 + rowH / 2) });
          }
        }
      }
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          scrollRef.current
            ?.querySelector<HTMLButtonElement>(`button[data-tile-index="${clamped}"]`)
            ?.focus();
        }),
      );
    },
    [filtered.length, virtual, cols, rowH],
  );

  /* ---- selection ---- */
  const toggleIcon = useCallback((id: string) => {
    setSelection((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }, []);

  const selectFiltered = useCallback(() => {
    setSelection(filtered.map((i) => i.id));
  }, [filtered]);

  /* ---- new sheet from selection ---- */
  const handleNewSheet = useCallback(() => {
    if (selection.length === 0) return;
    const created = useStudio.getState().moveIconsToNewSheet([...selection]);
    if (created > 0) {
      toast.success(`Created ${created} new sheet${created > 1 ? "s" : ""} — ${selection.length} icons filed`);
      setSelection([]);
    } else {
      toast.error("Could not create the sheet");
    }
  }, [selection]);

  /* ---- move-to-sheet flow ---- */
  const handleMoveToSheet = useCallback(
    (targetSheetId: string) => {
      if (selection.length === 0) return;
      const s = useStudio.getState();
      const targetIndex = s.sheets.findIndex((sh) => sh.id === targetSheetId);
      if (targetIndex < 0) return;
      const target = s.sheets[targetIndex];
      const already = new Set(target.iconIds);
      const toMove = selection.filter((id) => !already.has(id));
      if (toMove.length === 0) {
        toast.info("Selected icons are already on that sheet");
        return;
      }
      const free = Math.max(0, getSheetCapacity(s.sheets, targetSheetId) - target.iconIds.length);
      if (toMove.length > free) {
        // Ask before moving anything: some icons won't fit.
        const d: OverflowDialogState = {
          selection: [...selection],
          targetSheetId,
          targetSheetLabel: `Sheet ${pad2(targetIndex + 1)}`,
          overflowCount: toMove.length - free,
          toMoveCount: toMove.length,
        };
        dialogRef.current = d;
        setDialog(d);
        return;
      }
      const res = s.moveIcons([...selection], targetSheetId, false);
      toast.success(`Moved ${res.moved.length} icons`);
      setSelection([]);
    },
    [selection],
  );

  const confirmCreateNewSheet = useCallback(() => {
    const d = dialogRef.current;
    dialogRef.current = null;
    setDialog(null);
    if (!d) return;
    const res = useStudio.getState().moveIcons(d.selection, d.targetSheetId, true);
    // createOverflowSheet: overflow icons go to a freshly created sheet.
    const placed = res.overflow.length === 0 ? d.toMoveCount : res.moved.length;
    toast.success(`Moved ${placed} icons`);
    setSelection([]);
  }, []);

  const cancelOverflow = useCallback(() => {
    const d = dialogRef.current;
    dialogRef.current = null;
    setDialog(null);
    if (!d) return;
    // Move only the icons that fit; the overflow stays unassigned.
    const res = useStudio.getState().moveIcons(d.selection, d.targetSheetId, false);
    toast.success(`Moved ${res.moved.length} icons`);
    setSelection([]);
  }, []);

  /* ---- batch delete (selection) — undoable via delete-icons history ---- */
  const handleBatchDelete = useCallback(() => {
    if (selection.length === 0) return;
    const res = deleteIcons(selection);
    setDeleteArm(null);
    if (res.removed.length > 0) {
      const sheetsNote =
        res.sheetsTouched.length > 0
          ? ` — pulled from ${res.sheetsTouched.length} sheet${res.sheetsTouched.length === 1 ? "" : "s"}`
          : "";
      toast.success(`Deleted ${res.removed.length} icon${res.removed.length === 1 ? "" : "s"} from the library${sheetsNote}`, {
        description: "Ctrl Z to undo",
      });
      setSelection([]);
    }
  }, [selection, deleteIcons]);

  /* ---- batch unassign (selection) — icons stay in the library ---- */
  const assignedSelected = useMemo(
    () => selection.some((id) => assignedByIcon.has(id)),
    [selection, assignedByIcon],
  );
  const handleBatchUnassign = useCallback(() => {
    if (selection.length === 0) return;
    const res = unassignIcons(selection);
    if (res.sheetsTouched.length > 0) {
      toast.success(`Removed ${res.removed.length} icon${res.removed.length === 1 ? "" : "s"} from ${res.sheetsTouched.length} sheet${res.sheetsTouched.length === 1 ? "" : "s"} — icons stay in your library`, {
        description: "Ctrl Z to undo",
      });
    } else {
      toast.info("None of the selected icons are on a sheet");
    }
  }, [selection, unassignIcons]);

  /* ---- render ---- */
  const filterActive = query.trim() !== "" || filterMode !== "all" || tags.length > 0;
  const countLabel = filterActive
    ? `${filtered.length.toLocaleString()} of ${iconOrder.length.toLocaleString()} icons`
    : `${iconOrder.length.toLocaleString()} icons`;
  const allFilteredSelected =
    filtered.length > 0 && selection.length >= filtered.length && filtered.every((i) => selection.includes(i.id));
  /* AND/OR only matters once two or more tags are selected — with one tag
   * (or none) both modes are identical, so the toggle is hidden, not just
   * disabled (it reads as decoration otherwise) */
  const showLogicToggle = tags.length >= 2;
  /* selected tags that fell out of the visible chip row — kept inline so
   * the active filter is always visible without opening the popover */
  const hiddenSelectedTags = tags.filter((t) => !topTags.includes(t));

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 px-3 py-2.5">
      {/* 1 · header row: compact upload + count */}
      <div className="flex shrink-0 items-center justify-between gap-2">
        <UploadDropzone compact />
        <Badge
          variant="secondary"
          className="studio-chip studio-chip--neutral h-6 shrink-0 px-2 text-[11px] tabular-nums"
          title="Icons in your library"
        >
          {countLabel}
        </Badge>
      </div>

      {/* 1.5 · last-import audit card (round 17) — surfaces the store's
          previously write-only lastImportReport; null renders nothing.
          Round 18: once dismissed, the slim history strip keeps the
          session's import audit reachable. */}
      <ImportSummaryCard />
      <CollapsedImportHistory />

      {/* 2 · search (matches file names AND tags) + stroke audit + density + sort menus */}
      <div className="studio-search relative shrink-0 rounded-md transition-shadow">
        <Search
          className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
          aria-hidden="true"
        />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search names & tags…"
          className="lib-search-input h-8 rounded-md pl-8 pr-[5.6rem] text-[12px]"
          spellCheck={false}
          aria-label="Search icons by file name or tag"
        />
        {query ? (
          <button
            type="button"
            onClick={() => setQuery("")}
            aria-label="Clear search"
            title="Clear search"
            className="absolute right-[5.15rem] top-1/2 flex size-5 -translate-y-1/2 items-center justify-center rounded-[5px] text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="h-3 w-3" aria-hidden="true" />
          </button>
        ) : null}
        {/* round 17/18 · stroke-weight audit toggle — overlays each tile with its
         * measured native stroke width (the engine's own cached numbers) and
         * shows the aggregate strip below. Arms automatically when a stroke
         * sort mode is active (badge data is shared). Store-backed (round
         * 18) so the command palette can drive it too. */}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => setStrokeAudit(!showStrokeWidths)}
              data-active={showStrokeWidths}
              aria-pressed={showStrokeWidths}
              aria-label={
                showStrokeWidths
                  ? "Stroke-weight audit on — hide the per-tile measured widths"
                  : "Stroke-weight audit — show each icon's measured native stroke width"
              }
              title={
                showStrokeWidths
                  ? "Stroke audit ON — every tile carries its measured native stroke weight; the strip below aggregates the library"
                  : "Show each icon's measured native stroke weight on its tile — same numbers the stroke report uses"
              }
              className="lib-tool-btn absolute right-[3.6rem] top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring hover:bg-accent hover:text-foreground"
            >
              <PenLine className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </TooltipTrigger>
          <TooltipContent>Stroke-weight audit</TooltipContent>
        </Tooltip>
        {/* tile density — same compact-icon-menu pattern as the sort menu
         * (visual language consistency); persisted in workspace settings */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="lib-tool-btn absolute right-[2.05rem] top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring hover:bg-accent hover:text-foreground"
              data-active={density !== "standard"}
              title={`Tile size: ${preset.label} — ${preset.hint}`}
              aria-label={`Library tile density — current: ${preset.label}`}
            >
              <Rows3 className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[170px]">
            <DropdownMenuLabel className="pro-label">
              Tile size
            </DropdownMenuLabel>
            {(Object.keys(DENSITY_PRESETS) as LibraryDensity[]).map((d) => (
              <DropdownMenuItem
                key={d}
                onSelect={() => setLibraryDensity(d)}
                className="gap-2 text-[11px]"
                aria-checked={density === d}
              >
                <Check
                  className={cn("h-3 w-3 shrink-0", density === d ? "opacity-100" : "opacity-0")}
                  aria-hidden="true"
                />
                <span className="flex flex-col">
                  <span>{DENSITY_PRESETS[d].label}</span>
                  <span className="text-[9px] text-muted-foreground">{DENSITY_PRESETS[d].hint}</span>
                </span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="lib-tool-btn absolute right-1 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring hover:bg-accent hover:text-foreground"
              data-active={sort !== "manual"}
              title={
                sort !== "manual"
                  ? `Sorted: ${SORT_LABEL.get(sort) ?? "custom"} — click to change`
                  : "Sort the library — name, date added or tag count"
              }
              aria-label={`Sort library — current: ${SORT_LABEL.get(sort) ?? "library order"}`}
            >
              <ArrowDownUp className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[170px]">
            <DropdownMenuLabel className="pro-label">
              Sort library
            </DropdownMenuLabel>
            {SORT_OPTIONS.map((opt) => (
              <DropdownMenuItem
                key={opt.value}
                onSelect={() => setSort(opt.value)}
                className="gap-2 text-[11px]"
                aria-checked={sort === opt.value}
              >
                <Check
                  className={cn("h-3 w-3 shrink-0", sort === opt.value ? "opacity-100" : "opacity-0")}
                  aria-hidden="true"
                />
                <span className="flex flex-col">
                  <span>{opt.label}</span>
                  <span className="text-[9px] text-muted-foreground">{opt.hint}</span>
                </span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* 2.5 · stroke audit aggregate strip (round 17/18) — the library-wide
          weight census, shown only while the audit is armed. Same numbers
          the per-tile badges carry; "—" class counted separately. Round 18
          adds the unit toggle: root user units (inspector convention) ↔
          canvas px via the active sheet's grid embed (stroke-report
          convention) — the exact math the engine itself uses. */}
      {strokeAuditActive && strokeStats ? (
        <div
          className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-0.5 rounded-md border border-border/60 bg-muted/25 px-2 py-1 text-[10px] leading-relaxed text-muted-foreground"
          role="status"
          aria-label="Library stroke-weight census"
          title={
            displayUnit === "canvas"
              ? "Canvas px are measured through the active sheet's GRID embed box — the stroke-report convention. Hero icons embed larger on the sheet; the stroke report lists hero rows separately with their own measured widths. Root units are each icon's own viewBox."
              : "Root units are each icon's own viewBox (the inspector convention). Switch to canvas to see weights through the active sheet's grid embed box — hero icons embed larger and are listed separately in the stroke report."
          }
        >
          <PenLine className="h-3 w-3 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />
          <span className="font-medium text-foreground/80">native weights</span>
          {strokeStats.min != null && strokeStats.max != null ? (
            <span className="tabular-nums">
              {Math.round(strokeStats.min * 10) / 10}–{Math.round(strokeStats.max * 10) / 10}{" "}
              {displayUnit === "canvas" ? "px canvas" : "px units"}
              <span className="text-muted-foreground/60"> · median </span>
              {Math.round(strokeStats.median! * 10) / 10}
            </span>
          ) : (
            <span>no measurable artwork</span>
          )}
          {strokeStats.unmeasurable > 0 ? (
            <span className="tabular-nums text-muted-foreground/80">
              · {strokeStats.unmeasurable} unmeasurable
            </span>
          ) : null}
          {/* unit toggle (round 18) — a two-option micro segmented control.
              Canvas px disables with an explanatory tooltip when no sheet
              yields an embed box yet. */}
          <span
            className="inline-flex overflow-hidden rounded-[5px] border border-border/70"
            role="group"
            aria-label="Badge unit"
          >
            <button
              type="button"
              onClick={() => setStrokeUnit("root")}
              aria-pressed={displayUnit === "root"}
              title="Show weights in root user units (viewBox) — the inspector convention"
              className={cn(
                "px-1.5 py-px font-medium transition-colors",
                displayUnit === "root"
                  ? "bg-amber-500/20 font-semibold text-amber-800 dark:text-amber-300"
                  : "text-muted-foreground/80 hover:bg-accent hover:text-foreground",
              )}
            >
              units
            </button>
            <button
              type="button"
              onClick={() => setStrokeUnit("canvas")}
              disabled={!canvasAvailable}
              aria-pressed={displayUnit === "canvas"}
              title={
                canvasAvailable
                  ? `Show weights in canvas px via Sheet ${pad2(canvasRefIndex + 1)}'s grid embed — the stroke-report convention`
                  : "Needs a sheet with a usable grid — create or edit one first"
              }
              className={cn(
                "border-l border-border/70 px-1.5 py-px font-medium transition-colors",
                !canvasAvailable && "cursor-not-allowed opacity-45",
                displayUnit === "canvas"
                  ? "bg-amber-500/20 font-semibold text-amber-800 dark:text-amber-300"
                  : "text-muted-foreground/80 hover:bg-accent hover:text-foreground",
              )}
            >
              canvas
            </button>
          </span>
          <span className="ml-auto text-muted-foreground/70">
            {isStrokeSort(sort) ? "sorted by weight" : "same numbers the stroke report uses"}
          </span>
        </div>
      ) : null}

      {/* 3 · filter segmented: All / Unassigned + select-filtered */}
      <div className="flex shrink-0 items-center gap-1">
        <ToggleGroup
          type="single"
          value={filterMode}
          onValueChange={(v) => {
            if (v === "all" || v === "unassigned") setFilterMode(v);
          }}
          className="studio-seg h-7 min-w-0 flex-1 gap-0.5 p-0.5"
          aria-label="Filter icons by assignment"
        >
          <ToggleGroupItem
            value="all"
            className="studio-seg-item h-6 rounded-[5px] px-2.5 text-[11px]"
            title="Show all library icons"
          >
            All
          </ToggleGroupItem>
          <ToggleGroupItem
            value="unassigned"
            className="studio-seg-item h-6 rounded-[5px] px-2.5 text-[11px]"
            title="Show icons not placed on any sheet"
          >
            Unassigned
            {unassignedSet.size > 0 ? (
              <span className="ml-1 text-[10px] tabular-nums text-muted-foreground">
                {unassignedSet.size.toLocaleString()}
              </span>
            ) : null}
          </ToggleGroupItem>
        </ToggleGroup>
        {filtered.length > 0 ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 shrink-0 gap-1 px-1.5 text-[11px] text-muted-foreground"
            onClick={allFilteredSelected ? () => setSelection([]) : selectFiltered}
            title={allFilteredSelected ? "Clear the selection" : `Select all ${filtered.length} shown icons`}
            aria-label={allFilteredSelected ? "Clear selection" : `Select all ${filtered.length} shown icons`}
          >
            <ListPlus className="h-3 w-3" aria-hidden="true" />
            {allFilteredSelected ? "None" : `All ${filtered.length}`}
          </Button>
        ) : null}
      </div>

      {/* 3b · tag filter chips — horizontal scroll instead of wrapping so the
       * row stays one line tall, reclaiming vertical space for the icon grid.
       * (round 12: was flex-wrap, which wrapped to 3 rows = 100px on a 240px
       * sidebar.) The scroll is invisible (scrollbar-width: none).
       * Multi-tag (review round 6): chips are TOGGLES — click several tags to
       * build a set; with 2+ selected, an AND/OR segmented control appears
       * at the row head to switch the combining logic. */}
      {topTags.length > 0 ? (
        <div
          className="library-tag-scroll flex shrink-0 gap-1.5 overflow-x-auto py-1"
          role="group"
          aria-label="Filter icons by tag (multiple tags can be combined)"
        >
          {showLogicToggle ? (
            <div
              className="flex h-[1.375rem] shrink-0 items-center gap-px rounded-md border border-border/80 bg-muted/40 p-px"
              role="group"
              aria-label={`Tag filter logic — currently ${tagLogic === "and" ? "ALL selected tags" : "ANY selected tag"}`}
            >
              {(["and", "or"] as const).map((l) => (
                <button
                  key={l}
                  type="button"
                  className={cn(
                    "h-full rounded-[5px] px-1.5 text-[9px] font-semibold uppercase tracking-wide outline-none transition-colors focus-visible:ring-2 focus-visible:ring-amber-500",
                    tagLogic === l
                      ? "bg-amber-600 text-white shadow-sm dark:bg-amber-500 dark:text-amber-950"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                  onClick={() => setTagLogic(l)}
                  aria-pressed={tagLogic === l}
                  title={
                    l === "and"
                      ? "Match icons that carry ALL selected tags (intersection)"
                      : "Match icons that carry ANY selected tag (union)"
                  }
                >
                  {l === "and" ? "AND" : "OR"}
                </button>
              ))}
            </div>
          ) : null}
          {topTags.map((tag) => {
            const isActive = tags.includes(tag);
            /* faceted count: how many icons of the CURRENT result carry this
             *  tag (equals the total when no filter is active) */
            const facetCount = facetTagCounts.get(tag) ?? 0;
            return (
              <button
                key={tag}
                type="button"
                className="tag-chip shrink-0"
                data-active={isActive}
                data-zero={!isActive && facetCount === 0}
                onClick={() => toggleTag(tag)}
                aria-pressed={isActive}
                title={
                  isActive
                    ? `Remove ${tag} from the filter`
                    : facetCount === 0
                      ? `${tag} — no icons in the current view carry this tag`
                      : showLogicToggle
                        ? `Add ${tag} to the combined filter — ${facetCount} in view (${tagLogic === "and" ? "ALL" : "ANY"})`
                        : `Filter by ${tag} — ${facetCount} in view`
                }
              >
                {tag}
                <span className="tabular-nums hint-text">
                  {facetCount}
                </span>
              </button>
            );
          })}
          {/* selected tags hidden beyond the chip row — kept visible inline
           * so the active filter set is always inspectable at a glance */}
          {hiddenSelectedTags.map((tag) => (
            <button
              key={tag}
              type="button"
              className="tag-chip shrink-0"
              data-active="true"
              onClick={() => toggleTag(tag)}
              aria-pressed={true}
              title={`Remove ${tag} from the filter`}
            >
              {tag}
              <X className="h-2.5 w-2.5" aria-hidden="true" />
            </button>
          ))}
          {hiddenTags.length > 0 ? (
            <Popover open={moreTagsOpen} onOpenChange={setMoreTagsOpen}>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className="tag-chip shrink-0"
                  data-active={hiddenTags.some(([t]) => tags.includes(t))}
                  aria-expanded={moreTagsOpen}
                  title={`All ${libraryTagCounts.size} tags — rarer tags live here`}
                  aria-label={`More tags (${hiddenTags.length} more)`}
                >
                  <ChevronDown className="h-2.5 w-2.5" aria-hidden="true" />
                  +{hiddenTags.length}
                </button>
              </PopoverTrigger>
              <PopoverContent
                align="start"
                className="w-56 p-2"
                onOpenAutoFocus={(e) => e.preventDefault()}
              >
                <p className="pro-label px-1 pb-1.5">
                  All tags · {libraryTagCounts.size}
                </p>
                <div className="flex max-h-56 flex-wrap gap-1 overflow-y-auto custom-scroll pr-1">
                  {hiddenTags.map(([tag]) => {
                    const isActive = tags.includes(tag);
                    const facetCount = facetTagCounts.get(tag) ?? 0;
                    return (
                      <button
                        key={tag}
                        type="button"
                        className="tag-chip shrink-0"
                        data-active={isActive}
                        data-zero={!isActive && facetCount === 0}
                        onClick={() => toggleTag(tag)}
                        title={
                          isActive
                            ? `Remove ${tag} from the filter`
                            : facetCount === 0
                              ? `${tag} — no icons in the current view carry this tag`
                              : `Add ${tag} to the combined filter — ${facetCount} in view`
                        }
                        aria-pressed={isActive}
                      >
                        {tag}
                        <span className="tabular-nums hint-text">{facetCount}</span>
                      </button>
                    );
                  })}
                </div>
              </PopoverContent>
            </Popover>
          ) : null}
          {tags.length > 0 ? (
            <button
              type="button"
              className="tag-chip shrink-0"
              onClick={clearTags}
              title="Clear all selected tags"
              aria-label="Clear tag filter"
            >
              <X className="h-2.5 w-2.5" aria-hidden="true" />
              clear
            </button>
          ) : null}
          <span className="flex-1" />
          {simCount > 0 ? (
            <button
              type="button"
              className="studio-chip studio-chip--warn shrink-0 gap-1 px-2 py-0.5 text-[10px]"
              onClick={() => openSimilarityDialog()}
              title={`${simCount} similar-icon group${simCount === 1 ? "" : "s"} in the library — open the finder to review and consolidate them`}
              aria-label={`Find similar icons — ${simCount} group${simCount === 1 ? "" : "s"} detected`}
            >
              <ScanSearch className="h-2.5 w-2.5" aria-hidden="true" />
              {simCount} similar
            </button>
          ) : null}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-[1.375rem] shrink-0 gap-1 px-1.5 text-[10px] text-muted-foreground hover:text-foreground"
            onClick={() => setLibraryDialog("catalog")}
            title="Export the library metadata as JSON or CSV"
            aria-label="Export library catalog"
          >
            <FileDown className="h-3 w-3" aria-hidden="true" />
            catalog
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-[1.375rem] shrink-0 gap-1 px-1.5 text-[10px] text-muted-foreground hover:text-foreground"
            onClick={() => setLibraryDialog("tag-manager")}
            title="Rename, merge or delete tags across the library"
            aria-label="Manage tags"
          >
            <Tags className="h-3 w-3" aria-hidden="true" />
            manage
          </Button>
        </div>
      ) : null}

      {/* 4 · selection toolbar */}
      {selection.length > 0 ? (
        <div className="studio-rise flex shrink-0 flex-wrap items-center gap-1.5 rounded-lg border border-border/70 dark:border-border/90 bg-card/95 px-2.5 py-1.5 shadow-xs shadow-black/5 dark:shadow-black/30">
          <span className="shrink-0 text-[11px] font-medium tabular-nums" aria-live="polite">
            {selection.length} selected
          </span>
          {/* action row wraps with the toolbar — an unwrappable row here has a
           * ~560px min-content that inflates the whole sidebar layout */}
          <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-1.5">
            <TagEditorPopover selection={selection} libraryTagCounts={libraryTagCounts} />
            {assignedSelected ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-6 gap-1 px-2 text-[11px]"
                onClick={handleBatchUnassign}
                title="Pull the selected icons off their sheets — they stay in the library"
                aria-label="Remove selected icons from their sheets"
              >
                <FolderMinus className="h-3 w-3" aria-hidden="true" />
                Unfile
              </Button>
            ) : null}
            {deleteArmed ? (
              <>
                <span className="shrink-0 text-[10px] text-amber-700 dark:text-amber-400" aria-live="polite">
                  Delete {selection.length} icon{selection.length === 1 ? "" : "s"}?
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2 text-[11px]"
                  onClick={() => setDeleteArm(null)}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  size="sm"
                  className="h-6 gap-1 bg-amber-700 px-2 text-[11px] hover:bg-amber-800"
                  onClick={handleBatchDelete}
                  title="Remove the selected icons from the library (undoable)"
                >
                  <Trash2 className="h-3 w-3" aria-hidden="true" />
                  Delete
                </Button>
              </>
            ) : (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-6 gap-1 px-2 text-[11px] text-amber-700 hover:bg-amber-500/10 hover:text-amber-800 dark:text-amber-400 dark:hover:text-amber-300"
                onClick={() => setDeleteArm(selection.length)}
                title="Remove the selected icons from the library (undoable)"
                aria-label={`Delete ${selection.length} selected icons`}
              >
                <Trash2 className="h-3 w-3" aria-hidden="true" />
                Delete
              </Button>
            )}
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-6 gap-1 px-2 text-[11px]"
              onClick={handleNewSheet}
              title="Create a new sheet and move the selection onto it"
              aria-label="Create new sheet from selection"
            >
              <SquarePlus className="h-3 w-3" aria-hidden="true" />
              New sheet
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  size="sm"
                  className="h-6 gap-1 px-2 text-[11px]"
                  aria-label="Move selected icons to a sheet"
                >
                  <ArrowRightLeft className="h-3 w-3" aria-hidden="true" />
                  Move to sheet
                  <ChevronDown className="h-3 w-3" aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-56 max-w-64">
                {sheets.length === 0 ? (
                  <div className="px-2 py-1.5 text-[11px] text-muted-foreground">
                    No sheets yet — use “New sheet” or generate some first.
                  </div>
                ) : (
                  sheets.map((sheet, i) => {
                    const capacity = getSheetCapacity(sheets, sheet.id);
                    const full = sheet.iconIds.length >= capacity;
                    const label = `Sheet ${pad2(i + 1)} · ${sheet.iconIds.length}/${capacity} · ${sheet.category}`;
                    return (
                      <DropdownMenuItem
                        key={sheet.id}
                        disabled={full}
                        onSelect={() => handleMoveToSheet(sheet.id)}
                        title={full ? `${label} — full` : label}
                        className="gap-1.5 text-[11px]"
                      >
                        <FileBox
                          className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                          aria-hidden="true"
                        />
                        <span className="truncate">{label}</span>
                      </DropdownMenuItem>
                    );
                  })
                )}
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 gap-1 px-2 text-[11px]"
              onClick={() => setSelection([])}
              title="Clear selection"
              aria-label="Clear icon selection"
            >
              <X className="h-3 w-3" aria-hidden="true" />
              Clear
            </Button>
          </div>
        </div>
      ) : null}

      {/* 5 · icon grid / empty states */}
      {!hydrated && iconOrder.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden="true" />
          <p className="text-[11px] text-muted-foreground">Loading library…</p>
        </div>
      ) : iconOrder.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3">
          <UploadDropzone />
          <p className="pro-help max-w-52 text-center">
            Your library is empty. Icons you upload stay locally (IndexedDB).
          </p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2.5 py-10">
          <div className="grid h-9 w-9 place-items-center rounded-full bg-muted">
            <SearchX className="h-4 w-4 text-muted-foreground" aria-hidden />
          </div>
          <p className="text-[11px] text-muted-foreground">
            No icons match
            {filterActive ? " the current filter" : ""}.
          </p>
          {filterActive ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-6 gap-1 px-2 text-[10px]"
              onClick={() => setLibraryFilter({ query: "", tags: [], mode: "all" })}
              title="Clear the search text, tag set and assignment mode"
            >
              <X className="h-3 w-3" aria-hidden />
              Clear filters
            </Button>
          ) : null}
        </div>
      ) : (
        <div
          ref={scrollRef}
          onScroll={virtual ? handleScroll : undefined}
          role="group"
          aria-label={`Icon library, ${filtered.length.toLocaleString()} icons shown`}
          className={cn(
            /* round 12: removed max-h-[60vh] — it capped the grid at 60% of
             * viewport height, which combined with the selection toolbar pushed
             * total content past the sidebar and produced a large gap above the
             * grid + a cutoff at the bottom. flex-1 + min-h-0 + overflow-y-auto
             * now manages the height naturally within the flex column. */
            "min-h-0 flex-1 overflow-y-auto pr-0.5",
            "[&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border [&::-webkit-scrollbar-track]:bg-transparent",
          )}
        >
          {topPad > 0 ? <div style={{ height: topPad }} aria-hidden="true" /> : null}
          <div
            className={cn(
              "grid justify-items-center gap-1.5",
              density === "compact" ? "grid-cols-5" : density === "large" ? "grid-cols-3" : "grid-cols-4",
            )}
          >
            {visibleIcons.map((entry, i) => {
              const idx = assignedByIcon.get(entry.id);
              const inSelection = selection.includes(entry.id);
              return (
                <IconTile
                  key={entry.id}
                  entry={entry}
                  selected={inSelection}
                  sheetIndex={idx === undefined ? null : idx}
                  dragIds={inSelection && selection.length > 1 ? selection : [entry.id]}
                  tileClass={preset.tileClass}
                  index={indexBase + i}
                  cols={cols}
                  tabStop={indexBase + i === tabStopIndex}
                  strokeWidth={strokeAuditActive && displayWidths ? displayWidths.get(entry.id) ?? null : undefined}
                  strokeUnitLabel={displayUnit === "canvas" ? `px ${unitTooltip}` : unitTooltip}
                  strokeHeavyAt={heavyThreshold}
                  onNavigate={focusTile}
                  onRovingFocus={setRovingIndex}
                  onToggle={toggleIcon}
                  onInspect={openInspector}
                />
              );
            })}
          </div>
          {bottomPad > 0 ? <div style={{ height: bottomPad }} aria-hidden="true" /> : null}
        </div>
      )}

      {/* overflow dialog: sheet full */}
      <AlertDialog
        open={dialog !== null}
        onOpenChange={(open) => {
          if (!open) cancelOverflow();
        }}
      >
        <AlertDialogContent className="max-w-sm">
          <AlertDialogHeader>
            <AlertDialogTitle>Sheet is full</AlertDialogTitle>
            <AlertDialogDescription>
              {dialog
                ? `${dialog.overflowCount} icon${dialog.overflowCount === 1 ? "" : "s"} don't fit on ${dialog.targetSheetLabel}. Move the remaining icons to a new sheet?`
                : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={cancelOverflow}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmCreateNewSheet}>
              Create new sheet
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
