# 2026-07-22 代码与行为审查

## 范围与基线

审查覆盖工作区导航、列表/依赖图手势、层级、Zustand 会话边界、服务端认证与文件仓库、MCP、Electron 构建和生产依赖。行为依据为 `docs/behavior/`。

审查前全仓 424 项 Vitest 测试和 TypeScript 类型检查通过。这证明纯函数和存储边界有覆盖，但不能证明真实浏览器的 passive touch、滚动抢占和平台差异。

## 已处理问题

| 严重度 | 位置 | 问题与根因 | 处理 |
|---|---|---|---|
| P1 | `PageBar` / WorkspaceStore | 页面模式返回上下文保存在组件 ref，默认视图还是依赖图；组件生命周期与数据页状态被当作模式历史 | 增加会话级 `{pageId, view}`，用纯导航策略恢复并在登出时清除；新增 NAV-001～003 测试 |
| P1 | `TaskItem` | 列表长按为 240ms，与行为预期和依赖图 500ms 不一致，滚动时容易误触 | 固定为列表拖动 400ms、图空白创建 500ms；阈值集中到手势策略模块 |
| P1 | 根依赖覆盖 | `fast-uri@3.1.2` 命中两个高危公告；MCP 依赖链另含 Hono 中危和 body-parser 低危 | 覆盖到 `fast-uri@3.1.4`、`@hono/node-server@2.0.11`、`body-parser@2.3.0`；生产依赖审计归零，MCP/服务端测试通过 |
| P2 | `GraphView` 多选落位 | 每个父组重新扫描全部图节点，复杂度约为 O(g×n) | 一次建立未选节点父级索引，降为 O(n)，保持排序和碰撞策略不变 |
| P2 | Web 移动端外壳 | 缺少 manifest 和 iOS standalone 元数据 | 增加 Web App manifest、主题色、viewport/safe-area 与 iOS standalone 元数据；不缓存认证 API |
| P2 | 自动化 | 组件测试模拟 DOM listener，但没有 Chromium/WebKit 实际事件循环 | 加入隔离数据目录的 Playwright Android Chromium/iOS WebKit 项目；覆盖双击编辑和 Android 连续长按拖动 |

## 保留风险与后续项

- **P2：GraphView 体积过大。** 投影、碰撞、选择和视口仍集中在单组件。当前没有证据支持一次性拆分；后续只在修改相应行为时逐个抽取纯控制器。
- **P2：iOS 移动拖动自动化受限。** Playwright WebKit 可验证真实双击触摸，但不提供移动中的低层触点注入；iPhone Safari 真机仍是发布门禁。Android Chromium 使用 CDP 验证长按、移动、结束和连续第二次拖动。
- **P2：500 节点以上的浏览器性能缺少稳定硬件基准。** 当前保留 `content-visibility`，不引入可能破坏动态高度、落位提示和动画的列表虚拟化。
- **P3：PWA 图标仍复用现有 ICO。** 原生壳阶段应补齐 Apple/Android 多尺寸 PNG 和启动资源。

## 结论

服务端认证、容量/层级/DAG 校验、原子文件写入、冲突恢复和会话清理均已有针对性测试，未发现新的 P0/P1 实现缺陷。最主要的历史回归来源是产品状态与浏览器手势没有独立行为契约；本次通过行为 ID、纯策略和真实浏览器测试建立了对应门禁。

最终验证：430 项 Vitest 测试通过，Playwright 3 项通过/1 项按 WebKit 输入能力说明跳过，类型检查和全仓构建通过，`pnpm audit --prod` 无已知漏洞。
