import { describe, it, expect } from 'vitest';
import {
  buildHierarchyMetrics,
  depthOf,
  subtreeHeight,
  wouldExceedMaxDepth,
} from '@/stores/useTaskStore';
import {
  MAX_HIERARCHY_DEPTH,
  validateDependencyEdges,
  validateTaskHierarchy,
  type Task,
} from '@todograph/shared';

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

describe('buildHierarchyMetrics', () => {
  it('computes depth and subtree height for the whole hierarchy once', () => {
    const ns = [task('root'), task('child', 'root'), task('grand', 'child'), task('solo')];
    const metrics = buildHierarchyMetrics(ns);

    expect(metrics.depthById.get('root')).toBe(0);
    expect(metrics.depthById.get('child')).toBe(1);
    expect(metrics.depthById.get('grand')).toBe(2);
    expect(metrics.depthById.get('solo')).toBe(0);

    expect(metrics.subtreeHeightById.get('grand')).toBe(0);
    expect(metrics.subtreeHeightById.get('child')).toBe(1);
    expect(metrics.subtreeHeightById.get('root')).toBe(2);
    expect(metrics.subtreeHeightById.get('solo')).toBe(0);
  });

  it('stays finite on cyclic parent links', () => {
    const ns: Task[] = [
      { id: 'a', title: 'a', status: 'todo', parentId: 'b' },
      { id: 'b', title: 'b', status: 'todo', parentId: 'a' },
    ];

    const metrics = buildHierarchyMetrics(ns);

    expect(metrics.depthById.get('a')).toBe(2);
    expect(metrics.depthById.get('b')).toBe(2);
    expect(metrics.subtreeHeightById.get('a')).toBeLessThanOrEqual(2);
    expect(metrics.subtreeHeightById.get('b')).toBeLessThanOrEqual(2);
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

describe('validateTaskHierarchy', () => {
  it('rejects missing parents, cycles, duplicate ids, and excessive depth', () => {
    expect(validateTaskHierarchy([task('child', 'missing')])).toMatchObject({
      valid: false,
      reason: 'missing-parent',
    });
    expect(validateTaskHierarchy([task('a', 'b'), task('b', 'a')])).toMatchObject({
      valid: false,
      reason: 'cycle',
    });
    expect(validateTaskHierarchy([task('same'), task('same')])).toMatchObject({
      valid: false,
      reason: 'duplicate-id',
    });
    expect(
      validateTaskHierarchy([
        task('root'),
        task('child', 'root'),
        task('grandchild', 'child'),
        task('too-deep', 'grandchild'),
      ]),
    ).toMatchObject({ valid: false, reason: 'max-depth' });
    expect(validateTaskHierarchy([task('root'), task('child', 'root')])).toEqual({ valid: true });
  });

  it('rejects a very deep chain without recursive stack growth', () => {
    const nodes = Array.from({ length: 20_000 }, (_, index) =>
      task(String(index), index === 0 ? undefined : String(index - 1)),
    );
    expect(validateTaskHierarchy(nodes)).toMatchObject({ valid: false, reason: 'max-depth' });
  });
});

describe('validateDependencyEdges', () => {
  it('rejects self edges and missing endpoints', () => {
    const nodes = [task('a'), task('b')];
    expect(validateDependencyEdges(nodes, [{ from: 'a', to: 'a' }])).toMatchObject({ valid: false, reason: 'self-edge' });
    expect(validateDependencyEdges(nodes, [{ from: 'a', to: 'missing' }])).toMatchObject({ valid: false, reason: 'missing-endpoint' });
    expect(validateDependencyEdges(nodes, [{ from: 'a', to: 'b' }, { from: 'a', to: 'b' }])).toMatchObject({ valid: false, reason: 'duplicate-edge' });
    expect(validateDependencyEdges(nodes, [{ from: 'a', to: 'b' }])).toEqual({ valid: true });
  });
});
