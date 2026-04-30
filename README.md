# TodoGraph

> **把 Todo 建成一张依赖图**。任务不再是一条列表，而是一个可计算的 DAG — 系统自动告诉你"此刻最该做什么"。

<p align="center">
  <a href="./LICENSE"><img alt="license" src="https://img.shields.io/github/license/UriPomer/TodoGraph?color=4c1"></a>
  <a href="https://github.com/UriPomer/TodoGraph/stargazers"><img alt="stars" src="https://img.shields.io/github/stars/UriPomer/TodoGraph?style=flat&logo=github"></a>
  <a href="https://github.com/UriPomer/TodoGraph/issues"><img alt="issues" src="https://img.shields.io/github/issues/UriPomer/TodoGraph"></a>
  <a href="https://github.com/UriPomer/TodoGraph/commits/main"><img alt="last commit" src="https://img.shields.io/github/last-commit/UriPomer/TodoGraph"></a>
  <a href="https://github.com/UriPomer/TodoGraph/releases"><img alt="release" src="https://img.shields.io/github/v/release/UriPomer/TodoGraph?include_prereleases&sort=semver"></a>
</p>

<p align="center">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white">
  <img alt="React" src="https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=black">
  <img alt="Vite" src="https://img.shields.io/badge/Vite-5-646CFF?logo=vite&logoColor=white">
  <img alt="React Flow" src="https://img.shields.io/badge/React%20Flow-12-FF0072?logo=diagram&logoColor=white">
  <img alt="Fastify" src="https://img.shields.io/badge/Fastify-5-000000?logo=fastify&logoColor=white">
  <img alt="Electron" src="https://img.shields.io/badge/Electron-33-47848F?logo=electron&logoColor=white">
  <img alt="Tailwind CSS" src="https://img.shields.io/badge/Tailwind%20CSS-3-38B2AC?logo=tailwindcss&logoColor=white">
  <img alt="pnpm" src="https://img.shields.io/badge/pnpm-workspace-F69220?logo=pnpm&logoColor=white">
</p>

<p align="center">
  <a href="#-快速开始">快速开始</a> ·
  <a href="#-截图">截图</a> ·
  <a href="#-核心概念">核心概念</a> ·
  <a href="#-架构">架构</a> ·
  <a href="#-开发">开发</a> ·
  <a href="#-贡献">贡献</a>
</p>

---

## 为什么要做这个

经典 Todo app 的问题是：**任务之间的顺序关系无法表达**。"先做 A，B 要在 A 之后，C 要等 A 和 D 都做完" —— 这种依赖在平铺列表里只能靠脑子记。

TodoGraph 把每个任务视为图里的一个节点，节点之间的有向边表示"必须在…之后"。基于这个结构：

- **Ready 列表**：依赖都已完成、立刻就能开干的任务
- **Blocked 列表**：等前置任务的
- **推荐**：综合 `doing > 高优先级 > 下游影响大` 自动选出当前最应该做的一件事
- **防止死循环**：建边时实时检测环，不允许你给自己挖坑

---

## ✨ 特性

- 🕸️ **DAG 驱动**：任务以图形式组织，系统算出"解锁"与"阻塞"状态
- 🎯 **智能推荐**：策略可替换（`RecommendationStrategy` 接口），默认按 doing / 优先级 / 下游影响排序
- 🧱 **两种视图**：列表（按 Ready/Blocked/Done 分组）与依赖图（React Flow，可拖拽、可自动布局）
- 🎨 **深色 / 浅色一键切换**：所有颜色走 HSL CSS 变量，新增主题 = 新增一段 CSS
- 🖥️ **双形态**：浏览器 Web 版 & Electron 桌面版（同一套前端代码）
- 📦 **Portable EXE**：打包后就一个 `.exe`，拷到别的电脑双击即可运行，数据跟着走
- 🔒 **类型安全**：TypeScript 严格模式 + Zod schema 单一真源，前后端类型自动一致
- 🧪 **核心有测试**：`@todograph/core` 纯函数 DAG 引擎全部 Vitest 覆盖

---

## 📸 截图

![TodoGraph 截图](docs/screenshot.png)

> _上图展示了列表视图里的 Ready / Done 分组：已完成任务自动灰化并划线；空心圆点表示待办。_

---

## 🚀 快速开始

### 要求

- Node.js **≥ 20**
- pnpm **≥ 9**（或启用 corepack：`corepack enable`）

