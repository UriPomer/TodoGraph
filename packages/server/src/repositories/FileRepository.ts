import { promises as fs } from 'node:fs';
import path from 'node:path';
import { GraphSchema, type Graph } from '@todograph/shared';
import type { GraphRepository } from './Repository.js';

/**
 * 种子数据：首次启动时写入 data/tasks.json。
 *
 * 这份示例尽量覆盖当前所有字段和功能：
 * - 顶层节点 + 依赖边（"收集资料" → "开题报告" → "毕设"分组）
 * - 父节点（"毕设"）：自身参与依赖连线（入边 + 出边），并包含三个子任务
 * - 子节点用 parentId 归入父节点，x/y 为相对父节点的偏移（世界坐标 = 父 + 相对）
 * - status 三态齐全：done / doing / todo（done 链路会显示"动画边"）
 * - priority 三档齐全：1 低 / 2 中 / 3 高（用于推荐排序）
 * - 既有组内依赖（实验 → 报告 → ppt），也有跨组依赖（分组 → 答辩）
 */
const SEED: Graph = {
  nodes: [
    // ---- 顶层任务 ----
    {
      id: 't-collect',
      title: '收集资料',
      status: 'done',
      priority: 2,
      x: 80,
      y: 100,
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
    // 父节点本身是普通 Task，status / priority 都有意义；
    // 它的 x/y 为世界坐标；在图视图中，其尺寸由所有子节点包围盒 + padding 自动算出。
    {
      id: 'g-thesis',
      title: '毕设',
      status: 'doing',
      priority: 3,
      x: 360,
      y: 60,
    },

    // ---- "毕设" 的子任务（parentId 指向 g-thesis）----
    // 注意：带 parentId 的节点的 x/y 是相对父节点左上角的偏移
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
    // 顶层链：收集资料 → 开题（done → done，动画边）
    { from: 't-collect', to: 't-proposal' },
    // 开题完成后才能真正进入"毕设"分组
    { from: 't-proposal', to: 'g-thesis' },
    // 组内顺序：实验 → 报告 → PPT
    { from: 't-exp', to: 't-report' },
    { from: 't-report', to: 't-ppt' },
    // 分组本身作为"已完成"前置条件，指向答辩
    { from: 'g-thesis', to: 't-defense' },
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
