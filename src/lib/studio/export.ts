/**
 * ICON SHEET STUDIO — Export engine.
 * Exports always use the current authoritative sheet state via the SAME
 * renderer as preview (renderSheet). No stale caches.
 *
 * SVG  → clean, vector, Illustrator-friendly output of the renderer.
 * PNG  → rasterized via canvas (template background or transparent).
 * PDF  → one document, one page per sheet (raster pages at each sheet's
 *          native aspect ratio — shareable, print-ready).
 * Batch → zip archive with real per-sheet progress + error tally.
 */

import JSZip from "jszip";
import { jsPDF } from "jspdf";
import type { IconEntry, Sheet, TemplateDef } from "./types";
import { renderSheet } from "./renderer";
import { buildExportFilename } from "./filename";

export interface ExportTarget {
  sheet: Sheet;
  template: TemplateDef;
}

export interface ProgressReport {
  current: number;
  total: number;
  label: string;
}

export interface ExportResult {
  ok: boolean;
  succeeded: number;
  failed: number;
  errors: string[];
}

/* ------------------------------------------------------------------ */
/* Download helpers                                                    */
/* ------------------------------------------------------------------ */

export function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/* ------------------------------------------------------------------ */
/* SVG export                                                          */
/* ------------------------------------------------------------------ */

export function buildSheetSvg(sheet: Sheet, template: TemplateDef, icons: Record<string, IconEntry>): string {
  // export mode: no preview overlays, clean vector output
  return renderSheet(sheet, template, icons, { mode: "export" });
}

export function exportSheetSvg(
  sheet: Sheet,
  template: TemplateDef,
  icons: Record<string, IconEntry>,
  index: number
): void {
  const svg = buildSheetSvg(sheet, template, icons);
  const filename = buildExportFilename(sheet, index, "svg");
  triggerDownload(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }), filename);
}

/* ------------------------------------------------------------------ */
/* PNG export                                                          */
/* ------------------------------------------------------------------ */

/**
 * Transparent-PNG/SVG helper: the renderer emits the sheet background as
 * the first full-canvas rect inside the Background group. Removing that
 * single rect (first match only) leaves the artwork on a transparent canvas.
 * MINIMAL ADDITIVE EDIT (task 2-c): previously `transparent` was ignored.
 * Shared by export.ts paths AND the export panel's single-SVG quick path
 * (the duplicated local copy in the panel was removed in review round 7).
 * Canvas dimensions may be non-integer (e.g. width="7975.69") — the number
 * patterns accept decimals so the strip never silently fails on such
 * templates (t27/t36/t44/t55 all carry decimal canvas widths).
 */
const FULL_CANVAS_BACKGROUND_RECT = /<rect x="0" y="0" width="[\d.]+" height="[\d.]+" fill="[^"]+"\/>/;

export function stripBackgroundRect(svg: string): string {
  return svg.replace(FULL_CANVAS_BACKGROUND_RECT, "");
}

async function svgToPngBlob(
  svg: string,
  width: number,
  height: number,
  scale: number,
  transparent: boolean
): Promise<Blob> {
  // transparent → drop the Background rect so the canvas shows through;
  // otherwise the background rect is part of the renderer output already.
  const rasterSvg = transparent ? stripBackgroundRect(svg) : svg;

  const blob = new Blob([rasterSvg], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = "async";
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("Failed to rasterize SVG"));
      img.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas unavailable");
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("PNG encoding failed"))), "image/png");
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function exportSheetPng(
  sheet: Sheet,
  template: TemplateDef,
  icons: Record<string, IconEntry>,
  index: number,
  opts: { scale?: number; transparent?: boolean } = {}
): Promise<void> {
  const svg = buildSheetSvg(sheet, template, icons);
  const png = await svgToPngBlob(svg, template.width, template.height, opts.scale ?? 2, opts.transparent ?? false);
  const filename = buildExportFilename(sheet, index, "png");
  triggerDownload(png, filename);
}

/* ------------------------------------------------------------------ */
/* PDF export — one document, one page per sheet                       */
/* ------------------------------------------------------------------ */

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(new Error("PNG read failed"));
    fr.readAsDataURL(blob);
  });
}

