"use client";

/**
 * ICON SHEET STUDIO — Library health analysis (round 9).
 *
 * Pure computation over the live workspace state — shared by the command
 * palette (live issue-count hint on the "Library health report" command)
 * and the health report dialog (rows + actions), so the two surfaces can
 * never disagree about what "healthy" means.
 *
 * Checks, in report order (warnings first):
 *   untagged   — icons carrying no tags (warning: tag-based auto-filing
 *                and the "related icons" strip can't help them)
 *   empty      — sheets with zero icons (warning: dead artwork)
 *   dupes      — file names imported more than once (warning: likely the
 *                same glyph twice — exports will look wrong)
 *   unassigned — icons on no sheet at all (info: ready to file)
 *   singletons — tags used by exactly one icon (info: merge candidates)
 *   lowfill    — sheets under half capacity (info: unfinished layout)
 *   skipped    — cells hidden from preview & export via cellOverrides
 *                (info: usually intentional — but exports show empty
 *                holes, so the report surfaces the count per sheet)
 *
 * Actions are SEMANTIC (kind + payload) — the dialog decides what they do,
 * keeping this file free of store imports (usable from any surface).
 */

import type { IconEntry, Sheet } from "./types";
import { sheetTemplate } from "./templates";
import type { SimilarityGroup } from "./similarity";

export type HealthSeverity = "warning" | "info";

export type HealthActionKind =
  | "inspect-first" // open the inspector on one icon id
  | "library-unassigned" // filter the library to unassigned icons
  | "open-sheet" // jump to a sheet in edit mode
  | "tag-manager" // open the tag manager dialog
  | "similar-icons"; // open the similarity report dialog

export interface HealthAction {
  kind: HealthActionKind;
  payload?: string; // icon id / sheet id — kind-specific
}

export interface HealthIssue {
  id: string;
  severity: HealthSeverity;
  title: string;
  detail: string;
  /** how many items the issue covers (drives the count badge) */
  count: number;
  action: HealthAction;
}

export interface HealthSummary {
  iconCount: number;
  tagCount: number;
  sheetCount: number;
  /** 0..1 — filled cells across all sheets (0 when there are none) */
  fillRatio: number;
  /** total skipped cells across all sheets (round 12) — mirrors the
   *  per-sheet issues; 0 when nothing is skipped */
  skippedCells: number;
  /** icons with their own stroke exception — per-cell uniform targets
   *  (round 9) OR relative weights (round 12) — surfaced as a conditional
   *  stat; 0 when none exist */
  strokeExceptions: number;
}

export interface HealthReport {
  issues: HealthIssue[];
  summary: HealthSummary;
  issueCount: number;
}

export interface HealthInput {
  icons: Record<string, IconEntry>;
  iconOrder: string[];
  sheets: Sheet[];
  /** visually similar icon groups (round 10) — computed by the CALLER
   *  (similarity.ts needs DOMParser; health.ts stays pure) and passed in
   *  so the issue only appears when the scan actually ran. */
  similarity?: SimilarityGroup[];
}

/** Low-fill threshold — a sheet under 50% of its capacity. */
const LOW_FILL = 0.5;

