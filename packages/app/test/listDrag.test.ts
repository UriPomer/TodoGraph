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

  it('scrolls only near an edge and caps the speed', () => {
    const bounds = { top: 100, bottom: 500 };
    expect(dragAutoScrollDelta(300, bounds)).toBe(0);
    expect(dragAutoScrollDelta(101, bounds)).toBe(-14);
    expect(dragAutoScrollDelta(499, bounds)).toBe(14);
  });
});
