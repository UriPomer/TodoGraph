import { describe, it, expect } from 'vitest';
import {
  computeGroupSize,
  GROUP_PADDING_X,
  GROUP_PADDING_Y,
  GROUP_MIN_W,
  GROUP_MIN_H,
} from '@todograph/shared';

describe('computeGroupSize', () => {
  it('empty returns minimum size', () => {
    expect(computeGroupSize([])).toEqual({ w: GROUP_MIN_W, h: GROUP_MIN_H });
  });

  it('single child at (0,0) → min size', () => {
    const s = computeGroupSize([{ x: 0, y: 0, w: 180, h: 56 }]);
    expect(s.w).toBeGreaterThanOrEqual(GROUP_MIN_W);
    expect(s.h).toBeGreaterThanOrEqual(GROUP_MIN_H);
  });

  it('child offset grows parent', () => {
    // maxX = 100 + 180 = 280; left = min(0, 100) = 0; w = 280 - 0 + PAD_X = 304
    const s = computeGroupSize([{ x: 100, y: 100, w: 180, h: 56 }]);
    expect(s.w).toBe(Math.max(GROUP_MIN_W, 280 + GROUP_PADDING_X));
    // maxY = 100 + 56 = 156; h = 156 - 0 + PAD_Y = 216 (or min)
    expect(s.h).toBe(Math.max(GROUP_MIN_H, 156 + GROUP_PADDING_Y));
  });

  it('negative child x incorporated', () => {
    // left = -50; w = (x+w) - left + PAD = 130 - (-50) + PAD = 180 + PAD
    const s = computeGroupSize([{ x: -50, y: 0, w: 180, h: 56 }]);
    expect(s.w).toBe(Math.max(GROUP_MIN_W, 180 + GROUP_PADDING_X));
  });

  it('multiple children pick bounding box', () => {
    const s = computeGroupSize([
      { x: 20, y: 60, w: 180, h: 56 },
      { x: 220, y: 60, w: 180, h: 56 },
      { x: 20, y: 130, w: 180, h: 56 },
    ]);
    // maxX = 400; left = 0; w = 400 + PAD_X
    expect(s.w).toBe(Math.max(GROUP_MIN_W, 400 + GROUP_PADDING_X));
    // maxY = 186; top = 0; h = 186 + PAD_Y
    expect(s.h).toBe(Math.max(GROUP_MIN_H, 186 + GROUP_PADDING_Y));
  });
});
