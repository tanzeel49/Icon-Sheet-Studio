"use client";

/**
 * ICON SHEET STUDIO — TEMPLATE BUILDER (Phase 1) · properties panel.
 *
 * Context-sensitive inspector reusing the app's panel-kit primitives
 * (SliderField with scrub/nudge/wheel, ColorField, ToggleRow, Section)
 * so every numeric field behaves exactly like the studio's fields.
 *
 * Selection drives the content:
 *   · no selection → artboard + document
 *   · one element   → header/role + position/size + type-specific props
 *   · many elements → align / distribute / bulk actions
 *
 * Locked elements are NEVER editable here (explicit unlock notice).
 * All mutations flow through the store's commit() → undo/redo/persist.
 */

import { useMemo, useState } from "react";
import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignHorizontalDistributeCenter,
  AlignStartHorizontal,
  AlignStartVertical,
  AlignVerticalDistributeCenter,
  Copy,
  Grid3x3,
  Layers,
  Lock,
  RotateCcw,
  Ruler,
  Sparkles,
  Trash2,
  Type as TypeIcon,
} from "lucide-react";
import {
  ColorField,
  MultilineField,
  Row,
  Section,
  SegmentedField,
  SelectField,
  SliderField,
  TextField,
  ToggleRow,
} from "@/components/studio/panel-kit";
import { Button } from "@/components/ui/button";
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
import { useBuilderStore } from "@/lib/builder/store";
import {
  ARTBOARD_MAX,
  ARTBOARD_MIN,
  DEFAULT_FONT_STACK,
  GRID_COLS_MAX,
  GRID_ROWS_MAX,
  MAPPED_TEXT_ROLES,
  ROLE_GROUPS,
  createHeroElement,
  defaultGridProperties,
  defaultTextProperties,
  getGridProps,
  getShapeProps,
  getSvgProps,
  getTextProps,
  roleLabel,
  rolePlaceholderContent,
  rolesForElementType,
  type BuilderDocument,
  type BuilderElement,
  type BuilderRole,
  type GridElementProperties,
  type TextElementProperties,
} from "@/lib/builder/types";
import { computeGridMetrics, elementsBBox } from "@/lib/builder/geometry";
import { fitBuilderText } from "@/lib/builder/text-fit";
import { validateDocument } from "@/lib/builder/validation";
import { cn } from "@/lib/utils";

const FONT_OPTIONS: { value: string; label: string }[] = [
  { value: DEFAULT_FONT_STACK, label: "Sans (system)" },
  { value: "Georgia, 'Times New Roman', serif", label: "Serif" },
  { value: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", label: "Monospace" },
  { value: "ui-rounded, 'Hiragino Maru Gothic ProN', Quicksand, Comfortaa, sans-serif", label: "Rounded" },
];

/* ------------------------------------------------------------------ */
/* Small shared bits                                                   */
/* ------------------------------------------------------------------ */

function InfoLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2 rounded-lg bg-muted/50 px-2.5 py-2">
      <span className="text-[11px] font-medium text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate font-mono text-[11px] tabular-nums text-foreground">{value}</span>
    </div>
  );
}

function ValidationNote({ level, children }: { level: "error" | "warning"; children: React.ReactNode }) {
  return (
    <p
      role={level === "error" ? "alert" : "status"}
      className={cn(
        "rounded-lg border px-2.5 py-2 text-[11px] leading-relaxed",
        level === "error"
          ? "border-destructive/40 bg-destructive/10 text-destructive"
          : "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400"
      )}
    >
      {children}
    </p>
  );
}

