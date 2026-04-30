import { describe, it, expect } from 'vitest';
import { defaultPositionFor } from '@/lib/defaultPosition';
import {
  GROUP_PADDING_X,
  GROUP_PADDING_Y,
  CHILD_DEFAULT_H,
} from '@/features/graph/computeGroupSize';
import type { Task } from '@todograph/shared';

describe('defaultPositionFor', () => {
  it('fallback when no viewport center', () => {
    expect(defaultPositionFor({ nodes: [], viewportCenter: null })).toEqual({ x: 200, y: 120 });
  });

  it('uses viewport center (offset by half-node)', () => {
    expect(defaultPositionFor({ nodes: [], viewportCenter: { x: 500, y: 300 } })).toEqual({
      x: 410,
      y: 272,
    });
  });

  it('parent: empty parent → stacks at initial padding', () => {
    const ns: Task[] = [{ id: 'p', title: 'p', status: 'todo' }];
    const pos = defaultPositionFor({ parentId: 'p', nodes: ns, viewportCenter: null });
    expect(pos.x).toBe(GROUP_PADDING_X);
    expect(pos.y).toBe(GROUP_PADDING_Y + 12);
  });

  it('parent: stacks below existing children', () => {
    const ns: Task[] = [
      { id: 'p', title: 'p', status: 'todo' },
      { id: 'c1', title: 'c1', status: 'todo', parentId: 'p', x: GROUP_PADDING_X, y: GROUP_PADDING_Y },
    ];
    const pos = defaultPositionFor({ parentId: 'p', nodes: ns, viewportCenter: null });
    expect(pos.x).toBe(GROUP_PADDING_X);
    // Below c1's bottom (GROUP_PADDING_Y + CHILD_DEFAULT_H) + 12
    expect(pos.y).toBe(GROUP_PADDING_Y + CHILD_DEFAULT_H + 12);
  });

  it('parent: takes max bottom of siblings', () => {
    const ns: Task[] = [
      { id: 'p', title: 'p', status: 'todo' },
      { id: 'a', title: 'a', status: 'todo', parentId: 'p', x: 24, y: 200 },
      { id: 'b', title: 'b', status: 'todo', parentId: 'p', x: 24, y: 60 },
    ];
    const pos = defaultPositionFor({ parentId: 'p', nodes: ns, viewportCenter: null });
    expect(pos.y).toBe(200 + CHILD_DEFAULT_H + 12);
  });

  it('parent: ignores non-siblings', () => {
    const ns: Task[] = [
      { id: 'p', title: 'p', status: 'todo' },
      { id: 'q', title: 'q', status: 'todo' },
      { id: 'qc', title: 'qc', status: 'todo', parentId: 'q', x: 24, y: 999 },
    ];
    const pos = defaultPositionFor({ parentId: 'p', nodes: ns, viewportCenter: null });
    expect(pos.y).toBe(GROUP_PADDING_Y + 12);
  });
});
