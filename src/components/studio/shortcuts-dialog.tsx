"use client";

/**
 * ICON SHEET STUDIO — Keyboard shortcuts help dialog.
 * Documents every global shortcut in one place (opened via `?` key or the
 * header help button). Shortcuts are implemented in studio-app.tsx.
 */

import type { JSX } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { MousePointerClick, Sheet as SheetIcon, Eye, HardDrive, Grid2x2, Scan } from "lucide-react";

interface Shortcut {
  keys: string[];
  label: string;
}

interface ShortcutGroup {
  title: string;
  icon: typeof Eye;
  shortcuts: Shortcut[];
}

const GROUPS: ShortcutGroup[] = [
  {
    title: "Workspace",
    icon: Eye,
    shortcuts: [
      { keys: ["Ctrl", "K"], label: "Command palette — search everything, run any action" },
      { keys: ["1"], label: "Overview mode" },
      { keys: ["2"], label: "Edit mode (active sheet)" },
      { keys: ["[", "]"], label: "Previous / next sheet (wraps, jumps to edit)" },
      { keys: ["Ctrl", "D"], label: "Duplicate the active sheet's design into a new sheet" },
      { keys: ["G"], label: "Toggle grid guides" },
      { keys: ["E"], label: "Open export dialog" },
      { keys: ["?"], label: "Show this shortcut list" },
    ],
  },
  {
    title: "Command palette",
    icon: Eye,
    shortcuts: [
      { keys: ["↑", "↓"], label: "Move through results (skips disabled)" },
      { keys: ["↵"], label: "Run the active result" },
      { keys: ["#N", "query"], label: "Scope icon results to sheet N — e.g. “#2 arrow”" },
      { keys: ["#tag", "query"], label: "Scope to a tag — e.g. “#navigation arrow”" },
      { keys: ["#unassigned"], label: "Scope to icons not yet on any sheet" },
    ],
  },
  {
    title: "Icon inspector",
    icon: Scan,
    shortcuts: [
      { keys: ["←", "→"], label: "Step through icons in the current list (wraps)" },
      { keys: ["Esc"], label: "Close the inspector" },
    ],
  },
  {
    title: "Library grid",
    icon: Grid2x2,
    shortcuts: [
      { keys: ["↑", "↓", "←", "→"], label: "Walk tiles by row / column (density-aware)" },
      { keys: ["Home", "End"], label: "Jump to the first / last tile" },
      { keys: ["Tab"], label: "Enter / leave the grid in one press (roving focus)" },
      { keys: ["Enter", "Space"], label: "Toggle selection of the focused tile" },
      { keys: ["I"], label: "Inspect the focused tile" },
    ],
  },
  {
    title: "History",
    icon: HardDrive,
    shortcuts: [
      { keys: ["Ctrl", "Z"], label: "Undo" },
      { keys: ["Ctrl", "⇧", "Z"], label: "Redo" },
    ],
  },
  {
    title: "Zoom & pan (edit mode)",
    icon: SheetIcon,
    shortcuts: [
      { keys: ["F"], label: "Fit sheet to screen" },
      { keys: ["+"], label: "Zoom in" },
      { keys: ["–"], label: "Zoom out" },
      { keys: ["Ctrl", "Scroll"], label: "Smooth zoom in/out over the sheet canvas" },
      { keys: ["Space", "Drag"], label: "Hold Space and drag to pan the sheet canvas" },
    ],
  },
  {
    title: "Icon cells (edit mode)",
    icon: Grid2x2,
    shortcuts: [
      { keys: ["↑", "↓", "←", "→"], label: "Move focus between cells" },
      { keys: ["Tab"], label: "Enter / leave the grid in one press (roving focus)" },
      { keys: ["Alt", "←", "→"], label: "Nudge the focused icon left/right (undoable)" },
      { keys: ["Alt", "↑", "↓"], label: "Nudge the focused icon up/down (undoable)" },
      { keys: ["Enter", "Space"], label: "Select the focused cell" },
      { keys: ["2×Click"], label: "Inspect the clicked icon" },
    ],
  },
  {
    title: "Sheets list",
    icon: MousePointerClick,
    shortcuts: [
      { keys: ["↑", "↓"], label: "Move between sheets" },
      { keys: ["Enter", "Space"], label: "Open the focused sheet" },
      { keys: ["Space*"], label: "Lift a row in the drag handle, arrows to move, Space to drop" },
      { keys: ["Esc"], label: "Clear the multi-sheet selection (batch design-apply)" },
    ],
  },
];

export function ShortcutsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }): JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md max-h-[85vh] flex flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b border-border/70 px-5 pt-5 pb-3">
          <DialogTitle className="flex items-center gap-2 text-[15px] font-semibold tracking-tight">
            <span className="studio-dlg-tile">
              <MousePointerClick className="h-4 w-4" aria-hidden="true" />
            </span>
            Keyboard shortcuts
          </DialogTitle>
          <DialogDescription className="text-xs">
            Shortcuts are ignored while typing in any input. macOS: use ⌘ where Ctrl is shown.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto custom-scroll px-5 py-4">
          <div className="grid gap-4">
            {GROUPS.map((group) => (
              <section key={group.title} aria-label={group.title}>
                <h3 className="studio-group-label mb-1.5 flex items-center gap-1.5">
                  <group.icon className="h-3 w-3" aria-hidden="true" />
                  {group.title}
                </h3>
                <ul className="sc-list divide-y divide-border/50 rounded-md border border-border/60 dark:divide-border/80 dark:border-border">
                  {group.shortcuts.map((s) => (
                    <li
                      key={s.label}
                      className="sc-row flex items-center justify-between gap-3 px-2.5 py-1.5 text-[12px] transition-colors duration-150 hover:bg-muted/60"
                    >
                      <span className="text-foreground/90">{s.label}</span>
                      <span className="flex items-center gap-1 shrink-0">
                        {s.keys.map((k) => (
                          <kbd key={k} className="kbd-chip">
                            {k}
                          </kbd>
                        ))}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
