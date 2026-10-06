"use client";

/**
 * ICON SHEET STUDIO — Space + drag canvas panning (professional editor pan).
 *
 * Behavior contract (mirrors Figma / Photoshop / Illustrator):
 *   · HOLD Space              → pan mode ARMED: canvas cursor = `grab` and
 *                              every sheet/cell child becomes hit-test inert
 *                              (no icon selection, no dnd-kit rearrange, no
 *                              artboard activation — the pointer belongs to
 *                              the canvas alone).
 *   · Space + left-drag       → 1:1 viewport pan (cursor = `grabbing`). The
 *                              drag delta is raw viewport pixels applied to
 *                              scrollLeft/scrollTop, so the feel is identical
 *                              at 100% and 500% zoom — content follows the
 *                              mouse, no jumping on pan start.
 *   · release mouse           → pan stops, scroll position kept.
 *   · release Space           → pan mode exits, normal editing + cursors return.
 *
 * Safety rails:
 *   · typing spaces in inputs / textareas / contentEditable never engages pan
 *   · open dialogs / menus / listboxes keep their native Space semantics
 *   · focused native buttons keep their DOCUMENTED Space-tap activation
 *     (cell select, tile select, sheet-list lift) — keydown is not cancelled
 *     there; but a completed pan session swallows the trailing click (mouse
 *     or Space-keyup activation) through a canvas-level click gate, so a pan
 *     never double-fires a selection
 *   · window blur / tab hide always reset pan mode (no stuck grab cursor)
 *   · keyboard auto-repeat never churns state
 *   · wheel zoom + numeric-input wheel adjustments are untouched (separate
 *     listeners, separate targets)
 *
 * Integration: attach the returned ref callback to any scrollable canvas
 * element (plus the `pan-canvas` class for cursor styling). All pan state is
 * DOM-attribute driven (`data-pan-mode="armed" | "dragging"`) so cursor flips
 * are synchronous with the keypress — the pan hot path performs ZERO React
 * rendering. Refs persist across listener re-binds, so mid-pan re-renders of
 * the host component are harmless.
 */

import { useCallback, useRef } from "react";

/** Grace window in which clicks (and Space-keyup button activations) right
 *  after a pan session are swallowed — same rationale as the drag-gate:
 *  a pan that ends over a cell must not select / inspect that cell. */
const PAN_CLICK_GRACE_MS = 250;

/** Elements where Space already has an editing meaning (activation). Their
 *  native keydown default is preserved so the documented shortcuts
 *  ("Space — select the focused cell/tile", "Space — lift a sheet row")
 *  keep working when the key is tapped without any drag. */
const BUTTON_SELECTOR =
  "button, [role='button'], [role='option'], [role='tab'], " +
  "[role='menuitem'], [role='switch'], [role='checkbox'], [role='radio'], a[href]";

/** Overlays that own the Space key while open (Radix dialogs, alert-dialogs,
 *  dropdown menus, select listboxes — the command palette included). */
const OVERLAY_SELECTOR = "[role='dialog'], [role='alertdialog'], [role='menu'], [role='listbox']";

/** Text-editable targets — a space here must type a space, nothing else. */
const EDITABLE_SELECTOR =
  "input, textarea, select, [contenteditable='true'], [contenteditable='']";

