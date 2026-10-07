/**
 * Desktop Abstraction Layer
 * Isolates all Tauri-specific logic from the main application.
 * Falls back to standard web browser APIs if not running in Tauri.
 */

export const isDesktop = () => {
  return typeof window !== "undefined" && window.__TAURI_INTERNALS__ !== undefined;
};

export async function saveFileNative(blob: Blob, defaultFilename: string): Promise<void> {
  if (!isDesktop()) {
    // Web Fallback
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = defaultFilename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    return;
  }

  // Tauri Implementation
  try {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const { writeFile } = await import("@tauri-apps/plugin-fs");

    const filePath = await save({
      defaultPath: defaultFilename,
    });

    if (filePath) {
      const buffer = await blob.arrayBuffer();
      await writeFile(filePath, new Uint8Array(buffer));
    }
  } catch (error) {
    console.error("Native save failed:", error);
    throw error;
  }
}
