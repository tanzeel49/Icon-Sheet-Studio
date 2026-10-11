import fs from 'node:fs';
import path from 'node:path';

const standaloneDir = path.resolve('.next', 'standalone');

if (!fs.existsSync(standaloneDir)) {
  console.error('[prepare-standalone] ERROR: .next/standalone does not exist. Did next build succeed with output: standalone?');
  process.exit(1);
}

console.log('[prepare-standalone] Preparing standalone directory at:', standaloneDir);

// 1. Copy .next/static into .next/standalone/.next/static
const staticSrc = path.resolve('.next', 'static');
const staticDest = path.join(standaloneDir, '.next', 'static');
if (fs.existsSync(staticSrc)) {
  fs.mkdirSync(path.dirname(staticDest), { recursive: true });
  fs.cpSync(staticSrc, staticDest, { recursive: true });
  console.log('[prepare-standalone] Copied .next/static ->', staticDest);
}

// 2. Copy public into .next/standalone/public
const publicSrc = path.resolve('public');
const publicDest = path.join(standaloneDir, 'public');
if (fs.existsSync(publicSrc)) {
  fs.mkdirSync(publicDest, { recursive: true });
  fs.cpSync(publicSrc, publicDest, { recursive: true });
  console.log('[prepare-standalone] Copied public ->', publicDest);
}

// 3. Handle any nested subdirectories created by Next.js tracing
const entries = fs.readdirSync(standaloneDir, { withFileTypes: true });
for (const entry of entries) {
  if (entry.isDirectory() && entry.name !== '.next' && entry.name !== 'node_modules' && entry.name !== 'public') {
    const subDir = path.join(standaloneDir, entry.name);
    // If it has a package.json or server.js, copy static & public into it as well
    if (fs.existsSync(path.join(subDir, 'server.js')) || fs.existsSync(path.join(subDir, 'package.json'))) {
      const subStatic = path.join(subDir, '.next', 'static');
      const subPublic = path.join(subDir, 'public');
      if (fs.existsSync(staticSrc)) {
        fs.mkdirSync(path.dirname(subStatic), { recursive: true });
        fs.cpSync(staticSrc, subStatic, { recursive: true });
      }
      if (fs.existsSync(publicSrc)) {
        fs.mkdirSync(subPublic, { recursive: true });
        fs.cpSync(publicSrc, subPublic, { recursive: true });
      }
      console.log(`[prepare-standalone] Synced static & public into subfolder: ${entry.name}`);
    }
  }
}

// 4. Remove heavy build artifacts and sensitive keys from standalone
const cleanCandidates = [
  path.join(standaloneDir, 'src-tauri'),
  path.join(standaloneDir, 'Icon Sheet Studio', 'src-tauri'),
];

for (const candidate of cleanCandidates) {
  if (fs.existsSync(candidate)) {
    fs.rmSync(candidate, { recursive: true, force: true });
    console.log('[prepare-standalone] Removed build artifact:', candidate);
  }
}

// Remove any .msi, .exe, .zip, or tauri_key from standalone
function cleanUnwantedFiles(dir, depth = 0) {
  if (depth > 2) return;
  const items = fs.readdirSync(dir, { withFileTypes: true });
  for (const item of items) {
    const fullPath = path.join(dir, item.name);
    if (item.isDirectory() && item.name !== 'node_modules') {
      cleanUnwantedFiles(fullPath, depth + 1);
    } else if (item.isFile()) {
      if (
        item.name.endsWith('.msi') ||
        item.name.endsWith('.zip') ||
        item.name.startsWith('tauri_key')
      ) {
        fs.rmSync(fullPath, { force: true });
        console.log('[prepare-standalone] Removed unnecessary file:', item.name);
      }
    }
  }
}
cleanUnwantedFiles(standaloneDir);

// 5. Verify server.js exists
function findServerJs(dir, depth = 0) {
  if (depth > 4) return null;
  const items = fs.readdirSync(dir, { withFileTypes: true });
  for (const item of items) {
    const fullPath = path.join(dir, item.name);
    if (item.isFile() && item.name === 'server.js') {
      return fullPath;
    }
    if (item.isDirectory() && item.name !== 'node_modules') {
      const found = findServerJs(fullPath, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

const serverPath = findServerJs(standaloneDir);
if (serverPath) {
  console.log('[prepare-standalone] SUCCESS: Verified server.js at:', serverPath);
} else {
  console.warn('[prepare-standalone] WARNING: server.js not found in standalone directory!');
}
