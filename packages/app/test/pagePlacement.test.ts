import { describe, expect, it } from 'vitest';
import type { Task } from '@todograph/shared';
import {
  buildTopLevelCollisionRects,
  computeNodeSizeMap,
  placeMovedNodesOnTarget,
  rectsOverlap,
  resolveClusterTranslationAvoidingOccupied,
  separateSiblingNodeOverlaps,
} from '@todograph/shared';

const task = (id: string, x: number, y: number, parentId?: string, title = id): Task => ({
  id,
  title,
  status: 'todo',
  x,
  y,
  ...(parentId ? { parentId } : {}),
});

describe('pagePlacement', () => {
  it('keeps moved nodes in place when target page is free', () => {
    const moved = [task('a', 120, 40)];
    expect(placeMovedNodesOnTarget([], moved)).toEqual(moved);
  });

  it('moves the incoming root cluster away from existing top-level nodes', () => {
    const target = [task('target', 0, 0)];
    const moved = [task('incoming', 0, 0)];
    const placed = placeMovedNodesOnTarget(target, moved);

    expect(placed[0]).not.toMatchObject({ x: 0, y: 0 });
    const rects = buildTopLevelCollisionRects([...target, ...placed]);
    expect(rects).toHaveLength(2);
    expect(rectsOverlap(rects[0]!, rects[1]!, 12)).toBe(false);
  });

  it('moves only moved roots and keeps child relative coordinates untouched', () => {
    const target = [task('occupied', 0, 0)];
    const moved = [task('group', 0, 0), task('child', 24, 60, 'group')];
    const placed = placeMovedNodesOnTarget(target, moved);

    const group = placed.find((n) => n.id === 'group');
    const child = placed.find((n) => n.id === 'child');
    expect(group).toBeTruthy();
    expect(child).toBeTruthy();
    expect(group?.x === 0 && group?.y === 0).toBe(false);
    expect(child?.x).toBe(24);
    expect(child?.y).toBe(60);

    const rects = buildTopLevelCollisionRects([...target, ...placed]);
    expect(rects).toHaveLength(2);
    expect(rectsOverlap(rects[0]!, rects[1]!, 12)).toBe(false);
  });

  it('moves a cluster of multiple top-level roots together as one block', () => {
    const target = [task('occupied', 0, 0)];
    const moved = [task('a', 0, 0), task('b', 204, 0)];
    const placed = placeMovedNodesOnTarget(target, moved);

    expect(placed[0]!.x === 0 && placed[0]!.y === 0).toBe(false);
    // relative offset between cluster members is preserved
    expect(placed[1]!.x - placed[0]!.x).toBe(204);
    expect(placed[1]!.y - placed[0]!.y).toBe(0);

    const rects = buildTopLevelCollisionRects([...target, ...placed]);
    expect(rects).toHaveLength(3);
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        expect(rectsOverlap(rects[i]!, rects[j]!, 12)).toBe(false);
      }
    }
  });

  it('recursively computes sizes for nested groups', () => {
    const nodes: Task[] = [
      task('root', 0, 0),
      task('child1', 24, 60, 'root'),
      task('child2', 228, 60, 'root'),
    ];
    const sizeMap = computeNodeSizeMap(nodes);
    const rootSize = sizeMap.get('root');
    expect(rootSize).toBeTruthy();
    // group should be wide enough to fit both children
    expect(rootSize!.w).toBeGreaterThanOrEqual(400);
    expect(rootSize!.h).toBeGreaterThanOrEqual(100);
    // leaves get default child size
    expect(sizeMap.get('child1')).toEqual({ w: 180, h: 56 });
  });

  it('buildTopLevelCollisionRects uses group sizes for parent nodes', () => {
    const nodes: Task[] = [
      task('free', 0, 0),
      task('group', 300, 0),
      task('kid', 324, 60, 'group'),
    ];
    const rects = buildTopLevelCollisionRects(nodes);
    expect(rects).toHaveLength(2);
    const groupRect = rects.find((r) => r.id === 'group');
    expect(groupRect).toBeTruthy();
    // group rect must be larger than leaf because it wraps a child
    expect(groupRect!.w).toBeGreaterThan(180);
  });

  it('empty moved nodes returns empty array unchanged', () => {
    expect(placeMovedNodesOnTarget([task('a', 0, 0)], [])).toEqual([]);
  });

  it('moved nodes with only children (all have parentId within moved set) keep all coordinates', () => {
    const moved = [task('parent', 100, 100), task('kid', 24, 60, 'parent')];
    const placed = placeMovedNodesOnTarget([], moved);
    // no collision on empty target — coordinates unchanged
    expect(placed[0]).toMatchObject({ id: 'parent', x: 100, y: 100 });
    expect(placed[1]).toMatchObject({ id: 'kid', x: 24, y: 60 });
  });

  it('accounts for an expanded target group when placing incoming nodes', () => {
    const target = [
      task('group', 0, 0),
      task('left', 24, 60, 'group'),
      task('right', 636, 60, 'group'),
    ];
    const placed = placeMovedNodesOnTarget(target, [task('incoming', 400, 80)]);
    const rects = buildTopLevelCollisionRects([...target, ...placed]);
    expect(rects).toHaveLength(2);
    expect(rectsOverlap(rects[0]!, rects[1]!, 12)).toBe(false);
  });

  it('places a cluster safely on a dense target page', () => {
    const target = Array.from({ length: 500 }, (_, index) =>
      task(`target-${index}`, (index % 25) * 240, Math.floor(index / 25) * 96),
    );
    const placed = placeMovedNodesOnTarget(target, [task('incoming', 0, 0)]);
    const incomingRect = buildTopLevelCollisionRects(placed)[0]!;
    for (const occupied of buildTopLevelCollisionRects(target)) {
      expect(rectsOverlap(incomingRect, occupied, 12)).toBe(false);
    }
  });

  it('repairs overlap inside a moved cluster before placing it', () => {
    const placed = placeMovedNodesOnTarget([], [task('a', 0, 0), task('b', 0, 0)]);
    const rects = buildTopLevelCollisionRects(placed);
    expect(rectsOverlap(rects[0]!, rects[1]!, 12)).toBe(false);
  });
});

