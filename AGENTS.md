# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Commands

```bash
pnpm dev              # Start Fastify (5173) + Vite (5174) concurrently
pnpm dev:electron     # Run Electron desktop app with HMR
pnpm -r build         # Build packages (tsc; MCP entry bundled with esbuild)
pnpm test             # Build dependencies, then run all workspace tests
pnpm typecheck        # Type-check every workspace package
pnpm --filter @todograph/server test     # Run server tests
pnpm --filter @todograph/app test        # Run frontend tests
pnpm package          # Build Windows portable EXE (electron-builder)
pnpm --filter @todograph/app build:mobile  # Build/sync Capacitor; requires HTTPS VITE_API_BASE
```

**Single test**: `pnpm --filter <pkg> exec vitest run -t "test name"`

## Architecture

This is a **pnpm monorepo** with six packages. See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the canonical system and persistence flow.

| Package | Role |
|---|---|
| `@todograph/core` | Pure DAG algorithms. Reuses canonical domain types from shared. `buildAdj`, `topoSort`, `wouldCreateCycle`, `readyTasks`, `recommend`. |
| `@todograph/shared` | Canonical Zod schemas, hierarchy validation, limits, and geometry helpers shared by frontend and backend. |
| `@todograph/server` | Fastify 5 backend. Serves REST API and optionally static frontend files. |
| `@todograph/app` | React 18 + Vite frontend + Electron/Capacitor shells. React Flow graph editor, Zustand stores, shadcn/ui components. |
| `@todograph/mcp` | Independently published MCP server and TodoGraph tools. |
| `@todograph/desktop-host` | Owns the loopback Fastify lifecycle and session secret used by Electron. |

## Product terminology

模式和视图是两个不同概念，禁止混用：

- **清单模式**：系统级清单模式，目前只支持列表视图，不支持依赖图视图。
- **页面模式**：进入某个具体页面；页面模式支持列表视图和依赖图视图，并可在二者之间切换。
- **列表视图**：以任务行和嵌套层级呈现任务。
- **依赖图视图**：以图节点和依赖连线呈现当前页面任务。

术语按当前视图解析：

- 在列表视图中，“节点”或“任务”默认指列表里的任务行；“父节点、子节点、同级节点、嵌套、层级”均指列表的父子嵌套关系。
- 在依赖图视图中，“节点”或“任务”默认指依赖图里的图节点。依赖连线使用“前置依赖、后续依赖”等术语，不与父子层级混为一谈。
- **active 高亮**：移动端按住列表任务、尚未正式拖起时出现的整行按压高亮。它不是拖拽浮层、预计落位提示或推荐任务的紫色语义高亮。
- 模式切换必须同时保留离开前的具体页面和该页面的视图；从清单模式返回页面模式时，恢复原页面及原视图。
- 用户可见行为以 `docs/behavior/` 中的行为书为准；修改导航、手势或层级时必须同时更新对应行为 ID 的测试。

## Data flow

1. **TaskStore** (`useTaskStore`) is the single source of truth for the current page's nodes/edges. All writes go through it → 250ms debounced save to server → server validates DAG (cycle check) → writes JSON. A bounded session-only page cache paints revisited pages immediately, then refreshes them from the server; session reset clears it.
2. **WorkspaceStore** (`useWorkspaceStore`) manages multi-page orchestration — meta, page CRUD, cross-page move, all-tasks aggregation.
3. **Undo/redo**: `useHistoryStore` holds snapshots. Every mutation in `useTaskStore` calls `pushPre()` before modifying state.
4. **Save path**: `useTaskStore.scheduleSave()` → 250ms debounce → `api.savePage()` → `PUT /api/pages/:id` → server validates capacity, dependency DAG and task hierarchy → `FileWorkspaceRepository.savePage()` (fsync + atomic rename).
5. **Session lifecycle**: `WorkspaceStore.resetSession()` owns logout/account-switch cleanup for task state, history, pending saves, and polling. Protected API 401 responses invalidate auth globally.
6. **Recovery path**: every mutation is mirrored to a user-scoped local draft; destructive repository operations create a flushed backup, tombstone, or journal before their commit point. Recovery files are bounded by count and bytes while retaining the newest point. The account/data panel exposes draft, backup, and deleted-page restoration.

## Key architectural decisions

