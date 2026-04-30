import { describe, it, expect } from 'vitest';
import {
  depthOf,
  subtreeHeight,
  wouldExceedMaxDepth,
  MAX_HIERARCHY_DEPTH,
} from '@/stores/useTaskStore';
import type { Task } from '@todograph/shared';

const task = (id: string, parentId?: string): Task => ({
  id,
  title: id,
  status: 'todo',
  ...(parentId ? { parentId } : {}),
});

describe('depthOf', () => {
  it('root depth is 0', () => {
    expect(depthOf([task('a')], 'a')).toBe(0);
  });

  it('child depth is 1, grandchild is 2', () => {
    const ns = [task('a'), task('b', 'a'), task('c', 'b')];
    expect(depthOf(ns, 'a')).toBe(0);
    expect(depthOf(ns, 'b')).toBe(1);
    expect(depthOf(ns, 'c')).toBe(2);
  });

  it('does not loop on cyclic parent chain', () => {
    const ns: Task[] = [
      { id: 'a', title: 'a', status: 'todo', parentId: 'b' },
      { id: 'b', title: 'b', status: 'todo', parentId: 'a' },
    ];
    expect(() => depthOf(ns, 'a')).not.toThrow();
  });
});

describe('subtreeHeight', () => {
  it('leaf is 0', () => {
    expect(subtreeHeight([task('a')], 'a')).toBe(0);
  });

  it('parent with one child is 1', () => {
    expect(subtreeHeight([task('a'), task('b', 'a')], 'a')).toBe(1);
  });

  it('grandparent with chain is 2', () => {
    const ns = [task('a'), task('b', 'a'), task('c', 'b')];
    expect(subtreeHeight(ns, 'a')).toBe(2);
  });
});

describe('wouldExceedMaxDepth', () => {
  it('MAX is 3', () => {
    expect(MAX_HIERARCHY_DEPTH).toBe(3);
  });

  it('attaching leaf to root: 2 levels → ok', () => {
    const ns = [task('root'), task('leaf')];
    expect(wouldExceedMaxDepth(ns, 'leaf', 'root')).toBe(false);
  });

  it('attaching leaf to depth-1 parent (grandchild position) → ok', () => {
    const ns = [task('root'), task('mid', 'root'), task('leaf')];
    expect(wouldExceedMaxDepth(ns, 'leaf', 'mid')).toBe(false);
  });

  it('attaching subtree-height-1 to depth-1 parent → would make 4 levels → reject', () => {
    // p has 1 child (c) → height 1; depth of mid is 1;
    // result depth = 1 (mid) + 1 (p as new child) + 1 (c) = 3 → levels = 4 > 3
    const ns = [task('root'), task('mid', 'root'), task('p'), task('c', 'p')];
    expect(wouldExceedMaxDepth(ns, 'p', 'mid')).toBe(true);
  });

  it('parentId null always allowed', () => {
    expect(wouldExceedMaxDepth([task('a')], 'a', null)).toBe(false);
  });
});
