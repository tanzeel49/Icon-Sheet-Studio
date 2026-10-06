"use client";

/**
 * ICON SHEET STUDIO — Similar icons dialog (round 10).
 *
 * Groups of icons whose SOURCE GEOMETRY matches (similarity.ts — the
 * rasterized signature scan), surfaced side by side so renamed copies
 * and near-identical artwork are caught BEFORE a sheet renders what
 * reads as one glyph twice. Per group: every member tile shows the
 * icon's own original artwork, its file name, tags and sheet
 * assignment, with Inspect (jump to the full inspector) and Remove
 * (inline armed confirm — pulls the icon off its sheets, undoable).
 *
 * Byte-identical sources are flagged "exact copy"; everything else
 * carries the measured geometry match as a percentage. A filter chip
 * narrows the list to near-identical matches (≥ 90%).
 *
 * Round 13 — bulk "Consolidate all": one armed action keeps the MOST-USED
 * copy of every shown group (most sheet placements, tie → earliest in
 * library order), re-points the extras' placements at it, and deletes the
 * extras from the library — the whole sweep is ONE undo step. Respects the
 * near-identical filter (only the groups you are looking at are touched).
 *
 * Round 15 — per-group quick "Consolidate": the same store action, keeper
 * rule and one-undo semantics scoped to ONE group, armed inline on the
 * group card header — sweep a single group without the bulk sweep.
 *
 * Pure analysis of the immutable source SVGs — the scan mutates
 * nothing; removal is the only mutation and it goes through the
 * store's undoable deleteIcons.
 */

import { useMemo, useState } from "react";
import type { JSX } from "react";
import { toast } from "sonner";
import {
  Check,
  Combine,
  Copy,
  Layers,
  Repeat,
  Replace,
  Scan,
  ScanSearch,
  Trash2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useStudio } from "@/lib/studio/store";
import {
  findSimilarIcons,
  iconSignature,
  NEAR_IDENTICAL_THRESHOLD,
  pairScore,
  pairScoreDihedral,
  SIMILARITY_THRESHOLD,
  type SimilarityGroup,
} from "@/lib/studio/similarity";
import type { Sheet } from "@/lib/studio/types";
import { hashSvgContent } from "@/lib/studio/svg";
import { cn } from "@/lib/utils";

/* console QA hook (mirrors the stroke report's window.__strokeDebug):
 * window.__similarityDebug() → groups over the LIVE library, with the
 * file names inlined for console readability. __simSig exposes the raw
 * signature for engine debugging. */
if (typeof window !== "undefined") {
  const w = window as unknown as {
    __similarityDebug?: (dihedral?: boolean) => unknown;
    __simSig?: (svg: string) => unknown;
    __simPair?: (svgA: string, svgB: string, dihedral?: boolean) => unknown;
  };
  w.__similarityDebug = (dihedral?: boolean) => {
    const s = useStudio.getState();
    return findSimilarIcons(s.icons, s.iconOrder, { dihedral }).map((g) => ({
      ids: g.ids.map((id) => s.icons[id]?.fileName ?? id),
      best: Math.round(g.best * 100),
      pairs: g.pairs.map((p) => ({
        a: s.icons[p.a]?.fileName ?? p.a,
        b: s.icons[p.b]?.fileName ?? p.b,
        s: Math.round(p.score * 100),
        t: p.transform,
      })),
    }));
  };
  /* engine-level pair probe: __simPair(svgA, svgB, true) → score + the
   * winning orientation — precise verification without UI noise */
  w.__simPair = (svgA: string, svgB: string, dihedral?: boolean) => {
    const sa = iconSignature(svgA);
    const sb = iconSignature(svgB);
    if (!sa || !sb) return null;
    if (dihedral) {
      const d = pairScoreDihedral(sa, sb);
      return { score: Math.round(d.score * 1000) / 1000, transform: d.transform };
    }
    return { score: Math.round(pairScore(sa, sb) * 1000) / 1000, transform: undefined };
  };
  w.__simSig = (svg: string) => {
    const sig = iconSignature(svg);
    if (!sig) return null;
    let h = 0;
    for (let i = 0; i < sig.fineEdge.length; i++) h = (h * 31 + sig.fineEdge[i]) | 0;
    return {
      aspect: Math.round(sig.aspect * 100) / 100,
      popFineEdge: sig.popFineEdge,
      popFineFill: sig.popFineFill,
      popCoarseEdge: sig.popCoarseEdge,
      gridHash: h,
      fine: sig.fineEdge,
    };
  };
}