- **Schema must be built first**: After changing `packages/shared/src/schema.ts`, run `pnpm --filter @todograph/shared build` before frontend/backend will compile.
- **Zustand stores own all mutations**: UI never writes directly to the API. Store mutates → schedules save.
- **Repository abstraction**: `WorkspaceRepository` interface + `FileWorkspaceRepository` (JSON files, atomic writes). To add SQLite, implement the interface and swap the factory.
- **Auth**: session-based via `@fastify/secure-session` (encrypted httpOnly cookie). `authHook` protects all `/api/*` except `/api/auth/*`. `FileUserRepository` stores users in `data/users/users.json`.
- **Multi-user data layout**: `data/users/{userId}/meta.json`, `data/users/{userId}/pages/{pageId}.json`. Each user gets a separate `WorkspaceRepository` instance.
- **Migration**: On first `loadMeta()` with no `meta.json`, `FileWorkspaceRepository` auto-migrates legacy `tasks.json` (v1) → page-per-user layout, or seeds demo data if no data exists.
- **Electron**: Main process starts Fastify on a random port, preload injects `__API_BASE__` via `contextBridge`. Portable mode redirects `userData` to exe-adjacent `data/` folder.
- **Capacitor**: Android/iOS use a build-time public HTTPS `VITE_API_BASE`, native bearer auth, platform secure storage, keyboard/back/system-bar integration, and semantic (not per-frame) haptics. User-visible rules live in `docs/behavior/native-platform.md`.
- **Vite dev proxy**: `vite.config.ts` proxies `/api` to `http://127.0.0.1:5173` (the Fastify dev server).
- **MCP compatibility releases**: `packages/mcp/package.json` is the MCP runtime version and must match `LATEST_MCP_VERSION` (enforced by test). npm, Docker, and desktop release workflows share the exact-pack/latest-version guard; server distributions publish that package before advertising it.
- **Themes**: All colors as HSL CSS custom properties (`hsl(var(--xxx))`). 6 套主题（glass-dark/light、default-dark/light、muted-warm/cool）。每套主题一个独立 CSS 文件在 `styles/themes/`。`ThemeDef` 接口在 `features/theme/themes.ts`，包含 `id/label/mode/icon/preview`。新增主题只需：1) 创建 `styles/themes/<name>.css`，2) 在 `THEMES` 数组中加一条，3) 在 `globals.css` 顶部 `@import`。
- **玻璃/磨砂背景引擎**：`index.html` 中 `bg-sharp`（锐利原图）+ `bg-matte`（backdrop-filter blur 18px）双层 fixed div。背景图 6 张随机（`public/bg-{1..6}.jpg`），`main.tsx` 启动时设置 `--bg-url` CSS 变量。非玻璃主题自动隐藏这两层。
- **Hover 透镜效果**：`App.tsx` 全局 mouseover 代理，任何带 `data-lens` 属性的元素 hover 时在 `bg-matte` 的 CSS mask 上挖洞（`--hole-x/y/r`），露出锐利原图。透镜消失有 100ms 延迟防闪烁。
- **hover 交互统一**：所有交互元素使用 `hover:bg-foreground/5`（前景色 5% 不透明度，深浅主题均可见）+ `rounded-xl` + `transition-colors duration-200`。
- **React Flow 覆盖**：`.react-flow__node-group` 强制 `border:none`，`.selected` 强制 `box-shadow:none`（覆盖 React Flow 默认 `#1a192b` 黑色选中态）。

## Cross-page node movement

When nodes are moved between pages, `moveNodesBetweenPages` in `workspace.ts`:
- Automatically includes the entire subtree (all descendants).
- Converts relative coordinates to world coordinates when parent isn't moving with the child.
- Uses `placeMovedNodesOnTarget` from `shared` to avoid collision with existing nodes on the target page.
- Returns detailed stats (movedEdges, lostEdges, droppedParentLinks, autoIncludedChildren).

## Hierarchy (grouping)

Nodes can have a `parentId`, rendered as nested compound nodes in React Flow. Max depth is 3 (`MAX_HIERARCHY_DEPTH`). Shared validation rejects missing parents, duplicate IDs, cycles, and excessive depth at both client and server boundaries. UI mutation guards in `useTaskStore` include:
- `wouldCreateParentCycle()` — prevents parent cycles.
- `wouldExceedMaxDepth()` — enforces depth limit.
- `normalizeGroupBounds()` — keeps children within the group frame, shifting parent position to maintain visual stability.
- On delete: children are promoted to world coordinates and un-parented.

## Docker

Multi-stage build: Stage 1 builds all packages, Stage 2 copies dist/ + prod deps only. Exposes port 3000. Set env vars: `PORT`, `HOST`, `DATA_DIR`, `STATIC_DIR`, `SESSION_SECRET`, `REGISTRATION_KEY`.
