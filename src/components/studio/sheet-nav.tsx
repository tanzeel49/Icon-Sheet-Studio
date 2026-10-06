"use client";

/**
 * ICON SHEET STUDIO — Sheet navigation (left sidebar).
 * Compact sheet list with keyboard navigation (ArrowUp/ArrowDown/Enter/Space),
 * drag-and-drop reordering (dnd-kit, pointer + keyboard sensors) and a
 * duplicate action per row. Up/down buttons remain as a click fallback.
 */

import { useEffect, useRef, useState } from "react";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useStudio } from "@/lib/studio/store";
import { markDragEnd } from "@/lib/studio/drag-gate";
import { sheetTemplate } from "@/lib/studio/templates";
import { formatVolume, sheetTitle, type Sheet } from "@/lib/studio/types";
import { cn } from "@/lib/utils";
import { ChevronDown, ChevronUp, Copy, Dices, GripVertical } from "lucide-react";

function SheetRow({
  sheet,
  index,
  totalSheets,
  isActive,
  isSelected,
}: {
  sheet: Sheet;
  index: number;
  totalSheets: number;
  isActive: boolean;
  isSelected: boolean;
}) {
  const setActiveSheet = useStudio((s) => s.setActiveSheet);
  const toggleSheetSelected = useStudio((s) => s.toggleSheetSelected);
  const setViewMode = useStudio((s) => s.setViewMode);
  const randomizeSheet = useStudio((s) => s.randomizeSheet);
  const moveSheet = useStudio((s) => s.moveSheet);
  const duplicateSheet = useStudio((s) => s.duplicateSheet);
  const capacity = sheetTemplate(sheet)?.capacity ?? sheet.iconIds.length;
  const full = sheet.iconIds.length >= capacity;

  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: sheet.id,
  });

  const fillPct = capacity > 0 ? Math.min(100, (sheet.iconIds.length / capacity) * 100) : 0;

  return (
    <div
      ref={setNodeRef}
      id={`sheet-row-${sheet.id}`}
      role="listitem"
      aria-current={isActive ? "true" : undefined}
      tabIndex={isActive ? 0 : -1}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
      }}
      onClick={() => {
        setActiveSheet(sheet.id);
        setViewMode("edit");
      }}
      onKeyDown={(e) => {
        if (e.key === " " || e.key === "Enter") {
          e.preventDefault();
          setActiveSheet(sheet.id);
          setViewMode("edit");
        }
      }}
      className={cn(
        "sheet-nav-row studio-lift group relative w-full rounded-lg border px-2.5 py-2.5 text-left cursor-pointer outline-none",
        "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
        isActive
          ? "border-amber-500/25 bg-amber-500/[0.07] hover:bg-amber-500/[0.11]"
          : "border-border/60 dark:border-border bg-card/60 hover:border-border hover:bg-muted/50 hover:shadow-sm hover:shadow-black/10 dark:hover:shadow-black/40",
        isDragging && "z-20 opacity-85 border-amber-500/50 shadow-lg ring-2 ring-amber-500/25 cursor-grabbing"
      )}
    >
      {isActive && !isDragging && <span className="sheet-row-active-rail absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-full" aria-hidden />}
      <div className="flex items-center justify-between gap-2">
        <span className={cn("text-[12px] font-semibold tracking-tight flex items-center gap-1 min-w-0", isActive ? "text-foreground" : "text-foreground/90")}>
          <button
            ref={setActivatorNodeRef}
            {...attributes}
            {...listeners}
            type="button"
            aria-label={`Reorder sheet ${index + 1} (drag or press Space, then arrow keys)`}
            title="Drag to reorder — or focus and use Space + arrows"
            className={cn(
              "h-4 w-4 -ml-1 shrink-0 grid place-items-center rounded text-muted-foreground/0 transition-all cursor-grab active:cursor-grabbing",
              "hover:text-muted-foreground focus-visible:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring rounded-sm outline-none",
              "group-hover:text-muted-foreground/70 active:ring-1 active:ring-amber-500/40"
            )}
            onClick={(e) => e.stopPropagation()}
          >
            <GripVertical className="h-3 w-3" />
          </button>
          {/* round 22 · fix: the title owns the header line now — the count
              chip moved to the metadata line below, so "Sheet 01" never
              squeezes to "Shee…" even beside all four action buttons. */}
          <span className="truncate" title={sheetTitle(sheet, index)}>{sheetTitle(sheet, index)}</span>
        </span>
        <div className="flex items-center gap-1">
          <div className="flex items-center rounded-md border border-transparent hover:border-border dark:hover:border-muted overflow-hidden opacity-60 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
            <button
              type="button"
              aria-label={`Move sheet ${index + 1} up`}
              title="Move sheet up"
              disabled={index === 0}
              className="h-5 w-5 grid place-items-center text-muted-foreground/70 hover:text-foreground hover:bg-muted disabled:opacity-25 disabled:hover:bg-transparent transition"
              onClick={(e) => {
                e.stopPropagation();
                moveSheet(sheet.id, -1);
              }}
            >
              <ChevronUp className="h-3 w-3" />
            </button>
            <button
              type="button"
              aria-label={`Move sheet ${index + 1} down`}
              title="Move sheet down"
              disabled={index === totalSheets - 1}
              className="h-5 w-5 grid place-items-center text-muted-foreground/70 hover:text-foreground hover:bg-muted disabled:opacity-25 disabled:hover:bg-transparent transition"
              onClick={(e) => {
                e.stopPropagation();
                moveSheet(sheet.id, 1);
              }}
            >
              <ChevronDown className="h-3 w-3" />
            </button>
            <button
              type="button"
              aria-label={`Randomize sheet ${index + 1} icon order`}
              title="Randomize icon order (hero and library order stay intact)"
              /* container-query disclosure: hidden when the sidebar is narrow
               * (<236px) so renamed long titles keep their room; still
               * reachable from the overview card's quick actions. Round 22
               * lowered the gate from 252px — the count chip moving to the
               * metadata line freed its header space. */
              className="hidden @min-[236px]:grid h-5 w-5 place-items-center rounded text-muted-foreground hover:text-foreground hover:bg-muted transition"
              onClick={(e) => {
                e.stopPropagation();
                randomizeSheet(sheet.id);
              }}
            >
              <Dices className="h-3 w-3" />
            </button>
            <button
              type="button"
              aria-label={`Duplicate sheet ${index + 1} design`}
              title="Duplicate this sheet's design into a new empty sheet"
              className="hidden @min-[236px]:grid h-5 w-5 place-items-center rounded text-muted-foreground hover:text-foreground hover:bg-muted transition"
              onClick={(e) => {
                e.stopPropagation();
                duplicateSheet(sheet.id);
              }}
            >
              <Copy className="h-3 w-3" />
            </button>
          </div>
          <button
            type="button"
            aria-label={isSelected ? `Remove sheet ${index + 1} from selection` : `Add sheet ${index + 1} to selection`}
            title={isSelected ? "Remove from selection" : "Add to selection"}
            className={cn(
              "h-3.5 w-3.5 rounded border grid place-items-center transition",
              isSelected
                ? "bg-amber-500 border-amber-500 text-amber-50"
                : "border-muted-foreground/40 hover:border-foreground/60 text-transparent"
            )}
            onClick={(e) => {
              e.stopPropagation();
              toggleSheetSelected(sheet.id);
            }}
          >
            <svg viewBox="0 0 24 24" className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth="4">
              <path d="M20 6L9 17l-5-5" />
            </svg>
          </button>
        </div>
      </div>
      <div className="mt-0.5 flex items-center gap-1.5 min-w-0 pl-3">
        <span className="hint-text text-[10px] truncate" title={sheet.category}>{sheet.category}</span>
        <span className="text-[10px] text-muted-foreground/50">·</span>
        <span className="hint-text font-mono text-[10px] shrink-0">{formatVolume(sheet.volume)}</span>
        {/* round 22 · moved from the header line: the count chip is metadata
            (same family as category · volume) and its header space was
            squeezing the sheet title to "Shee…". mono chip styling kept. */}
        <span
          title={`${sheet.iconIds.length} of ${capacity} cells in use`}
          className={cn(
            "ml-auto shrink-0 rounded border px-1 py-px font-mono text-[10px] tabular-nums leading-4 transition-colors",
            full
              ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/15 dark:text-amber-400"
              : "border-border/70 bg-muted/40 text-muted-foreground dark:text-muted-foreground"
          )}
        >
          {sheet.iconIds.length}/{capacity}
        </span>
      </div>
      {/* fill-level progress — thin bottom rail, amber as the sheet fills */}
      <div
        className="absolute inset-x-2.5 bottom-0 h-[2px] overflow-hidden rounded-full bg-border/50"
        title={`${sheet.iconIds.length} of ${capacity} cells filled — ${capacity - sheet.iconIds.length} free`}
        role="presentation"
      >
        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-300",
            full ? "bg-amber-500" : fillPct > 60 ? "bg-amber-500/70" : "bg-muted-foreground/40",
          )}
          style={{ width: `${fillPct}%` }}
        />
      </div>
    </div>
  );
}

