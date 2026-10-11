"use client";

/**
 * ICON SHEET STUDIO — Icon Detail Inspector.
 *
 * Opens from the library (tile hover "expand" button or double-click) for a
 * single icon and shows everything about it in one place:
 *   · large artwork preview (dotted design-tool surface)
 *   · source metadata — viewBox, intrinsic size, content weight, stroke
 *     nature/width, import date, content-hash identity
 *   · per-icon tag editing (chips + input + library suggestions)
 *   · assignment — which sheet/cell owns it (or unassigned), with move,
 *     new-sheet and hero context
 *   · related icons — others sharing tags, one click away
 *   · actions — copy SVG source, download .svg, delete from library
 *     (delete is fully undoable via the store's delete-icons history entry)
 *
 * Round 8: inspector NAVIGATION — prev/next stepper walks the icon list in
 * the live library-filter context (whatever the library panel currently
 * shows: query, tag filter or unassigned mode; falls back to the whole
 * library). Plain ←/→ keys work while focus is outside text inputs. Every
 * open records the icon into the palette's "recently inspected" memory.
 *
 * The dialog shell stays mounted (for open/close animation); the body is
 * remounted per icon via `key={iconId}` so local state (tag input, delete
 * arm) resets naturally.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { toast } from "sonner";
import { saveFileNative } from "@/lib/studio/desktop";
import {
  AlignLeft,
  ArrowRightLeft,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  Eye,
  EyeOff,
  FileBox,
  FolderMinus,
  Hash,
  Heading2,
  ListPlus,
  PlugZap,
  RotateCcw,
  Save,
  Sparkles,
  SquarePlus,
  Star,
  Tag as TagIcon,
  Trash2,
  X,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { getSheetCapacity, useStudio, getUnassignedIconIds } from "@/lib/studio/store";
import { styledIconPreviewSvg } from "@/lib/studio/icon-preview";
import { iconMatchesLibraryFilter, libraryFilterIsEmpty } from "@/lib/studio/filter";
import { hashSvgContent, parseIcon, embedSvgMetadata } from "@/lib/studio/svg";
import { analyzeNativeStroke } from "@/lib/studio/icon-style";

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/* ------------------------------------------------------------------ */
/* Metadata derivation                                                 */
/* ------------------------------------------------------------------ */

interface IconMeta {
  viewBox: string;
  width: number;
  height: number;
  /** "Stroke" (line art) · "Fill" (solid) · "Auto" (inherited/mixed) */
  nature: "Stroke" | "Fill" | "Auto";
  /** Dominant MEASURED outline weight in icon viewBox units — derived from
   *  analyzeNativeStroke, the SAME cached per-icon measurement the sheet
   *  renderer's stroke engine uses (one source of truth: what the panel
   *  reports here is exactly the native baseline the single stroke-weight
   *  control adjusts around). null = no measurable stroke/outline artwork. */
  strokeWidth: string | null;
  /** "stroke" = true stroke-width declarations · "outline" = filled outline
   *  artwork measured via T̂ = 2·A/P. Distinguishes the two honestly. */
  strokeKind: "stroke" | "outline" | null;
  kb: string;
  hash: string;
}

function deriveMeta(svg: string): IconMeta {
  const parsed = parseIcon(svg);
  const root = parsed?.rootStyle ?? {};
  const [vx, vy, vw, vh] = parsed?.viewBox ?? [0, 0, 24, 24];

  /* Measured dominant native weight — the renderer's own analysis
   *  (cached, pure, deterministic). This replaces the old root-attr /
   *  first-regex-match heuristic, which could show a non-dominant width
   *  on multi-path icons and "—" on filled-outline icons that DO carry
   *  measurable line weight. */
  const report = analyzeNativeStroke(svg);
  let strokeWidth: string | null = null;
  let strokeKind: IconMeta["strokeKind"] = null;
  if (report.rootWidth > 0) {
    strokeWidth = String(Math.round(report.rootWidth * 100) / 100);
    strokeKind = report.strokedLeaves > 0 ? "stroke" : "outline";
  }

  let nature: IconMeta["nature"] = "Auto";
  if (root.stroke && (root.fill === "none" || !root.fill)) nature = "Stroke";
  else if (root.fill && root.fill !== "none" && !root.stroke) nature = "Fill";

  return {
    viewBox: `${vx} ${vy} ${vw} ${vh}`,
    width: parsed?.width ?? vw,
    height: parsed?.height ?? vh,
    nature,
    strokeWidth,
    strokeKind,
    kb: (new Blob([svg]).size / 1024).toFixed(1),
    hash: hashSvgContent(svg).slice(0, 10),
  };
}

/* ------------------------------------------------------------------ */
/* Recently-inspected icons (shared with the command palette)           */
/* ------------------------------------------------------------------ */

