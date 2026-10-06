"use client";

/**
 * ICON SHEET STUDIO — Left sidebar.
 * Tabs: Sheet navigation · Icon Library (upload/search/move).
 *
 * The tab strip is implemented directly (not via Radix Tabs) so its
 * id/aria-controls wiring uses DETERMINISTIC ids ("sidebar-tab-*").
 * React's useId — which Radix Tabs uses for baseId — encodes the fiber
 * tree position, so any change to the number of siblings above this
 * subtree (dialogs mounted in the shell, etc.) silently shifts every
 * generated id and surfaces as a hydration attribute mismatch the next
 * time a browser hydrates stale HTML against newer code. Deterministic
 * ids make the markup stable across renders, HMR and future tree
 * changes. DOM shape, classes, roving-tabindex keyboard behavior and
 * ARIA semantics mirror the Radix/shadcn output exactly; each Sidebar
 * instance (desktop rail + mobile drawer) namespaces its ids via
 * idPrefix so two instances never collide in the DOM.
 */

import { useRef } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { Layers, Library } from "lucide-react";
import { cn } from "@/lib/utils";
import { SheetNav } from "./sheet-nav";
import { IconLibraryPanel } from "./icon-library";
import { useStudio } from "@/lib/studio/store";

const TAB_ITEMS = [
  { value: "sheets", label: "Sheets", Icon: Layers },
  { value: "library", label: "Library", Icon: Library },
] as const;

type TabValue = (typeof TAB_ITEMS)[number]["value"];

/* shadcn/ui tabs base classes — kept verbatim so the merged output is
 * identical to what the Radix-backed components produced. */
const TABS_BASE = "flex flex-col gap-2";
const TABS_LIST_BASE =
  "bg-muted text-muted-foreground inline-flex h-9 w-fit items-center justify-center rounded-lg p-[3px] ring-1 ring-border/60";
const TABS_TRIGGER_BASE =
  "data-[state=active]:bg-background dark:data-[state=active]:text-foreground focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:outline-ring dark:data-[state=active]:border-input dark:data-[state=active]:bg-input/30 text-foreground dark:text-muted-foreground inline-flex h-[calc(100%-1px)] flex-1 items-center justify-center gap-1.5 rounded-md border border-transparent px-2 py-1 text-sm font-medium whitespace-nowrap transition-[color,box-shadow] focus-visible:ring-[3px] focus-visible:outline-1 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:shadow-sm [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4";
const TABS_CONTENT_BASE = "flex-1 outline-none";

export function Sidebar({ idPrefix = "sidebar" }: { idPrefix?: string }) {
  const sheetCount = useStudio((s) => s.sheets.length);
  const iconCount = useStudio((s) => s.iconOrder.length);
  const tab = useStudio((s) => s.sidebarTab);
  const setTab = useStudio((s) => s.setSidebarTab);
  const listRef = useRef<HTMLDivElement>(null);

  const selectTab = (value: TabValue) => {
    setTab(value === "library" ? "library" : "sheets");
  };

  /* roving tabindex + automatic activation, mirroring Radix Tabs
   * (horizontal): arrows wrap, Home/End jump, focus follows selection */
  const handleListKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement | null;
    if (!target || target.getAttribute("role") !== "tab") return;
    const idx = TAB_ITEMS.findIndex((t) => t.value === tab);
    let next: number;
    switch (e.key) {
      case "ArrowRight":
      case "ArrowDown":
        next = (idx + 1) % TAB_ITEMS.length;
        break;
      case "ArrowLeft":
      case "ArrowUp":
        next = (idx - 1 + TAB_ITEMS.length) % TAB_ITEMS.length;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = TAB_ITEMS.length - 1;
        break;
      default:
        return;
    }
    e.preventDefault();
    const value = TAB_ITEMS[next].value;
    if (value !== tab) selectTab(value);
    const buttons = listRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    buttons?.[next]?.focus();
  };

  const tabId = (value: TabValue) => `${idPrefix}-tab-${value}`;
  const panelId = (value: TabValue) => `${idPrefix}-tabpanel-${value}`;

  return (
    <div className="h-full w-full min-w-0 flex flex-col bg-background">
      <div
        dir="ltr"
        data-orientation="horizontal"
        data-slot="tabs"
        className={cn(TABS_BASE, "h-full flex flex-col data-[orientation=vertical]:flex-col")}
      >
        <div className="shrink-0 border-b border-border/70 px-3 pt-3 pb-2.5">
          <div
            ref={listRef}
            role="tablist"
            aria-orientation="horizontal"
            data-slot="tabs-list"
            onKeyDown={handleListKeyDown}
            className={cn(TABS_LIST_BASE, "grid grid-cols-2 w-full h-8")}
          >
            {TAB_ITEMS.map(({ value, label, Icon }) => {
              const active = tab === value;
              const count = value === "sheets" ? sheetCount : iconCount;
              return (
                <button
                  key={value}
                  type="button"
                  role="tab"
                  id={tabId(value)}
                  aria-selected={active}
                  aria-controls={panelId(value)}
                  data-state={active ? "active" : "inactive"}
                  data-slot="tabs-trigger"
                  tabIndex={active ? 0 : -1}
                  className={cn(TABS_TRIGGER_BASE, "studio-tab text-[11px] gap-1.5")}
                  onClick={() => selectTab(value)}
                >
                  <Icon className="h-3 w-3" aria-hidden="true" />
                  {label}
                  {count > 0 && (
                    <span className="studio-tab-count">
                      {value === "library" && count > 999 ? `${(count / 1000).toFixed(1)}k` : count}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        <div
          role="tabpanel"
          id={panelId("sheets")}
          aria-labelledby={tabId("sheets")}
          data-state={tab === "sheets" ? "active" : "inactive"}
          data-slot="tabs-content"
          tabIndex={0}
          hidden={tab !== "sheets"}
          className={cn(TABS_CONTENT_BASE, "flex-1 min-h-0 m-0 overflow-y-auto custom-scroll")}
        >
          {tab === "sheets" ? <SheetNav /> : null}
        </div>

        <div
          role="tabpanel"
          id={panelId("library")}
          aria-labelledby={tabId("library")}
          data-state={tab === "library" ? "active" : "inactive"}
          data-slot="tabs-content"
          tabIndex={0}
          hidden={tab !== "library"}
          className={cn(TABS_CONTENT_BASE, "flex-1 min-h-0 m-0 overflow-hidden")}
        >
          {tab === "library" ? <IconLibraryPanel /> : null}
        </div>
      </div>
    </div>
  );
}