### 60 秒跑起来（Web 模式）

```bash
git clone https://github.com/UriPomer/TodoGraph.git
cd TodoGraph
pnpm install
pnpm dev              # 首次自动编译 core / shared / server，然后同时起 Fastify(5173) + Vite(5174)
# 浏览器打开 http://127.0.0.1:5174/
```

> **首次运行**：`pnpm dev` 会自动检测并编译 core / shared / server；如果遇到模块找不到的错误，先手动执行 `pnpm -r build` 再 `pnpm dev`。

### Electron 开发模式

```bash
pnpm dev:electron     # electron-vite HMR
```

### 打一个 Windows 便携版 EXE

双击 **`build.bat`** 一键出包。产物在 `Build/TodoGraph-<version>-portable.exe`。

拷到任何 Win10/11 机器双击即可运行：
- **无需** Node / pnpm / 安装步骤
- **用户数据与 exe 同目录**（`./data/tasks.json`），整个文件夹拷走就能继续用

手动命令：

```bash
pnpm install
pnpm -r build
pnpm --filter @todograph/app exec electron-builder --win portable
```

---

## 🧠 核心概念

### Task

```ts
interface Task {
  id: string;
  title: string;
  status: 'todo' | 'doing' | 'done';
  priority?: 1 | 2 | 3;   // 1=低 2=中 3=高
  x?: number; y?: number; // 图中的位置，可选
}
```

### Edge

```ts
interface Edge {
  from: string;  // 前置任务 id
  to: string;    // 后继任务 id，语义："to 必须在 from 之后"
}
```

### Ready / Blocked

- **Ready**：所有前置任务 `status === 'done'` 的任务
- **Blocked**：尚有未完成前置的任务
- 图中 `done → ?` 这条边会被高亮（视觉上"通路"已经打开）

### Recommendation

默认策略（`defaultStrategy`）按顺序排序：

1. 当前已在 `doing` 的任务优先（避免频繁切换上下文）
2. 优先级高的优先
3. 下游任务多的优先（做这一件能解锁更多任务）

换策略只需实现 `RecommendationStrategy` 接口并注入。

---

## 🏗️ 架构

```
packages/
├─ core/        DAG 引擎（纯 TS、零依赖、纯函数）
│               topo 排序、环检测、readyTasks、recommend
├─ shared/      前后端共享的 Zod schema（Task / Edge / Graph）
├─ server/      Fastify 5 后端 + 可替换的 GraphRepository
│               GET/PUT /api/graph；保存前校验环
└─ app/         React 18 前端 + Electron 壳
                React Flow 图编辑器、Zustand 状态、shadcn/ui 组件
```

### 关键设计

| 关注点 | 做法 |
|---|---|
| **前后端解耦** | 前端不关心跑在浏览器还是 Electron。Electron 主进程起 Fastify 动态端口，preload 通过 `contextBridge` 注入 `__API_BASE__`；Web 模式就是固定端口。 |
| **DAG 引擎独立** | `@todograph/core` 是纯函数、零依赖，前端（连接校验）和后端（持久化校验）共用同一份。 |
| **Repository 抽象** | `GraphRepository` 接口 + `FileRepository` 实现（原子写：临时文件 + rename）。要换 SQLite / Postgres 只需新写一个实现。 |
| **Zod 单一真源** | `shared/schema.ts` 定义一次，Fastify 路由用它校验请求体，前端 API client 用它校验响应，类型由 `z.infer` 自动派生。 |
| **多主题** | 所有颜色 `hsl(var(--xxx))`；新增皮肤 = 在 `globals.css` 加一段 `[data-theme="..."]`，组件代码零改动。 |
| **可扩展推荐** | `RecommendationStrategy` 是接口；未来加 AI 推荐只需写一个新策略并注入。 |
| **Portable 便携** | Electron 主进程读取 `PORTABLE_EXECUTABLE_DIR`，把 userData 重定向到 exe 同级 `data/`，做到真·绿色软件。 |

### 技术栈

| 层 | 选型 |
|---|---|
| 语言 | TypeScript 5 严格模式 |
| 前端 | React 18 · Vite 5 · Zustand · React Flow (@xyflow/react) · dagre |
| UI | Tailwind CSS 3 · shadcn/ui（手写组件）· lucide-react |
| 后端 | Fastify 5 · Zod · 文件 JSON（可替换） |
| 桌面 | Electron 33 · electron-vite · electron-builder |
| Monorepo | pnpm workspace |
| 测试 | Vitest |

