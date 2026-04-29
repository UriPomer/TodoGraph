import { describe, expect, it } from 'vitest';
import { rankRecommendations, recommend } from '../src/recommender.js';
import type { Graph } from '../src/types.js';

const g = (nodes: Graph['nodes'], edges: Graph['edges']): Graph => ({ nodes, edges });

describe('defaultStrategy / recommend', () => {
  it('returns null when no ready tasks', () => {
    expect(recommend(g([], []))).toBeNull();
    expect(
      recommend(
        g(
          [
            { id: 'a', title: 'a', status: 'done' },
            { id: 'b', title: 'b', status: 'done' },
          ],
          [],
        ),
      ),
    ).toBeNull();
  });

  it('prefers doing over todo', () => {
    const graph = g(
      [
        { id: 'a', title: 'a', status: 'todo', priority: 3 },
        { id: 'b', title: 'b', status: 'doing', priority: 1 },
      ],
      [],
    );
    expect(recommend(graph)?.id).toBe('b');
  });

  it('prefers higher priority among same status', () => {
    const graph = g(
      [
        { id: 'a', title: 'a', status: 'todo', priority: 1 },
        { id: 'b', title: 'b', status: 'todo', priority: 3 },
        { id: 'c', title: 'c', status: 'todo', priority: 2 },
      ],
      [],
    );
    const rank = rankRecommendations(graph).map((n) => n.id);
    expect(rank).toEqual(['b', 'c', 'a']);
  });

  it('tiebreaks by downstream count', () => {
    // 两个同优先级的 ready，拥有更多下游的应排在前
    const graph = g(
      [
        { id: 'a', title: 'a', status: 'todo', priority: 2 },
        { id: 'b', title: 'b', status: 'todo', priority: 2 },
        { id: 'c', title: 'c', status: 'todo' },
        { id: 'd', title: 'd', status: 'todo' },
      ],
      [
        { from: 'a', to: 'c' },
        { from: 'a', to: 'd' },
      ],
    );
    expect(recommend(graph)?.id).toBe('a');
  });
});
