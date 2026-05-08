import { promises as fs } from 'node:fs';
import path from 'node:path';
import { GraphSchema, type Graph } from '@todograph/shared';
import type { GraphRepository } from './Repository.js';

/**
 * 入门教程种子数据，新用户首次启动时展示。
 */
export const SEED_GRAPH: Graph = {
  nodes: [
    // ---- 左上：核心概念链（线形依赖，演示 Ready/Blocked） ----
    {
      id: 't-welcome',
      title: '认识依赖图',
      status: 'done',
      priority: 3,
      x: 40,
      y: 60,
      description: '箭头 = 必须先完成前面的',
    },
    {
      id: 't-ready',
      title: '试试切换状态',
      status: 'done',
      priority: 3,
      x: 40,
      y: 180,
      description: '点左边的圆圈：todo → doing → done',
    },
    {
      id: 't-blocked',
      title: '我被阻塞了 🔒',
      status: 'todo',
      priority: 3,
      x: 40,
      y: 300,
      description: '把前面两个都点成 done，我就能解锁',
    },

    // ---- 中部：分组演示 ----
    {
      id: 'g-group-demo',
      title: '这是父节点 📦',
      status: 'doing',
      priority: 2,
      x: 360,
      y: 40,
      description: '收纳子任务，拖标题栏可移动整组',
    },
    {
      id: 't-child1',
      title: '我是子任务 ①',
      status: 'doing',
      priority: 2,
      parentId: 'g-group-demo',
      x: 24,
      y: 68,
      description: '双击标题就能原地编辑',
    },
    {
      id: 't-child2',
      title: '子任务也能连箭头 ②',
      status: 'todo',
      priority: 2,
      parentId: 'g-group-demo',
      x: 24,
      y: 144,
      description: '拖右边的圆点到 ③ 的左边',
    },
    {
      id: 't-child3',
      title: '等前面的完成 ③',
      status: 'todo',
      priority: 1,
      parentId: 'g-group-demo',
      x: 24,
      y: 220,
      description: '把 ② 做成 done，我就能解锁',
    },

    // ---- 右侧：操作技巧 ----
    {
      id: 'g-tips',
      title: '操作提示 💡',
      status: 'todo',
      priority: 1,
      x: 660,
      y: 40,
      description: '下面几个试试看',
    },
    {
      id: 't-tip-connect',
      title: '拖圆点连箭头',
      status: 'todo',
      priority: 2,
      parentId: 'g-tips',
      x: 24,
      y: 68,
      description: '从右圆点拖线到另一个节点的左圆点',
    },
    {
      id: 't-tip-space',
      title: '按空格键新建',
      status: 'todo',
      priority: 2,
      parentId: 'g-tips',
      x: 24,
      y: 144,
      description: '手机长按空白 / 电脑按空格',
    },
    {
      id: 't-tip-merge',
      title: '拖节点上 = 分组',
      status: 'todo',
      priority: 1,
      parentId: 'g-tips',
      x: 24,
      y: 220,
      description: '拖到另一节点停留半秒，松手就归进去',
    },

    // ---- 底部：独立节点演示优先级 ----
    {
      id: 't-priority',
      title: '高优先级 ⭐',
      status: 'todo',
      priority: 3,
      x: 360,
      y: 360,
      description: '优先级 1/2/3，越高越推荐先做',
    },
  ],
  edges: [
    { from: 't-welcome', to: 't-ready' },
    { from: 't-ready', to: 't-blocked' },
    { from: 't-child1', to: 't-child2' },
    { from: 't-child2', to: 't-child3' },
    { from: 't-tip-connect', to: 't-tip-space' },
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
