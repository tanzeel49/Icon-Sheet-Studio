/**
 * ICON SHEET STUDIO — Library catalog export (round 6).
 *
 * Builds a complete metadata catalog of the workspace — icons, tags, sheet
 * assignments, technical SVG facts — and renders it as JSON or CSV.
 *
 * Local-first principle: everything happens in the browser; the catalog
 * only leaves the machine through an explicit user-triggered download.
 * Icon SVG SOURCES are never included (metadata only) so catalogs stay
 * lightweight even for 5000-icon libraries.
 */

import { hashSvgContent, parseIcon } from "./svg";
import { sheetTemplate } from "./templates";
import { sheetTitle } from "./types";
import type { IconEntry, Sheet } from "./types";

export type CatalogFormat = "json" | "csv";

/* ------------------------------------------------------------------ */
/* Catalog model                                                       */
/* ------------------------------------------------------------------ */

export interface CatalogIcon {
  id: string;
  fileName: string;
  tags: string[];
  viewBox: string;
  width: number;
  height: number;
  /** "stroke" line art · "fill" solid · "auto" inherited/mixed */
  nature: "stroke" | "fill" | "auto";
  strokeWidth: number | null;
  /** source size in bytes */
  bytes: number;
  /** 10-char content hash (same identity the inspector shows) */
  contentHash: string;
  importedAt: string;
  assignment: {
    sheet: string;
    sheetIndex: number;
    cell: number;
    category: string;
    volume: number;
    isHero: boolean;
  } | null;
}

export interface CatalogSheet {
  id: string;
  index: number;
  label: string;
  category: string;
  volume: number;
  template: string;
  capacity: number;
  iconCount: number;
}

export interface LibraryCatalog {
  application: "Icon Sheet Studio";
  version: 1;
  exportedAt: string;
  /** present when the catalog covers a subset (filter/selection scope) */
  scope?: {
    label: string;
    totalIcons: number;
  };
  summary: {
    icons: number;
    sheets: number;
    assignedIcons: number;
    unassignedIcons: number;
    taggedIcons: number;
    tags: number;
    categories: number;
  };
  tags: { name: string; iconCount: number }[];
  sheets: CatalogSheet[];
  icons: CatalogIcon[];
}

/* ------------------------------------------------------------------ */
/* Builder                                                             */
/* ------------------------------------------------------------------ */

