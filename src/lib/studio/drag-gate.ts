/**
 * ICON SHEET STUDIO — drag interaction gate.
 * dnd-kit pointerc drags end with a browser click event on the draggable
 * element. Tiles are also click-to-select buttons, so a just-ended drag
 * must swallow the trailing click. Shared via a module-level timestamp
 * (cheaper and simpler than cross-component state).
 */

let lastDragEnd = 0;

/** Call from every DndContext onDragEnd / onDragCancel. */
export function markDragEnd(): void {
  lastDragEnd = Date.now();
}

/** True when a drag ended milliseconds ago — click handlers should no-op. */
export function justDragged(graceMs = 180): boolean {
  return Date.now() - lastDragEnd < graceMs;
}