function ActionGrid({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-2 gap-1.5">{children}</div>;
}

/* ------------------------------------------------------------------ */
/* Role select (§27 type-aware · §28 uniqueness with replace confirm)   */
/* ------------------------------------------------------------------ */

/** Roles that must exist at most once per template — assigning a second
 *  one offers to REPLACE the existing holder (never two competing
 *  bindings). Mapped text roles + the hero area. */
const UNIQUE_ROLES: BuilderRole[] = [...MAPPED_TEXT_ROLES, "hero"];

/** Content strings that count as “still the untouched default” — role
 *  assignment re-seeds these with the role's own placeholder (§11). */
const DEFAULT_CONTENT_SEEDS = new Set(["Category title", "Text", ""]);

/** The doc's usable icon count (grid iconCount clamped) — drives the live
 *  Icon Count placeholder (§5/§19). */
function gridIconCountOf(doc: BuilderDocument | null): number {
  if (!doc) return 0;
  const grid = doc.elements.find((el) => el.type === "icon-grid");
  const p = grid ? getGridProps(grid) : null;
  if (!p) return 0;
  return Math.min(Math.max(1, p.iconCount || p.rows * p.columns), p.rows * p.columns);
}

function RoleSelect({
  el,
  doc,
  disabled,
}: {
  el: BuilderElement;
  doc: BuilderDocument;
  disabled?: boolean;
}) {
  const updateElements = useBuilderStore((s) => s.updateElements);
  const allowed = rolesForElementType(el.type);
  const [pendingRole, setPendingRole] = useState<BuilderRole | null>(null);

  /** role → the option groups filtered to this element type's allowed roles */
  const groups = ROLE_GROUPS.map((g) => ({
    ...g,
    roles: g.roles.filter((r) => allowed.includes(r.value)),
  })).filter((g) => g.roles.length > 0);

  if (allowed.length === 0) {
    /* fixed-role types (icon grid / background) — semantic by construction */
    return <InfoLine label="Role" value={`${roleLabel(el.role)} — fixed for this element type`} />;
  }

  const applyRole = (role: BuilderRole, demoteId?: string): void => {
    const ids = demoteId ? [el.id, demoteId] : [el.id];
    updateElements(
      ids,
      (target) => {
        if (target.id === el.id) {
          const patch: Partial<BuilderElement> = { role };
          /* §11 — seed the role's placeholder when the content is still an
           * untouched default (never overwrite the author's own words) */
          if (target.type === "text") {
            const p = getTextProps(target);
            const seed = rolePlaceholderContent(role, gridIconCountOf(doc));
            if (p && seed && DEFAULT_CONTENT_SEEDS.has(p.content)) {
              patch.properties = { ...p, content: seed };
            }
          }
          return patch;
        }
        /* the replaced holder loses its (now taken) unique role */
        return { role: target.type === "text" ? "text" : "decorative" };
      },
      { label: "Change role" }
    );
  };

  const requestRole = (role: BuilderRole): void => {
    if (role === el.role || disabled) return;
    if (UNIQUE_ROLES.includes(role)) {
      const holder = doc.elements.find(
        (other) => other.id !== el.id && other.role === role && other.type === el.type
      );
      if (holder) {
        setPendingRole(role);
        return;
      }
    }
    applyRole(role);
  };

  const holderName = pendingRole
    ? doc.elements.find((o) => o.id !== el.id && o.role === pendingRole)?.name ?? "another element"
    : "";

  return (
    <>
      <Row label="Role">
        <select
          value={el.role}
          disabled={disabled}
          onChange={(e) => requestRole(e.target.value as BuilderRole)}
          className="ip-field h-9 w-full cursor-pointer rounded-lg border border-input bg-card px-2.5 pr-7 text-[12px] text-foreground shadow-xs outline-none transition-[border-color,box-shadow] focus-visible:border-ring focus-visible:ring-[2.5px] focus-visible:ring-ring/25 disabled:opacity-50"
          aria-label="Semantic role"
        >
          {groups.map((g) => (
            <optgroup key={g.group} label={g.group}>
              {g.roles.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </Row>

      {/* §28 — replacing a unique role is always an explicit choice */}
      <AlertDialog open={pendingRole !== null} onOpenChange={(open) => !open && setPendingRole(null)}>
        <AlertDialogContent className="max-w-sm">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-left">
              Replace the existing {pendingRole ? roleLabel(pendingRole) : ""}?
            </AlertDialogTitle>
            <AlertDialogDescription className="text-left">
              This template already has a {pendingRole ? roleLabel(pendingRole) : ""} element —
              “{holderName}”. Only one element can carry this role; replacing it turns
              “{holderName}” into plain {el.type === "text" ? "text" : "artwork"}. Both changes
              undo together as one step.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingRole) {
                  const holder = doc.elements.find((o) => o.id !== el.id && o.role === pendingRole);
                  applyRole(pendingRole, holder?.id);
                }
                setPendingRole(null);
              }}
            >
              Replace
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Grid properties — the most important panel                          */
/* ------------------------------------------------------------------ */

function GridSection({ el }: { el: BuilderElement }) {
  const updateElementProps = useBuilderStore((s) => s.updateElementProps);
  const p = getGridProps(el);
  const metrics = computeGridMetrics(el);
  const [linkGaps, setLinkGaps] = useState(true);
  const [linkPadding, setLinkPadding] = useState(true);
  if (!p) return null;
  const key = (field: string) => `grid:${el.id}:${field}`;
  const up = (patch: Partial<GridElementProperties>, field: string) =>
    updateElementProps(el.id, patch, { label: "Grid change", key: key(field) });

  const cellValue = p.autoFit ? metrics.cellWidth : p.cellWidth;
  const capacity = p.rows * p.columns;
  const iconCount = Math.min(Math.max(1, p.iconCount || capacity), capacity);
  const unused = capacity - iconCount;

  /* rows/columns changes re-flow the cells AND keep iconCount sane: a full
   * grid tracks the new capacity; a deliberately reduced count is clamped. */
  const setRows = (v: number): void => {
    const rows = Math.round(v);
    const newCap = rows * p.columns;
    const wasFull = iconCount >= capacity;
    up({ rows, iconCount: wasFull ? newCap : Math.min(iconCount, newCap) }, "rows");
  };
  const setColumns = (v: number): void => {
    const columns = Math.round(v);
    const newCap = p.rows * columns;
    const wasFull = iconCount >= capacity;
    up({ columns, iconCount: wasFull ? newCap : Math.min(iconCount, newCap) }, "columns");
  };

  return (
    <Section title="Icon Grid" icon={<Grid3x3 className="h-4 w-4" />} defaultOpen badge={<span className="font-mono text-[10px] tabular-nums text-muted-foreground">{iconCount}/{capacity} icons</span>}>
      <div className="space-y-2.5">
        <SliderField label="Rows" value={p.rows} min={1} max={GRID_ROWS_MAX} step={1} onChange={setRows} unit="rows" />
        <SliderField label="Columns" value={p.columns} min={1} max={GRID_COLS_MAX} step={1} onChange={setColumns} unit="cols" />
        <InfoLine label="Grid capacity" value={`${capacity} (${p.rows} × ${p.columns})`} />

        <SliderField
          label="Icon count"
          value={iconCount}
          min={1}
          max={capacity}
          step={1}
          onChange={(v) => up({ iconCount: Math.round(v) }, "count")}
          unit="slots"
          tooltip="How many grid positions actually hold icons — trailing positions stay unused (never deleted)"
        />
        {unused > 0 && (
          <>
            <InfoLine label="Unused positions" value={`${unused} of ${capacity} — ${iconCount} active slots`} />
            <SegmentedField
              label="Unused cells"
              value={p.unusedCells}
              options={[
                { value: "empty", label: "Keep empty" },
                { value: "hidden", label: "Hide" },
              ]}
              onChange={(v) => up({ unusedCells: v }, "unused")}
            />
          </>
        )}

        {p.squareCells ? (
          <SliderField
            label="Cell size"
            value={cellValue}
            min={4}
            max={600}
            step={1}
            disabled={p.autoFit}
            onChange={(v) => up({ cellWidth: v, cellHeight: v }, "cell")}
            unit="px"
            tooltip="Width and height are locked equal while Square Cells is on"
          />
        ) : (
          <>
            <SliderField label="Cell width" value={p.autoFit ? metrics.cellWidth : p.cellWidth} min={4} max={600} step={1} disabled={p.autoFit} onChange={(v) => up({ cellWidth: v }, "cellW")} unit="px" />
            <SliderField label="Cell height" value={p.autoFit ? metrics.cellHeight : p.cellHeight} min={4} max={600} step={1} disabled={p.autoFit} onChange={(v) => up({ cellHeight: v }, "cellH")} unit="px" />
          </>
        )}

        <div className="space-y-2.5 rounded-lg border border-border/70 bg-muted/30 p-2.5">
          <ToggleRow
            label="Link gaps"
            checked={linkGaps}
            onChange={setLinkGaps}
            tooltip="Horizontal and vertical gap move together while linked"
          />
          {linkGaps ? (
            <SliderField
              label="Gap"
              value={p.horizontalGap}
              min={0}
              max={300}
              step={1}
              onChange={(v) => up({ horizontalGap: v, verticalGap: v }, "gap")}
              unit="px"
              tooltip="Linked — horizontal and vertical stay equal"
            />
          ) : (
            <>
              <SliderField label="H gap" value={p.horizontalGap} min={0} max={300} step={1} onChange={(v) => up({ horizontalGap: v }, "hgap")} unit="px" />
              <SliderField label="V gap" value={p.verticalGap} min={0} max={300} step={1} onChange={(v) => up({ verticalGap: v }, "vgap")} unit="px" />
            </>
          )}
        </div>

        <div className="space-y-2.5 rounded-lg border border-border/70 bg-muted/30 p-2.5">
          <ToggleRow
            label="Link margins"
            checked={linkPadding}
            onChange={setLinkPadding}
            tooltip="All four grid paddings move together while linked"
          />
          {linkPadding ? (
            <SliderField
              label="Padding"
              value={p.paddingTop}
              min={0}
              max={400}
              step={1}
              onChange={(v) => up({ paddingTop: v, paddingRight: v, paddingBottom: v, paddingLeft: v }, "pad")}
              unit="px"
              tooltip="Linked — top, right, bottom and left stay equal"
            />
          ) : (
            <div className="space-y-2.5">
              <SliderField label="Pad top" value={p.paddingTop} min={0} max={400} step={1} onChange={(v) => up({ paddingTop: v }, "padT")} unit="px" />
              <SliderField label="Pad right" value={p.paddingRight} min={0} max={400} step={1} onChange={(v) => up({ paddingRight: v }, "padR")} unit="px" />
              <SliderField label="Pad bottom" value={p.paddingBottom} min={0} max={400} step={1} onChange={(v) => up({ paddingBottom: v }, "padB")} unit="px" />
              <SliderField label="Pad left" value={p.paddingLeft} min={0} max={400} step={1} onChange={(v) => up({ paddingLeft: v }, "padL")} unit="px" />
            </div>
          )}
        </div>

        <ToggleRow
          label="Square cells"
          checked={p.squareCells}
          onChange={(v) => up({ squareCells: v, ...(v ? { cellHeight: p.cellWidth } : {}) }, "square")}
          tooltip="cellWidth === cellHeight — enforced everywhere"
        />
        <ToggleRow
          label="Auto fit"
          checked={p.autoFit}
          onChange={(v) => up({ autoFit: v }, "autofit")}
          tooltip="Largest cell that fits the grid area (rows, columns, gaps, padding)"
        />
        <SegmentedField
          label="Alignment"
          value={p.alignment}
          options={[
            { value: "start", label: "Start" },
            { value: "center", label: "Center" },
            { value: "end", label: "End" },
          ]}
          onChange={(v) => up({ alignment: v }, "align")}
        />
        <ColorField label="Cell fill" value={p.cellFill} onChange={(v) => up({ cellFill: v }, "cellFill")} />
        <SliderField label="Cell radius" value={p.cellRadius} min={0} max={120} step={1} onChange={(v) => up({ cellRadius: v }, "cellR")} unit="px" />

        {!metrics.fits && (
          <ValidationNote level="error">
            Grid does not fit in the available area ({metrics.availableWidth}×{metrics.availableHeight} px). Reduce spacing or padding, change rows/columns, or enlarge the icon area.
          </ValidationNote>
        )}
        {!metrics.renderable && (
          <ValidationNote level="warning">
            {metrics.totalIcons} cells exceeds the render limit — cells are hidden until rows/columns are reduced.
          </ValidationNote>
        )}
        {metrics.fits && p.autoFit && (
          <InfoLine label="Auto-fit result" value={`${metrics.cellWidth} × ${metrics.cellHeight} px cell`} />
        )}

        <Button
          variant="outline"
          size="sm"
          className="h-8 w-full gap-1.5 text-[11px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={() => updateElementProps(el.id, defaultGridProperties(), { label: "Reset grid" })}
          title="Restore this grid's factory defaults (rows, columns, spacing, styling) — geometry stays"
        >
          <RotateCcw className="h-3.5 w-3.5" aria-hidden />
          Reset grid
        </Button>
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------ */
/* Text properties                                                     */
/* ------------------------------------------------------------------ */

/** What the Studio fills in for a mapped role (§10 Phase C). */
function roleMappingHint(role: BuilderRole, iconCount: number): string {
  switch (role) {
    case "category":
      return "The Studio replaces this text with each sheet's category name (auto-fitted).";
    case "icon-count":
      return `The Studio keeps this in sync with the sheet's icons — currently “${iconCount} ICONS” from the grid.`;
    case "volume":
      return "The Studio replaces this text with each sheet's volume (e.g. VOL. 03).";
    case "descriptor":
      return "Optional descriptor — the Studio replaces it with the sheet's caption text.";
    default:
      return "Decorative text stays exactly as designed — the Studio never rewrites it.";
  }
}

function TextSection({ el, doc, autoFocus }: { el: BuilderElement; doc: BuilderDocument; autoFocus?: boolean }) {
  const updateElementProps = useBuilderStore((s) => s.updateElementProps);
  const p = getTextProps(el);
  const iconCount = gridIconCountOf(doc);
  const isIconCount = el.role === "icon-count";
  if (!p) return null;
  const key = (field: string) => `text:${el.id}:${field}`;
  const up = (patch: Partial<TextElementProperties>, field: string) =>
    updateElementProps(el.id, patch, { label: "Text change", key: key(field) });

  /* the live display values the canvas renders — Icon Count is derived
   * from the grid (§5), autoFit shrinks the measured size (§13) */
  const displayContent = isIconCount ? `${iconCount} ICONS` : p.content;
  const fit = fitBuilderText(p, displayContent, el.width, el.height);

  return (
    <Section title="Text" icon={<TypeIcon className="h-4 w-4" />} defaultOpen>
      <div className="space-y-2.5">
        {isIconCount ? (
          <>
            <InfoLine label="Content" value={`${iconCount} ICONS (auto)`} />
            <p className="pro-help">
              The count is derived from the icon grid's usable icon count — it updates
              automatically whenever rows, columns or the icon count change. Never typed, never stale.
            </p>
          </>
        ) : (
          <MultilineField
            key={autoFocus ? `tf-focused-${el.id}` : `tf-${el.id}`}
            label="Content"
            value={p.content}
            onCommit={(v) => up({ content: v }, "content")}
            rows={3}
            autoFocus={autoFocus}
            hint={MAPPED_TEXT_ROLES.includes(el.role) ? "Placeholder text — the Studio fills the real value per sheet" : "Editable text — line breaks are preserved"}
          />
        )}
        <SelectField label="Font" value={p.fontFamily} options={FONT_OPTIONS} onChange={(v) => up({ fontFamily: v }, "font")} />
        <SliderField label="Size" value={p.fontSize} min={8} max={400} step={1} onChange={(v) => up({ fontSize: v }, "size")} unit="px" />
        <SliderField label="Weight" value={p.fontWeight} min={100} max={900} step={100} onChange={(v) => up({ fontWeight: Math.round(v) }, "weight")} />
        <SliderField label="Line height" value={p.lineHeight} min={0.5} max={3} step={0.05} onChange={(v) => up({ lineHeight: v }, "lh")} unit="×" />
        <SliderField label="Tracking" value={p.letterSpacing} min={-10} max={100} step={0.5} onChange={(v) => up({ letterSpacing: v }, "ls")} unit="px" />
        <SegmentedField
          label="Align"
          value={p.align}
          options={[
            { value: "left", label: "Left" },
            { value: "center", label: "Center" },
            { value: "right", label: "Right" },
          ]}
          onChange={(v) => up({ align: v }, "align")}
        />
        <ColorField label="Color" value={p.color} onChange={(v) => up({ color: v }, "color")} />

        <ToggleRow
          label="Auto fit"
          checked={p.autoFit}
          onChange={(v) => up({ autoFit: v }, "autofit")}
          tooltip="ON — the font size is the largest size that fits the text box (measured, never distorted). OFF — the exact size above is used."
        />
        {p.autoFit && (
          <InfoLine
            label="Fitted size"
            value={fit.shrunk ? `${fit.fontSize} px (from ${p.fontSize})` : `${fit.fontSize} px (fits as-is)`}
          />
        )}
        <p className="pro-help">{roleMappingHint(el.role, iconCount)}</p>

        <Button
          variant="outline"
          size="sm"
          className="h-8 w-full gap-1.5 text-[11px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={() => updateElementProps(el.id, defaultTextProperties(), { label: "Reset text" })}
          title="Restore this text's factory typography defaults — geometry stays"
        >
          <RotateCcw className="h-3.5 w-3.5" aria-hidden />
          Reset text
        </Button>
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------ */
/* Shape properties                                                    */
/* ------------------------------------------------------------------ */

function ShapeSection({ el }: { el: BuilderElement }) {
  const updateElementProps = useBuilderStore((s) => s.updateElementProps);
  const p = getShapeProps(el);
  if (!p) return null;
  const key = (field: string) => `shape:${el.id}:${field}`;
  const up = (patch: Record<string, number | string>, field: string) =>
    updateElementProps(el.id, patch, { label: "Shape change", key: key(field) });
  const isLine = el.type === "line";

  return (
    <Section title="Shape" icon={<Ruler className="h-4 w-4" />} defaultOpen>
      <div className="space-y-2.5">
        {!isLine && <ColorField label="Fill" value={p.fill} onChange={(v) => up({ fill: v }, "fill")} allowEmpty />}
        <ColorField label="Stroke" value={p.stroke} onChange={(v) => up({ stroke: v }, "stroke")} allowEmpty />
        <SliderField
          label="Stroke width"
          value={p.strokeWidth}
          min={isLine ? 1 : 0}
          max={100}
          step={0.5}
          onChange={(v) => up({ strokeWidth: v }, "sw")}
          unit="px"
        />
        {el.type === "rounded-rectangle" && (
          <SliderField label="Corner radius" value={p.cornerRadius} min={0} max={200} step={1} onChange={(v) => up({ cornerRadius: v }, "radius")} unit="px" />
        )}
        {el.type === "polygon" && (
          <SliderField label="Sides" value={p.sides} min={3} max={12} step={1} onChange={(v) => up({ sides: Math.round(v) }, "sides")} unit="sides" />
        )}
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------ */
/* SVG info                                                            */
/* ------------------------------------------------------------------ */

function SvgSection({ el }: { el: BuilderElement }) {
  const p = getSvgProps(el);
  if (!p) return null;
  const kb = (p.svg.length / 1024).toFixed(1);
  return (
    <Section title="SVG Artwork" icon={<Layers className="h-4 w-4" />} defaultOpen>
      <div className="space-y-2.5">
        <InfoLine label="Source size" value={`${p.sourceWidth} × ${p.sourceHeight}`} />
        <InfoLine label="ViewBox" value={p.viewBox} />
        <InfoLine label="Stored vector" value={`${kb} KB`} />
        <p className="pro-help">
          Vector geometry is preserved verbatim — scaling this element never rewrites path data.
        </p>
        {!p.svg && <ValidationNote level="error">This element has no SVG source — re-import a file.</ValidationNote>}
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------ */
/* Align / distribute                                                  */
/* ------------------------------------------------------------------ */

function AlignSection({ count }: { count: number }) {
  const alignSelection = useBuilderStore((s) => s.alignSelection);
  const distributeSelection = useBuilderStore((s) => s.distributeSelection);
  const single = count === 1;
  const btn = "builder-align-btn grid h-8 place-items-center rounded-lg border border-border/80 bg-card text-muted-foreground shadow-xs outline-none transition-colors hover:border-ring/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40";
  return (
    <Section
      title="Align & Distribute"
      defaultOpen
      badge={<span className="font-mono text-[10px] text-muted-foreground">{single ? "to artboard" : "to selection"}</span>}
    >
      <div className="grid grid-cols-6 gap-1.5">
        <button type="button" className={btn} onClick={() => alignSelection("left")} aria-label="Align left" title="Align left">
          <AlignStartVertical className="h-3.5 w-3.5" />
        </button>
        <button type="button" className={btn} onClick={() => alignSelection("hcenter")} aria-label="Align horizontal centers" title="Align center (horizontal)">
          <AlignCenterVertical className="h-3.5 w-3.5" />
        </button>
        <button type="button" className={btn} onClick={() => alignSelection("right")} aria-label="Align right" title="Align right">
          <AlignEndVertical className="h-3.5 w-3.5" />
        </button>
        <button type="button" className={btn} onClick={() => alignSelection("top")} aria-label="Align top" title="Align top">
          <AlignStartHorizontal className="h-3.5 w-3.5" />
        </button>
        <button type="button" className={btn} onClick={() => alignSelection("vcenter")} aria-label="Align vertical centers" title="Align middle (vertical)">
          <AlignCenterHorizontal className="h-3.5 w-3.5" />
        </button>
        <button type="button" className={btn} onClick={() => alignSelection("bottom")} aria-label="Align bottom" title="Align bottom">
          <AlignEndHorizontal className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        <Button
          variant="outline"
          size="sm"
          className="h-8 gap-1.5 text-[11px]"
          disabled={count < 3}
          onClick={() => distributeSelection("horizontal")}
          title={count < 3 ? "Needs at least 3 elements" : "Even horizontal spacing"}
        >
          <AlignHorizontalDistributeCenter className="h-3.5 w-3.5" />
          Horizontal
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-8 gap-1.5 text-[11px]"
          disabled={count < 3}
          onClick={() => distributeSelection("vertical")}
          title={count < 3 ? "Needs at least 3 elements" : "Even vertical spacing"}
        >
          <AlignVerticalDistributeCenter className="h-3.5 w-3.5" />
          Vertical
        </Button>
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------ */
/* Artboard (no-selection surface)                                     */
/* ------------------------------------------------------------------ */

function ArtboardSection({ doc }: { doc: BuilderDocument }) {
  const renameDocument = useBuilderStore((s) => s.renameDocument);
  const setArtboard = useBuilderStore((s) => s.setArtboard);
  const [keepSquare, setKeepSquare] = useState(doc.artboard.width === doc.artboard.height);

  const setWidth = (v: number): void => {
    const width = Math.round(v);
    setArtboard(keepSquare ? { width, height: width } : { width }, `art:${doc.id}:w`);
  };
  const setHeight = (v: number): void => {
    const height = Math.round(v);
    setArtboard(keepSquare ? { width: height, height } : { height }, `art:${doc.id}:h`);
  };

  return (
    <Section title="Artboard" icon={<Ruler className="h-4 w-4" />} defaultOpen>
      <div className="space-y-2.5">
        <TextField label="Name" value={doc.name} onChange={(v) => renameDocument(doc.id, v)} />
        <SliderField
          label="Width"
          value={doc.artboard.width}
          min={ARTBOARD_MIN}
          max={ARTBOARD_MAX}
          step={1}
          onChange={setWidth}
          unit="px"
        />
        <SliderField
          label="Height"
          value={doc.artboard.height}
          min={ARTBOARD_MIN}
          max={ARTBOARD_MAX}
          step={1}
          onChange={setHeight}
          unit="px"
        />
        <ToggleRow
          label="Keep square"
          checked={keepSquare}
          onChange={(v) => {
            setKeepSquare(v);
            if (v) setArtboard({ height: doc.artboard.width });
          }}
          tooltip="While on, width and height stay equal (icon sheets are usually square). Turn off for independent custom dimensions."
        />
        <ColorField
          label="Background"
          value={doc.artboard.background}
          onChange={(v) => setArtboard({ background: v }, `art:${doc.id}:bg`)}
        />
        <div className="grid grid-cols-3 gap-1.5">
          {(
            [
              { label: "Square", w: 1200, h: 1200 },
              { label: "Landscape", w: 1920, h: 1080 },
              { label: "Portrait", w: 1080, h: 1920 },
            ] as const
          ).map((preset) => {
            const active = doc.artboard.width === preset.w && doc.artboard.height === preset.h;
            return (
              <Button
                key={preset.label}
                variant="outline"
                size="sm"
                className={cn("h-7 px-1 text-[10.5px]", active && "border-ring bg-muted")}
                onClick={() => {
                  setKeepSquare(preset.label === "Square");
                  setArtboard({ width: preset.w, height: preset.h });
                }}
                title={`Set artboard to ${preset.w} × ${preset.h}`}
              >
                {preset.label}
              </Button>
            );
          })}
        </div>
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------ */
/* Main panel                                                          */
/* ------------------------------------------------------------------ */

export function BuilderPropertiesPanel({
  focusTextId,
  focusTextToken,
}: {
  focusTextId?: string | null;
  focusTextToken?: number;
}) {
  const docs = useBuilderStore((s) => s.docs);
  const activeDocId = useBuilderStore((s) => s.activeDocId);
  const selection = useBuilderStore((s) => s.selection);
  const store = useBuilderStore();
  const doc = useMemo(() => docs.find((d) => d.id === activeDocId) ?? null, [docs, activeDocId]);
  const selected = useMemo(
    () => (doc ? doc.elements.filter((el) => selection.includes(el.id)) : []),
    [doc, selection]
  );

  const issues = useMemo(() => (doc ? validateDocument(doc) : []), [doc]);

  if (!doc) {
    return (
      <div className="p-3 text-[11px] leading-relaxed text-muted-foreground">
        Open a template draft to edit its properties.
      </div>
    );
  }

  /* ---------------- no selection: artboard + document ---------------- */
  if (selected.length === 0) {
    const errors = issues.filter((i) => i.level === "error");
    const warnings = issues.filter((i) => i.level === "warning");
    return (
      /* pb-8: the final control keeps breathing room below it when the
       * inspector is scrolled to its end (same contract as the studio
       * panel's pb-10) — never flush against the panel edge. */
      <div className="space-y-2.5 p-3 pb-8">
        <ArtboardSection doc={doc} />

        <Section title="Document" icon={<Layers className="h-4 w-4" />} defaultOpen>
          <div className="space-y-2.5">
            <InfoLine label="Elements" value={`${doc.elements.length}`} />
            <InfoLine label="Updated" value={new Date(doc.metadata.updatedAt).toLocaleString()} />
            {(errors.length > 0 || warnings.length > 0) && (
              <ValidationNote level={errors.length > 0 ? "error" : "warning"}>
                {errors.length > 0
                  ? `${errors.length} error${errors.length > 1 ? "s" : ""}`
                  : `${warnings.length} warning${warnings.length > 1 ? "s" : ""}` + " in this document — select the flagged element to see details."}
              </ValidationNote>
            )}
          </div>
        </Section>
      </div>
    );
  }

  /* ---------------- locked → explicit read-only notice ---------------- */
  const allLocked = selected.every((el) => el.locked);
  const single = selected.length === 1 ? selected[0] : null;
  const editableIds = selected.filter((el) => !el.locked).map((el) => el.id);
  const bbox = elementsBBox(selected);

  const updateGeometry = (patch: Partial<BuilderElement>, field: string): void => {
    if (editableIds.length === 0) return;
    store.updateElements(editableIds, patch, { label: "Property change", key: `el:${editableIds.join(",")}:${field}` });
  };

  return (
    <div className="space-y-2.5 p-3 pb-8" aria-live="polite">
      {allLocked ? (
        <ValidationNote level="warning">
          <span className="inline-flex items-center gap-1.5">
            <Lock className="h-3.5 w-3.5" />
            {selected.length === 1 ? "This element is locked" : `${selected.length} elements are locked`} — unlock in the
            layers panel to edit.
          </span>
        </ValidationNote>
      ) : single ? (
        <>
          {/* element identity */}
          <Section title={single.name || "Element"} icon={<Layers className="h-4 w-4" />} defaultOpen>
            <div className="space-y-2.5">
              <TextField
                label="Name"
                value={single.name}
                onChange={(v) => store.updateElements([single.id], { name: v.slice(0, 120) }, { label: "Rename element", key: `el:${single.id}:name` })}
              />
              <RoleSelect el={single} doc={doc} disabled={single.locked} />
              <InfoLine label="Type" value={`${single.type} · layer ${single.zIndex + 1} of ${doc.elements.length}`} />
            </div>
          </Section>

          <Section title="Position & Size" icon={<Ruler className="h-4 w-4" />} defaultOpen>
            <div className="space-y-2.5">
              <SliderField label="X" value={single.x} min={-ARTBOARD_MAX} max={ARTBOARD_MAX} step={1} onChange={(v) => updateGeometry({ x: v }, "x")} unit="px" />
              <SliderField label="Y" value={single.y} min={-ARTBOARD_MAX} max={ARTBOARD_MAX} step={1} onChange={(v) => updateGeometry({ y: v }, "y")} unit="px" />
              <SliderField label="Width" value={single.width} min={single.type === "line" ? 0 : 1} max={ARTBOARD_MAX} step={1} onChange={(v) => updateGeometry({ width: Math.max(single.type === "line" ? 0 : 1, v) }, "w")} unit="px" />
              <SliderField label="Height" value={single.height} min={single.type === "line" ? 0 : 1} max={ARTBOARD_MAX} step={1} onChange={(v) => updateGeometry({ height: Math.max(single.type === "line" ? 0 : 1, v) }, "h")} unit="px" />
              <SliderField label="Rotation" value={single.rotation} min={-180} max={180} step={1} bigStep={15} onChange={(v) => updateGeometry({ rotation: v }, "rot")} unit="°" />
              <SliderField label="Opacity" value={single.opacity} min={0} max={1} step={0.01} onChange={(v) => updateGeometry({ opacity: v }, "opacity")} />
            </div>
          </Section>

          <Section title="Visibility & Lock" defaultOpen>
            <div className="space-y-2.5">
              <ToggleRow label="Visible" checked={single.visible} onChange={(v) => updateGeometry({ visible: v }, "visible")} />
              <ToggleRow label="Locked" checked={single.locked} onChange={(v) => updateGeometry({ locked: v }, "locked")} tooltip="Locked elements can't be selected or edited on the canvas" />
            </div>
          </Section>

          {single.type === "icon-grid" && <GridSection el={single} />}
          {single.type === "text" && <TextSection el={single} doc={doc} autoFocus={focusTextId === single.id} />}
          {(single.type === "rectangle" ||
            single.type === "rounded-rectangle" ||
            single.type === "circle" ||
            single.type === "ellipse" ||
            single.type === "line" ||
            single.type === "polygon") && <ShapeSection el={single} />}
          {single.type === "svg" && <SvgSection el={single} />}
          {single.type === "background" && (
            <Section title="Background" icon={<Layers className="h-4 w-4" />} defaultOpen>
              <div className="space-y-2.5">
                <ColorField label="Fill" value={(single.properties as { fill: string }).fill ?? "#FFFFFF"} onChange={(v) => store.updateElementProps(single.id, { fill: v }, { label: "Background change", key: `bg:${single.id}` })} />
                <p className="pro-help">The artboard background color stays in sync with this layer.</p>
              </div>
            </Section>
          )}

          {/* hero area explainer + factory reset (role: hero) — the hero
           * element IS the hero background + centered icon slot (§7/§8/§47).
           * P5: the published slot is the element's rotated bounding box and
           * the Studio fits the icon INSIDE it via the shared hero-fit
           * engine (padding-aware, uniform scale, centered). */}
          {single.role === "hero" && (
            <Section title="Hero Area" icon={<Sparkles className="h-4 w-4" />} defaultOpen>
              <div className="space-y-2.5">
                <InfoLine label="Slot size" value={`${Math.round(single.width)} × ${Math.round(single.height)} px${Math.abs(single.rotation) > 1e-6 ? " (rotated → bounding box)" : ""}`} />
                <InfoLine label="Icon placement" value="Centered · uniformly scaled to fit" />
                <p className="pro-help">
                  In the Studio, the sheet's hero icon is drawn centered inside this area and uniformly
                  scaled so it always fits (aspect preserved — never distorted, never cropped); each sheet
                  can add inner padding and turn the hero on or off per sheet. Style the element below as
                  the hero background (fill, stroke, corner radius). Changing the hero icon later only
                  swaps the icon; this background stays exactly as designed.
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 w-full gap-1.5 text-[11px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
                  disabled={single.locked}
                  onClick={() => {
                    const fresh = createHeroElement(doc.artboard);
                    store.updateElements(
                      [single.id],
                      {
                        x: fresh.x,
                        y: fresh.y,
                        width: fresh.width,
                        height: fresh.height,
                        rotation: 0,
                        opacity: 1,
                        properties: fresh.properties,
                      },
                      { label: "Reset hero" }
                    );
                  }}
                  title="Restore the hero placeholder's default position, size and styling — the icon grid is never touched"
                >
                  <RotateCcw className="h-3.5 w-3.5" aria-hidden />
                  Reset hero
                </Button>
              </div>
            </Section>
          )}
        </>
      ) : (
        <Section title={`${selected.length} Elements Selected`} icon={<Layers className="h-4 w-4" />} defaultOpen>
          <div className="space-y-2.5">
            <InfoLine label="Selection size" value={bbox ? `${Math.round(bbox.width)} × ${Math.round(bbox.height)} px` : "—"} />
            <InfoLine label="Editable" value={`${editableIds.length} of ${selected.length} (locked skipped)`} />
          </div>
        </Section>
      )}

      {!allLocked && <AlignSection count={selected.length} />}

      {/* validation for the selected element(s) */}
      {single &&
        issues
          .filter((i) => i.elementId === single.id)
          .slice(0, 4)
          .map((issue, i) => (
            <ValidationNote key={i} level={issue.level}>
              {issue.message}
            </ValidationNote>
          ))}

      {/* actions */}
      <Section title="Actions" defaultOpen>
        <ActionGrid>
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1.5 text-[11px]"
            disabled={selected.length === 0}
            onClick={() => store.duplicateElements(selection)}
          >
            <Copy className="h-3.5 w-3.5" />
            Duplicate
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1.5 border-destructive/40 text-[11px] text-destructive hover:bg-destructive/10 hover:text-destructive"
            disabled={selected.length === 0}
            onClick={() => store.deleteElements(selection)}
          >
            <Trash2 className="h-3.5 w-3.5" />
            Delete
          </Button>
        </ActionGrid>
        <p className="pro-help">
          Ctrl+D duplicates · Delete removes · Ctrl+Z / Ctrl+Shift+Z undo & redo — deletion is always undoable.
        </p>
      </Section>
    </div>
  );
}
