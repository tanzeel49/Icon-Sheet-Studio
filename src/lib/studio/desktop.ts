/**
 * Desktop Abstraction Layer
 * Isolates all Tauri-specific logic from the main application.
 * Falls back to standard web browser APIs if not running in Tauri.
 */

export interface SaveResult {
  saved: boolean;
  cancelled?: boolean;
  filePath?: string;
  bytesWritten?: number;
}

export const isDesktop = () => {
  return typeof window !== "undefined" && window.__TAURI_INTERNALS__ !== undefined;
};

export async function saveFileNative(
  blob: Blob,
  defaultFilename: string,
  filterName?: string
): Promise<SaveResult> {
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
    return { saved: true, filePath: defaultFilename, bytesWritten: blob.size };
  }

  // Tauri Implementation
  try {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const ext = defaultFilename.split(".").pop() || "";
    const filters = ext
      ? [{ name: filterName || (ext.toUpperCase() + " File"), extensions: [ext] }]
      : [];

    const filePath = await save({
      defaultPath: defaultFilename,
      filters,
    });

    // If user cancelled the save dialog, return cancelled: true without error
    if (!filePath) {
      return { saved: false, cancelled: true };
    }

    const buffer = await blob.arrayBuffer();
    const bytes = new Uint8Array(buffer);

    // Primary: Custom native Rust command (writes to any user-selected path, even external or secondary drives)
    let written = false;
    let bytesWritten = 0;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const res = await invoke<number>("write_file_native", {
        path: filePath,
        data: bytes,
      });
      bytesWritten = typeof res === "number" ? res : bytes.length;
      written = true;
    } catch (invokeErr) {
      console.warn("write_file_native command failed, trying plugin-fs fallback:", invokeErr);
    }

    // Fallback: Tauri plugin-fs writeFile
    if (!written) {
      const { writeFile } = await import("@tauri-apps/plugin-fs");
      await writeFile(filePath, bytes);
      bytesWritten = bytes.length;
    }

    return {
      saved: true,
      filePath,
      bytesWritten,
    };
  } catch (error) {
    console.error("Native save failed:", error);
    throw error;
  }
}