/* ------------------------------------------------------------------ */
/* Member tile                                                         */
/* ------------------------------------------------------------------ */

function MemberTile({
  iconId,
  otherCount,
  armed,
  onArm,
  onInspect,
  onConfirmReplace,
}: {
  iconId: string;
  /** how many OTHER members the group has (replace-confirm copy) */
  otherCount: number;
  /** which confirm state this tile is in (null = plain action row) */
  armed: "remove" | "replace" | null;
  onArm: (kind: "remove" | "replace" | null) => void;
  onInspect: () => void;
  onConfirmReplace: () => void;
}): JSX.Element | null {
  const entry = useStudio((s) => s.icons[iconId]);
  const sheets = useStudio((s) => s.sheets);
  const deleteIcons = useStudio((s) => s.deleteIcons);

  const ownerNames = useMemo(() => {
    if (!entry) return [] as string[];
    return sheets
      .filter((sh) => sh.iconIds.includes(iconId))
      .map((sh) => {
        const idx = sheets.indexOf(sh);
        return `Sheet ${String(idx + 1).padStart(2, "0")}`;
      });
  }, [entry, iconId, sheets]);

  if (!entry) return null;

  function confirmRemove(): void {
    const res = deleteIcons([iconId]);
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

  return (
    <div
      className={cn(
        "sim-tile flex w-[150px] shrink-0 flex-col gap-1.5 rounded-lg border p-2.5",
        armed === "remove"
          ? "sim-tile--remove"
          : armed === "replace"
            ? "sim-tile--keep"
            : "border-border/60 bg-card/60 dark:border-border",
      )}
    >
      <div className="sim-tile-art grid h-11 w-11 place-items-center self-center overflow-hidden rounded-md">
        <span
          className="block h-full w-full text-foreground [&>svg]:block [&>svg]:h-full [&>svg]:w-full"
          dangerouslySetInnerHTML={{ __html: entry.svg }}
        />
      </div>
      <p className="truncate text-center text-[11px] font-medium leading-tight" title={entry.fileName}>
        {entry.fileName}
      </p>
      <div className="flex flex-wrap items-center justify-center gap-x-1 gap-y-0.5 text-center text-[9.5px] leading-tight text-muted-foreground">
        <span>{(entry.tags ?? []).length} tag{(entry.tags ?? []).length === 1 ? "" : "s"}</span>
        <span aria-hidden="true">·</span>
        <span title={ownerNames.length > 0 ? ownerNames.join(", ") : undefined}>
          {ownerNames.length === 0 ? "unassigned" : ownerNames.length === 1 ? ownerNames[0] : `${ownerNames.length} sheets`}
        </span>
      </div>
      {armed === "replace" ? (
        <>
          <p className="text-center text-[9.5px] leading-tight text-emerald-700 dark:text-emerald-400">
            Replace {otherCount} other {otherCount === 1 ? "copy" : "copies"} with this icon?
          </p>
          <div className="flex items-center gap-1">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-6 flex-1 px-1.5 text-[10px]"
              onClick={() => onArm(null)}
              aria-label="Cancel replacing"
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              className="sim-keep-btn h-6 flex-1 gap-1 bg-emerald-700 px-1.5 text-[10px] hover:bg-emerald-800"
              onClick={onConfirmReplace}
              aria-label={`Confirm replacing the other ${otherCount} ${otherCount === 1 ? "copy" : "copies"} with ${entry.fileName}`}
            >
              <Check className="h-3 w-3" aria-hidden="true" />
              Keep this
            </Button>
          </div>
        </>
      ) : armed === "remove" ? (
        <div className="flex items-center gap-1">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-6 flex-1 px-1.5 text-[10px]"
            onClick={() => onArm(null)}
            aria-label="Cancel removal"
          >
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            className="sim-delete-btn h-6 flex-1 gap-1 bg-amber-700 px-1.5 text-[10px] hover:bg-amber-800"
            onClick={confirmRemove}
            aria-label={`Confirm deleting ${entry.fileName}`}
          >
            <Check className="h-3 w-3" aria-hidden="true" />
            Delete
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-1">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-6 flex-1 px-1.5 text-muted-foreground hover:text-foreground"
            onClick={onInspect}
            aria-label={`Inspect ${entry.fileName}`}
            title="Open the full inspector"
          >
            <Scan className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-6 flex-1 px-1.5 text-muted-foreground hover:text-emerald-700 dark:hover:text-emerald-400"
            onClick={() => onArm("replace")}
            aria-label={`Replace the other copies with ${entry.fileName}`}
            title={`Keep this one — replace every other group member's sheet placements with ${entry.fileName}`}
          >
            <Replace className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-6 flex-1 px-1.5 text-muted-foreground hover:text-amber-700 dark:hover:text-amber-400"
            onClick={() => onArm("remove")}
            aria-label={`Remove ${entry.fileName} from the library`}
            title="Delete this icon from the library"
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Group card                                                          */
/* ------------------------------------------------------------------ */

function GroupCard({ group, index }: { group: SimilarityGroup; index: number }): JSX.Element {
  const icons = useStudio((s) => s.icons);
  const sheets = useStudio((s) => s.sheets);
  const openInspector = useStudio((s) => s.openInspector);
  const closeSimilarityDialog = useStudio((s) => s.closeSimilarityDialog);
  const replaceIconEverywhere = useStudio((s) => s.replaceIconEverywhere);
  const consolidateSimilarGroups = useStudio((s) => s.consolidateSimilarGroups);
  const [armed, setArmed] = useState<{ id: string; kind: "remove" | "replace" } | null>(null);
  /* round 15 — per-group quick consolidation state */
  const [quickArmed, setQuickArmed] = useState(false);

  const nearIdentical = group.best >= NEAR_IDENTICAL_THRESHOLD;
  const exactPair = group.pairs.find((p) => {
    const ea = icons[p.a];
    const eb = icons[p.b];
    return ea && eb && hashSvgContent(ea.svg) === hashSvgContent(eb.svg);
  });

  /* round 15 — the quick button's keeper: the SAME most-placements rule
   * the bulk sweep uses (pickKeeper), announced up front so the armed
   * confirm states exactly what will be kept */
  const quickKeeper = pickKeeper(group, sheets);
  const quickKeeperName =
    icons[quickKeeper]?.title ?? icons[quickKeeper]?.fileName ?? "the most-used copy";
  const quickOthers = group.ids.length - 1;

  /* dedupe consolidation: make `keeperId` the single copy — every other
   * member's sheet placements are replaced with it (the history label
   * coalesces within 900ms, so the whole consolidation is ONE undo). */
  function confirmReplace(keeperId: string): void {
    let replaced = 0;
    let merged = 0;
    const touched = new Set<string>();
    for (const other of group.ids) {
      if (other === keeperId) continue;
      const res = replaceIconEverywhere(other, keeperId);
      replaced += res.replaced;
      merged += res.merged;
      for (const sid of res.sheetsTouched) touched.add(sid);
    }
    setArmed(null);
    const keeperName = icons[keeperId]?.fileName ?? "this icon";
    const others = group.ids.length - 1;
    if (replaced + merged === 0) {
      toast.info(
        `Nothing to replace — the other ${others === 1 ? "copy is" : `${others} copies are`} not on any sheet`,
      );
      return;
    }
    const parts: string[] = [];
    if (replaced > 0) parts.push(`${replaced} placement${replaced === 1 ? "" : "s"} replaced`);
    if (merged > 0) parts.push(`${merged} duplicate cell${merged === 1 ? "" : "s"} merged away`);
    const sheetsNote = touched.size > 0 ? ` across ${touched.size} sheet${touched.size === 1 ? "" : "s"}` : "";
    toast.success(`${keeperName} is now the single copy — ${parts.join(" · ")}${sheetsNote}`, {
      description: `${others} other cop${others === 1 ? "y" : "ies"} now unassigned · Ctrl Z to undo`,
    });
  }

  /* round 15 — quick consolidation of THIS group only: the bulk store
   * action with a one-group plan (identical merge/replace/keeper
   * semantics, ONE undo step). The scan recomputes from the new library,
   * so the group simply disappears from the list. */
  function confirmQuickConsolidate(): void {
    const res = consolidateSimilarGroups([
      { keeperId: quickKeeper, otherIds: group.ids.filter((id) => id !== quickKeeper) },
    ]);
    setQuickArmed(false);
    if (res.iconsDeleted === 0) {
      toast.info("Nothing to consolidate — this group has no extra copies to remove");
      return;
    }
    const parts: string[] = [];
    if (res.placementsReplaced > 0) {
      parts.push(
        `${res.placementsReplaced} placement${res.placementsReplaced === 1 ? "" : "s"} now render${res.placementsReplaced === 1 ? "s" : ""} the kept copy`
      );
    }
    if (res.duplicatesMerged > 0) {
      parts.push(`${res.duplicatesMerged} duplicate cell${res.duplicatesMerged === 1 ? "" : "s"} merged away`);
    }
    toast.success(
      `Group ${index + 1} consolidated — kept ${quickKeeperName}, deleted ${res.iconsDeleted} extra cop${res.iconsDeleted === 1 ? "y" : "ies"}`,
      { description: [...parts, "Ctrl Z to undo"].join(" · ") }
    );
  }

  return (
    <div
      className="sim-group rounded-lg border border-border/70 bg-card/40 p-3 dark:border-border"
      role="group"
      aria-label={`Similar icon group ${index + 1}`}
    >
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <p className="text-[12px] font-semibold leading-tight">
          Group {index + 1}
          <span className="ml-1.5 font-normal text-muted-foreground">
            {group.ids.length} icons
          </span>
        </p>
        <span
          className={cn(
            "studio-chip px-2 py-px font-mono text-[10px] tabular-nums",
            nearIdentical ? "studio-chip--warn" : "studio-chip--neutral",
          )}
          title={`Geometry match — matches at or above ${Math.round(SIMILARITY_THRESHOLD * 100)}% are reported`}
        >
          {Math.round(group.best * 100)}% best match
        </span>
        {group.pairs.some((p) => p.transform) ? (
          <span
            className="studio-chip studio-chip--neutral gap-1 px-2 py-px text-[10px]"
            title="At least one pair in this group only matches after a rotation or mirror — check the pair labels below before consolidating"
          >
            <Repeat className="h-2.5 w-2.5" aria-hidden="true" />
            incl. rotated / mirrored
          </span>
        ) : null}
        {exactPair ? (
          <span className="studio-chip studio-chip--warn px-2 py-px text-[10px]" title="Byte-identical SVG sources">
            <Copy className="mr-1 h-2.5 w-2.5" aria-hidden="true" />
            exact copy
          </span>
        ) : null}
        {/* round 15 — per-group quick consolidation (armed inline, the
            bulk sweep's mini sibling: same keeper rule, one undo step) */}
        {quickArmed ? (
          <span className="sim-quick-armed ml-auto flex min-w-0 items-center gap-1">
            <span
              className="min-w-0 truncate text-[10.5px] font-medium leading-tight text-amber-700 dark:text-amber-300"
              title={`The most-used copy — ${quickOthers} other${quickOthers === 1 ? "" : "s"} deleted from the library, one undo step`}
            >
              Keep {quickKeeperName}?
            </span>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-6 shrink-0 px-2 text-[10.5px]"
              onClick={() => setQuickArmed(false)}
              aria-label={`Cancel consolidating group ${index + 1}`}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              className="sim-quick-confirm h-6 shrink-0 gap-1 bg-emerald-700 px-2.5 text-[10.5px] hover:bg-emerald-800"
              onClick={confirmQuickConsolidate}
              aria-label={`Consolidate group ${index + 1} — keep ${quickKeeperName}, delete ${quickOthers} other${quickOthers === 1 ? "" : "s"}`}
            >
              <Check className="h-3 w-3" aria-hidden="true" />
              Consolidate
            </Button>
          </span>
        ) : (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="sim-quick-btn ml-auto h-6 gap-1 px-2 text-[10.5px] text-muted-foreground hover:bg-emerald-500/10 hover:text-emerald-700 dark:hover:text-emerald-400"
            onClick={() => setQuickArmed(true)}
            title={`Keep ${quickKeeperName} (the most-used copy) — the other ${quickOthers} get${quickOthers === 1 ? "s" : ""} deleted from the library (one undo step)`}
            aria-label={`Consolidate group ${index + 1} — keep the most-used copy, delete ${quickOthers} other${quickOthers === 1 ? "" : "s"}`}
          >
            <Combine className="h-3 w-3" aria-hidden="true" />
            Consolidate
          </Button>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        {group.ids.map((id) => (
          <MemberTile
            key={id}
            iconId={id}
            otherCount={group.ids.length - 1}
            armed={armed?.id === id ? armed.kind : null}
            onArm={(kind) => setArmed(kind ? { id, kind } : null)}
            onInspect={() => {
              closeSimilarityDialog();
              openInspector(id);
            }}
            onConfirmReplace={() => confirmReplace(id)}
          />
        ))}
      </div>
      {group.pairs.length > 1 ? (
        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 border-t border-border/60 pt-2 dark:border-border/80">
          {group.pairs.map((p) => (
            <span
              key={`${p.a}:${p.b}`}
              className="truncate text-[10px] text-muted-foreground"
              title={`${icons[p.a]?.fileName} ↔ ${icons[p.b]?.fileName} — ${Math.round(p.score * 100)}% geometry match${p.transform ? ` (${p.transform} source)` : ""}`}
            >
              {icons[p.a]?.fileName} ↔ {icons[p.b]?.fileName}
              {p.transform ? (
                <span
                  className="ml-1 font-mono tabular-nums text-amber-600 dark:text-amber-400"
                  title={`These sources only match after: ${p.transform}`}
                >
                  ↻ {p.transform}
                </span>
              ) : (
                <span className={cn("ml-1 font-mono tabular-nums", p.score >= NEAR_IDENTICAL_THRESHOLD ? "text-amber-600 dark:text-amber-400" : "")}>
                  {Math.round(p.score * 100)}%
                </span>
              )}
            </span>
          ))}
        </div>
      ) : group.pairs.length === 1 && group.pairs[0].transform ? (
        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 border-t border-border/60 pt-2 dark:border-border/80">
          <span
            className="truncate text-[10px] text-muted-foreground"
            title={`${icons[group.pairs[0].a]?.fileName} ↔ ${icons[group.pairs[0].b]?.fileName} — ${Math.round(group.pairs[0].score * 100)}% geometry match (${group.pairs[0].transform} source)`}
          >
            {icons[group.pairs[0].a]?.fileName} ↔ {icons[group.pairs[0].b]?.fileName}
            <span
              className="ml-1 font-mono tabular-nums text-amber-600 dark:text-amber-400"
              title={`These sources only match after: ${group.pairs[0].transform}`}
            >
              ↻ {group.pairs[0].transform}
            </span>
          </span>
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Bulk consolidation helpers                                          */
/* ------------------------------------------------------------------ */

/** The keeper for a bulk consolidation: the member with the MOST sheet
 * placements (the rendered artwork stays pixel-identical wherever it
 * already appears); ties fall through to group order (= library order). */
function pickKeeper(group: SimilarityGroup, sheets: Sheet[]): string {
  const members = new Set(group.ids);
  const counts = new Map<string, number>();
  for (const sh of sheets) {
    for (const id of sh.iconIds) {
      if (members.has(id)) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  let keeper = group.ids[0];
  let best = -1;
  for (const id of group.ids) {
    const n = counts.get(id) ?? 0;
    if (n > best) {
      best = n;
      keeper = id;
    }
  }
  return keeper;
}

/* ------------------------------------------------------------------ */
/* Dialog                                                              */
/* ------------------------------------------------------------------ */

export function SimilarityDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): JSX.Element {
  const icons = useStudio((s) => s.icons);
  const iconOrder = useStudio((s) => s.iconOrder);
  const sheets = useStudio((s) => s.sheets);
  const consolidateSimilarGroups = useStudio((s) => s.consolidateSimilarGroups);
  const [nearOnly, setNearOnly] = useState(false);
  const [armedAll, setArmedAll] = useState(false);
  /* round 14: orientation-insensitive matching is OPT-IN — a rotated or
   *  mirrored copy is only a duplicate when the user says their set treats
   *  it so (arrow-up vs arrow-right are exact 90° rotations, different
   *  glyphs). Kept in component state: each dialog open starts honest. */
  const [dihedral, setDihedral] = useState(false);

  /* scan runs ONLY while the dialog is open (mirrors the stroke report) */
  const groups = useMemo(
    () => (open ? findSimilarIcons(icons, iconOrder, { dihedral }) : []),
    [open, icons, iconOrder, dihedral]
  );
  const nearGroups = useMemo(
    () => groups.filter((g) => g.best >= NEAR_IDENTICAL_THRESHOLD),
    [groups]
  );
  const shown = nearOnly ? nearGroups : groups;
  const iconsInGroups = useMemo(
    () => new Set(groups.flatMap((g) => g.ids)).size,
    [groups]
  );
  /* the extras a bulk consolidation would delete from the shown groups */
  const extrasInShown = useMemo(
    () => shown.reduce((n, g) => n + g.ids.length - 1, 0),
    [shown]
  );

  function confirmConsolidateAll(): void {
    const plan = shown.map((g) => {
      const keeperId = pickKeeper(g, sheets);
      return { keeperId, otherIds: g.ids.filter((id) => id !== keeperId) };
    });
    const res = consolidateSimilarGroups(plan);
    setArmedAll(false);
    if (res.iconsDeleted === 0) {
      toast.info("Nothing to consolidate — the groups have no extra copies to remove");
      return;
    }
    const parts: string[] = [];
    if (res.placementsReplaced > 0) {
      parts.push(
        `${res.placementsReplaced} placement${res.placementsReplaced === 1 ? "" : "s"} now render${res.placementsReplaced === 1 ? "s" : ""} the kept cop${res.placementsReplaced === 1 ? "y" : "ies"}`
      );
    }
    if (res.duplicatesMerged > 0) {
      parts.push(`${res.duplicatesMerged} duplicate cell${res.duplicatesMerged === 1 ? "" : "s"} merged away`);
    }
    const sheetsNote =
      res.sheetsTouched > 0 ? ` across ${res.sheetsTouched} sheet${res.sheetsTouched === 1 ? "" : "s"}` : "";
    toast.success(
      `Consolidated ${res.groups} group${res.groups === 1 ? "" : "s"} — ${res.iconsDeleted} extra cop${res.iconsDeleted === 1 ? "y" : "ies"} deleted${sheetsNote}`,
      {
        description: [...parts, "Ctrl Z to undo"].join(" · "),
      }
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl p-0 gap-0 overflow-hidden">
        <DialogHeader className="px-5 pt-5 pb-0">
          <DialogTitle className="flex items-center gap-2 text-[15px] font-semibold tracking-tight">
            <span className="studio-dlg-tile">
              <ScanSearch className="h-4 w-4" aria-hidden="true" />
            </span>
            Similar icons
            <span
              className={cn(
                "studio-chip ml-auto px-2.5 py-0.5 text-[10.5px]",
                groups.length === 0 ? "studio-chip--ok" : "studio-chip--warn",
              )}
            >
              <span
                className={cn(
                  "h-1.5 w-1.5 rounded-full",
                  groups.length === 0 ? "bg-emerald-500" : "bg-amber-500",
                )}
                aria-hidden="true"
              />
              {groups.length === 0
                ? "All distinct"
                : `${groups.length} group${groups.length === 1 ? "" : "s"}`}
            </span>
          </DialogTitle>
          <DialogDescription className="text-[12px]">
            Icons whose source geometry matches — renamed copies and near-identical artwork, side by side.
          </DialogDescription>
        </DialogHeader>

        {/* filter chips — the near-identical chip only appears when it
            would actually narrow the list; the dihedral toggle also shows
            while active so it can always be switched back off */}
        {groups.length > 0 || dihedral ? (
          <div className="flex flex-wrap items-center gap-2 px-5 pt-3" role="group" aria-label="Match filter">
            <button
              type="button"
              className={cn(
                "studio-chip sim-filter px-2.5 py-0.5 text-[10.5px] transition-colors duration-150",
                !nearOnly ? "studio-chip--warn" : "studio-chip--neutral hover:border-amber-500/50",
              )}
              aria-pressed={!nearOnly}
              onClick={() => setNearOnly(false)}
            >
              All matches · {groups.length}
            </button>
            {nearGroups.length > 0 && nearGroups.length < groups.length ? (
              <button
                type="button"
                className={cn(
                  "studio-chip sim-filter px-2.5 py-0.5 text-[10.5px] transition-colors duration-150",
                  nearOnly ? "studio-chip--warn" : "studio-chip--neutral hover:border-amber-500/50",
                )}
                aria-pressed={nearOnly}
                onClick={() => setNearOnly(true)}
              >
                Near-identical ≥ {Math.round(NEAR_IDENTICAL_THRESHOLD * 100)}% · {nearGroups.length}
              </button>
            ) : null}
            <button
              type="button"
              className={cn(
                "studio-chip sim-filter gap-1 px-2.5 py-0.5 text-[10.5px] transition-colors duration-150",
                dihedral ? "studio-chip--warn" : "studio-chip--neutral hover:border-amber-500/50",
              )}
              aria-pressed={dihedral}
              onClick={() => setDihedral((v) => !v)}
              title="Also match copies someone rotated (90°/180°/270°) or mirrored — off by default because a rotated pair can also be two DIFFERENT glyphs (arrow-up vs arrow-right). Matched pairs carry the orientation label."
            >
              <Repeat className="h-2.5 w-2.5" aria-hidden="true" />
              Rotated / mirrored
            </button>
            {groups.length > 0 ? (
              <span className="ml-auto text-[10px] text-muted-foreground">
                {iconsInGroups} icon{iconsInGroups === 1 ? "" : "s"} involved
              </span>
            ) : null}
          </div>
        ) : null}

        {/* bulk consolidation — one armed action for every shown group */}
        {shown.length > 0 ? (
          <div
            className={cn(
              "mx-4 mt-2.5 flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2",
              armedAll
                ? "border-amber-600/45 bg-amber-500/10 dark:border-amber-400/40 dark:bg-amber-400/10"
                : "border-transparent px-0 py-0"
            )}
            role="group"
            aria-label="Bulk consolidation"
          >
            {armedAll ? (
              <>
                <p className="min-w-[180px] flex-1 text-[11px] leading-snug text-amber-800 dark:text-amber-300">
                  Keep the most-used copy of each of the {shown.length} shown group
                  {shown.length === 1 ? "" : "s"}? {extrasInShown} other
                  {extrasInShown === 1 ? "" : "s"} will be deleted from the library — one undo step.
                </p>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2.5 text-[11px]"
                  onClick={() => setArmedAll(false)}
                  aria-label="Cancel bulk consolidation"
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  size="sm"
                  className="h-7 gap-1.5 bg-emerald-700 px-3 text-[11px] hover:bg-emerald-800"
                  onClick={confirmConsolidateAll}
                  aria-label={`Consolidate ${shown.length} group${shown.length === 1 ? "" : "s"} — keep the most-used copy of each`}
                >
                  <Check className="h-3.5 w-3.5" aria-hidden="true" />
                  Consolidate {shown.length} group{shown.length === 1 ? "" : "s"}
                </Button>
              </>
            ) : (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="ml-auto h-7 gap-1.5 px-2.5 text-[11px] text-muted-foreground hover:bg-emerald-500/10 hover:text-emerald-700 dark:hover:text-emerald-400"
                onClick={() => setArmedAll(true)}
                title={`Keep the most-used copy of every shown group — the other ${extrasInShown} icon${extrasInShown === 1 ? "" : "s"} get${extrasInShown === 1 ? "s" : ""} deleted from the library (one undo step)`}
                aria-label={`Consolidate all ${shown.length} group${shown.length === 1 ? "" : "s"} — keep the most-used copy of each`}
              >
                <Combine className="h-3.5 w-3.5" aria-hidden="true" />
                Consolidate all
              </Button>
            )}
          </div>
        ) : null}

        {/* groups */}
        <div
          className="custom-scroll max-h-[52vh] space-y-2.5 overflow-y-auto px-4 py-3"
          role="list"
          aria-label="Similar icon groups"
        >
          {iconOrder.length === 0 ? (
            <div className="flex flex-col items-center gap-2.5 py-8 text-center">
              <div className="studio-empty-glyph grid h-11 w-11 place-items-center">
                <Layers className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
              </div>
              <p className="text-[13px] font-semibold">Nothing to scan yet</p>
              <p className="max-w-[340px] text-[11px] leading-relaxed text-muted-foreground">
                Upload icons to the library first — the scan compares every glyph against every other.
              </p>
            </div>
          ) : shown.length === 0 ? (
            <div className="flex flex-col items-center gap-2.5 py-8 text-center">
              <div className="studio-empty-glyph grid h-11 w-11 place-items-center">
                <ScanSearch className="h-5 w-5 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
              </div>
              <p className="text-[13px] font-semibold">No visually similar icons</p>
              <p className="max-w-[340px] text-[11px] leading-relaxed text-muted-foreground">
                {nearOnly
                  ? `No matches at or above ${Math.round(NEAR_IDENTICAL_THRESHOLD * 100)}% — switch to all matches to see looser pairs.`
                  : "Every glyph in the library is geometrically distinct — nothing looks like a copy."}
              </p>
            </div>
          ) : (
            shown.map((g, i) => <GroupCard key={g.ids.join("|")} group={g} index={i} />)
          )}
        </div>

        <DialogFooter className="studio-dlg-footer px-5 py-2.5 sm:justify-between">
          <span className="text-[10.5px] hint-text">
            Pure geometry scan of the immutable source SVGs · matches ≥ {Math.round(SIMILARITY_THRESHOLD * 100)}%
          </span>
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-[11.5px]"
            onClick={() => onOpenChange(false)}
          >
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
