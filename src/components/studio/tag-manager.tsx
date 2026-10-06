"use client";

/**
 * ICON SHEET STUDIO — Tag Manager.
 *
 * Library-wide tag housekeeping in one dialog:
 *   · every tag with its icon count, sorted by frequency
 *   · RENAME a tag inline (Enter commits, Esc reverts) — renaming onto an
 *     existing tag MERGES the two (icon count union, no duplicates)
 *   · DELETE a tag (two-step arm per row) — removes it from every icon
 *   · MERGE a tag into another (per-row "Merge into…" quick action,
 *     round-6 rec #4): inline target input with quick-pick suggestion
 *     chips — one undoable mergeTags step (Enter commits, Esc cancels)
 *   · BULK selection (round 6): check several tags → merge them ALL onto
 *     one target tag in a single undoable step, or delete every selected
 *     tag at once
 *
 * Every operation is undoable since round 6 (tag history entries restore
 * the affected icons' exact tag lists) — toasts carry a Ctrl Z hint.
 * Tag filters in the library panel follow all changes automatically
 * because the chip row derives from the same store.
 */

import { useMemo, useState } from "react";
import type { JSX } from "react";
import { toast } from "sonner";
import {
  ArrowRightLeft,
  Check,
  CheckSquare,
  GitMerge,
  Pencil,
  Square,
  Tags,
  Trash2,
  X,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { useStudio } from "@/lib/studio/store";

interface TagRow {
  tag: string;
  count: number;
}

const UNDO_HINT = "Ctrl Z to undo";

export function TagManagerDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): JSX.Element {
  const icons = useStudio((s) => s.icons);
  const iconOrder = useStudio((s) => s.iconOrder);
  const renameTag = useStudio((s) => s.renameTag);
  const deleteTag = useStudio((s) => s.deleteTag);
  const mergeTags = useStudio((s) => s.mergeTags);
  const deleteTags = useStudio((s) => s.deleteTags);

  /** tag being renamed (its original name) — row switches to edit mode */
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  /** tag whose delete is armed — stores the ORIGINAL name; a rename or
   *  data change disarms it naturally (name no longer matches) */
  const [deleteArm, setDeleteArm] = useState<string | null>(null);
  /** tag whose row is in per-row "merge into" mode — its normal content is
   *  replaced by a target input + quick-pick chips (round-6 rec #4) */
  const [mergingRow, setMergingRow] = useState<string | null>(null);
  const [mergeRowTarget, setMergeRowTarget] = useState("");

  /* ---- bulk selection state (round 6) ---- */
  /** selected tag names (kept sorted for stable arm comparisons) */
  const [selected, setSelected] = useState<string[]>([]);
  /** merge mode active → shows the target input */
  const [mergeMode, setMergeMode] = useState(false);
  const [mergeTarget, setMergeTarget] = useState("");
  /** bulk delete armed — stores the exact selection snapshot; any change
   *  to the selection disarms it naturally (snapshot no longer matches) */
  const [bulkArm, setBulkArm] = useState<string | null>(null);

  const rows = useMemo<TagRow[]>(() => {
    const counts = new Map<string, number>();
    for (const id of iconOrder) {
      for (const tag of icons[id]?.tags ?? []) {
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([tag, count]) => ({ tag, count }));
  }, [icons, iconOrder]);

  const totalTaggedIcons = useMemo(
    () => iconOrder.filter((id) => (icons[id]?.tags ?? []).length > 0).length,
    [icons, iconOrder],
  );

  /* selection pruned to tags that still exist (deletes/merges shrink it) */
  const liveSelected = useMemo(
    () => selected.filter((t) => rows.some((r) => r.tag === t)),
    [selected, rows],
  );
  const selectedCount = liveSelected.length;
  const selectedIconCount = useMemo(
    () =>
      liveSelected.reduce((sum, t) => sum + (rows.find((r) => r.tag === t)?.count ?? 0), 0),
    [liveSelected, rows],
  );
  const bulkArmed = bulkArm !== null && bulkArm === [...liveSelected].sort().join("\u0000");

  function toggleSelected(tag: string): void {
    setSelected((prev) =>
      prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag].sort(),
    );
    setMergeMode(false);
  }

  function selectAll(): void {
    setSelected(rows.map((r) => r.tag));
    setMergeMode(false);
  }

  function clearSelection(): void {
    setSelected([]);
    setMergeMode(false);
    setBulkArm(null);
    setMergeTarget("");
  }

  function startRename(tag: string): void {
    setEditing(tag);
    setDraft(tag);
    setDeleteArm(null);
    setMergingRow(null); // rename and merge modes are mutually exclusive
  }

  function commitRename(original: string): void {
    const trimmed = draft.trim();
    setEditing(null);
    // the original name may be part of the bulk selection — drop it there
    setSelected((prev) => (prev.includes(original) ? prev.filter((t) => t !== original) : prev));
    if (!trimmed || trimmed === original) return;
    const res = renameTag(original, trimmed);
    if (res.icons > 0) {
      toast.success(
        res.merged
          ? `Merged "${original}" into "${trimmed}" — ${res.icons} icons updated`
          : `Renamed "${original}" to "${trimmed}" — ${res.icons} icons updated`,
        { description: UNDO_HINT },
      );
    } else {
      toast.info(`Nothing to rename — "${original}" is not in use`);
    }
  }

  /** per-row "merge into…" — mirrors the rename inline mode: target input
   *  (Enter commits, Esc cancels); quick-pick chips fill it on click */
  function startRowMerge(tag: string): void {
    setMergingRow(tag);
    setMergeRowTarget("");
    setEditing(null); // starting a rename cancels merge mode and vice versa
    setDeleteArm(null);
    setMergeMode(false); // the bulk bar's merge input and this never coexist
  }

  function commitRowMerge(original: string): void {
    const target = mergeRowTarget.trim().toLowerCase().replace(/\s+/g, "-");
    setMergingRow(null);
    if (!target) return; // empty target → no-op, like rename's empty draft
    const res = mergeTags([original], target);
    if (res.icons > 0) {
      // the source tag vanishes — drop it from the bulk selection too
      setSelected((prev) =>
        prev.includes(original) ? prev.filter((t) => t !== original) : prev,
      );
      toast.success(
        res.merged
          ? `Merged "${original}" into "${target}" — ${res.icons} icons updated`
          : `Renamed "${original}" to "${target}" — ${res.icons} icons updated`,
        { description: UNDO_HINT },
      );
    } else {
      toast.info(`Nothing to merge — pick a target other than "${original}"`);
    }
  }

  function confirmDelete(tag: string): void {
    const affected = deleteTag(tag);
    setDeleteArm(null);
    setSelected((prev) => prev.filter((t) => t !== tag));
    if (affected > 0) {
      toast.success(`Deleted tag "${tag}" from ${affected} icon${affected === 1 ? "" : "s"}`, {
        description: UNDO_HINT,
      });
    }
  }

  function enterMergeMode(): void {
    // prefill with the most frequent selected tag
    const mostFrequent = rows.find((r) => liveSelected.includes(r.tag))?.tag ?? "";
    setMergeTarget(mostFrequent);
    setMergeMode(true);
    setMergingRow(null); // cancel any per-row merge first
    setBulkArm(null);
  }

  function commitBulkMerge(): void {
    const target = mergeTarget.trim().toLowerCase().replace(/\s+/g, "-");
    if (!target) return;
    const res = mergeTags(liveSelected, target);
    setMergeMode(false);
    if (res.icons > 0) {
      toast.success(
        `Merged ${liveSelected.length} tags into "${target}" — ${res.icons} icons updated`,
        { description: UNDO_HINT },
      );
      clearSelection();
    } else {
      toast.info("Nothing to merge — pick at least two different tags");
    }
  }

  function commitBulkDelete(): void {
    const affected = deleteTags(liveSelected);
    setBulkArm(null);
    if (affected > 0) {
      toast.success(
        `Deleted ${selectedCount} tags from ${affected} icon${affected === 1 ? "" : "s"}`,
        { description: UNDO_HINT },
      );
      clearSelection();
    }
  }

  const selectionActive = selectedCount > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Escape guard (round 9, fixes the round-7 documented quirk): while a
       * row edit is active (inline rename or merge-into) the FIRST Escape
       * cancels that edit only — Radix dismisses on capture-phase Escape,
       * so we swallow it here and let the input's own handler revert. */}
      <DialogContent
        className="max-w-md gap-0 overflow-hidden p-0"
        onEscapeKeyDown={(e) => {
          if (editing !== null || mergingRow !== null || mergeMode) e.preventDefault();
        }}
      >
        <DialogHeader className="border-b border-border/70 px-5 pt-5 pb-3">
          <DialogTitle className="flex items-center gap-2 text-[15px] font-semibold tracking-tight">
            <span className="studio-dlg-tile">
              <Tags className="h-4 w-4" aria-hidden="true" />
            </span>
            Manage tags
            <Badge variant="outline" className="studio-chip studio-chip--neutral shrink-0 px-1.5 font-mono text-[10px] font-normal tabular-nums">
              {rows.length}
            </Badge>
          </DialogTitle>
          <DialogDescription className="text-[11px] leading-relaxed">
            Rename tags (renaming onto an existing tag merges them), bulk-merge or delete
            them across the whole library. {totalTaggedIcons} of {iconOrder.length} icons carry tags.
          </DialogDescription>
        </DialogHeader>

        {/* ---- bulk action bar (round 6) ---- */}
        {rows.length > 0 && (selectionActive || mergeMode) ? (
          mergeMode ? (
            <div
              className="tm-bulk-bar--amber flex items-center gap-1.5 border-b border-amber-500/30 bg-amber-500/[0.07] px-4 py-2"
              aria-live="polite"
            >
              <GitMerge className="h-3.5 w-3.5 shrink-0 text-amber-600" aria-hidden="true" />
              <span className="shrink-0 text-[11px] font-medium text-amber-800 dark:text-amber-300">
                Merge {selectedCount} tags into
              </span>
              <Input
                autoFocus
                value={mergeTarget}
                onChange={(e) => setMergeTarget(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    commitBulkMerge();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    setMergeMode(false);
                  }
                }}
                className="ip-field h-7 min-w-0 flex-1 text-[12px]"
                spellCheck={false}
                maxLength={24}
                aria-label="Target tag name for the merge"
              />
              <Button
                type="button"
                size="sm"
                className="h-7 shrink-0 gap-1 bg-amber-700 px-2.5 text-[11px] hover:bg-amber-800"
                onClick={commitBulkMerge}
                disabled={selectedCount < 2}
                title="Merge every selected tag onto this name (Enter)"
              >
                <Check className="h-3 w-3" aria-hidden="true" />
                Merge
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 shrink-0 px-2 text-[11px]"
                onClick={() => setMergeMode(false)}
                title="Cancel (Esc)"
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </Button>
            </div>
          ) : bulkArmed ? (
            <div
              className="tm-bulk-bar--amber flex items-center gap-1.5 border-b border-amber-500/30 bg-amber-500/[0.07] px-4 py-2"
              aria-live="polite"
            >
              <Trash2 className="h-3.5 w-3.5 shrink-0 text-amber-600" aria-hidden="true" />
              <span className="min-w-0 flex-1 text-[11px] font-medium text-amber-800 dark:text-amber-300">
                Delete {selectedCount} tags from {selectedIconCount} icon
                {selectedIconCount === 1 ? "" : "s"}?
              </span>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-6 shrink-0 px-2 text-[11px]"
                onClick={() => setBulkArm(null)}
              >
                Cancel
              </Button>
              <Button
                type="button"
                size="sm"
                className="h-6 shrink-0 gap-1 bg-amber-700 px-2 text-[11px] hover:bg-amber-800"
                onClick={commitBulkDelete}
              >
                <Trash2 className="h-3 w-3" aria-hidden="true" />
                Delete
              </Button>
            </div>
          ) : (
            <div className="tm-bulk-bar flex flex-wrap items-center gap-1.5 border-b border-border/70 bg-muted/30 px-4 py-2">
              <span className="flex items-center gap-1 text-[11px] font-medium text-amber-700 dark:text-amber-400">
                <CheckSquare className="h-3.5 w-3.5 text-amber-600" aria-hidden="true" />
                {selectedCount} tag{selectedCount === 1 ? "" : "s"}
                <span className="font-normal text-muted-foreground">
                  {" "}
                  · {selectedIconCount} icon{selectedIconCount === 1 ? "" : "s"}
                </span>
              </span>
              <div className="flex-1" />
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-6 px-1.5 text-[10px] text-muted-foreground hover:text-foreground"
                onClick={selectAll}
                disabled={selectedCount === rows.length}
              >
                <Square className="mr-0.5 h-2.5 w-2.5" aria-hidden="true" />
                All
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-6 px-1.5 text-[10px] text-muted-foreground hover:text-foreground"
                onClick={clearSelection}
              >
                None
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="tm-bulk-btn h-6 gap-1 px-2 text-[11px]"
                onClick={enterMergeMode}
                disabled={selectedCount < 2}
                title="Merge every selected tag onto one name (undoable)"
              >
                <GitMerge className="h-3 w-3" aria-hidden="true" />
                Merge…
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="tm-bulk-btn tm-bulk-btn--danger h-6 gap-1 px-2 text-[11px]"
                onClick={() => setBulkArm([...liveSelected].sort().join("\u0000"))}
                title="Delete every selected tag from the library (undoable)"
              >
                <Trash2 className="h-3 w-3" aria-hidden="true" />
                Delete
              </Button>
            </div>
          )
        ) : null}

        <div className="tm-list-wrap">
          <div className="tm-scroll max-h-[50vh] overflow-y-auto px-3 py-2 custom-scroll">
          {rows.length === 0 ? (
            <div className="grid place-items-center py-10 text-center">
              <div className="studio-empty-glyph mb-2.5">
                <Tags className="h-5 w-5" aria-hidden="true" />
              </div>
              <p className="text-[12px] font-medium text-foreground/80">No tags in this library yet.</p>
              <p className="text-[11px] hint-text">
                Select icons in the library and use the Tag button to create some.
              </p>
            </div>
          ) : (
            <ul className="space-y-0.5">
              {rows.map(({ tag, count }) => {
                const isEditing = editing === tag;
                const isArmed = deleteArm === tag;
                const isMerging = mergingRow === tag;
                const isSelected = liveSelected.includes(tag);
                /** quick-pick suggestions: top 4 other tags by frequency */
                const suggestions = isMerging
                  ? rows.filter((r) => r.tag !== tag).slice(0, 4).map((r) => r.tag)
                  : [];
                return (
                  <li
                    key={tag}
                    className={cn(
                      "group/row flex items-center gap-2 rounded-lg px-2 py-1.5 focus-within:bg-muted/60",
                      !isEditing && !isArmed && !isMerging && "studio-row",
                      !isEditing && !isArmed && !isMerging && isSelected && "studio-row--selected",
                      isArmed && "bg-amber-500/5 ring-1 ring-amber-500/30",
                      isMerging && "bg-amber-500/[0.06] ring-1 ring-amber-500/30",
                    )}
                  >
                    {isEditing ? (
                      <>
                        <Input
                          autoFocus
                          value={draft}
                          onChange={(e) => setDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              commitRename(tag);
                            } else if (e.key === "Escape") {
                              e.preventDefault();
                              setEditing(null);
                            }
                          }}
                          className="ip-field h-7 flex-1 text-[12px]"
                          spellCheck={false}
                          aria-label={`Rename tag ${tag}`}
                          maxLength={24}
                        />
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7 shrink-0"
                          onClick={() => commitRename(tag)}
                          aria-label="Apply rename"
                          title="Apply rename (Enter)"
                        >
                          <Check className="h-3.5 w-3.5" aria-hidden="true" />
                        </Button>
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7 shrink-0"
                          onClick={() => setEditing(null)}
                          aria-label="Cancel rename"
                          title="Cancel (Esc)"
                        >
                          <X className="h-3.5 w-3.5" aria-hidden="true" />
                        </Button>
                      </>
                    ) : isMerging ? (
                      <div className="flex min-w-0 flex-1 flex-col gap-1">
                        <div className="flex items-center gap-2">
                          <Input
                            autoFocus
                            value={mergeRowTarget}
                            onChange={(e) => setMergeRowTarget(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                e.preventDefault();
                                commitRowMerge(tag);
                              } else if (e.key === "Escape") {
                                e.preventDefault();
                                setMergingRow(null);
                              }
                            }}
                            className="ip-field h-7 flex-1 text-[12px]"
                            placeholder="Target tag name"
                            spellCheck={false}
                            maxLength={24}
                            aria-label={`Merge ${tag} into…`}
                          />
                          <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7 shrink-0"
                            onClick={() => commitRowMerge(tag)}
                            aria-label="Apply merge"
                            title="Apply merge (Enter)"
                          >
                            <Check className="h-3.5 w-3.5" aria-hidden="true" />
                          </Button>
                          <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7 shrink-0"
                            onClick={() => setMergingRow(null)}
                            aria-label="Cancel merge"
                            title="Cancel (Esc)"
                          >
                            <X className="h-3.5 w-3.5" aria-hidden="true" />
                          </Button>
                        </div>
                        {suggestions.length > 0 && (
                          <div className="flex min-w-0 flex-wrap items-center gap-1">
                            {suggestions.map((s) => (
                              <button
                                key={s}
                                type="button"
                                className="tag-chip max-w-[8rem]"
                                onClick={() => setMergeRowTarget(s)}
                                aria-label={`Set merge target to ${s}`}
                                title={`Use "${s}" as the merge target`}
                              >
                                <span className="truncate">{s}</span>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    ) : isArmed ? (
                      <>
                        <span className="min-w-0 flex-1 truncate text-[12px] text-amber-700 dark:text-amber-400">
                          Delete “{tag}” from {count} icon{count === 1 ? "" : "s"}?
                        </span>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="h-6 shrink-0 px-2 text-[11px]"
                          onClick={() => setDeleteArm(null)}
                        >
                          Cancel
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          className="h-6 shrink-0 gap-1 bg-amber-700 px-2 text-[11px] hover:bg-amber-800"
                          onClick={() => confirmDelete(tag)}
                        >
                          <Trash2 className="h-3 w-3" aria-hidden="true" />
                          Delete
                        </Button>
                      </>
                    ) : (
                      <>
                        {/* bulk-selection checkbox (round 6) */}
                        <button
                          type="button"
                          role="checkbox"
                          aria-checked={isSelected}
                          aria-label={isSelected ? `Deselect tag ${tag}` : `Select tag ${tag}`}
                          title={isSelected ? "Remove from bulk selection" : "Add to bulk selection"}
                          onClick={() => toggleSelected(tag)}
                          className={cn(
                            "bulk-check grid h-3.5 w-3.5 shrink-0 place-items-center rounded-[4px] border transition",
                            isSelected
                              ? "border-amber-500 bg-amber-500 text-amber-50"
                              : "border-border text-transparent hover:border-foreground/40",
                          )}
                        >
                          <svg viewBox="0 0 24 24" className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth="5">
                            <path d="M20 6L9 17l-5-5" />
                          </svg>
                        </button>
                        <button
                          type="button"
                          className="tag-chip min-w-0 max-w-[55%]"
                          onClick={() => startRename(tag)}
                          title={`Rename "${tag}" (click to edit)`}
                          aria-label={`Rename tag ${tag}`}
                        >
                          <Pencil className="h-2.5 w-2.5 shrink-0 opacity-0 transition-opacity group-hover/row:opacity-60" aria-hidden="true" />
                          <span className="truncate">{tag}</span>
                        </button>
                        <span className="tm-row-count shrink-0">
                          {count}
                        </span>
                        <span className="flex-1" />
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          className="h-6 w-6 shrink-0 text-muted-foreground/70 opacity-0 transition-opacity hover:text-foreground group-hover/row:opacity-100 focus-visible:opacity-100"
                          onClick={() => startRename(tag)}
                          aria-label={`Rename tag ${tag}`}
                          title="Rename (or merge onto another tag)"
                        >
                          <Pencil className="h-3 w-3" aria-hidden="true" />
                        </Button>
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          className="h-6 w-6 shrink-0 text-muted-foreground/70 opacity-0 transition-opacity hover:text-foreground group-hover/row:opacity-100 focus-visible:opacity-100"
                          onClick={() => startRowMerge(tag)}
                          aria-label={`Merge ${tag} into another tag`}
                          title="Merge this tag into another tag"
                        >
                          <GitMerge className="h-3 w-3" aria-hidden="true" />
                        </Button>
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          className="tm-danger h-6 w-6 shrink-0 text-muted-foreground/70 opacity-0 transition-opacity focus-visible:opacity-100 group-hover/row:opacity-100"
                          onClick={() => setDeleteArm(tag)}
                          aria-label={`Delete tag ${tag}`}
                          title="Delete this tag from every icon"
                        >
                          <Trash2 className="h-3 w-3" aria-hidden="true" />
                        </Button>
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          </div>
          <span className="tm-scroll-fade" aria-hidden="true" />
        </div>

        <DialogFooter className="studio-dlg-footer px-5 py-3">
          <span className="hint-text mr-auto hidden items-center gap-1.5 text-[10px] sm:inline-flex">
            <ArrowRightLeft className="h-3 w-3" aria-hidden="true" />
            renaming to an existing tag merges both · every change is undoable
          </span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 px-3 text-[11px]"
            onClick={() => onOpenChange(false)}
          >
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