describe('rectsOverlap (shared)', () => {
  it('reports false for diagonally separated rects', () => {
    expect(rectsOverlap({ x: 0, y: 0, w: 100, h: 50 }, { x: 200, y: 100, w: 100, h: 50 })).toBe(
      false,
    );
  });

  it('reports true for fully contained rect', () => {
    expect(rectsOverlap({ x: 0, y: 0, w: 100, h: 100 }, { x: 20, y: 20, w: 10, h: 10 })).toBe(true);
  });

  it('reports false for zero-area rect at boundary with gap=0', () => {
    expect(rectsOverlap({ x: 0, y: 0, w: 0, h: 0 }, { x: 0, y: 10, w: 100, h: 50 })).toBe(false);
  });
});

describe('separateSiblingNodeOverlaps', () => {
  it('separates a newly appended top-level node', () => {
    const separated = separateSiblingNodeOverlaps([task('existing', 0, 0), task('new', 0, 0)]);
    const rects = buildTopLevelCollisionRects(separated);
    expect(separated[0]).toMatchObject({ x: 0, y: 0 });
    expect(rectsOverlap(rects[0]!, rects[1]!, 12)).toBe(false);
  });

  it('moves a top-level sibling when a parent expands', () => {
    const separated = separateSiblingNodeOverlaps([
      task('group', 0, 0),
      task('child-a', 24, 60, 'group'),
      task('child-b', 500, 60, 'group'),
      task('sibling', 240, 0),
    ]);
    const rects = buildTopLevelCollisionRects(separated);
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        expect(rectsOverlap(rects[i]!, rects[j]!, 12)).toBe(false);
      }
    }
  });

  it('separates overlapping children and propagates the expanded bounds', () => {
    const separated = separateSiblingNodeOverlaps([
      task('group', 0, 0),
      task('a', 24, 60, 'group'),
      task('b', 24, 60, 'group'),
      task('outside', 260, 0),
    ]);
    const a = separated.find((node) => node.id === 'a')!;
    const b = separated.find((node) => node.id === 'b')!;
    expect(rectsOverlap({ ...a, w: 180, h: 56 }, { ...b, w: 180, h: 56 }, 12)).toBe(false);
    const top = buildTopLevelCollisionRects(separated);
    expect(rectsOverlap(top[0]!, top[1]!, 12)).toBe(false);
  });
});

describe('resolveClusterTranslationAvoidingOccupied', () => {
  it('uses a safe right-side fallback when the search radius is exhausted', () => {
    const moving = [{ id: 'moving', x: 0, y: 0, w: 180, h: 56 }];
    const occupied = [{ id: 'occupied', x: 0, y: 0, w: 180, h: 56 }];
    const translation = resolveClusterTranslationAvoidingOccupied(moving, occupied, { maxRing: 0 });
    const shifted = { ...moving[0]!, x: moving[0]!.x + translation.dx, y: moving[0]!.y + translation.dy };
    expect(rectsOverlap(shifted, occupied[0]!, 12)).toBe(false);
  });

  it('moves multiple nodes as one cluster without changing relative positions', () => {
    const moving = [
      { id: 'a', x: 0, y: 0, w: 180, h: 56 },
      { id: 'b', x: 240, y: 0, w: 180, h: 56 },
    ];
    const occupied = [{ id: 'occupied', x: 0, y: 0, w: 500, h: 56 }];
    const translation = resolveClusterTranslationAvoidingOccupied(moving, occupied);
    const shifted = moving.map((rect) => ({
      ...rect,
      x: rect.x + translation.dx,
      y: rect.y + translation.dy,
    }));
    expect(shifted[1]!.x - shifted[0]!.x).toBe(240);
    for (const rect of shifted) expect(rectsOverlap(rect, occupied[0]!, 12)).toBe(false);
  });
});
