import { z } from 'zod';

export const TaskStatusSchema = z.enum(['todo', 'doing', 'done']);
export const MAX_TASK_TITLE_LENGTH = 200;
export const MAX_PAGE_TITLE_LENGTH = 100;
export const SYSTEM_HIERARCHY_PAGE_ID = 'system-hierarchy';
export const SYSTEM_HIERARCHY_PAGE_TITLE = '清单';

export const TaskSchema = z.object({
  id: z.string().min(1),
  // Persisted data remains readable across upgrades; write boundaries enforce the current limit.
  title: z.string(),
  status: TaskStatusSchema,
  x: z.number().optional(),
  y: z.number().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  /**
   * 父任务 id（分组/compound node 用）。
   * - 当一个任务有 parentId 时，它在图中被渲染到父节点的容器内，
   *   坐标 (x, y) 视为相对父节点左上角的偏移。
   * - 父节点本身仍是一个正常的 Task，可以参与依赖边连线。
   * - 自引用、循环、悬空父节点和最大深度由共享层级校验在客户端与服务端共同保证。
   */
  parentId: z.string().optional(),
  /**
   * 任务描述 —— 长文，支持多行。上限 4000 字节，避免误贴超长文本。
   * 显示层会做截断（前两行），hover 出完整 tooltip。
   */
  description: z.string().max(4000).optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const EdgeSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
});

/**
 * 【v1 legacy】整张图的 schema —— 仅供迁移脚本读老 tasks.json 使用。
 * 新代码应通过 `PageDataSchema` + `MetaSchema` 访问多页面数据。
 */
export const GraphSchema = z.object({
  nodes: z.array(TaskSchema),
  edges: z.array(EdgeSchema),
});

/**
 * 单个页面的数据文件（`data/pages/{pageId}.json`）。
 * 自足：只含本页面的 nodes+edges；页面元信息（标题/顺序）集中在 meta.json。
 * 不能含跨页面 edge —— 服务端在 PUT/move-nodes 时保证。
 */
export const PageDataSchema = z.object({
  /** 乐观锁版本号：服务端每次保存时从磁盘读取并自增，客户端传入的版本仅用于比对。
   *  optional —— 迁移/新建页面时服务端内部调用不传此字段，旧数据文件也缺此字段。 */
  version: z.number().int().min(0).optional(),
  nodes: z.array(TaskSchema),
  edges: z.array(EdgeSchema),
});

/** 页面元信息，存在 meta.json 的 `pages` 数组中。 */
export const PageInfoSchema = z.object({
  id: z.string().min(1),
  // Persisted data remains readable across upgrades; write boundaries enforce the current limit.
  title: z.string(),
  order: z.number().int(),
  /** ISO-8601 创建时间，仅展示用。 */
  createdAt: z.string(),
  /** hierarchy pages deliberately have no dependency graph or dependency edges. */
  kind: z.enum(['graph', 'hierarchy']).optional(),
});

/** 全局工作区设置 —— 目前只放拖拽时长，未来可扩。 */
/**
 * 工作区元信息（`data/meta.json`）。
 * `version` 字段是迁移判据 —— 老数据若检测到此文件存在，就认为已经是 v2。
 */
export const MetaSchema = z.object({
  version: z.literal(2),
  revision: z.number().int().min(0).default(0),
  activePageId: z.string().min(1),
  pages: z.array(PageInfoSchema),
});

export type TaskStatus = z.infer<typeof TaskStatusSchema>;
export type Task = z.infer<typeof TaskSchema>;
export type Edge = z.infer<typeof EdgeSchema>;
export type Graph = z.infer<typeof GraphSchema>;
export type PageData = z.infer<typeof PageDataSchema>;
export type PageInfo = z.infer<typeof PageInfoSchema>;
export type Meta = z.infer<typeof MetaSchema>;

export function pageSupportsDependencyGraph(page: Pick<PageInfo, 'kind'> | undefined): boolean {
  return page?.kind !== 'hierarchy';
}

/** 聚合 `/api/all-tasks` 的返回体。附上页面冗余信息方便左侧列表直接渲染。 */
export const AllTasksItemSchema = TaskSchema.extend({
  _pageId: z.string().min(1),
  _pageTitle: z.string(),
  _ready: z.boolean(),
});
export const AllTasksResponseSchema = z.object({
  tasks: z.array(AllTasksItemSchema),
  errors: z.array(z.object({ pageId: z.string(), message: z.string() })).optional(),
});
export type AllTasksItem = z.infer<typeof AllTasksItemSchema>;
export type AllTasksResponse = z.infer<typeof AllTasksResponseSchema>;

/** 跨页转移接口的返回体。客户端据此 toast 提示用户。 */
export const MoveNodesResponseSchema = z.object({
  movedNodes: z.number().int(),
  movedEdges: z.number().int(),
  /** 自动一并带走的子孙数量（用户未显式选中但同步转移了）。 */
  autoIncludedChildren: z.number().int(),
  /** 被切断的跨页 edge 数（原页面里某端被转走另一端没走）。 */
  lostEdges: z.number().int(),
  /** 被清空 parentId 的节点数 —— 即"有 parent 但 parent 没被转走"的场景。 */
  droppedParentLinks: z.number().int(),
});
export type MoveNodesResponse = z.infer<typeof MoveNodesResponseSchema>;
