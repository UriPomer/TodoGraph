# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
pnpm dev              # Start Fastify (5173) + Vite (5174) concurrently
pnpm dev:electron     # Run Electron desktop app with HMR
pnpm -r build         # Build all workspace packages (tsc)
pnpm test             # Run @todograph/core tests (DAG engine)
pnpm --filter @todograph/server test     # Run server tests
pnpm --filter @todograph/app test        # Run frontend tests
pnpm lint             # Run lint across all packages
pnpm package          # Build Windows portable EXE (electron-builder)
```

**Single test**: `pnpm --filter <pkg> vitest run -t "test name"`

## Architecture

This is a **pnpm monorepo** with four packages:

| Package | Role |
|---|---|
| `@todograph/core` | Pure DAG engine — zero deps. `buildAdj`, `topoSort`, `wouldCreateCycle`, `readyTasks`, `recommend` (strategy interface). Used by both frontend and backend. |
| `@todograph/shared` | Zod schemas shared between frontend and backend — `TaskSchema`, `EdgeSchema`, `PageDataSchema`, `MetaSchema`. Also geometry helpers (`computeGroupSize`, `pagePlacement`). Types derived via `z.infer` — single source of truth. |
| `@todograph/server` | Fastify 5 backend. Serves REST API and optionally static frontend files. |
| `@todograph/app` | React 18 + Vite frontend + Electron shell. React Flow graph editor, Zustand stores, shadcn/ui components. |

## Data flow

1. **TaskStore** (`useTaskStore`) is the single source of truth for the current page's nodes/edges. All writes go through it → 250ms debounced save to server → server validates DAG (cycle check) → writes JSON.
2. **WorkspaceStore** (`useWorkspaceStore`) manages multi-page orchestration — meta, page CRUD, cross-page move, all-tasks aggregation.
3. **Undo/redo**: `useHistoryStore` holds snapshots. Every mutation in `useTaskStore` calls `pushPre()` before modifying state.
4. **Save path**: `useTaskStore.scheduleSave()` → 250ms debounce → `api.savePage()` → `PUT /api/pages/:id` → server validates with `isDAG()` → `FileWorkspaceRepository.savePage()` (atomic tmp+rename).

## Key architectural decisions

- **Schema must be built first**: After changing `packages/shared/src/schema.ts`, run `pnpm --filter @todograph/shared build` before frontend/backend will compile.
- **Zustand stores own all mutations**: UI never writes directly to the API. Store mutates → schedules save.
- **Repository abstraction**: `WorkspaceRepository` interface + `FileWorkspaceRepository` (JSON files, atomic writes). To add SQLite, implement the interface and swap the factory.
- **Auth**: session-based via `@fastify/secure-session` (encrypted httpOnly cookie). `authHook` protects all `/api/*` except `/api/auth/*`. `FileUserRepository` stores users in `data/users/users.json`.
- **Multi-user data layout**: `data/users/{userId}/meta.json`, `data/users/{userId}/pages/{pageId}.json`. Each user gets a separate `WorkspaceRepository` instance.
- **Migration**: On first `loadMeta()` with no `meta.json`, `FileWorkspaceRepository` auto-migrates legacy `tasks.json` (v1) → page-per-user layout, or seeds demo data if no data exists.
- **Electron**: Main process starts Fastify on a random port, preload injects `__API_BASE__` via `contextBridge`. Portable mode redirects `userData` to exe-adjacent `data/` folder.
- **Vite dev proxy**: `vite.config.ts` proxies `/api` to `http://127.0.0.1:5173` (the Fastify dev server).
- **Themes**: All colors as HSL CSS custom properties (`hsl(var(--xxx))`). Adding a theme = adding a `[data-theme="..."]` block in `globals.css`.

## Cross-page node movement

When nodes are moved between pages, `moveNodesBetweenPages` in `workspace.ts`:
- Automatically includes the entire subtree (all descendants).
- Converts relative coordinates to world coordinates when parent isn't moving with the child.
- Uses `placeMovedNodesOnTarget` from `shared` to avoid collision with existing nodes on the target page.
- Returns detailed stats (movedEdges, lostEdges, droppedParentLinks, autoIncludedChildren).

## Hierarchy (grouping)

Nodes can have a `parentId`, rendered as nested compound nodes in React Flow. Max depth is 3 (`MAX_HIERARCHY_DEPTH`). Key invariants enforced in `useTaskStore`:
- `wouldCreateParentCycle()` — prevents parent cycles.
- `wouldExceedMaxDepth()` — enforces depth limit.
- `normalizeGroupBounds()` — keeps children within the group frame, shifting parent position to maintain visual stability.
- On delete: children are promoted to world coordinates and un-parented.

## Docker

Multi-stage build: Stage 1 builds all packages, Stage 2 copies dist/ + prod deps only. Exposes port 3000. Set env vars: `PORT`, `HOST`, `DATA_DIR`, `STATIC_DIR`, `SESSION_SECRET`, `REGISTRATION_KEY`.
