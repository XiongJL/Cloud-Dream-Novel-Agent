# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

CloudDream Novel Agent (云梦小说智能体) — a desktop novel-writing tool with offline-first data, structured creative management, and AI-assisted writing. Monorepo managed by pnpm + Turborepo.

## Essential Commands

```bash
# First-time setup (generates Prisma Client + builds core)
pnpm install && pnpm run setup

# Dev (desktop only)
pnpm dev:desktop

# Dev (all workspaces via Turbo)
pnpm dev

# Build core package (required before desktop build if schema changed)
pnpm build:core

# Build desktop for Windows (installer + portable)
pnpm build:desktop:win

# Build desktop for macOS
pnpm build:desktop:mac

# Database
pnpm db:push          # Push Prisma schema to SQLite
pnpm db:generate      # Regenerate Prisma Client

# Lint & format
pnpm lint
pnpm format

# AI diagnostics (terminal only, dev mode)
pnpm --filter novel-editor-desktop run ai:diag -- smoke mcp
pnpm --filter novel-editor-desktop run ai:diag -- coverage
```

## Architecture

### Monorepo Layout

- **`apps/desktop`** — Electron + Vite + React + TypeScript + TailwindCSS. The main application.
- **`apps/backend`** — Spring Boot 3 + MariaDB. Cloud sync service (not required for local dev).
- **`packages/core`** (`@novel-editor/core`) — Prisma schema, generated client, and shared logic. Exports via `dist/`.

### Desktop App Structure (`apps/desktop`)

- **`electron/`** — Electron main process
  - `main.ts` — app entry (changes require full restart, no HMR)
  - `preload.ts` — context bridge
  - `ai/` — AI service layer (`AiService.ts`, providers, context builder, summary, capabilities)
  - `search/` — global search engine
  - `debug/` — dev debug logging (`debug-dev.log`, 15MB cap)
  - `services/` — IPC service handlers
  - `sync/` — cloud sync logic
- **`src/`** — Renderer process (React)
  - `components/` — UI components (LexicalEditor, AIWorkbench, StoryWorkbench, WorldWorkbench, MapWorkbench, SearchWorkbench, Settings, etc.)
  - `hooks/` — `useEditorPreferences` (theme/settings), `usePlotSystem`, `useShortcuts`, `useHistory`
  - `i18n/locales/` — `zh.json`, `en.json` (all UI text must use react-i18next)
  - `pages/` — route-level pages

### Data Layer

- **Runtime DB**: `%APPDATA%/@novel-editor/desktop/novel_editor.db` (SQLite, via Prisma)
- **Schema source**: `packages/core/prisma/schema.prisma`
- **Generated client**: `packages/core/generated/client/` (built by `pnpm build:core`)
- **First-run bootstrap**: packaged app calls `ensureDbSchema()` with bundled `schema-init.sql`, not runtime `prisma db push`
- **Dev DB**: `packages/core/prisma/dev.db` is for Prisma tooling only, not the runtime DB

### Key Architectural Decisions

- **Dual database**: SQLite offline (desktop), MariaDB (backend sync)
- **Editor**: Lexical (Meta fork) with plugin architecture. `@lexical/mark` for highlights, custom `MentionsPlugin` for @-mentions in editor, separate native textarea implementation in `PlotPointModal`
- **Theme**: All components must support light/dark mode via `useEditorPreferences().preferences.theme`. No hardcoded colors — use Tailwind `neutral-900/white` or dynamic `isDark` classes
- **i18n**: All user-facing strings must use `react-i18next` keys. Add translations to both `zh.json` and `en.json`
- **Modals**: All modals must extend `BaseModal`. Delete actions use `ConfirmModal` (not `confirm()`). Footer: delete left, cancel+save right, `text-xs` buttons
- **AI keys**: stored in `userData/ai-settings.json`, never in the novel DB, excluded from backup/restore

## Build & Packaging Notes

- `pnpm build:desktop:win` runs: prepare:core → tsc → vite build → electron-builder → fix:win:exe-icon → pack portable
- `packages/core` build generates both Prisma Client and `schema-init.sql`
- Electron main process (`electron/main.ts`) changes require restarting `pnpm dev` — no HMR for main process
- Renderer process code (React/Vite) supports HMR

## Common Pitfalls

- After modifying `schema.prisma`, run `pnpm db:generate` then `pnpm build:core` before desktop build — stale Prisma Client causes runtime crashes
- Large component files (e.g., `Editor.tsx`) — use surgical edits, not bulk regex replace; verify `export default` and state declarations survive
- `// @ts-ignore` in IPC handlers causes silent runtime failures — fix types or use `(db as any)` with try-catch logging
- `tsc` output may be truncated in terminal — redirect to file (`tsc > log.txt`) for debugging
- Terminal mojibake ≠ file encoding corruption — do not mass-rewrite without confirmation

## Release Flow

1. Ensure version in root `package.json` and `apps/desktop/package.json` match
2. Push to default branch
3. Tag and push: `git tag v<version> && git push origin v<version>`
4. GitHub Actions (`.github/workflows/release.yml`) auto-builds Windows + macOS, creates Release with assets
