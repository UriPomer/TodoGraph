import type { StoreApi } from 'zustand';
import type { Edge, PageData, Task, TaskStatus } from '@todograph/shared';

export interface TaskStore {
  /** 当前页的 pageId —— 供 scheduleSave/flush 使用。null 表示未加载任何页。 */
  activePageId: string | null;
  /** 乐观锁版本号：loadPage 时从服务端获取，保存时带上，用于检测多设备冲突。 */
  pageVersion: number;
  nodes: Task[];
  edges: Edge[];
  /** Only changes when ids, statuses, or dependency edges change. */
  recommendationRevision: number;
  /** Only changes when fields used by the list projection change; coordinates are excluded. */
  listRevision: number;
  loaded: boolean;
  /**
   * 图视口中心（世界坐标系）。GraphView 在初始化 / viewport 变动时
   * 通过 setViewportCenter 写入；列表里新建任务时读取用于放置新节点。
   * 未设置时 addTask 会回落到随机位置。
   */
  viewportCenter: { x: number; y: number } | null;
  setViewportCenter: (p: { x: number; y: number } | null) => void;
  /** 加载（或切换到）指定页面；会把之前页面的 nodes/edges 整体替换。 */
  loadPage: (pageId: string) => Promise<void>;
  /** 用服务端返回的数据替换当前页，不先 flush pending local edits。 */
  replaceLoadedPage: (pageId: string, data: PageData) => void;
  /** 立即把 pending 的保存写出去 —— 切页/卸载前调用。 */
  flush: () => Promise<void>;
  hasPendingSave: () => boolean;
  /** 退出登录或切换账号时停止后台任务并清空全部用户数据。 */
  resetSession: () => void;
  setSessionUser: (userId: string) => void;
  addTask: (input: {
    title: string;
    x?: number;
    y?: number;
    parentId?: string;
  }) => Task;
  updateTask: (id: string, patch: Partial<Omit<Task, 'id'>>) => void;
  deleteTask: (id: string) => void;
  deleteTasks: (ids: readonly string[]) => void;
  detachTasks: (ids: readonly string[]) => void;
  /** 批量更新坐标等，避免每次 set 都触发订阅者重渲染。 */
  updateTasksBulk: (patches: Array<{ id: string; patch: Partial<Omit<Task, 'id'>> }>) => void;
  /** 同步浏览器实测尺寸；属于派生几何，不进入撤销历史。 */
  syncMeasuredSizes: (measurements: Array<{ id: string; width: number; height: number }>) => void;
  toggleStatus: (id: string) => boolean;
  completeTask: (id: string) => boolean;
  setStatus: (id: string, status: TaskStatus) => void;
  addEdge: (from: string, to: string) => boolean;
  removeEdge: (from: string, to: string) => void;
  insertBetween: (aId: string, bId: string, title: string) => Task | null;
  /**
   * 把 childId 归入 parentId 下（parentId === null 表示解除归属到顶层）。
   * positionHint 提供时，直接用作 child 在新父下的相对坐标，跳过 world→local 转换。
   */
  setParent: (
    childId: string,
    parentId: string | null,
    positionHint?: { x: number; y: number },
  ) => boolean;
  /** 按列表视觉顺序把任务放到同级锚点之前或之后，不改变父子关系。 */
  reorderTask: (taskId: string, anchorId: string, position: 'before' | 'after', storageOrder: 'forward' | 'reverse') => boolean;
  /** 原子地改为锚点的同级任务并放入指定列表插槽。 */
  moveTaskToSibling: (taskId: string, anchorId: string, position: 'before' | 'after', storageOrder: 'forward' | 'reverse') => boolean;
  ascendOneLevel: (childId: string) => boolean;
  /** 把一批子任务合并到一个新父任务下；若 existingParentId 给出则复用它，否则创建新父。 */
  groupTasks: (
    childIds: string[],
    opts?: { title?: string; existingParentId?: string },
  ) => string | null;
  /** 回滚到最后一次 push 的快照；返回是否真正发生回滚。 */
  undo: () => boolean;
  /** 重新应用 redo 栈顶的快照；返回是否真正发生前进。 */
  redo: () => boolean;
  /** 自上次备份以来是否有新的 mutation。 */
  backupDirty: boolean;
  /** mutation 单调版本，避免旧备份完成后清掉新修改的 dirty 标记。 */
  backupRevision: number;
  markBackupDone: (pageId: string, revision: number) => void;
}

export interface TaskStoreContext {
  set: StoreApi<TaskStore>['setState'];
  get: () => TaskStore;
  pushPre: () => void;
  scheduleSave: () => void;
}