/* localStorage-backed UX memory only — never workspace data. Same
 * philosophy as the palette's recent-commands list. */
const RECENT_ICONS_KEY = "iss-recent-icons";
const RECENT_ICONS_MAX = 6;

export function loadRecentIconIds(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_ICONS_KEY);
    const ids = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(ids) ? ids.filter((v) => typeof v === "string").slice(0, RECENT_ICONS_MAX) : [];
  } catch {
    return [];
  }
}

export function pushRecentIcon(iconId: string): void {
  try {
    const next = [iconId, ...loadRecentIconIds().filter((r) => r !== iconId)].slice(0, RECENT_ICONS_MAX);
    localStorage.setItem(RECENT_ICONS_KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable — recency just won't persist */
  }
}

/** Wipe the recently-inspected memory (palette "clear" affordance). */
export function clearRecentIconIds(): void {
  try {
    localStorage.removeItem(RECENT_ICONS_KEY);
  } catch {
    /* storage unavailable — nothing to clear */
  }
}

/* ------------------------------------------------------------------ */
/* Inspector navigation context                                         */
/* ------------------------------------------------------------------ */

/**
 * The list the prev/next stepper walks — uses the SHARED filter semantics
 * (lib/studio/filter.ts: query substring on fileName+tags, multi-tag
 * AND/OR set, unassigned mode), so the inspector always walks exactly what
 * the library panel shows. Empty filter → the whole library order. Opening
 * the inspector from the canvas or palette falls back to this same context,
 * which keeps "what you were browsing" coherent everywhere.
 */
function useContextIconIds(): string[] {
  const iconOrder = useStudio((s) => s.iconOrder);
  const icons = useStudio((s) => s.icons);
  const sheets = useStudio((s) => s.sheets);
  const filter = useStudio((s) => s.libraryFilter);

  return useMemo(() => {
    if (libraryFilterIsEmpty(filter)) return iconOrder;
    const unassigned = new Set(getUnassignedIconIds({ sheets, iconOrder }));
    const out: string[] = [];
    for (const id of iconOrder) {
      const entry = icons[id];
      if (!entry) continue;
      if (!iconMatchesLibraryFilter(entry, id, filter, unassigned)) continue;
      out.push(id);
    }
    return out;
  }, [iconOrder, icons, sheets, filter]);
}

/* ------------------------------------------------------------------ */
/* Small presentational bits                                           */
/* ------------------------------------------------------------------ */

function MetaRow({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <dt className="shrink-0 text-[10px] font-medium uppercase tracking-wider hint-text">
        {label}
      </dt>
      <dd className="truncate font-mono text-[11px] tabular-nums text-foreground" title={value}>
        {value}
      </dd>
    </div>
  );
}

function SectionLabel({ children }: { children: string }): JSX.Element {
  return (
    <p className="studio-group-label mb-1.5">{children}</p>
  );
}

/* ------------------------------------------------------------------ */
/* Inspector body (remounts per icon — local state resets via key)     */
/* ------------------------------------------------------------------ */

interface NavProps {
  /** 1-based position of the icon in the stepper context, null when the
   * icon sits outside the current library filter */
  position: number | null;
  total: number;
  onPrev: () => void;
  onNext: () => void;
}

function InspectorBody({
  iconId,
  onClose,
  nav,
}: {
  iconId: string;
  onClose: () => void;
  nav: NavProps;
}): JSX.Element {
  const entry = useStudio((s) => s.icons[iconId]);
  const sheets = useStudio((s) => s.sheets);
  const iconOrder = useStudio((s) => s.iconOrder);
  const iconsMap = useStudio((s) => s.icons);
  const updateIconTags = useStudio((s) => s.updateIconTags);
  const deleteIcons = useStudio((s) => s.deleteIcons);
  const unassignIcons = useStudio((s) => s.unassignIcons);
  const setHero = useStudio((s) => s.setHero);
  const moveIconsToNewSheet = useStudio((s) => s.moveIconsToNewSheet);
  const moveIcons = useStudio((s) => s.moveIcons);
  const openInspector = useStudio((s) => s.openInspector);
  /* round 8: jump-to-sheet + per-cell skip cross-reference */
  const setViewMode = useStudio((s) => s.setViewMode);
  const setActiveSheet = useStudio((s) => s.setActiveSheet);
  const setCellSkip = useStudio((s) => s.setCellSkip);

  const [tagInput, setTagInput] = useState("");
  const [deleteArmed, setDeleteArmed] = useState(false);
  /* round 15 — metadata drafts: initialized once per icon (the body
   * remounts via key={iconId}); after commit the drafts are re-normalized
   * to the stored values so the dirty flag settles. */
  const updateIconMeta = useStudio((s) => s.updateIconMeta);
  const [titleDraft, setTitleDraft] = useState(entry?.title ?? "");
  const [descDraft, setDescDraft] = useState(entry?.description ?? "");

  const meta = useMemo(() => (entry ? deriveMeta(entry.svg) : null), [entry]);

  /* P7: the original-look artwork preview (ink-bounds viewport, original
   * colors — no stroke request) so artwork extending past the declared
   * viewBox is fully visible here exactly as the sheet now places it. */
  const inspectorPreviewHtml = useMemo(
    () => (entry ? styledIconPreviewSvg(entry, undefined, { size: 128 }) || entry.svg : ""),
    [entry]
  );

  const owner = useMemo(() => {
    const sheet = sheets.find((sh) => sh.iconIds.includes(iconId)) ?? null;
    if (!sheet) return null;
    return { sheet, index: sheets.indexOf(sheet), cell: sheet.iconIds.indexOf(iconId) + 1 };
  }, [sheets, iconId]);

  const ownerCapacity = owner ? getSheetCapacity(sheets, owner.sheet.id) : 0;
  const isHero = owner ? owner.sheet.heroIconId === iconId : false;
  /* round 8: the cell's skip state on its owning sheet — surfaced inline so
   *  "why is this icon missing from the export" is answerable in one look */
  const ownerSkipped = owner ? owner.sheet.cellOverrides?.[iconId]?.skip === true : false;

  /* jump from the inspector straight to the cell's sheet: edit view + active
   *  sheet + auto scroll (the workspace scrolls to activeSheetId changes) */
  function viewOnSheet(): void {
    if (!owner) return;
    setViewMode("edit");
    setActiveSheet(owner.sheet.id);
    onClose();
  }

  /* library tag suggestions not yet on this icon */
  const suggestions = useMemo(() => {
    if (!entry) return [] as { tag: string; count: number }[];
    const present = new Set(entry.tags ?? []);
    const counts = new Map<string, number>();
    for (const id of iconOrder) {
      for (const tag of iconsMap[id]?.tags ?? []) {
        if (present.has(tag)) continue;
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([tag, count]) => ({ tag, count }));
  }, [entry, iconOrder, iconsMap]);

  const movableSheets = owner ? sheets.filter((sh) => sh.id !== owner.sheet.id) : sheets;

  /* related icons — library siblings sharing at least one tag, ranked by
   * shared-tag count (ties fall back to library order). Powers quick
   * triage: inspect → jump to a sibling → tag it → jump on. */
  const related = useMemo(() => {
    if (!entry) return [] as { id: string; shared: number; sharedTags: string[] }[];
    const myTags = new Set(entry.tags ?? []);
    if (myTags.size === 0) return [];
    const out: { id: string; shared: number; sharedTags: string[] }[] = [];
    for (const id of iconOrder) {
      if (id === iconId) continue;
      const e = iconsMap[id];
      if (!e) continue;
      const sharedTags = (e.tags ?? []).filter((t) => myTags.has(t));
      if (sharedTags.length > 0) out.push({ id, shared: sharedTags.length, sharedTags });
    }
    out.sort((a, b) => b.shared - a.shared);
    return out.slice(0, 6);
  }, [entry, iconId, iconOrder, iconsMap]);

  const canStep = nav.total > 1 && nav.position !== null;

  if (!entry || !meta) {
    return <div className="h-40 grid place-items-center text-[11px] text-muted-foreground">Icon not found.</div>;
  }

  /* ---- tag editing ---- */
  function commitTagInput(): void {
    const tags = tagInput
      .split(/[,\n]/)
      .map((t) => t.trim().toLowerCase().replace(/\s+/g, "-"))
      .filter(Boolean);
    if (tags.length === 0) return;
    updateIconTags([iconId], "add", tags);
    setTagInput("");
    toast.success(`Tagged ${entry.fileName} — ${Array.from(new Set(tags)).join(", ")}`, { description: "Ctrl Z to undo" });
  }

  /* ---- metadata editing (round 15) ----
   * Drafts compare against the STORED (normalized) values; commit sends
   * both fields wholesale ("" clears) and re-normalizes the drafts so the
   * dirty flag settles instantly. */
  const metaDirty =
    titleDraft.trim() !== (entry.title ?? "") || descDraft.trim() !== (entry.description ?? "");

  function commitMeta(): void {
    if (!metaDirty) return;
    const changed = updateIconMeta(iconId, { title: titleDraft, description: descDraft });
    if (!changed) {
      setTitleDraft(entry.title ?? "");
      setDescDraft(entry.description ?? "");
      return;
    }
    /* mirror the store's trim normalization so drafts === stored */
    setTitleDraft(titleDraft.trim());
    setDescDraft(descDraft.trim());
    toast.success("Metadata saved — searchable, embedded in SVG exports", {
      description: "Ctrl Z to undo",
    });
  }

  function resetMeta(): void {
    setTitleDraft(entry.title ?? "");
    setDescDraft(entry.description ?? "");
  }

  function downloadSvg(): void {
    /* round 15: metadata rides along as <title>/<desc> — the downloaded
     * file is accessible out of the box */
    const out = embedSvgMetadata(entry.svg, entry.title, entry.description);
    const blob = new Blob([out], { type: "image/svg+xml" });
    const filename = entry.fileName.endsWith(".svg") ? entry.fileName : `${entry.fileName}.svg`;
    saveFileNative(blob, filename)
      .then((res) => {
        if (res.saved) toast.success(`Downloaded ${filename}`);
      })
      .catch((err) => {
        console.error("Download failed:", err);
        toast.error(`Download failed: ${err instanceof Error ? err.message : String(err)}`);
      });
  }

  async function copySvg(): Promise<void> {
    try {
      await navigator.clipboard.writeText(
        embedSvgMetadata(entry.svg, entry.title, entry.description)
      );
      toast.success("SVG source copied to clipboard");
    } catch {
      toast.error("Clipboard unavailable — use Download instead");
    }
  }

  function confirmDelete(): void {
    const res = deleteIcons([iconId]);
    setDeleteArmed(false);
    onClose();
    if (res.removed.length > 0) {
      const sheetsNote =
        res.sheetsTouched.length > 0
          ? ` — pulled from ${res.sheetsTouched.length} sheet${res.sheetsTouched.length === 1 ? "" : "s"}`
          : "";
      toast.success(`Deleted ${entry.fileName} from the library${sheetsNote}`, {
        description: "Ctrl Z to undo",
      });
    }
  }

  function doMoveToSheet(targetId: string): void {
    const res = moveIcons([iconId], targetId, false);
    const idx = sheets.findIndex((s) => s.id === targetId);
    if (res.moved.length > 0) {
      toast.success(`Moved to Sheet ${pad2(idx + 1)}`);
    } else {
      toast.info(`Sheet ${pad2(idx + 1)} is full — create a new sheet instead`);
    }
  }

  function doNewSheet(): void {
    const created = moveIconsToNewSheet([iconId]);
    if (created > 0) {
      toast.success("New sheet created with this icon");
      onClose();
    }
  }

  function doSetHero(): void {
    if (!owner) return;
    setHero(owner.sheet.id, iconId);
    toast.success(`Hero icon set for Sheet ${pad2(owner.index + 1)}`);
  }

  function doUnassign(): void {
    const res = unassignIcons([iconId]);
    if (res.sheetsTouched.length > 0) {
      toast.success(`Removed from Sheet ${pad2((sheets.findIndex((s) => s.id === res.sheetsTouched[0]) ?? 0) + 1)} — icon stays in your library`, {
        description: "Ctrl Z to undo",
      });
    }
  }

  return (
    <div className="inspector-body flex min-h-0 flex-col">
      <DialogHeader className="shrink-0 border-b border-border/70 px-5 pb-3 pt-5">
        <DialogTitle className="flex items-center gap-2 text-[15px] leading-tight">
          <span
            className="studio-dlg-tile [&>svg]:h-4 [&>svg]:w-4"
            aria-hidden="true"
            dangerouslySetInnerHTML={{ __html: entry.svg }}
          />
          <span
            className="truncate font-semibold tracking-tight"
            title={entry.title ? `${entry.title} · ${entry.fileName}` : entry.fileName}
          >
            {entry.title ?? entry.fileName}
          </span>
          <Badge variant="outline" className="studio-chip studio-chip--neutral shrink-0 px-1.5 font-mono text-[10px] font-normal">
            {meta.nature}
          </Badge>
          {isHero ? (
            <Badge className="shrink-0 gap-1 bg-amber-500 text-[10px] text-amber-50 hover:bg-amber-500">
              <Star className="h-2.5 w-2.5 fill-current" aria-hidden="true" />
              hero
            </Badge>
          ) : null}
          {/* prev/next stepper — walks the live library-filter context */}
          <span className="ml-auto flex items-center gap-0.5 shrink-0">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={nav.onPrev}
              disabled={!canStep}
              aria-label="Previous icon in the current list"
              title={canStep ? "Previous icon (←)" : "No list to step through"}
            >
              <ChevronLeft className="h-4 w-4" aria-hidden="true" />
            </Button>
            <span
              className="insp-pos min-w-[52px] text-center font-mono text-[10px] tabular-nums text-muted-foreground"
              title="Position in the current library list — arrows step through it"
              aria-label={`Icon ${nav.position ?? 0} of ${nav.total} in the current list`}
            >
              {nav.position !== null ? `${nav.position} / ${nav.total}` : "— / —"}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={nav.onNext}
              disabled={!canStep}
              aria-label="Next icon in the current list"
              title={canStep ? "Next icon (→)" : "No list to step through"}
            >
              <ChevronRight className="h-4 w-4" aria-hidden="true" />
            </Button>
          </span>
        </DialogTitle>
        <DialogDescription className="sr-only">
          Details, tags and actions for icon {entry.fileName}
        </DialogDescription>
      </DialogHeader>

      {/* two-column body — flex column chain (min-h-0 all the way down) so
          the shell can always shrink to the viewport cap while header and
          footer stay pinned; single column below sm, side-by-side above */}
      <div className="flex min-h-0 flex-col sm:flex-row">
        {/* -------- left · artwork preview -------- */}
        <div className="inspector-surface relative flex shrink-0 items-center justify-center overflow-hidden border-b border-border/70 p-6 sm:w-[210px] sm:border-b-0 sm:border-r">
          {/* design-tool center guides */}
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-6 top-1/2 h-px bg-foreground/[0.07]"
          />
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-6 left-1/2 w-px bg-foreground/[0.07]"
          />
          {/* P7: the original-look preview renders through the shared preview
              engine (ink-bounds viewport, original colors — no stroke request)
              so artwork extending past the declared viewBox is fully visible
              here exactly as the sheet now places it. Raw fallback keeps the
              as-authored look for unmeasurable icons. */}
          <div
            role="img"
            aria-label={`Large preview of ${entry.fileName}`}
            className="relative h-28 w-28 text-foreground [&>svg]:block [&>svg]:h-full [&>svg]:w-full"
            dangerouslySetInnerHTML={{ __html: inspectorPreviewHtml }}
          />
          <span className="absolute bottom-2.5 left-1/2 -translate-x-1/2 rounded-full border border-border/60 bg-background/80 px-2 py-0.5 font-mono text-[9px] tabular-nums text-muted-foreground backdrop-blur">
            {meta.width}×{meta.height}
            {meta.strokeWidth ? ` · ${meta.strokeWidth}px${meta.strokeKind === "outline" ? " outline" : ""}` : ""}
          </span>
        </div>

        {/* -------- right · details / tags / assignment -------- */}
        <div className="insp-list-wrap flex min-h-0 min-w-0 flex-col overflow-hidden sm:flex-1">
          <div className="insp-scroll min-h-0 space-y-4 overflow-y-auto px-5 py-4 custom-scroll">
          {/* details */}
          <section>
            <SectionLabel>Source</SectionLabel>
            <dl className="insp-meta divide-y divide-border/50 rounded-lg border border-border/70 bg-muted/30 px-3 py-1">
              <MetaRow label="ViewBox" value={meta.viewBox} />
              <MetaRow label="Weight" value={`${meta.kb} KB`} />
              <MetaRow
                label="Stroke"
                value={
                  meta.strokeWidth
                    ? `${meta.strokeWidth}px${meta.strokeKind === "outline" ? " (filled outline)" : ""}`
                    : "—"
                }
              />
              <MetaRow
                label="Imported"
                value={new Date(entry.createdAt).toLocaleDateString(undefined, {
                  year: "numeric",
                  month: "short",
                  day: "numeric",
                })}
              />
              <MetaRow label="Identity" value={`#${meta.hash}`} />
            </dl>
          </section>

          {/* metadata (round 15) — title + description drafts; commit on
              Enter / Ctrl+Enter / the save button, undoable like tags */}
          <section className="border-t border-border/60 pt-3.5 dark:border-border/80">
            <SectionLabel>Metadata</SectionLabel>
            {/* 15-e: the title + description pair read as ONE editing
                surface — the insp-meta bordered-box language with flush
                hairline-divided fields (chrome carried by the
                .insp-meta-fields CSS, incl. the amber focus-warm +
                dirty-state affordances) */}
            <div className="insp-meta-body space-y-2">
              <div className="insp-meta-fields">
                <div className="relative">
                  <Heading2
                    className="insp-meta-glyph pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <Input
                    value={titleDraft}
                    onChange={(e) => setTitleDraft(e.target.value.slice(0, 80))}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        commitMeta();
                      }
                    }}
                    placeholder="Title — display name, shown in search"
                    className="h-7 pl-7 text-[11px]"
                    spellCheck={false}
                    maxLength={80}
                    aria-label="Icon title"
                  />
                </div>
                <Textarea
                  value={descDraft}
                  onChange={(e) => setDescDraft(e.target.value.slice(0, 280))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      commitMeta();
                    }
                  }}
                  placeholder="Description — what it depicts, usage notes (searchable, embedded in SVG exports)"
                  className="min-h-[54px] resize-none px-2.5 py-1.5 text-[11px] leading-relaxed"
                  maxLength={280}
                  rows={2}
                  aria-label="Icon description"
                />
              </div>
              <div className="flex items-center justify-between gap-2">
                <p className="min-w-0 truncate text-[10px] hint-text" aria-live="polite">
                  {metaDirty
                    ? "Unsaved — Enter (title) or Ctrl+Enter (description) to save"
                    : entry.title || entry.description
                      ? "Saved — searchable · embedded in downloaded/copied SVGs"
                      : "Optional — title & description are searchable everywhere"}
                </p>
                <span className="flex shrink-0 items-center gap-1">
                  {metaDirty ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="insp-meta-reset h-6 gap-1 px-2 text-[10.5px]"
                      onClick={resetMeta}
                      title="Revert to the saved metadata"
                      aria-label="Revert metadata edits"
                    >
                      <RotateCcw className="h-3 w-3" aria-hidden="true" />
                      Reset
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="insp-meta-save h-6 gap-1 px-2.5 text-[10.5px]"
                    onClick={commitMeta}
                    disabled={!metaDirty}
                    title={metaDirty ? "Save title & description (undoable)" : "No changes to save"}
                    aria-label="Save icon metadata"
                  >
                    <Save className="h-3 w-3" aria-hidden="true" />
                    Save
                  </Button>
                </span>
              </div>
            </div>
          </section>

          {/* tags */}
          <section className="border-t border-border/60 pt-3.5 dark:border-border/80">
            <SectionLabel>Tags</SectionLabel>
            <div className="space-y-2">
              {(entry.tags ?? []).length > 0 ? (
                <div className="flex flex-wrap gap-1">
                  {(entry.tags ?? []).map((tag) => (
                    <button
                      key={tag}
                      type="button"
                      className="tag-chip"
                      data-active="true"
                      onClick={() => {
                        updateIconTags([iconId], "remove", [tag]);
                        toast.info(`Removed "${tag}"`, { description: "Ctrl Z to undo" });
                      }}
                      title={`Remove tag ${tag}`}
                      aria-label={`Remove tag ${tag}`}
                    >
                      {tag}
                      <X className="h-2.5 w-2.5" aria-hidden="true" />
                    </button>
                  ))}
                </div>
              ) : (
                <p className="text-[11px] text-muted-foreground">
                  No tags yet — tags power filtering and AI categorization.
                </p>
              )}
              <div className="relative">
                <TagIcon
                  className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground"
                  aria-hidden="true"
                />
                <Input
                  value={tagInput}
                  onChange={(e) => setTagInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      commitTagInput();
                    }
                  }}
                  placeholder="Add tags — Enter to apply"
                  className="ip-field h-7 pl-7 text-[11px]"
                  spellCheck={false}
                  aria-label="New tags, comma separated"
                />
              </div>
              {suggestions.length > 0 ? (
                <div className="flex flex-wrap items-center gap-1">
                  <span className="text-[10px] hint-text">Library:</span>
                  {suggestions.map(({ tag, count }) => (
                    <button
                      key={tag}
                      type="button"
                      className="tag-chip"
                      onClick={() => {
                        updateIconTags([iconId], "add", [tag]);
                        toast.success(`Tagged — ${tag}`, { description: "Ctrl Z to undo" });
                      }}
                      title={`Add tag ${tag} (${count} icons use it)`}
                      aria-label={`Add tag ${tag}`}
                    >
                      <ListPlus className="h-2.5 w-2.5" aria-hidden="true" />
                      {tag}
                      <span className="tabular-nums hint-text">{count}</span>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          </section>

          {/* assignment */}
          <section className="border-t border-border/60 pt-3.5 dark:border-border/80">
            <SectionLabel>Assignment</SectionLabel>
            {owner ? (
              <div className="rounded-lg border border-border/70 bg-muted/30 px-3 py-2">
                <div className="flex items-center gap-2">
                  <FileBox className="h-4 w-4 shrink-0 text-amber-600" aria-hidden="true" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[12px] font-medium">
                      Sheet {pad2(owner.index + 1)}
                      <span className="font-normal text-muted-foreground">
                        {" "}
                        · cell {owner.cell}/{ownerCapacity}
                      </span>
                    </p>
                    <p className="truncate text-[10px] text-muted-foreground">
                      {owner.sheet.category} · VOL {pad2(owner.sheet.volume)}
                    </p>
                  </div>
                  {ownerSkipped ? (
                    <span
                      className="studio-chip studio-chip--neutral shrink-0 px-2 py-0.5 text-[9px] uppercase tracking-wide"
                      title="This cell is hidden from preview & export"
                    >
                      <EyeOff className="h-2.5 w-2.5" aria-hidden="true" />
                      Skipped
                    </span>
                  ) : null}
                  {isHero ? (
                    <span
                      className="studio-chip studio-chip--warn shrink-0 px-2 py-0.5 text-[9px] uppercase tracking-wide"
                      title="This icon is the sheet's hero"
                    >
                      <Star className="h-2.5 w-2.5 fill-current" aria-hidden="true" />
                      Hero
                    </span>
                  ) : null}
                </div>
                {ownerSkipped ? (
                  <div className="mt-2 flex items-center gap-2 rounded-md border border-dashed border-stone-400/70 bg-stone-500/5 px-2 py-1.5">
                    <EyeOff className="h-3.5 w-3.5 shrink-0 text-stone-500" aria-hidden="true" />
                    <p className="flex-1 text-[10px] leading-tight text-muted-foreground">
                      Cell hidden from preview &amp; export — the icon stays on the
                      sheet but renders as an empty hole.
                    </p>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-6 shrink-0 gap-1 px-2 text-[10px]"
                      onClick={() => {
                        setCellSkip(owner.sheet.id, [iconId], false);
                        toast.success("Cell restored — renders in preview & export");
                      }}
                      title="Render this cell again"
                    >
                      <Eye className="h-3 w-3" aria-hidden="true" />
                      Unskip
                    </Button>
                  </div>
                ) : null}
                <div className="mt-2 flex items-center gap-1.5">
                  {!isHero ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-7 shrink-0 gap-1 px-2 text-[11px]"
                      onClick={doSetHero}
                      title="Make this icon the sheet's hero"
                    >
                      <Star className="h-3 w-3" aria-hidden="true" />
                      Set hero
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-7 shrink-0 gap-1 px-2 text-[11px]"
                    onClick={viewOnSheet}
                    title="Open this sheet in Edit view and scroll to it"
                  >
                    <Eye className="h-3 w-3" aria-hidden="true" />
                    View on sheet
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-2 rounded-lg border border-dashed border-amber-500/50 bg-amber-500/5 px-3 py-2">
                <Sparkles className="h-4 w-4 shrink-0 text-amber-600" aria-hidden="true" />
                <p className="text-[11px] text-muted-foreground">
                  Unassigned — not placed on any sheet yet.
                </p>
              </div>
            )}
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {owner ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-7 gap-1 px-2.5 text-[11px]"
                  onClick={doUnassign}
                  title="Pull this icon off its sheet — it stays in the library"
                >
                  <FolderMinus className="h-3 w-3" aria-hidden="true" />
                  Remove from sheet
                </Button>
              ) : null}
              {movableSheets.length > 0 ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-7 gap-1 px-2.5 text-[11px]"
                      aria-label="Move this icon to another sheet"
                    >
                      <ArrowRightLeft className="h-3 w-3" aria-hidden="true" />
                      Move to sheet
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="min-w-56 max-w-64 max-h-72 overflow-y-auto">
                    {movableSheets.map((sheet) => {
                      const capacity = getSheetCapacity(sheets, sheet.id);
                      const full = sheet.iconIds.length >= capacity;
                      const realIndex = sheets.indexOf(sheet);
                      const label = `Sheet ${pad2(realIndex + 1)} · ${sheet.iconIds.length}/${capacity} · ${sheet.category}`;
                      return (
                        <DropdownMenuItem
                          key={sheet.id}
                          disabled={full}
                          onSelect={() => doMoveToSheet(sheet.id)}
                          title={full ? `${label} — full` : label}
                          className="gap-1.5 text-[11px]"
                        >
                          <FileBox className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                          <span className="truncate">{label}</span>
                        </DropdownMenuItem>
                      );
                    })}
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 gap-1 px-2.5 text-[11px]"
                onClick={doNewSheet}
                title="Create a new sheet with this icon on it"
              >
                <SquarePlus className="h-3 w-3" aria-hidden="true" />
                New sheet
              </Button>
            </div>
          </section>

          {/* related icons — shared-tag siblings, one click to inspect */}
          {related.length > 0 ? (
            <section className="border-t border-border/60 pt-3.5 dark:border-border/80">
              <SectionLabel>Related by tags</SectionLabel>
              <div className="related-grid">
                {related.map((r) => {
                  const e = iconsMap[r.id];
                  if (!e) return null;
                  const sharedLabel = `Shares ${r.shared} tag${r.shared === 1 ? "" : "s"} — ${r.sharedTags.join(", ")}`;
                  return (
                    <button
                      key={r.id}
                      type="button"
                      className="related-tile group"
                      onClick={() => openInspector(r.id)}
                      title={`${e.fileName} — ${sharedLabel}`}
                      aria-label={`Inspect ${e.fileName}: ${sharedLabel}`}
                    >
                      <span
                        className="grid h-9 w-9 shrink-0 place-items-center rounded-md border border-border/60 bg-background text-foreground transition-colors group-hover:border-amber-500/50 [&>svg]:h-5 [&>svg]:w-5"
                        aria-hidden="true"
                        dangerouslySetInnerHTML={{ __html: styledIconPreviewSvg(e, undefined, { size: 32 }) || e.svg }}
                      />
                      <span className="min-w-0 flex-1 text-left">
                        <span className="block truncate text-[10.5px] font-medium leading-tight">{e.fileName}</span>
                        <span className="block truncate hint-text text-[9px] leading-tight">{r.sharedTags.join(" · ")}</span>
                      </span>
                      <span
                        className="studio-chip studio-chip--warn shrink-0 px-1.5 py-0.5 font-mono text-[9px] tabular-nums"
                        title={sharedLabel}
                      >
                        {r.shared}
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>
          ) : null}
          </div>
          <span className="insp-scroll-fade" aria-hidden="true" />
        </div>
      </div>

      {/* -------- footer actions — pinned outside the scrolling body -------- */}
      <DialogFooter className="studio-dlg-footer shrink-0 items-center gap-2 px-5 py-3">
        {deleteArmed ? (
          <div className="flex w-full flex-wrap items-center gap-2">
            <p className="flex-1 min-w-40 text-[11px] text-amber-700 dark:text-amber-400">
              Delete {entry.fileName} from the library? It will be pulled off its sheet — undoable.
            </p>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 px-3 text-[11px]"
              onClick={() => setDeleteArmed(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              className="h-7 gap-1.5 bg-amber-700 px-3 text-[11px] hover:bg-amber-800"
              onClick={confirmDelete}
            >
              <Trash2 className="h-3 w-3" aria-hidden="true" />
              Delete icon
            </Button>
          </div>
        ) : (
          <>
            <div className="mr-auto flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 gap-1.5 px-2.5 text-[11px]"
                onClick={() => void copySvg()}
                title="Copy the raw SVG source to the clipboard"
              >
                <Copy className="h-3 w-3" aria-hidden="true" />
                Copy SVG
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 gap-1.5 px-2.5 text-[11px]"
                onClick={downloadSvg}
                title="Download the original SVG file"
              >
                <Download className="h-3 w-3" aria-hidden="true" />
                Download
              </Button>
            </div>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 gap-1.5 px-2.5 text-[11px] text-amber-700 hover:bg-amber-500/10 hover:text-amber-800 dark:text-amber-400 dark:hover:text-amber-300"
              onClick={() => setDeleteArmed(true)}
              title="Remove this icon from the library (undoable)"
            >
              <Trash2 className="h-3 w-3" aria-hidden="true" />
              Delete
            </Button>
            <span className="hidden items-center gap-1 text-[10px] hint-text md:inline-flex">
              <Hash className="h-3 w-3" aria-hidden="true" />
              {meta.kb} KB · {meta.nature.toLowerCase()}
              {meta.strokeWidth
                ? ` · ${meta.strokeWidth}px ${meta.strokeKind === "outline" ? "outline" : "stroke"}`
                : ""}
            </span>
          </>
        )}
      </DialogFooter>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Inspector dialog shell                                              */
/* ------------------------------------------------------------------ */

export function IconInspector({
  iconId,
  onClose,
}: {
  iconId: string | null;
  onClose: () => void;
}): JSX.Element {
  const open = iconId !== null;
  const openInspector = useStudio((s) => s.openInspector);

  /* stepper context — the live library filter (or the whole library) */
  const contextIds = useContextIconIds();
  const index = iconId !== null ? contextIds.indexOf(iconId) : -1;
  const position = index >= 0 ? index + 1 : null;

  /* wrap-around stepping: last → first and vice versa. Total <= 1 (or the
   * icon outside the filter) disables the stepper — the header shows “— / —”. */
  const step = useCallback(
    (delta: 1 | -1) => {
      if (iconId === null || position === null || contextIds.length <= 1) return;
      const next = (index + delta + contextIds.length) % contextIds.length;
      openInspector(contextIds[next]);
    },
    [iconId, position, index, contextIds, openInspector],
  );
  const onPrev = useCallback(() => step(-1), [step]);
  const onNext = useCallback(() => step(1), [step]);

  /* record every inspection into the palette's "recently inspected" memory.
   * localStorage write on an icon switch — no React state involved. */
  useEffect(() => {
    if (iconId) pushRecentIcon(iconId);
  }, [iconId]);

  /* ←/→ step through the context while focus is outside text inputs.
   * Portaled dropdowns live outside DialogContent, so their own arrow-key
   * handling never bubbles through here. */
  function onKeyDown(e: React.KeyboardEvent): void {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (position === null || contextIds.length <= 1) return;
    e.preventDefault();
    if (e.key === "ArrowLeft") onPrev();
    else onNext();
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        className="inspector-shell flex flex-col gap-0 overflow-hidden p-0 sm:max-w-[min(42rem,calc(100%-2rem))]"
        onKeyDown={onKeyDown}
      >
        {iconId ? (
          <InspectorBody
            key={iconId}
            iconId={iconId}
            onClose={onClose}
            nav={{ position, total: contextIds.length, onPrev, onNext }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