function deriveNatureAndWidth(svg: string): {
  nature: CatalogIcon["nature"];
  strokeWidth: number | null;
} {
  const parsed = parseIcon(svg);
  const root = parsed?.rootStyle ?? {};
  let nature: CatalogIcon["nature"] = "auto";
  if (root.stroke && (root.fill === "none" || !root.fill)) nature = "stroke";
  else if (root.fill && root.fill !== "none" && !root.stroke) nature = "fill";
  let sw: number | null = root["stroke-width"] ? Number(root["stroke-width"]) : null;
  if (sw === null || Number.isNaN(sw)) {
    const m = svg.match(/stroke-width\s*=\s*["']([\d.]+)/i);
    sw = m ? Number(m[1]) : null;
  }
  return { nature, strokeWidth: sw !== null && !Number.isNaN(sw) ? sw : null };
}

/** Optional export scope: a subset of the library (current filter or an
 *  explicit selection). Icons stay in library order; sheets and tags that
 *  the subset doesn't reference are omitted from those sections. */
export interface CatalogScope {
  label: string;
  iconIds: string[];
}

export function buildLibraryCatalog(
  state: {
    icons: Record<string, IconEntry>;
    iconOrder: string[];
    sheets: Sheet[];
  },
  scope?: CatalogScope,
): LibraryCatalog {
  const { icons, sheets } = state;
  const ordered = scope
    ? scope.iconIds.filter((id) => icons[id])
    : state.iconOrder;
  const inScope = new Set(ordered);

  /* assignment index: iconId → { sheet, position, isHero } */
  const assignment = new Map<
    string,
    { sheet: Sheet; sheetIndex: number; cell: number; isHero: boolean }
  >();
  const referencedSheets: Sheet[] = scope
    ? sheets.filter((s) => s.iconIds.some((id) => inScope.has(id)))
    : sheets;
  referencedSheets.forEach((sheet, sheetIndex) => {
    sheet.iconIds.forEach((iconId, cellIdx) => {
      assignment.set(iconId, {
        sheet,
        sheetIndex,
        cell: cellIdx + 1,
        isHero: sheet.heroIconId === iconId,
      });
    });
  });

  /* tag counts (frequency order, like the tag manager) */
  const tagCounts = new Map<string, number>();
  for (const id of ordered) {
    for (const tag of icons[id]?.tags ?? []) {
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    }
  }

  const catalogIcons: CatalogIcon[] = ordered.map((id) => {
    const entry = icons[id];
    const parsed = parseIcon(entry.svg);
    const [vx, vy, vw, vh] = parsed?.viewBox ?? [0, 0, 24, 24];
    const { nature, strokeWidth } = deriveNatureAndWidth(entry.svg);
    const assigned = assignment.get(id) ?? null;
    return {
      id,
      fileName: entry.fileName,
      tags: [...(entry.tags ?? [])],
      viewBox: `${vx} ${vy} ${vw} ${vh}`,
      width: parsed?.width ?? vw,
      height: parsed?.height ?? vh,
      nature,
      strokeWidth,
      bytes: new Blob([entry.svg]).size,
      contentHash: hashSvgContent(entry.svg).slice(0, 10),
      importedAt: new Date(entry.createdAt).toISOString(),
      assignment:
        assigned !== null
          ? {
              sheet: sheetTitle(assigned.sheet, assigned.sheetIndex),
              sheetIndex: assigned.sheetIndex + 1,
              cell: assigned.cell,
              category: assigned.sheet.category,
              volume: assigned.sheet.volume,
              isHero: assigned.isHero,
            }
          : null,
    };
  });

  const assignedCount = catalogIcons.filter((i) => i.assignment !== null).length;
  const taggedCount = catalogIcons.filter((i) => i.tags.length > 0).length;

  return {
    application: "Icon Sheet Studio",
    version: 1,
    exportedAt: new Date().toISOString(),
    ...(scope ? { scope: { label: scope.label, totalIcons: ordered.length } } : {}),
    summary: {
      icons: ordered.length,
      sheets: referencedSheets.length,
      assignedIcons: assignedCount,
      unassignedIcons: ordered.length - assignedCount,
      taggedIcons: taggedCount,
      tags: tagCounts.size,
      categories: new Set(referencedSheets.map((s) => s.category)).size,
    },
    tags: [...tagCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([name, iconCount]) => ({ name, iconCount })),
    sheets: referencedSheets.map((sheet, index) => ({
      id: sheet.id,
      index: index + 1,
      label: sheetTitle(sheet, index),
      category: sheet.category,
      volume: sheet.volume,
      template: sheetTemplate(sheet)?.name ?? sheet.templateId,
      capacity: sheetTemplate(sheet)?.capacity ?? sheet.iconIds.length,
      /* in scoped exports the count reflects the subset, not the sheet */
      iconCount: scope
        ? sheet.iconIds.filter((id) => inScope.has(id)).length
        : sheet.iconIds.length,
    })),
    icons: catalogIcons,
  };
}

/* ------------------------------------------------------------------ */
/* Renderers                                                           */
/* ------------------------------------------------------------------ */

export function catalogToJson(catalog: LibraryCatalog): string {
  return JSON.stringify(catalog, null, 2);
}

const CSV_HEADER = [
  "id",
  "file",
  "tags",
  "viewBox",
  "width",
  "height",
  "nature",
  "strokeWidth",
  "bytes",
  "contentHash",
  "importedAt",
  "sheet",
  "cell",
  "category",
  "volume",
  "isHero",
] as const;

/** RFC 4180 quoting: wrap in quotes when needed, double embedded quotes. */
function csvCell(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

export function catalogToCsv(catalog: LibraryCatalog): string {
  const lines: string[] = [CSV_HEADER.join(",")];
  for (const icon of catalog.icons) {
    const a = icon.assignment;
    lines.push(
      [
        icon.id,
        icon.fileName,
        icon.tags.join("|"),
        icon.viewBox,
        String(icon.width),
        String(icon.height),
        icon.nature,
        icon.strokeWidth !== null ? String(icon.strokeWidth) : "",
        String(icon.bytes),
        icon.contentHash,
        icon.importedAt,
        a ? a.sheet : "",
        a ? String(a.cell) : "",
        a ? a.category : "",
        a ? String(a.volume) : "",
        a && a.isHero ? "true" : "false",
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/* Download                                                            */
/* ------------------------------------------------------------------ */

export function buildCatalogFilename(format: CatalogFormat, scopeTag?: string): string {
  const date = new Date();
  const stamp = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(
    date.getDate(),
  ).padStart(2, "0")}`;
  const scopePart = scopeTag ? `_${scopeTag}` : "";
  return `icon-library${scopePart}_${stamp}.${format}`;
}

/** "Current filter (12 of 64)" → "current-filter-12-of-64"-ish file-safe slug */
function slugifyScope(label: string): string {
  return (
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "scope"
  );
}

import { saveFileNative } from "./desktop";

export async function downloadCatalog(catalog: LibraryCatalog, format: CatalogFormat): Promise<import("./desktop").SaveResult & { filename: string }> {
  const mime = format === "json" ? "application/json" : "text/csv";
  const blob = new Blob([format === "json" ? catalogToJson(catalog) : catalogToCsv(catalog)], {
    type: `${mime};charset=utf-8`,
  });
  const filename = buildCatalogFilename(
    format,
    catalog.scope?.label ? slugifyScope(catalog.scope.label) : undefined,
  );
  const res = await saveFileNative(blob, filename);
  return { ...res, filename };
}
