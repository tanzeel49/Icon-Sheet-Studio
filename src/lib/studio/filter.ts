/**
 * ICON SHEET STUDIO — Shared library filter semantics.
 *
 * The exact same "what does the current library filter match?" question was
 * previously answered independently in THREE components (icon-library grid,
 * catalog-dialog scope, icon-inspector context) — three copies of the same
 * predicate that could drift apart. Multi-tag filtering (AND/OR) made that
 * drift unacceptable, so the semantics now live here and every consumer
 * calls the same functions.
 *
 * Semantics (identical to the historic single-tag behavior when one tag is
 * selected, regardless of the logic mode):
 *  · query      — case-insensitive substring against fileName OR title OR
 *                 description OR any tag (round 15: metadata joined the
 *                 match set — icons are findable by what they MEAN, not
 *                 just by what the file was named)
 *  · tags       — selected tag set, combined by tagLogic ("and" = every tag,
 *                 "or" = any tag). Empty set = no tag constraint.
 *  · mode       — "unassigned" keeps only icons on no sheet
 *  · sort is applied by the library panel AFTER matching (view-only).
 */

import type { IconEntry, LibraryTagLogic, Sheet } from "./types";
import { getUnassignedIconIds } from "./store";

/** The filter state shape consumed by this module — matches the store's
 *  libraryFilter minus the sort mode (which is ordering, not matching). */
export interface LibraryFilterQuery {
  query: string;
  tags: string[];
  tagLogic: LibraryTagLogic;
  mode: "all" | "unassigned";
}

/** True when nothing is constrained — the filter is a pass-through. */
export function libraryFilterIsEmpty(f: LibraryFilterQuery): boolean {
  return f.query.trim() === "" && f.tags.length === 0 && f.mode === "all";
}

/** Does one icon match the tag constraint? (Both modes agree when a single
 *  tag is selected; "and" with zero tags is vacuously true.) */
export function iconMatchesTags(entry: IconEntry, tags: string[], logic: LibraryTagLogic): boolean {
  if (tags.length === 0) return true;
  const own = entry.tags ?? [];
  if (logic === "and") {
    const ownSet = new Set(own);
    return tags.every((t) => ownSet.has(t));
  }
  return tags.some((t) => own.includes(t));
}

/** Full predicate: query + tags(logic) + assignment mode. */
export function iconMatchesLibraryFilter(
  entry: IconEntry,
  id: string,
  filter: LibraryFilterQuery,
  unassignedSet: Set<string>,
): boolean {
  if (filter.mode === "unassigned" && !unassignedSet.has(id)) return false;
  if (!iconMatchesTags(entry, filter.tags, filter.tagLogic)) return false;
  const q = filter.query.trim().toLowerCase();
  if (q) {
    const inName = entry.fileName.toLowerCase().includes(q);
    const inTitle = entry.title?.toLowerCase().includes(q) ?? false;
    const inDescription = entry.description?.toLowerCase().includes(q) ?? false;
    const inTags = entry.tags?.some((t) => t.toLowerCase().includes(q)) ?? false;
    if (!inName && !inTitle && !inDescription && !inTags) return false;
  }
  return true;
}

/** Human label for the tag part of a filter — "#a + #b" (AND) or "#a / #b"
 *  (OR). Used by the catalog scope line and screen-reader descriptions. */
export function describeTagFilter(tags: string[], logic: LibraryTagLogic): string {
  if (tags.length === 0) return "";
  const joiner = logic === "and" ? " + " : " / ";
  return tags.map((t) => `#${t}`).join(joiner);
}

export interface LibraryFilterScopeInput {
  icons: Record<string, IconEntry>;
  iconOrder: string[];
  sheets: Sheet[];
  filter: LibraryFilterQuery;
}

/** Resolve the filter to the ordered list of matching icon ids plus a
 *  human-readable summary line ("Current filter: … (n of total)"). Returns
 *  null when the filter is empty — the whole library order applies. */
export function buildLibraryFilterScope(input: LibraryFilterScopeInput): {
  ids: string[];
  label: string;
} | null {
  const { icons, iconOrder, sheets, filter } = input;
  if (libraryFilterIsEmpty(filter)) return null;
  const unassigned = new Set(getUnassignedIconIds({ sheets, iconOrder }));
  const ids: string[] = [];
  for (const id of iconOrder) {
    const entry = icons[id];
    if (!entry) continue;
    if (iconMatchesLibraryFilter(entry, id, filter, unassigned)) ids.push(id);
  }
  const parts: string[] = [];
  const q = filter.query.trim();
  if (q) parts.push(`“${q}”`);
  const tagLabel = describeTagFilter(filter.tags, filter.tagLogic);
  if (tagLabel) parts.push(tagLabel);
  if (filter.mode === "unassigned") parts.push("unassigned");
  return {
    ids,
    label: `Current filter: ${parts.join(" · ")} (${ids.length} of ${iconOrder.length})`,
  };
}