export function computeHealthReport({ icons, iconOrder, sheets, similarity }: HealthInput): HealthReport {
  /* ---- summary ---- */
  const tagSet = new Set<string>();
  for (const id of iconOrder) for (const t of icons[id]?.tags ?? []) tagSet.add(t);
  let totalCells = 0;
  let filledCells = 0;
  let strokeExceptions = 0;
  for (const sh of sheets) {
    totalCells += sheetTemplate(sh)?.capacity ?? sh.iconIds.length;
    filledCells += sh.iconIds.length;
    for (const id of sh.iconIds) {
      const ov = sh.cellOverrides?.[id];
      /* round 9 target + round 12 weight exceptions — either counts */
      if (ov?.strokeTargetPx != null || ov?.strokeWeightPx != null) strokeExceptions++;
    }
  }
  const summary: HealthSummary = {
    iconCount: iconOrder.length,
    tagCount: tagSet.size,
    sheetCount: sheets.length,
    fillRatio: totalCells > 0 ? filledCells / totalCells : 0,
    skippedCells: 0,
    strokeExceptions,
  };

  const issues: HealthIssue[] = [];

  /* ---- untagged icons ---- */
  const untaggedIds = iconOrder.filter((id) => (icons[id]?.tags ?? []).length === 0);
  if (untaggedIds.length > 0) {
    issues.push({
      id: "untagged",
      severity: "warning",
      title: "Untagged icons",
      detail:
        untaggedIds.length === 1
          ? `${icons[untaggedIds[0]]?.fileName ?? "One icon"} carries no tags — tag-based filing and related icons can't find it.`
          : `${untaggedIds.length} icons carry no tags — tag-based filing and related icons can't find them.`,
      count: untaggedIds.length,
      action: { kind: "inspect-first", payload: untaggedIds[0] },
    });
  }

  /* ---- empty sheets ---- */
  const emptySheets = sheets.filter((sh) => sh.iconIds.length === 0);
  for (const sh of emptySheets) {
    const idx = sheets.findIndex((s) => s.id === sh.id);
    issues.push({
      id: `empty-sheet:${sh.id}`,
      severity: "warning",
      title: `Sheet ${String(idx + 1).padStart(2, "0")} is empty`,
      detail: `A ${sheetTemplate(sh)?.name ?? "custom"} sheet with no icons — duplicate or delete it to keep the overview honest.`,
      count: 0,
      action: { kind: "open-sheet", payload: sh.id },
    });
  }

  /* ---- duplicate file names ---- */
  const byName = new Map<string, string[]>();
  for (const id of iconOrder) {
    const name = icons[id]?.fileName;
    if (!name) continue;
    const key = name.toLowerCase();
    const list = byName.get(key) ?? [];
    list.push(id);
    byName.set(key, list);
  }
  const dupes = [...byName.entries()].filter(([, ids]) => ids.length > 1);
  if (dupes.length > 0) {
    const dupeCount = dupes.reduce((sum, [, ids]) => sum + ids.length, 0);
    issues.push({
      id: "duplicate-names",
      severity: "warning",
      title: "Duplicate file names",
      detail:
        dupes.length === 1
          ? `“${icons[dupes[0][1][0]]?.fileName}” was imported ${dupes[0][1].length} times — sheets may render the same glyph twice.`
          : `${dupes.length} file names imported more than once (${dupeCount} icons total) — sheets may render the same glyphs twice.`,
      count: dupeCount,
      action: { kind: "inspect-first", payload: dupes[0][1][1] },
    });
  }

  /* ---- visually similar icons (round 10) ----
   * Groups come from the caller (similarity.ts — rasterized geometry
   * signatures, DOM-dependent) so this file stays pure. Warning: the
   * glyphs READ as the same icon on a sheet even though the names (and
   * health's duplicate-name check) say they are different icons. */
  if (similarity && similarity.length > 0) {
    const iconsInGroups = new Set(similarity.flatMap((g) => g.ids)).size;
    const best = Math.max(...similarity.map((g) => g.best));
    const pct = Math.round(best * 100);
    issues.push({
      id: "similar-icons",
      severity: "warning",
      title: "Visually similar icons",
      detail:
        similarity.length === 1
          ? `${iconsInGroups} icons with different names share ${pct}% of their geometry — a sheet may render what reads as one glyph twice.`
          : `${iconsInGroups} icons across ${similarity.length} groups share up to ${pct}% of their geometry — sheets may render what reads as the same glyphs twice.`,
      count: iconsInGroups,
      action: { kind: "similar-icons" },
    });
  }

  /* ---- unassigned icons ---- */
  const assigned = new Set<string>();
  for (const sh of sheets) for (const id of sh.iconIds) assigned.add(id);
  const unassignedIds = iconOrder.filter((id) => !assigned.has(id));
  if (unassignedIds.length > 0) {
    issues.push({
      id: "unassigned",
      severity: "info",
      title: "Unassigned icons",
      detail: `${unassignedIds.length} icon${unassignedIds.length === 1 ? "" : "s"} not yet on any sheet — generate a sheet to turn ${
        unassignedIds.length === 1 ? "it" : "them"
      } into artwork.`,
      count: unassignedIds.length,
      action: { kind: "library-unassigned" },
    });
  }

  /* ---- singleton tags ---- */
  const tagCounts = new Map<string, number>();
  for (const id of iconOrder) for (const t of icons[id]?.tags ?? []) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
  const singletons = [...tagCounts.entries()].filter(([, n]) => n === 1).map(([t]) => t);
  if (singletons.length > 0) {
    issues.push({
      id: "singleton-tags",
      severity: "info",
      title: "Singleton tags",
      detail: `${singletons.length} tag${singletons.length === 1 ? "" : "s"} used by a single icon (${singletons
        .slice(0, 3)
        .map((t) => `#${t}`)
        .join(" · ")}${singletons.length > 3 ? " …" : ""}) — likely merge or rename candidates.`,
      count: singletons.length,
      action: { kind: "tag-manager" },
    });
  }

  /* ---- low-fill sheets ---- */
  for (const sh of sheets) {
    if (sh.iconIds.length === 0) continue; // empty already reported
    const cap = sheetTemplate(sh)?.capacity ?? sh.iconIds.length;
    if (cap > 0 && sh.iconIds.length / cap < LOW_FILL) {
      const idx = sheets.findIndex((s) => s.id === sh.id);
      issues.push({
        id: `low-fill:${sh.id}`,
        severity: "info",
        title: `Sheet ${String(idx + 1).padStart(2, "0")} below half capacity`,
        detail: `${sh.iconIds.length} of ${cap} cells filled — add icons from the library or accept the airy layout.`,
        count: sh.iconIds.length,
        action: { kind: "open-sheet", payload: sh.id },
      });
    }
  }

  /* ---- skipped cells (round 12) ----
   * cellOverrides store per-ICON exceptions keyed by icon id, so the count
   * is derived from the sheet's CURRENT icon list (entries for icons that
   * left the sheet are pruned by the store, but staying list-driven keeps
   * this pure function honest on its own). Info severity: skipping is a
   * deliberate feature — the report just verifies the export will look the
   * way the user expects. */
  for (const sh of sheets) {
    const skipped = sh.iconIds.filter((id) => sh.cellOverrides?.[id]?.skip === true).length;
    if (skipped === 0) continue;
    summary.skippedCells += skipped;
    const idx = sheets.findIndex((s) => s.id === sh.id);
    issues.push({
      id: `skipped-cells:${sh.id}`,
      severity: "info",
      title: `Sheet ${String(idx + 1).padStart(2, "0")} has ${skipped} skipped cell${skipped === 1 ? "" : "s"}`,
      detail: `Skipped cells export as empty holes — unskip them in Edit view (select the cell, then Unskip) if that's unintended.`,
      count: skipped,
      action: { kind: "open-sheet", payload: sh.id },
    });
  }

  return { issues, summary, issueCount: issues.length };
}
