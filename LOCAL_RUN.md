# Icon Sheet Studio — Local Run

A professional icon-sheet artwork composer. Turn collections of 100–5,000+
SVG icons into professional icon-sheet artwork. Local-first (all data lives
in your browser's IndexedDB).

## Requirements
- Node.js 18+ (or Bun)

## Install & Run (Bun — recommended)
```bash
bun install
bun run dev
```
Open http://localhost:3000

## Install & Run (npm)
```bash
npm install
npx next dev -p 3000
```

## Scripts
- `bun run dev` (or `npm run dev`) — dev server on port 3000
- `bun run lint` — ESLint
- `bun run db:push` — push the Prisma schema (optional; the UI does not need it)

## Quick start
1. Load the sample icons (or upload your own SVG icons)
2. Pick a template (27/30/36/40/44/50/55/60 icons, or import a custom SVG template)
3. Generate sheets, then edit everything live in the Properties panel
4. Edit mode shows all sheets vertically — click a sheet to make it the active edit target
5. Export as SVG (vector) / PNG / ZIP

## AI Category Suggestion
The "AI suggest" button analyzes the ACTUAL RENDERED ICON ARTWORK (via a
vision model on numbered contact sheets of the icons), not the filenames.

Two interchangeable AI providers power it (gear icon next to "AI suggest"
or the command palette → "AI provider settings"):

- **Z.AI** — built-in, configured on the server via z-ai-web-dev-sdk
  (works out of the box on the hosting sandbox).
- **Google Gemini** — bring your own API key (free tier supported).
  The key is stored ONLY in your browser's localStorage (application
  configuration — never in sheet data, exports, backups, or the project
  zip) and is sent only to Google's API. Configure the key, pick a model
  (default gemini-2.5-flash), and use "Test connection".

Both providers run the same artwork-driven analysis pipeline and return
the same suggestion format; the UI shows which provider produced each
suggestion. Failures are provider-specific and never break the other.

## Notes
- All project data lives in the browser's IndexedDB — nothing leaves your machine.
- The Prisma/SQLite schema is scaffolded but unused by the UI.