---

## 🧩 开发

### 常用命令（根目录）

| 命令 | 作用 |
|---|---|
| `pnpm dev` | 同时起后端（Fastify 5173）和前端（Vite 5174） |
| `pnpm dev:electron` | Electron + HMR |
| `pnpm -r build` | 编译所有工作区包 |
| `pnpm test` | 跑 `@todograph/core` 单测 |
| `pnpm package` | 打 Windows portable exe |
| `pnpm lint` | 走 ESLint |

### 目录约定

每个包遵循 `src/` → `dist/` 的构建约定。`@todograph/app` 的 Electron 主进程 / preload / renderer 由 `electron-vite` 三段构建到 `out/`，然后 `electron-builder` 从 `out/` 出 exe。

### 修改 schema 的正确姿势

1. 改 `packages/shared/src/schema.ts`
2. `pnpm --filter @todograph/shared build`（让消费端拿到新类型）
3. 前端 store / 后端 route 会立即出现类型错误 → 按提示修

Zod 保证了 schema 改动无处可藏。

### 端口与代理

- Fastify：`5173`
- Vite：`5174`，`vite.config.ts` 里 `/api` 代理到 Fastify
- Electron 模式下 Fastify 监听随机端口，由 preload 注入给前端

---

## 🛠 构建 Portable EXE 的注意事项

一些实现细节（踩坑记录），方便二次开发者：

- 根目录 `.npmrc` 配了 `node-linker=hoisted` + `shamefully-hoist=true`。pnpm 默认的 symlink 布局会让 electron-builder 找不到二进制文件，扁平布局解决这个问题。
- `@todograph/core` / `shared` / `server` 作为工作区包被 electron-vite **直接 bundle 进主进程 bundle**（见 `electron.vite.config.ts` 的 `workspaceDeps` 排除名单），运行时不依赖符号链接。
- 第三方 Node 依赖（fastify 等）仍作为 external 保留在 `packages/app/node_modules`，由 electron-builder 打进 asar。
- `build.bat` 的 Step 0 会自愈被打断的安装（hoisted 生效后旧的子包 node_modules 可能残留死链）。
- 想打安装版（NSIS）：`packages/app/package.json` 的 `win.target` 改为 `nsis`。
- 想加图标：放 `packages/app/build/icon.ico`（256×256），electron-builder 自动识别。

---

## 🗺️ Roadmap

- [ ] **多项目**：`Task` 加 `projectId` 字段，Repository 按项目分片
- [ ] **时间约束**：`Task` 加 `deadline`，推荐策略考虑临近截止
- [ ] **AI 推荐**：`AIStrategy implements RecommendationStrategy`
- [ ] **远程协作**：server 部署到云端，preload 指向云端 URL
- [ ] **SQLite 存储**：新增 `SqliteRepository`，只改注入点
- [ ] **导入导出**：OPML / Markdown / JSON
- [ ] **键盘快捷键**：新建 / 删除 / 切状态 / 聚焦推荐
- [ ] **macOS / Linux 打包**：当前只跑了 Windows portable

---

## 🤝 贡献

欢迎 PR、issue 和讨论。

### 提 PR

1. Fork & 新建分支：`git checkout -b feat/xxx`
2. 编码 & 测试：`pnpm test`、`pnpm -r build` 保证通过
3. 提交使用清晰的消息（建议 Conventional Commits）
4. Push → 发 PR，描述改动动机和验证步骤

### 提 Issue

- Bug：附上复现步骤、实际行为、预期行为，如能提供 `tasks.json` 或截图更好
- Feature：先说用途 / 使用场景，再说实现建议

### 代码规范

- TS 严格模式，不留 `any`
- 公共函数 / 组件写 doc comment（中文 OK）
- 所有写入操作走 Zustand → 防抖 → Repository，不允许绕过
- 组件颜色只用主题变量，不写死 hex

---

## 📄 License

[MIT](./LICENSE) © TodoGraph contributors

---

## 🙏 致谢

- [@xyflow/react](https://reactflow.dev/) — 工业级图编辑器
- [shadcn/ui](https://ui.shadcn.com/) — 把设计系统源码化
- [Fastify](https://fastify.dev/) — 高性能 Node 框架
- [Zustand](https://zustand.docs.pmnd.rs/) — 小而美的状态管理
- [dagre](https://github.com/dagrejs/dagre) — 层级自动布局
