import { describe, expect, it } from 'vitest';
import {
  centeredDropPosition,
  isOutsideRect,
} from '@/features/graph/collapsedGroupDrag';

describe('collapsed group child dragging', () => {
  const rect = { left: 100, right: 500, top: 200, bottom: 620 };

  it('detaches only after the pointer leaves the parent frame', () => {
    expect(isOutsideRect({ x: 300, y: 400 }, rect)).toBe(false);
    expect(isOutsideRect({ x: 99, y: 400 }, rect)).toBe(true);
    expect(isOutsideRect({ x: 300, y: 621 }, rect)).toBe(true);
  });

  it('centers the detached node at the drop point', () => {
    expect(centeredDropPosition(
      { x: 500, y: 300 },
      { width: 180, height: 56 },
    )).toEqual({ x: 410, y: 272 });
  });
});
