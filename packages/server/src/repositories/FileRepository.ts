import { promises as fs } from 'node:fs';
import path from 'node:path';
import { GraphSchema, type Graph, type Task } from '@todograph/shared';
import type { GraphRepository } from './Repository.js';

/**
 * 入门教程种子数据，新用户首次启动时展示。
 */
const seedNodes: Task[] = [
  { id: 't-welcome', title: '认识依赖图', status: 'done', x: 40, y: 60, description: '箭头 = 必须先完成前面的' },
  { id: 't-ready', title: '试试切换状态', status: 'done', x: 40, y: 180, description: '点左边的圆圈：todo → doing → done' },
  { id: 't-blocked', title: '我被阻塞了 🔒', status: 'todo', x: 40, y: 300, description: '把前面两个都点成 done，我就能解锁' },
  { id: 'g-group-demo', title: '这是父节点 📦', status: 'doing', x: 360, y: 40, description: '收纳子任务，拖标题栏可移动整组' },
  { id: 't-child1', title: '我是子任务 ①', status: 'doing', x: 24, y: 68, description: '双击标题就能原地编辑', parentId: 'g-group-demo' },
  { id: 't-child2', title: '子任务也能连箭头 ②', status: 'todo', x: 24, y: 144, description: '拖右边的圆点到 ③ 的左边', parentId: 'g-group-demo' },
  { id: 't-child3', title: '等前面的完成 ③', status: 'todo', x: 24, y: 220, description: '把 ② 做成 done，我就能解锁', parentId: 'g-group-demo' },
  { id: 'g-tips', title: '操作提示 💡', status: 'todo', x: 660, y: 40, description: '下面几个试试看' },
  { id: 't-tip-connect', title: '拖圆点连箭头', status: 'todo', x: 24, y: 68, description: '从右圆点拖线到另一个节点的左圆点', parentId: 'g-tips' },
  { id: 't-tip-space', title: '按空格键新建', status: 'todo', x: 24, y: 144, description: '手机长按空白 / 电脑按空格', parentId: 'g-tips' },
  { id: 't-tip-merge', title: '拖节点上 = 分组', status: 'todo', x: 24, y: 220, description: '拖到另一节点停留半秒，松手就归进去', parentId: 'g-tips' },
];

export const SEED_GRAPH: Graph = {
  nodes: seedNodes,
  edges: [
    { from: 't-welcome', to: 't-ready' },
    { from: 't-ready', to: 't-blocked' },
    { from: 't-child1', to: 't-child2' },
    { from: 't-child2', to: 't-child3' },
    { from: 't-tip-connect', to: 't-tip-space' },
    { from: 'g-group-demo', to: 'g-tips' },
  ],
};

/** Legacy v1 single-file repository kept for public API compatibility. */
export class FileRepository implements GraphRepository {
  constructor(private readonly filePath: string) {}

  async load(): Promise<Graph> {
    try {
      return GraphSchema.parse(JSON.parse(await fs.readFile(this.filePath, 'utf-8')));
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await this.save(SEED_GRAPH);
      return SEED_GRAPH;
    }
  }

  async save(graph: Graph): Promise<void> {
    const valid = GraphSchema.parse(graph);
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(valid, null, 2), 'utf-8');
    await fs.rename(temporary, this.filePath);
  }
}
