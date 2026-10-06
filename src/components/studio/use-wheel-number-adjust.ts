"use client";

/**
 * ICON SHEET STUDIO — Global mouse-wheel value adjustment for numeric fields.
 *
 * THE one shared implementation behind "focus a number field, scroll the
 * wheel, the value steps" — applied at the shared-component level so every
 * numeric input that uses the app's numeric-field pattern gets it
 * automatically (no per-field handlers, no field-name special cases):
 *
 *   · panel-kit.tsx      SliderField       — the right properties panel (~35 fields)
 *   · small-controls.tsx SliderField       — the legacy/shared kit twin
 *   · category-ai.tsx    VolumeField       — the sheet volume number
 *   · sheet-preview.tsx  CellStrokePopover — the per-cell stroke exception px
 *
 * Any FUTURE numeric input gets the behavior for free by rendering a
 * SliderField (or by mounting this hook's ref on its input).
 *
 * Behavior contract (mirrors the fields' own arrow-key nudge semantics):
 *   · wheel UP (negative deltaY)   → +1 step
 *   · wheel DOWN (positive deltaY) → −1 step
 *   · Shift + wheel                → the field's bigStep (10 × step), the same
 *     modifier convention the arrow keys already use — Shift is OPTIONAL,
 *     never required.
 *   · the callback is the field's OWN nudge/commit → the field's own step,
 *     min/max clamp, decimal precision and state path (typing, sliders,
 *     undo/redo and persistence are untouched).
 *   · adjustment ONLY while the field itself holds focus (click or Tab);
 *     hovering an unfocused field scrolls the panel normally, and after
 *     blur the page/panel scrolls again.
 *
 * Why a NATIVE non-passive listener instead of React's onWheel: React 17+
 * registers wheel listeners as PASSIVE at the root, so preventDefault()
 * cannot stop the panel from scrolling there. A non-passive
 * addEventListener("wheel") on the input element can. It also cancels
 * Chromium's built-in wheel-spinning of focused <input type="number">.
 *
 * Why a CALLBACK REF instead of an effect: popovers (Radix) may swap the
 * input DOM node after mount without re-rendering the owning component —
 * an effect keyed to the owner's renders would keep the listener on a dead
 * node. A ref callback fires exactly when React attaches/detaches the node,
 * so the listener always rides the live element. The returned callback is
 * identity-stable (no re-attach churn across renders).
 *
 * Robustness details:
 *   · deltaMode normalization (pixel / line / page) so Firefox's line-based
 *     wheels and Chromium's pixel wheels step at the same rate;
 *   · accumulated-delta threshold ≈ one mouse notch (= one step) so a single
 *     notch is exactly one increment and trackpads don't fly;
 *   · accumulator resets on direction reversal and after a short idle decay
 *     (momentum tails never leak into later adjustments);
 *   · at most MAX_TICKS_PER_EVENT steps per single wheel event — a violent
 *     trackpad fling can never stampede the undo history;
 *   · zero re-renders of its own (no state) and zero stale closures (the
 *     params ref is refreshed on every render of the owning component).
 */

import { useCallback, useEffect, useRef, type RefObject } from "react";

/** Accumulated (normalized) delta that equals ONE step ≈ one mouse notch. */
const STEP_THRESHOLD = 100;
/** ms without wheel events before the accumulator resets. */
const DECAY_MS = 250;
/** Never apply more than this many steps for a single wheel event. */
const MAX_TICKS_PER_EVENT = 3;

/** WheelEvent deltaMode → normalized pixel-ish units. */
function normalizeDelta(e: WheelEvent): number {
  if (e.deltaMode === 1) return e.deltaY * 33; // DOM_DELTA_LINE (Firefox)
  if (e.deltaMode === 2) return e.deltaY * 100; // DOM_DELTA_PAGE
  return e.deltaY; // DOM_DELTA_PIXEL (Chromium/Safari)
}

export interface WheelNumberAdjustParams {
  /** skip adjustment entirely (disabled / read-only / closed fields). */
  disabled?: boolean;
  /**
   * Step the value. dir = +1 for wheel UP, −1 for wheel DOWN. `large` is
   * true while Shift is held — fields map it to their bigStep (10 × step),
   * exactly like their arrow-key nudge.
   */
  onNudge: (dir: 1 | -1, large: boolean) => void;
}

/**
 * Attach wheel-value adjustment to an input element.
 *
 * @param params      { disabled?, onNudge } — refreshed every render, so the
 *                   listener always calls the latest closure (no stale values).
 * @param existingRef optional RefObject the field already uses for
 *                   focus/select — the returned callback keeps it populated,
 *                   so existing code that reads it is unaffected.
 * @returns a STABLE ref callback to spread onto the input:
 *          `<input ref={wheelRef} … />` (or merged with an inline ref).
 */
export function useWheelNumberAdjust(
  params: WheelNumberAdjustParams,
  existingRef?: RefObject<HTMLInputElement | null>
): (node: HTMLInputElement | null) => void {
  /* keep the latest params without re-binding the listener. Synced in an
   * effect (never during render — React compiler rule); wheel events only
   * fire long after commit, so the closure is always current. */
  const paramsRef = useRef(params);
  useEffect(() => {
    paramsRef.current = params;
  });

  /* the currently-bound element + its remove-listener (imperative) */
  const boundRef = useRef<{ el: HTMLInputElement; off: () => void } | null>(null);

  /* identity-stable attach/detach — runs exactly when React mounts/unmounts
   * (or swaps) the input node, independent of the owner's render schedule */
  const attach = useCallback((node: HTMLInputElement | null) => {
    const prev = boundRef.current;
    if (prev) {
      prev.off();
      boundRef.current = null;
    }
    if (existingRef) existingRef.current = node;
    if (!node) return;

    let acc = 0; // accumulated normalized delta since the last step/reset
    let lastAt = 0; // timeStamp of the last wheel event seen

    const onWheel = (e: WheelEvent): void => {
      const p = paramsRef.current;
      /* only while THIS field holds focus (the user clicked / tabbed in).
       * Hovering an unfocused field → return early, no preventDefault →
       * the panel scrolls normally. */
      if (document.activeElement !== node) return;
      if (p.disabled) return;
      const delta = normalizeDelta(e);
      if (delta === 0) return;

      /* we are adjusting — the page/panel must not scroll under the field */
      e.preventDefault();

      const now = e.timeStamp;
      /* idle decay + direction reversal both restart the accumulation */
      if (now - lastAt > DECAY_MS || (acc !== 0 && Math.sign(acc) !== Math.sign(delta))) {
        acc = 0;
      }
      lastAt = now;
      acc += delta;

      let ticks = 0;
      while (Math.abs(acc) >= STEP_THRESHOLD && ticks < MAX_TICKS_PER_EVENT) {
        const dir: 1 | -1 = acc > 0 ? -1 : 1; // wheel down = decrease
        p.onNudge(dir, e.shiftKey);
        acc -= Math.sign(acc) * STEP_THRESHOLD;
        ticks++;
      }
      if (ticks === MAX_TICKS_PER_EVENT) {
        /* runaway momentum (trackpad fling) — drop the excess instead of
         * stampeding the value through dozens of store/history commits */
        acc = 0;
      }
    };

    node.addEventListener("wheel", onWheel, { passive: false });
    boundRef.current = { el: node, off: () => node.removeEventListener("wheel", onWheel) };
    /* existingRef is a caller's useRef object — identity-stable, so this
     * dependency never actually changes; the compiler just needs it listed */
  }, [existingRef]);

  return attach;
}