export interface PdfOptions {
  /** page raster quality (1/2/3) — maps to 144 / 216 / 288 DPI on the
   *  fixed 1000pt-wide pages. NOT the template-canvas scale: rasterizing a
   *  6000×2400 canvas at 2× (12000×4800 = 57 MP) would hang weak machines
   *  for a quality no printer can use — pages are rastered at their OWN
   *  print resolution instead. */
  pngScale?: number;
  transparent?: boolean;
  /** Draw the metadata footer strip under each page's artwork (sheet title,
   *  category, VOL, page N/M, export date). Absent/undefined = ON. */
  footer?: boolean;
}

/** Width of every PDF page (points). Height follows each sheet's ratio. */
const PDF_PAGE_WIDTH_PT = 1000;
/** Height of the per-page metadata footer strip (points). Artwork keeps its
 *  full ratio; the strip is APPENDED below it — nothing is cropped. */
const PDF_FOOTER_PT = 30;

/** Stamp the metadata footer under one page's artwork: separator rule,
 *  sheet title · category · VOL on the left, page N of M · date right. */
function drawPdfFooter(
  doc: jsPDF,
  opts: {
    pageWidth: number;
    bodyHeight: number;
    index: number;
    total: number;
    sheet: Sheet;
    sheetIndex: number;
    iconCount: number;
    stamp: string;
  }
): void {
  const { pageWidth, bodyHeight } = opts;
  const y = bodyHeight;
  const mid = y + PDF_FOOTER_PT / 2;
  /* separator rule with generous side margins */
  doc.setDrawColor(214);
  doc.setLineWidth(0.75);
  doc.line(24, y + 7, pageWidth - 24, y + 7);
  /* text baseline vertically centered in the strip */
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8.5);
  doc.setTextColor(118, 118, 118);
  const title =
    typeof opts.sheet.name === "string" && opts.sheet.name.trim()
      ? opts.sheet.name.trim()
      : `Sheet ${String(opts.sheetIndex + 1).padStart(2, "0")}`;
  /* the footer is a single-line strip — multiline category text is
   *  flattened for THIS metadata line only (the artwork itself renders
   *  every manual break). */
  const left = `${title} · ${opts.sheet.category.replace(/\s*\n\s*/g, " ").trim()} · VOL. ${String(opts.sheet.volume).padStart(2, "0")} · ${opts.iconCount} icons`;
  doc.text(left, 24, mid + 3);
  const right = `Icon Sheet Studio · ${opts.stamp} · page ${opts.index + 1} / ${opts.total}`;
  doc.text(right, pageWidth - 24, mid + 3, { align: "right" });
}

/**
 * Export the scoped sheets as ONE PDF document — one page per sheet, each
 * page sized to that sheet's native aspect ratio (templates are wide
 * 2.3–3.1:1 canvases, so landscape pages fit them edge-to-edge). Real
 * per-sheet progress; single-sheet scope simply produces a 1-page PDF.
 */
