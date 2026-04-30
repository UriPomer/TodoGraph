import { promises as fs } from 'node:fs';
import path from 'node:path';
import { GraphSchema, type Graph } from '@todograph/shared';
import type { GraphRepository } from './Repository.js';

/**
 * 种子数据：无任何数据时写入的"默认页面"内容。
 *
 * 覆盖了 v2 的核心能力：
 * - 顶层节点 + 依赖边
 * - 父节点 + 子节点（演示分组）
 * - status/priority 三态齐全
 * - 描述字段（P2.5 新增）
 */
export const SEED_GRAPH: Graph = {
  nodes: [
    // ---- 顶层任务 ----
    {
      id: 't-collect',
      title: '收集资料',
      status: 'done',
      priority: 2,
      x: 80,
      y: 100,
      description: '把相关论文和开源项目过一遍，整理成一份大纲。',
    },
    {
      id: 't-proposal',
      title: '开题报告',
      status: 'done',
      priority: 3,
      x: 80,
      y: 220,
    },
    {
      id: 't-defense',
      title: '答辩',
      status: 'todo',
      priority: 3,
      x: 720,
      y: 200,
    },

    // ---- "毕设" 父节点 ----
    {
      id: 'g-thesis',
      title: '毕设',
      status: 'doing',
      priority: 3,
      x: 360,
      y: 60,
      description: '毕业设计主线任务，包含实验、报告、PPT 三个阶段。',
    },

    // ---- "毕设" 的子任务 ----
    {
      id: 't-exp',
      title: '做毕设实验',
      status: 'doing',
      priority: 3,
      parentId: 'g-thesis',
      x: 20,
      y: 40,
    },
    {
      id: 't-report',
      title: '写毕设报告',
      status: 'todo',
      priority: 2,
      parentId: 'g-thesis',
      x: 20,
      y: 110,
    },
    {
      id: 't-ppt',
      title: '写毕设 PPT',
      status: 'todo',
      priority: 1,
      parentId: 'g-thesis',
      x: 20,
      y: 180,
    },
  ],
  edges: [
    { from: 't-collect', to: 't-proposal' },
    { from: 't-proposal', to: 'g-thesis' },
    { from: 't-exp', to: 't-report' },
    { from: 't-report', to: 't-ppt' },
    { from: 'g-thesis', to: 't-defense' },
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
