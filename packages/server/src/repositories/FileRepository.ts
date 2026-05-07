import { promises as fs } from 'node:fs';
import path from 'node:path';
import { GraphSchema, type Graph } from '@todograph/shared';
import type { GraphRepository } from './Repository.js';

/**
 * 种子数据：新用户首次启动时的入门教程。
 *
 * 覆盖 v2 核心概念：
 * - 顶层节点 + 依赖边（演示 Ready/Blocked）
 * - 父节点 + 子节点（演示分组）
 * - status / priority 三态齐全
 * - description 字段提供上下文提示
 */
export const SEED_GRAPH: Graph = {
  nodes: [
    // ============================================================
    // 左上：核心概念链（线性的三步教程）
    // ============================================================
    {
      id: 't-welcome',
      title: '👋 认识 TodoGraph',
      status: 'done',
      priority: 3,
      x: 40,
      y: 60,
      description: 'TodoGraph 把任务组织成一张依赖图。每个任务是一个节点，箭头表示"必须在…之后"。系统自动告诉你哪些任务已经解锁、哪些还被阻塞。',
    },
    {
      id: 't-ready',
      title: '✅ Ready：已解锁的任务',
      status: 'done',
      priority: 3,
      x: 40,
      y: 180,
      description: '所有前置任务都完成后，这个任务就进入 Ready 状态 —— 意味着你现在就可以开始做它。Ready 任务在列表和图中都会有绿色边框标记。',
    },
    {
      id: 't-blocked',
      title: '🔒 Blocked：被阻塞的任务',
      status: 'todo',
      priority: 3,
      x: 40,
      y: 300,
      description: '还有前置任务没完成？那它就是 Blocked 状态。左侧列表会自动按 Ready / Blocked / Done 分组。把前面两个任务标记为 done 试试看这个会不会解锁。',
    },

    // ============================================================
    // 中部：分组演示（父节点 + 三个子节点）
    // ============================================================
    {
      id: 'g-group-demo',
      title: '📦 父节点：这是一个分组',
      status: 'doing',
      priority: 2,
      x: 360,
      y: 40,
      description: '父节点就像一个文件夹，把相关子任务收纳在一起。父节点本身也是一个任务，可以参与依赖连线。拖动标题栏即可移动整组。',
    },
    {
      id: 't-child1',
      title: '子任务：可独立操作',
      status: 'doing',
      priority: 2,
      parentId: 'g-group-demo',
      x: 24,
      y: 68,
      description: '子任务存在于父节点内部，可以独立切换状态、编辑、删除。坐标 (x,y) 存储的是相对父节点左上角的偏移量。',
    },
    {
      id: 't-child2',
      title: '子任务之间也能连线',
      status: 'todo',
      priority: 2,
      parentId: 'g-group-demo',
      x: 24,
      y: 144,
      description: '子节点之间的依赖边和顶层节点完全一样 —— 只是它们被收纳在父节点容器内。把子任务切换为 done 试试看。',
    },
    {
      id: 't-child3',
      title: '子任务：等待上级完成',
      status: 'todo',
      priority: 1,
      parentId: 'g-group-demo',
      x: 24,
      y: 220,
      description: '这个子任务被上面的子任务阻塞着。注意：父节点的状态是独立管理的 —— 即使所有子任务都 done，父节点也不会自动变成 done。',
    },

    // ============================================================
    // 右侧：操作技巧（一个分组 + 两个子任务）
    // ============================================================
    {
      id: 'g-tips',
      title: '💡 试试这些操作',
      status: 'todo',
      priority: 1,
      x: 660,
      y: 40,
      description: '花 2 分钟上手核心手势，之后效率会很高。',
    },
    {
      id: 't-tip-connect',
      title: '拖拽圆点连边',
      status: 'todo',
      priority: 2,
      parentId: 'g-tips',
      x: 24,
      y: 68,
      description: '节点左右两侧有圆点（Handle）。从右侧圆点拖出一条线，连接到另一个节点的左侧圆点，就创建了一条依赖边。',
    },
    {
      id: 't-tip-space',
      title: '空格键 / 回车键新建',
      status: 'todo',
      priority: 2,
      parentId: 'g-tips',
      x: 24,
      y: 144,
      description: '在图视图中，把鼠标放到空白位置，按空格或回车即可在鼠标位置创建新节点。移动端可以直接点击空白区域。',
    },
    {
      id: 't-tip-merge',
      title: '拖拽合并分组',
      status: 'todo',
      priority: 1,
      parentId: 'g-tips',
      x: 24,
      y: 220,
      description: '把任意任务拖到另一个任务上，停留半秒后会显示合并预览，松手即归入分组。选中多个节点后右键可批量归入新分组。',
    },

    // ============================================================
    // 底部：单独节点 —— 演示优先级
    // ============================================================
    {
      id: 't-priority',
      title: '🔴 高优先级任务示例',
      status: 'todo',
      priority: 3,
      x: 360,
      y: 360,
      description: '任务可以设置 1（低）/ 2（中）/ 3（高）三个优先级。系统推荐时会优先推荐高优先级 + 下游影响大的 Ready 任务。双击标题文字即可编辑。',
    },
  ],
  edges: [
    // 核心概念链：线性依赖，演示 Ready → Blocked 的流转
    { from: 't-welcome', to: 't-ready' },
    { from: 't-ready', to: 't-blocked' },

    // 分组内子任务之间的依赖
    { from: 't-child1', to: 't-child2' },
    { from: 't-child2', to: 't-child3' },

    // 分组内的技巧节点之间的依赖
    { from: 't-tip-connect', to: 't-tip-space' },

    // 跨组依赖：演示分组之间也可以连线
    { from: 'g-group-demo', to: 'g-tips' },
  ],
};

/**
 * 【legacy v1】基于单个 JSON 文件的仓库。
 *
 * **仅迁移脚本使用** —— 把老的 `data/tasks.json` 读成一整张 Graph。
 * v2 生产代码请使用 `FileWorkspaceRepository`。
 */
export class FileRepository implements GraphRepository {
  constructor(private readonly filePath: string) {}

  async load(): Promise<Graph> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      return GraphSchema.parse(parsed);
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') {
        // v2 迁移时这个分支不再走 —— 旧代码路径保留兼容
        await this.save(SEED_GRAPH);
        return SEED_GRAPH;
      }
      throw err;
    }
  }

  async save(graph: Graph): Promise<void> {
    const valid = GraphSchema.parse(graph);
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tmp = this.filePath + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(valid, null, 2), 'utf-8');
    await fs.rename(tmp, this.filePath);
  }
}
