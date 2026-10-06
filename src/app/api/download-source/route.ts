import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";

/**
 * GET /api/download-source — packages the Icon Sheet Studio source into a
 * zip archive ON DEMAND so the footer "Download project (.zip)" link always
 * ships the current code (a static public/*.zip would go stale the moment
 * the source changes — this was the original 404 bug).
 *
 * Included: src/, prisma/, db/ (seeded SQLite), public/, package.json,
 * bun.lock and the config files needed to `bun install && bun run dev` locally.
 * Excluded: node_modules, .next, .git, logs and sandbox infrastructure folders.
 *
 * PORTABILITY: the .env is REWRITTEN so DATABASE_URL points at the relative
 * `file:../db/custom.db` (resolved from prisma/schema.prisma) instead of the
 * sandbox-absolute path — the extracted project runs `prisma db push` and
 * `bun run dev` on any machine out of the box.
 */

const INCLUDED_DIRS = ["src", "prisma", "public"];
const INCLUDED_ROOT_FILES = [
  "package.json",
  "bun.lock",
  "next.config.ts",
  "tsconfig.json",
  "postcss.config.mjs",
  "components.json",
  "eslint.config.mjs",
  ".gitignore",
  ".env",
  "LOCAL_RUN.md",
];
const SKIP_DIR_NAMES = new Set(["node_modules", ".next", ".git", ".turbo"]);
const TEXT_ENCODABLE = /\.(?:ts|tsx|js|jsx|mjs|json|css|svg|txt|md|prisma|lock)$/i;
const ALWAYS_INCLUDE = new Set([".gitignore", ".env"]);

async function walkDir(dir: string, base: string, zip: JSZip): Promise<number> {
  const entries = await readdir(dir, { withFileTypes: true });
  let count = 0;
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIR_NAMES.has(entry.name)) continue;
      count += await walkDir(abs, base, zip);
    } else if (entry.isFile()) {
      const rel = path.relative(base, abs).split(path.sep).join("/");
      const baseName = path.basename(rel);
      if (ALWAYS_INCLUDE.has(baseName) || TEXT_ENCODABLE.test(baseName)) {
        zip.file(rel, await readFile(abs, "utf8"));
        count++;
      }
    }
  }
  return count;
}

const PORTABLE_ENV_LINES = { databaseUrl: "DATABASE_URL=file:../db/custom.db" };

/** Sandbox .env → portable .env: keep every line except DATABASE_URL. */
function toPortableEnv(raw: string): string {
  const lines = raw
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "" && !/^\s*DATABASE_URL\s*=/.test(line));
  lines.push(PORTABLE_ENV_LINES.databaseUrl);
  return lines.join("\n") + "\n";
}

export async function GET() {
  try {
    const root = process.cwd();
    const zip = new JSZip();
    let files = 0;

    for (const dir of INCLUDED_DIRS) {
      files += await walkDir(path.join(root, dir), root, zip);
    }
    for (const file of INCLUDED_ROOT_FILES) {
      try {
        const raw = await readFile(path.join(root, file), "utf8");
        zip.file(file, file === ".env" ? toPortableEnv(raw) : raw);
        files++;
      } catch {
        /* optional file missing in this deployment — skip silently */
      }
    }
    // Seed the SQLite db (binary) so the extracted project has the same
    // starting state as the static public/*.zip deliverable.
    try {
      zip.file("db/custom.db", await readFile(path.join(root, "db", "custom.db")));
      files++;
    } catch {
      /* db file missing — `prisma db push` recreates it locally */
    }

    if (files === 0) {
      return Response.json({ error: "No source files found to package" }, { status: 500 });
    }

    const buffer = await zip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
      compressionOptions: { level: 6 },
    });

    return new Response(new Uint8Array(buffer), {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": 'attachment; filename="icon-sheet-studio.zip"',
        "Content-Length": String(buffer.length),
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    console.error("download-source failed:", err);
    return Response.json({ error: "Failed to package the project source" }, { status: 500 });
  }
}

export const dynamic = "force-dynamic";