export function SheetNav() {
  const sheets = useStudio((s) => s.sheets);
  const activeSheetId = useStudio((s) => s.activeSheetId);
  const selectedSheetIds = useStudio((s) => s.selectedSheetIds);
  const setActiveSheet = useStudio((s) => s.setActiveSheet);
  const reorderSheet = useStudio((s) => s.reorderSheet);
  const containerRef = useRef<HTMLDivElement>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);

  // clicks still work: a 6px drag threshold before a drag activates
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  // keep the active row in view when navigating by keyboard
  useEffect(() => {
    if (!activeSheetId) return;
    const el = document.getElementById(`sheet-row-${activeSheetId}`);
    el?.scrollIntoView({ block: "nearest" });
  }, [activeSheetId]);

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    // let the drag handle's own keyboard sensor handle arrows while dragging
    if (draggingId) return;
    e.preventDefault();
    const idx = sheets.findIndex((s) => s.id === activeSheetId);
    const next = e.key === "ArrowDown" ? Math.min(idx + 1, sheets.length - 1) : Math.max(idx - 1, 0);
    if (idx !== next && sheets[next]) {
      setActiveSheet(sheets[next].id);
      requestAnimationFrame(() => document.getElementById(`sheet-row-${sheets[next].id}`)?.focus());
    }
  }

  function handleDragEnd(event: DragEndEvent) {
    setDraggingId(null);
    markDragEnd(); // swallow the trailing click on the row
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = sheets.findIndex((s) => s.id === active.id);
    const newIndex = sheets.findIndex((s) => s.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    reorderSheet(String(active.id), newIndex);
  }

  if (sheets.length === 0) {
    return (
      <div className="px-3 py-8 text-center">
        <p className="text-[11px] text-muted-foreground">No sheets yet.</p>
        <p className="text-[11px] hint-text mt-1">Generate sheets from your library to begin.</p>
      </div>
    );
  }

  return (
    <div ref={containerRef} onKeyDown={handleKeyDown} className="flex flex-col gap-1.5 p-2.5 outline-none">
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={({ active }) => setDraggingId(String(active.id))}
        onDragCancel={() => setDraggingId(null)}
        onDragEnd={handleDragEnd}
      >
        {/* display:contents — the list carries the ARIA role while the rows
         * stay flex items of the padded container; dnd-kit's internal
         * screen-reader divs land OUTSIDE the role="list" (axe fix) */}
        <div role="list" aria-label="Sheets" className="contents">
          <SortableContext items={sheets.map((s) => s.id)} strategy={verticalListSortingStrategy}>
            {sheets.map((sheet, i) => (
              <SheetRow
                key={sheet.id}
                sheet={sheet}
                index={i}
                totalSheets={sheets.length}
                isActive={sheet.id === activeSheetId}
                isSelected={selectedSheetIds.includes(sheet.id)}
              />
            ))}
          </SortableContext>
        </div>
      </DndContext>
      {/* hint lives outside the role="list" (axe aria-required-children) */}
      {sheets.length > 1 ? (
        <p className="sr-only">Drag the grip handle, or use the up and down buttons, to reorder sheets.</p>
      ) : null}
    </div>
  );
}