export function useCanvasPan(): (node: HTMLElement | null) => void {
  const canvasElRef = useRef<HTMLElement | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  /** Space currently held (pan mode armed or dragging). */
  const spaceRef = useRef(false);
  /** Active pan session (null = not dragging). */
  const panRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    scrollLeft: number;
    scrollTop: number;
  } | null>(null);
  /** Timestamp of the last completed pan (trailing-click gate). */
  const lastPanEndRef = useRef(0);

  /**
   * Ref callback — binds the full pan system to the canvas node. React calls
   * it with the element on mount and null on unmount, and it re-binds
   * cleanly if the node is ever swapped. All state lives in refs above, so
   * a re-bind mid-session is lossless.
   */
  const bindCanvasPan = useCallback((node: HTMLElement | null) => {
    /* detach from the previous node first (idempotent) */
    cleanupRef.current?.();
    cleanupRef.current = null;
    canvasElRef.current = node;
    /* leaving pan state behind on node swap would strand the grab cursor */
    spaceRef.current = false;
    panRef.current = null;
    if (!node) return;

    const setPanMode = (mode: "armed" | "dragging" | null): void => {
      const el = canvasElRef.current;
      if (!el) return;
      if (mode) el.dataset.panMode = mode;
      else delete el.dataset.panMode;
    };

    const isEditableTarget = (target: EventTarget | null): boolean => {
      const el = target as HTMLElement | null;
      return !!el && typeof el.closest === "function" && !!el.closest(EDITABLE_SELECTOR);
    };
    const inOverlayTarget = (target: EventTarget | null): boolean => {
      const el = target as HTMLElement | null;
      return !!el && typeof el.closest === "function" && !!el.closest(OVERLAY_SELECTOR);
    };
    const isButtonTarget = (target: EventTarget | null): boolean => {
      const el = target as HTMLElement | null;
      return !!el && typeof el.closest === "function" && !!el.closest(BUTTON_SELECTOR);
    };

    /** End the active drag (if any). Keeps pan mode armed while Space is
     *  still held — releasing the MOUSE only stops the pan, per spec. */
    const endPanDrag = (): void => {
      const el = canvasElRef.current;
      const p = panRef.current;
      if (el && p) {
        try {
          el.releasePointerCapture(p.pointerId);
        } catch {
          /* pointer already released / capture lost — nothing to do */
        }
        lastPanEndRef.current = Date.now();
      }
      panRef.current = null;
      setPanMode(spaceRef.current ? "armed" : null);
    };

    /** Full exit — Space released, window blurred, tab hidden, node gone. */
    const exitPanMode = (): void => {
      spaceRef.current = false;
      endPanDrag();
    };

    /* ---------------- keyboard (global — canvas-scoped state) ---------------- */

    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.code !== "Space") return;
      /* typing spaces is sacred */
      if (isEditableTarget(e.target)) return;
      /* an open dialog / menu owns the Space key */
      if (inOverlayTarget(e.target)) return;
      /* focused buttons keep their Space-tap activation (no cancel); every
       * other target would page-scroll — suppress that. */
      if (!isButtonTarget(e.target)) e.preventDefault();
      /* auto-repeat must not churn state (scroll stays suppressed above) */
      if (e.repeat) return;
      if (spaceRef.current) return;
      spaceRef.current = true;
      setPanMode("armed");
    };

    const onKeyUp = (e: KeyboardEvent): void => {
      if (e.code !== "Space") return;
      /* unconditional restore — even when the matching keydown was ignored
       * (typed in an input, dialog open) so pan mode can never strand. */
      exitPanMode();
    };

    const onBlur = (): void => exitPanMode();
    const onVisibility = (): void => {
      if (document.hidden) exitPanMode();
    };

    /* ---------------- pointer (the canvas itself) ---------------- */

    const onPointerDown = (e: PointerEvent): void => {
      /* left button only, Space must already be held, one pan at a time */
      if (e.button !== 0) return;
      if (!spaceRef.current) return;
      if (panRef.current) return;
      e.preventDefault(); /* no focus steal, no selection seed */
      panRef.current = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        scrollLeft: node.scrollLeft,
        scrollTop: node.scrollTop,
      };
      try {
        node.setPointerCapture(e.pointerId);
      } catch {
        /* synthetic / lost pointers — move/up listeners still track */
      }
      setPanMode("dragging");
    };

    const onPointerMove = (e: PointerEvent): void => {
      const p = panRef.current;
      if (!p || p.pointerId !== e.pointerId) return;
      /* raw viewport-pixel delta → 1:1 scroll: identical feel at every zoom
       * level (content follows the mouse, never jumps, never lags) */
      node.scrollLeft = p.scrollLeft - (e.clientX - p.startX);
      node.scrollTop = p.scrollTop - (e.clientY - p.startY);
    };

    const onPointerEnd = (e: PointerEvent): void => {
      const p = panRef.current;
      if (!p) return;
      if (e.pointerId !== undefined && p.pointerId !== e.pointerId) return;
      endPanDrag();
    };

    /* ---------------- trailing-click gate ---------------- */

    /** A click / dblclick that trails a pan (mouse release, or the keyup
     *  activation of a focused button after dragging) must not select or
     *  inspect anything. Swallowing at the canvas stops it from ever
     *  reaching React's delegated handlers at the root. */
    const panGateActive = (): boolean =>
      spaceRef.current || Date.now() - lastPanEndRef.current < PAN_CLICK_GRACE_MS;

    const onClickGate = (e: MouseEvent): void => {
      if (!panGateActive()) return;
      e.preventDefault();
      e.stopPropagation();
    };

    /* ---------------- bind ---------------- */

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onVisibility);
    node.addEventListener("pointerdown", onPointerDown);
    node.addEventListener("pointermove", onPointerMove);
    node.addEventListener("pointerup", onPointerEnd);
    node.addEventListener("pointercancel", onPointerEnd);
    node.addEventListener("click", onClickGate);
    node.addEventListener("dblclick", onClickGate);

    cleanupRef.current = () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onVisibility);
      node.removeEventListener("pointerdown", onPointerDown);
      node.removeEventListener("pointermove", onPointerMove);
      node.removeEventListener("pointerup", onPointerEnd);
      node.removeEventListener("pointercancel", onPointerEnd);
      node.removeEventListener("click", onClickGate);
      node.removeEventListener("dblclick", onClickGate);
    };
  }, []);

  return bindCanvasPan;
}
