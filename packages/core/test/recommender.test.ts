import { describe, expect, it } from 'vitest';
import { deriveReadyAndRecommended, rankRecommendations, recommend } from '../src/recommender.js';
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
        { id: 'a', title: 'a', status: 'todo' },
        { id: 'b', title: 'b', status: 'doing' },
      ],
      [],
    );
    expect(recommend(graph)?.id).toBe('b');
  });

  it('tiebreaks by downstream count', () => {
    // 两个同状态 ready，拥有更多下游的应排在前
    const graph = g(
      [
        { id: 'a', title: 'a', status: 'todo' },
        { id: 'b', title: 'b', status: 'todo' },
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

  it('counts a shared downstream task only once', () => {
    const graph = g(
      ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, title: id, status: 'todo' as const })),
      [
        { from: 'a', to: 'c' },
        { from: 'a', to: 'd' },
        { from: 'c', to: 'e' },
        { from: 'd', to: 'e' },
        { from: 'b', to: 'c' },
      ],
    );
    expect(
      rankRecommendations(graph)
        .map((node) => node.id)
        .slice(0, 2),
    ).toEqual(['a', 'b']);
  });

  it('handles a large dependency chain', () => {
    const nodes = Array.from({ length: 1000 }, (_, index) => ({
      id: `n${index}`,
      title: `n${index}`,
      status: 'todo' as const,
    }));
    const edges = nodes.slice(1).map((node, index) => ({ from: nodes[index]!.id, to: node.id }));
    expect(recommend(g(nodes, edges))?.id).toBe('n0');
  });

  it('derives ready list, ready set, and recommendation in one pass', () => {
    const graph = g(
      [
        { id: 'a', title: 'a', status: 'todo' },
        { id: 'b', title: 'b', status: 'doing' },
        { id: 'c', title: 'c', status: 'todo' },
        { id: 'd', title: 'd', status: 'done' },
      ],
      [{ from: 'd', to: 'c' }],
    );

    const derived = deriveReadyAndRecommended(graph);

    expect(derived.ready.map((node) => node.id)).toEqual(['a', 'b', 'c']);
    expect([...derived.readySet]).toEqual(['a', 'b', 'c']);
    expect(derived.recommended?.id).toBe('b');
  });

  it('returns empty ready state when no task is ready', () => {
    const graph = g(
      [
        { id: 'a', title: 'a', status: 'done' },
        { id: 'b', title: 'b', status: 'done' },
      ],
      [],
    );

    expect(deriveReadyAndRecommended(graph)).toEqual({
      ready: [],
      readySet: new Set(),
      recommended: null,
    });
  });
});