export async function exportSheetsPdf(
  targets: ExportTarget[],
  icons: Record<string, IconEntry>,
  options: PdfOptions,
  onProgress?: (report: ProgressReport) => void
): Promise<ExportResult> {
  const errors: string[] = [];
  let succeeded = 0;
  let doc: jsPDF | null = null;
  const total = targets.length;

  try {
    const stamp = new Date().toISOString().slice(0, 10);
    const footerOn = options.footer !== false;
    for (let i = 0; i < targets.length; i++) {
      const { sheet, template } = targets[i];
      onProgress?.({ current: i + 1, total, label: `Rasterizing sheet ${i + 1} / ${total}` });
      // yield to the event loop so progress actually paints
      await new Promise((r) => setTimeout(r, 0));
      try {
        /* raster at PAGE resolution, not canvas resolution: quality 1/2/3 →
         * 2000/3000/4000 px wide rasters (144/216/288 DPI on a 1000pt page).
         * Keeps pages crisp for print while staying fast and light. */
        const ratio = template.width / template.height;
        const landscape = ratio >= 1;
        const rasterW = Math.round(PDF_PAGE_WIDTH_PT * (options.pngScale ?? 2));
        const pageScale = rasterW / template.width;
        const svg = buildSheetSvg(sheet, template, icons);
        const blob = await svgToPngBlob(
          svg,
          template.width,
          template.height,
          pageScale,
          options.transparent ?? false
        );
        const dataUrl = await blobToDataUrl(blob);
        /* page size: fixed 1000pt width, height from the sheet ratio (+ the
         * metadata footer strip, which is APPENDED below the artwork — the
         * image keeps its exact ratio, nothing is cropped or squashed).
         * Every template canvas is landscape — orientation matches the
         * format array so jsPDF never swaps the dimensions. */
        const bodyH = Math.round(PDF_PAGE_WIDTH_PT / ratio);
        const pageH = bodyH + (footerOn ? PDF_FOOTER_PT : 0);
        const pageW = PDF_PAGE_WIDTH_PT;
        const format: [number, number] = landscape ? [pageW, pageH] : [pageH, pageW];
        if (!doc) {
          doc = new jsPDF({
            orientation: landscape ? "landscape" : "portrait",
            unit: "pt",
            format,
            compress: true,
          });
        } else {
          doc.addPage(format, landscape ? "landscape" : "portrait");
        }
        /* landscape: artwork keeps its exact ratio at the top, footer strip
         * appended below. Portrait (theoretical only — every template is
         * landscape): original full-page image, footer skipped. */
        if (landscape) {
          doc.addImage(dataUrl, "PNG", 0, 0, pageW, bodyH);
          if (footerOn) {
            drawPdfFooter(doc, {
              pageWidth: pageW,
              bodyHeight: bodyH,
              index: i,
              total,
              sheet,
              sheetIndex: i,
              iconCount: sheet.iconIds.length,
              stamp,
            });
          }
        } else {
          doc.addImage(dataUrl, "PNG", 0, 0, format[0], format[1]);
        }
        succeeded++;
      } catch (err) {
        errors.push(`Sheet ${i + 1}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (doc && succeeded > 0) {
      onProgress?.({ current: total, total, label: "Writing PDF…" });
      if (total === 1 && targets[0]) {
        // single-sheet PDF keeps the per-sheet filename convention
        doc.save(buildExportFilename(targets[0].sheet, 0, "pdf"));
      } else {
        doc.save(`icon-sheets_${stamp}.pdf`);
      }
    }
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }

  return { ok: errors.length === 0, succeeded, failed: errors.length, errors };
}

/* ------------------------------------------------------------------ */
/* Batch export                                                        */
/* ------------------------------------------------------------------ */

export interface BatchOptions {
  format: "svg" | "png";
  pngScale?: number;
  transparent?: boolean;
}

export async function exportBatch(
  targets: ExportTarget[],
  icons: Record<string, IconEntry>,
  options: BatchOptions,
  onProgress?: (report: ProgressReport) => void
): Promise<ExportResult> {
  const zip = new JSZip();
  const errors: string[] = [];
  let succeeded = 0;
  const total = targets.length;

  for (let i = 0; i < targets.length; i++) {
    const { sheet, template } = targets[i];
    onProgress?.({ current: i + 1, total, label: `Exporting ${i + 1} / ${total}` });
    // yield to the event loop so progress actually paints
    await new Promise((r) => setTimeout(r, 0));
    try {
      const filename = buildExportFilename(sheet, i, options.format);
      if (options.format === "svg") {
        // transparent applies to batch SVG too — strip the full-canvas
        // Background rect exactly like the single-SVG path (unified behavior)
        const svg = buildSheetSvg(sheet, template, icons);
        zip.file(filename, options.transparent ? stripBackgroundRect(svg) : svg);
      } else {
        const svg = buildSheetSvg(sheet, template, icons);
        const blob = await svgToPngBlob(
          svg,
          template.width,
          template.height,
          options.pngScale ?? 2,
          options.transparent ?? false
        );
        zip.file(filename, blob);
      }
      succeeded++;
    } catch (err) {
      errors.push(`Sheet ${i + 1}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (succeeded > 0) {
    onProgress?.({ current: total, total, label: "Packaging archive…" });
    const zipBlob = await zip.generateAsync({ type: "blob" });
    const stamp = new Date().toISOString().slice(0, 10);
    triggerDownload(zipBlob, `icon-sheets_${stamp}.zip`);
  }

  return { ok: errors.length === 0, succeeded, failed: errors.length, errors };
}
