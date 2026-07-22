import { describe, expect, it } from 'vitest';
import type { Task } from '@todograph/shared';
import { dragAutoScrollDelta, resolveListDropIntent } from '../src/features/tasks/listDrag';

const task = (id: string, parentId?: string): Task => ({
  id,
  title: id,
  status: 'todo',
  ...(parentId ? { parentId } : {}),
});

describe('list drag intent', () => {
  it('prefers sibling ordering at row edges and nesting at the center', () => {
    const dragged = task('dragged');
    const target = task('target');
    const byId = new Map([[dragged.id, dragged], [target.id, target]]);
    const base = {
      startX: 100,
      clientX: 100,
      dragged,
      target,
      targetRect: { top: 100, height: 40 },
      byId,
      depthById: new Map([[target.id, 0]]),
      subtreeHeightById: new Map([[dragged.id, 0]]),
    };

    expect(resolveListDropIntent({ ...base, clientY: 103 })).toEqual({
      kind: 'reorder', anchorId: target.id, position: 'before', storageOrder: 'reverse',
    });
    expect(resolveListDropIntent({ ...base, clientY: 120 })).toEqual({
      kind: 'nest', targetId: target.id,
    });
  });

  it('moves a nested task into the exact sibling slot at another parent level', () => {
    const root = task('root');
    const parent = task('parent', root.id);
    const dragged = task('level-three', parent.id);
    const target = task('level-two-target', root.id);
    const byId = new Map([root, parent, dragged, target].map((node) => [node.id, node]));

    expect(resolveListDropIntent({
      startX: 140,
      clientX: 110,
      clientY: 103,
      dragged,
      target,
      targetRect: { top: 100, height: 40 },
      byId,
      depthById: new Map([[root.id, 0], [parent.id, 1], [dragged.id, 2], [target.id, 1]]),
      subtreeHeightById: new Map([[dragged.id, 0]]),
    })).toEqual({
      kind: 'reparent-reorder',
      anchorId: target.id,
      position: 'before',
      storageOrder: 'forward',
    });
  });

  it('only unparents after a deliberate left drag outside a valid row target', () => {
    const dragged = task('dragged', 'parent');
    expect(resolveListDropIntent({
      startX: 100,
      clientX: 51,
      clientY: 100,
      dragged,
      target: null,
      targetRect: null,
      byId: new Map([[dragged.id, dragged]]),
      depthById: new Map(),
      subtreeHeightById: new Map([[dragged.id, 0]]),
    })).toEqual({ kind: 'unparent' });
  });

  it('prefers leaving the current parent over nesting into a row crossed while dragging left', () => {
    const dragged = task('level-three', 'level-two');
    const crossed = task('crossed');

    expect(resolveListDropIntent({
      startX: 140,
      clientX: 116,
      clientY: 120,
      dragged,
      target: crossed,
      targetRect: { top: 100, height: 40 },
      byId: new Map([[dragged.id, dragged], [crossed.id, crossed]]),
      depthById: new Map([[crossed.id, 0]]),
      subtreeHeightById: new Map([[dragged.id, 0]]),
    })).toEqual({ kind: 'unparent' });
  });

  it('scrolls only near the list edges', () => {
    const bounds = { top: 100, bottom: 500 };

    expect(dragAutoScrollDelta(300, bounds)).toBe(0);
    expect(dragAutoScrollDelta(110, bounds)).toBeLessThan(0);
    expect(dragAutoScrollDelta(490, bounds)).toBeGreaterThan(0);
  });
});
