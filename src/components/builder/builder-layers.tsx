"use client";

/**
 * ICON SHEET STUDIO — TEMPLATE BUILDER (Phase 1) · layers panel.
 *
 * The document is the source of truth — this panel only READS
 * doc.elements (rendered top-first) and dispatches store actions:
 * select / multi-select, visibility, locking, rename, z-order.
 */

import { useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  BringToFront,
  Circle,
  CircleDashed,
  Eye,
  EyeOff,
  FileCode2,
  Frame,
  LayoutGrid,
  Lock,
  Minus,
  RectangleHorizontal,
  SendToBack,
  Square,
  Triangle,
  Type,
  Unlock,
} from "lucide-react";
import { useBuilderStore, getActiveDoc } from "@/lib/builder/store";
import { roleLabel, type BuilderElementType } from "@/lib/builder/types";
import { cn } from "@/lib/utils";

const TYPE_ICONS: Record<BuilderElementType, typeof Square> = {
  background: Frame,
  "icon-grid": LayoutGrid,
  text: Type,
  rectangle: Square,
  "rounded-rectangle": RectangleHorizontal,
  circle: Circle,
  ellipse: CircleDashed,
  line: Minus,
  polygon: Triangle,
  svg: FileCode2,
};

export function BuilderLayersPanel() {
  const docs = useBuilderStore((s) => s.docs);
  const activeDocId = useBuilderStore((s) => s.activeDocId);
  const selection = useBuilderStore((s) => s.selection);
  const setSelection = useBuilderStore((s) => s.setSelection);
  const toggleSelection = useBuilderStore((s) => s.toggleSelection);
  const updateElements = useBuilderStore((s) => s.updateElements);
  const reorderElements = useBuilderStore((s) => s.reorderElements);
  const doc = docs.find((d) => d.id === activeDocId) ?? null;

  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");

  /* top-first rendering (array index = z, 0 = bottom) */
  const layers = doc ? [...doc.elements].reverse() : [];
  const hasSelection = selection.length > 0;

  const commitRename = (id: string): void => {
    const name = renameDraft.trim().slice(0, 120);
    setRenamingId(null);
    if (doc && name) updateElements([id], { name }, { label: "Rename element" });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        className="builder-layers min-h-0 flex-1 overflow-y-auto custom-scroll"
        role="listbox"
        aria-label="Layers — topmost first"
        aria-multiselectable="true"
      >
        {layers.length === 0 ? (
          <p className="px-2 py-6 text-center text-[11px] leading-relaxed text-muted-foreground">
            No layers yet — objects you add appear here, topmost first.
          </p>
        ) : (
          layers.map((el) => {
            const Icon = TYPE_ICONS[el.type] ?? Square;
            const selected = selection.includes(el.id);
            return (
              <div
                key={el.id}
                role="option"
                aria-selected={selected}
                tabIndex={0}
                onClick={(e) => {
                  if (e.shiftKey) toggleSelection(el.id);
                  else setSelection([el.id]);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    if (e.shiftKey) toggleSelection(el.id);
                    else setSelection([el.id]);
                  }
                }}
                onDoubleClick={() => {
                  setRenamingId(el.id);
                  setRenameDraft(el.name);
                }}
                className={cn(
                  "group flex items-center gap-1.5 border-b border-border/40 px-2 py-1.5 text-[11.5px] outline-none transition-colors",
                  selected
                    ? "bg-amber-500/10 hover:bg-amber-500/15"
                    : "hover:bg-muted/60 focus-visible:bg-muted/60",
                  !el.visible && "opacity-45"
                )}
              >
                {/* visibility */}
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    updateElements([el.id], { visible: !el.visible }, { label: el.visible ? "Hide layer" : "Show layer" });
                  }}
                  className={cn(
                    "grid size-5 shrink-0 place-items-center rounded text-muted-foreground/70 hover:bg-muted hover:text-foreground",
                    !el.visible && "text-amber-600"
                  )}
                  aria-label={el.visible ? `Hide ${el.name}` : `Show ${el.name}`}
                  title={el.visible ? "Hide layer" : "Show layer"}
                >
                  {el.visible ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
                </button>

                {/* lock */}
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    updateElements([el.id], { locked: !el.locked }, { label: el.locked ? "Unlock layer" : "Lock layer" });
                  }}
                  className={cn(
                    "grid size-5 shrink-0 place-items-center rounded text-muted-foreground/70 hover:bg-muted hover:text-foreground",
                    el.locked && "text-amber-600"
                  )}
                  aria-label={el.locked ? `Unlock ${el.name}` : `Lock ${el.name}`}
                  title={el.locked ? "Unlock layer" : "Lock layer"}
                >
                  {el.locked ? <Lock className="size-3.5" /> : <Unlock className="size-3.5 opacity-0 group-hover:opacity-100 focus-visible:opacity-100" />}
                </button>

                <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />

                {/* name / rename */}
                {renamingId === el.id ? (
                  <input
                    autoFocus
                    value={renameDraft}
                    onChange={(e) => setRenameDraft(e.target.value)}
                    onBlur={() => commitRename(el.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        commitRename(el.id);
                      } else if (e.key === "Escape") {
                        e.preventDefault();
                        e.stopPropagation();
                        setRenamingId(null);
                      }
                    }}
                    onClick={(e) => e.stopPropagation()}
                    className="h-6 min-w-0 flex-1 rounded border border-ring/50 bg-background px-1.5 text-[11.5px] outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                    aria-label="Layer name"
                    maxLength={120}
                  />
                ) : (
                  <span className="min-w-0 flex-1 truncate" title={`${el.name} — double-click to rename`}>
                    {el.name}
                  </span>
                )}

                {/* semantic role chip */}
                <span
                  className={cn(
                    "shrink-0 rounded px-1 py-px text-[9px] font-medium uppercase tracking-wide",
                    el.role === "hero"
                      ? "bg-amber-500/15 text-amber-700 dark:text-amber-400"
                      : el.role === "icon-grid"
                        ? "bg-foreground/10 text-foreground"
                        : el.role === "category" || el.role === "icon-count" || el.role === "volume" || el.role === "descriptor"
                          ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
                          : "bg-muted text-muted-foreground"
                  )}
                  title={`Role: ${roleLabel(el.role)}`}
                >
                  {roleLabel(el.role)}
                </span>
              </div>
            );
          })
        )}
      </div>

      {/* z-order controls */}
      <div className="flex shrink-0 items-center justify-between gap-1 border-t border-border bg-background px-1.5 py-1.5">
        <span className="px-1 font-mono text-[10px] tabular-nums text-muted-foreground">
          {layers.length} layer{layers.length === 1 ? "" : "s"}
        </span>
        <div className="flex items-center gap-0.5">
          {(
            [
              { action: "front" as const, icon: BringToFront, label: "Bring to front" },
              { action: "up" as const, icon: ArrowUp, label: "Move up one layer" },
              { action: "down" as const, icon: ArrowDown, label: "Move down one layer" },
              { action: "back" as const, icon: SendToBack, label: "Send to back" },
            ]
          ).map(({ action, icon: Icon, label }) => (
            <button
              key={action}
              type="button"
              disabled={!hasSelection}
              onClick={() => reorderElements(selection, action)}
              className="grid size-6 place-items-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-35"
              aria-label={label}
              title={label}
            >
              <Icon className="size-3.5" />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
