"use client";

/**
 * ICON SHEET STUDIO — TEMPLATE BUILDER (Phase 1) · insert panel.
 *
 * Compact object toolbar. Every insert flows through createElement()
 * defaults (types.ts) + insertElement() (store) — no per-object ad-hoc
 * geometry. SVG import goes through the sanitizing importer; vector
 * data is preserved and sized proportionally onto the artboard.
 */

import { useRef } from "react";
import { toast } from "sonner";
import {
  Circle,
  CircleDashed,
  FileCode2,
  Frame,
  LayoutGrid,
  Minus,
  RectangleHorizontal,
  Square,
  Triangle,
  Type,
  Wand2,
} from "lucide-react";
import { insertElement, useBuilderStore, getActiveDoc } from "@/lib/builder/store";
import type { BuilderElementType, SvgElementProperties } from "@/lib/builder/types";
import { importSvgFile } from "@/lib/builder/svg-import";
import { newId, createElement } from "@/lib/builder/types";

interface InsertSpec {
  type: BuilderElementType | "svg-import" | "hero";
  label: string;
  icon: typeof Square;
  hint: string;
}

const INSERT_TOOLS: InsertSpec[] = [
  { type: "icon-grid", label: "Icon Grid", icon: LayoutGrid, hint: "Rows × columns of icon cells — generated mathematically, auto-fits its area" },
  { type: "text", label: "Text", icon: Type, hint: "Editable text — assign a role: Category Title, Icon Count, Volume, Descriptor" },
  { type: "hero", label: "Hero", icon: Wand2, hint: "Hero area — the studio draws the selected hero icon centered inside it; style it as the hero background" },
  { type: "rectangle", label: "Rectangle", icon: Square, hint: "Sharp-cornered rectangle" },
  { type: "rounded-rectangle", label: "Rounded", icon: RectangleHorizontal, hint: "Rounded-corner rectangle" },
  { type: "circle", label: "Circle", icon: Circle, hint: "Circle" },
  { type: "ellipse", label: "Ellipse", icon: CircleDashed, hint: "Ellipse" },
  { type: "line", label: "Line", icon: Minus, hint: "Straight line (drag its handles to re-aim)" },
  { type: "polygon", label: "Polygon", icon: Triangle, hint: "Regular polygon — set the side count in properties" },
  { type: "svg-import", label: "Import SVG", icon: FileCode2, hint: "Vector artwork — sanitized, never rasterized" },
];

export function BuilderInsertPanel() {
  const hasDoc = useBuilderStore((s) => s.docs.some((d) => d.id === s.activeDocId));
  const fileRef = useRef<HTMLInputElement | null>(null);

  const onInsert = (spec: InsertSpec): void => {
    if (!hasDoc) return;
    if (spec.type === "svg-import") {
      fileRef.current?.click();
      return;
    }
    if (spec.type === "hero") {
      // semantic hero placeholder: a selectable/resizable dashed area
      const doc = getActiveDoc(useBuilderStore.getState());
      if (!doc) return;
      const w = 480;
      const h = 480;
      const el = createElement({
        type: "rectangle",
        role: "hero",
        artboard: doc.artboard,
        x: Math.round((doc.artboard.width - w) / 2),
        y: Math.round(doc.artboard.height * 0.55),
        width: w,
        height: h,
        name: "Hero",
        properties: {
          fill: "rgba(217,119,6,0.04)",
          stroke: "none",
          strokeWidth: 0,
          opacity: 1,
          cornerRadius: 4,
          sides: 0,
        },
      });
      useBuilderStore.getState().addElement(el);
      toast.success("Hero added — the studio places the hero icon centered inside it");
      return;
    }
    const el = insertElement(spec.type);
    toast.success(`${el.name} added`);
  };

  const onFiles = async (files: FileList | null): Promise<void> => {
    if (!files || files.length === 0) return;
    const doc = getActiveDoc(useBuilderStore.getState());
    if (!doc) return;
    const maxSide = 480;
    let index = 0;
    for (const file of Array.from(files)) {
      try {
        const imported = await importSvgFile(file);
        const scale = Math.min(1, maxSide / Math.max(imported.sourceWidth, imported.sourceHeight));
        const w = Math.round(imported.sourceWidth * scale);
        const h = Math.round(imported.sourceHeight * scale);
        const stagger = index * 28;
        const el = createElement({
          type: "svg",
          artboard: doc.artboard,
          x: Math.round((doc.artboard.width - w) / 2) + stagger,
          y: Math.round((doc.artboard.height - h) / 2) + stagger,
          width: w,
          height: h,
          name: file.name.replace(/\.svg$/i, "").slice(0, 80) || "SVG artwork",
          properties: {
            svg: imported.svg,
            viewBox: imported.viewBox,
            sourceWidth: imported.sourceWidth,
            sourceHeight: imported.sourceHeight,
          } satisfies SvgElementProperties,
        });
        el.id = newId("el");
        useBuilderStore.getState().addElement(el);
        index++;
        if (imported.warnings.length) {
          toast.warning(`"${file.name}" imported — ${imported.warnings.join(" · ")}`);
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : `Could not import "${file.name}".`);
      }
    }
    if (index > 0) toast.success(`${index} SVG${index > 1 ? "s" : ""} imported — full vector data preserved`);
    if (fileRef.current) fileRef.current.value = "";
  };

  return (
    <div className="space-y-2">
      <input
        ref={fileRef}
        type="file"
        accept=".svg,image/svg+xml"
        multiple
        className="hidden"
        onChange={(e) => void onFiles(e.target.files)}
        aria-label="Import SVG files"
      />
      <div className="grid grid-cols-2 gap-1.5">
        {INSERT_TOOLS.map((spec) => {
          const Icon = spec.icon;
          const disabled = !hasDoc;
          return (
            <button
              key={spec.label}
              type="button"
              disabled={disabled}
              onClick={() => onInsert(spec)}
              title={spec.hint}
              aria-label={`Add ${spec.label} — ${spec.hint}`}
              className="builder-insert-btn group flex flex-col items-center gap-1.5 rounded-lg border border-border/80 bg-card px-1.5 py-2.5 text-foreground shadow-xs outline-none transition-colors hover:border-ring/50 hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring/40 disabled:pointer-events-none disabled:opacity-40"
            >
              <Icon className="h-4 w-4 text-muted-foreground transition-colors group-hover:text-foreground" aria-hidden />
              <span className="text-[10.5px] font-medium leading-none">{spec.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
