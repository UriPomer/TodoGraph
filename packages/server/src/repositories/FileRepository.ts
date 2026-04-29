import { promises as fs } from 'node:fs';
import path from 'node:path';
import { GraphSchema, type Graph } from '@todograph/shared';
import type { GraphRepository } from './Repository.js';

const SEED: Graph = {
  nodes: [
    { id: 't1', title: '欢迎使用 TodoGraph', status: 'todo', priority: 2, x: 120, y: 120 },
    { id: 't2', title: '拖拽节点 handle 建立依赖', status: 'todo', priority: 1, x: 420, y: 120 },
    { id: 't3', title: '完成依赖后自动推荐下一步', status: 'todo', priority: 3, x: 270, y: 300 },
  ],
  edges: [
    { from: 't1', to: 't3' },
    { from: 't2', to: 't3' },
  ],
};

/**
 * 基于 JSON 文件的仓库实现。
 * - 懒初始化：首次 load 若文件不存在则写入种子数据
 * - 原子写：先写临时文件，再 rename，避免崩溃时损坏主数据
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
        await this.save(SEED);
        return SEED;
      }
      throw err;
    }
  }

  async save(graph: Graph): Promise<void> {
    // 校验后再写（防止把损坏的数据写入磁盘）
    const valid = GraphSchema.parse(graph);
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tmp = this.filePath + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(valid, null, 2), 'utf-8');
    await fs.rename(tmp, this.filePath);
  }
}
