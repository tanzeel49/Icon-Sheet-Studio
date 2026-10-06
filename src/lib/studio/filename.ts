/**
 * ICON SHEET STUDIO — Export filename generation.
 * Pattern: {Category}_{Vol-NN}_{N}-Icons.{ext}
 * Category is sanitized for filesystem safety.
 */

import type { Sheet } from "./types";

export function sanitizeCategory(category: string): string {
  const cleaned = category
    .trim()
    // remove filesystem-invalid characters
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/&/g, "And")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return cleaned || "Icons";
}

export function buildExportFilename(sheet: Sheet, index: number, ext: "svg" | "png" | "pdf"): string {
  const cat = sanitizeCategory(sheet.category);
  const vol = String(sheet.volume > 0 ? sheet.volume : index + 1).padStart(2, "0");
  const count = sheet.iconIds.length;
  return `${cat}_Vol-${vol}_${count}-Icons.${ext}`;
}
