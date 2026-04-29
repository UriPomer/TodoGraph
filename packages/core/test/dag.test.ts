import { describe, expect, it } from 'vitest';
import { buildAdj, isDAG, topoSort, wouldCreateCycle } from '../src/dag.js';
import { readyTasks } from '../src/ready.js';
import type { Graph } from '../src/types.js';

const g = (nodes: Graph['nodes'], edges: Graph['edges']): Graph => ({ nodes, edges });
const t = (id: string, status: 'todo' | 'doing' | 'done' = 'todo') => ({
  id,
  title: id,
  status,
});

describe('buildAdj', () => {
  it('ignores self-loops and unknown endpoints', () => {
    const graph = g(
      [t('a'), t('b')],
      [
        { from: 'a', to: 'a' },
        { from: 'a', to: 'b' },
        { from: 'x', to: 'b' }, // unknown
      ],
    );
    const adj = buildAdj(graph);
    expect([...adj.children.get('a')!]).toEqual(['b']);
    expect([...adj.parents.get('b')!]).toEqual(['a']);
  });
});

describe('wouldCreateCycle', () => {
  it('returns true for direct self-loop', () => {
    expect(wouldCreateCycle(g([t('a')], []), 'a', 'a')).toBe(true);
  });

  it('detects cycle on indirect reverse path', () => {
    const graph = g([t('a'), t('b'), t('c')], [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
    ]);
    // 加 c → a 会形成 a→b→c→a 的环
    expect(wouldCreateCycle(graph, 'c', 'a')).toBe(true);
    // 加 a → c 仍是 DAG
    expect(wouldCreateCycle(graph, 'a', 'c')).toBe(false);
  });
});

describe('topoSort / isDAG', () => {
  it('returns valid order for DAG', () => {
    const graph = g([t('a'), t('b'), t('c')], [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
    ]);
    const order = topoSort(graph);
    expect(order).not.toBeNull();
    expect(order!.indexOf('a')).toBeLessThan(order!.indexOf('b'));
    expect(order!.indexOf('b')).toBeLessThan(order!.indexOf('c'));
    expect(isDAG(graph)).toBe(true);
  });

  it('returns null when cycle exists', () => {
    const graph = g([t('a'), t('b')], [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'a' },
    ]);
    expect(topoSort(graph)).toBeNull();
    expect(isDAG(graph)).toBe(false);
  });
});

describe('readyTasks', () => {
  it('includes root todo tasks', () => {
    const graph = g([t('a'), t('b')], []);
    expect(readyTasks(graph).map((n) => n.id).sort()).toEqual(['a', 'b']);
  });

  it('excludes tasks with undone parents', () => {
    const graph = g([t('a', 'todo'), t('b')], [{ from: 'a', to: 'b' }]);
    expect(readyTasks(graph).map((n) => n.id)).toEqual(['a']);
  });

  it('includes task when all parents done', () => {
    const graph = g([t('a', 'done'), t('b')], [{ from: 'a', to: 'b' }]);
    expect(readyTasks(graph).map((n) => n.id)).toEqual(['b']);
  });

  it('excludes done tasks', () => {
    const graph = g([t('a', 'done')], []);
    expect(readyTasks(graph)).toEqual([]);
  });
});
