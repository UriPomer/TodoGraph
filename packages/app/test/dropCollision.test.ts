import { describe, expect, it } from 'vitest';
import {
  rectsOverlap,
  resolveDropCollision,
  resolvePinnedDropPushAway,
} from '@/features/graph/dropCollision';

describe('dropCollision', () => {
  it('keeps the original position when there is no overlap', () => {
    expect(
      resolveDropCollision({
        x: 0,
        y: 0,
        w: 180,
        h: 56,
        occupied: [{ id: 'b', x: 260, y: 0, w: 180, h: 56 }],
      }),
    ).toEqual({ x: 0, y: 0 });
  });

  it('moves the node when the drop position overlaps another node', () => {
    const next = resolveDropCollision({
      x: 0,
      y: 0,
      w: 180,
      h: 56,
      occupied: [{ id: 'b', x: 0, y: 0, w: 180, h: 56 }],
    });
    expect(next).not.toEqual({ x: 0, y: 0 });
    expect(
      rectsOverlap(
        { x: next.x, y: next.y, w: 180, h: 56 },
        { x: 0, y: 0, w: 180, h: 56 },
        12,
      ),
    ).toBe(false);
  });

  it('can search past immediate neighbors to find a free slot', () => {
    const occupied = [
      { id: 'a', x: 0, y: 0, w: 180, h: 56 },
      { id: 'b', x: 24, y: 0, w: 180, h: 56 },
      { id: 'c', x: -24, y: 0, w: 180, h: 56 },
      { id: 'd', x: 0, y: 24, w: 180, h: 56 },
      { id: 'e', x: 0, y: -24, w: 180, h: 56 },
    ];
    const next = resolveDropCollision({
      x: 0,
      y: 0,
      w: 180,
      h: 56,
      occupied,
    });
    expect(next).not.toEqual({ x: 0, y: 0 });
    for (const rect of occupied) {
      expect(rectsOverlap({ x: next.x, y: next.y, w: 180, h: 56 }, rect, 12)).toBe(false);
    }
  });

  it('keeps the dragged node pinned and moves the collided sibling away', () => {
    const moved = resolvePinnedDropPushAway({
      pinned: { id: 'drag', x: 0, y: 0, w: 180, h: 56 },
      occupied: [{ id: 'b', x: 0, y: 0, w: 180, h: 56 }],
    });
    expect(moved).toHaveLength(1);
    expect(moved[0]?.id).toBe('b');
    expect(moved[0]).not.toMatchObject({ x: 0, y: 0 });
    expect(
      rectsOverlap(
        { x: 0, y: 0, w: 180, h: 56 },
        { x: moved[0]!.x, y: moved[0]!.y, w: 180, h: 56 },
        12,
      ),
    ).toBe(false);
  });

  it('moves only directly collided nodes and keeps non-colliding nodes in place', () => {
    const moved = resolvePinnedDropPushAway({
      pinned: { id: 'drag', x: 0, y: 0, w: 180, h: 56 },
      occupied: [
        { id: 'b', x: 0, y: 0, w: 180, h: 56 },
        { id: 'c', x: 260, y: 0, w: 180, h: 56 },
      ],
    });
    expect(moved.map((item) => item.id)).toEqual(['b']);
    expect(
      rectsOverlap(
        { x: moved[0]!.x, y: moved[0]!.y, w: 180, h: 56 },
        { x: 260, y: 0, w: 180, h: 56 },
        12,
      ),
    ).toBe(false);
  });

  it('empty occupied returns no movement', () => {
    expect(
      resolveDropCollision({
        x: 100,
        y: 50,
        w: 180,
        h: 56,
        occupied: [],
      }),
    ).toEqual({ x: 100, y: 50 });
    expect(
      resolvePinnedDropPushAway({
        pinned: { id: 'drag', x: 0, y: 0, w: 180, h: 56 },
        occupied: [],
      }),
    ).toEqual([]);
  });

  it('returns original position when maxRing is exhausted', () => {
    const occupied: Array<{ id: string; x: number; y: number; w: number; h: number }> = [];
    for (let row = -3; row <= 3; row++) {
      for (let col = -3; col <= 3; col++) {
        occupied.push({ id: `b${row}_${col}`, x: col * 204, y: row * 80, w: 180, h: 56 });
      }
    }
    const next = resolveDropCollision({
      x: 0,
      y: 0,
      w: 180,
      h: 56,
      occupied,
      maxRing: 2,
    });
    expect(next).toEqual({ x: 0, y: 0 });
  });

  it('moves multiple collided siblings without overlapping each other', () => {
    const moved = resolvePinnedDropPushAway({
      pinned: { id: 'drag', x: 0, y: 0, w: 180, h: 56 },
      occupied: [
        { id: 'a', x: 0, y: 0, w: 180, h: 56 },
        { id: 'b', x: 170, y: 0, w: 180, h: 56 },
      ],
    });
    expect(moved).toHaveLength(2);
    const all = [
      { x: 0, y: 0, w: 180, h: 56 },
      { x: moved[0]!.x, y: moved[0]!.y, w: 180, h: 56 },
      { x: moved[1]!.x, y: moved[1]!.y, w: 180, h: 56 },
    ];
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        expect(rectsOverlap(all[i]!, all[j]!, 12)).toBe(false);
      }
    }
  });
});

describe('rectsOverlap', () => {
  it('reports false for separated rects', () => {
    expect(
      rectsOverlap({ x: 0, y: 0, w: 100, h: 50 }, { x: 200, y: 0, w: 100, h: 50 }),
    ).toBe(false);
  });

  it('reports true for overlapping rects', () => {
    expect(
      rectsOverlap({ x: 0, y: 0, w: 100, h: 50 }, { x: 50, y: 25, w: 100, h: 50 }),
    ).toBe(true);
  });

  it('reports false for edge-touching rects with gap=0', () => {
    expect(
      rectsOverlap({ x: 0, y: 0, w: 100, h: 50 }, { x: 100, y: 0, w: 100, h: 50 }),
    ).toBe(false);
  });

  it('reports true for rects separated by less than gap', () => {
    expect(
      rectsOverlap({ x: 0, y: 0, w: 100, h: 50 }, { x: 110, y: 0, w: 100, h: 50 }, 12),
    ).toBe(true);
  });
});
