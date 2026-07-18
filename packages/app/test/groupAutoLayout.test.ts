import { describe, expect, it } from 'vitest';
import type { Node } from '@xyflow/react';
import {
  layoutChildrenInTwoColumns,
  layoutNestedGroupChildren,
} from '@/features/graph/useAutoLayout';
import { capGroupSize, GROUP_COLLAPSED_MAX_H } from '@todograph/shared';

const node = (id: string, x: number, y: number, width = 180, height = 56): Node => ({
  id,
  position: { x, y },
  data: {},
  width,
  height,
});

describe('layoutNestedGroupChildren', () => {
  it('lays out nested groups from the inside out', () => {
    const nodes = [
      node('outer', 0, 0),
      { ...node('inner', 0, 0), parentId: 'outer' },
      { ...node('outer-leaf', 0, 0), parentId: 'outer' },
      { ...node('a', 0, 0), parentId: 'inner' },
      { ...node('b', 0, 0), parentId: 'inner' },
      { ...node('c', 0, 0), parentId: 'inner' },
    ];
    const result = layoutNestedGroupChildren(
      nodes,
      ['inner', 'outer'],
      new Map([
        ['inner', ['a', 'b', 'c']],
        ['outer', ['inner', 'outer-leaf']],
      ]),
      (child) => ({ width: child.width ?? 180, height: child.height ?? 56 }),
    );

    expect(result.positions.get('a')?.y).toBe(result.positions.get('b')?.y);
    expect(result.positions.get('c')?.y).toBeGreaterThan(result.positions.get('a')!.y);
    expect(result.positions.get('outer-leaf')!.x).toBeGreaterThan(result.positions.get('inner')!.x);
    expect(result.sizes.get('outer')?.width).toBeGreaterThan(result.sizes.get('inner')!.width);
  });
});

describe('capGroupSize', () => {
  it('folds only height and preserves two-column width', () => {
    expect(capGroupSize({ w: 960, h: 1200 })).toEqual({
      w: 960,
      h: GROUP_COLLAPSED_MAX_H,
    });
  });
});

describe('layoutChildrenInTwoColumns', () => {
  it('arranges children in no more than two columns', () => {
    const children = [
      node('a', 10, 10),
      node('b', 20, 20),
      node('c', 30, 30),
      node('d', 40, 40),
      node('e', 50, 50),
    ];
    const result = layoutChildrenInTwoColumns(children, (child) => ({
      width: child.width ?? 180,
      height: child.height ?? 56,
    }));

    const positions = [...result.positions.values()];
    expect(new Set(positions.map((position) => position.x)).size).toBe(2);
    expect(positions[0]?.y).toBe(positions[1]?.y);
    expect(positions[2]?.y).toBe(positions[3]?.y);
    expect(positions[4]?.y).toBeGreaterThan(positions[2]!.y);
  });

  it('uses the widest first-column child to avoid overlap', () => {
    const result = layoutChildrenInTwoColumns(
      [node('wide', 0, 0, 320), node('right', 0, 0), node('next', 0, 0)],
      (child) => ({ width: child.width ?? 180, height: child.height ?? 56 }),
    );

    expect(result.positions.get('right')!.x).toBeGreaterThanOrEqual(
      result.positions.get('wide')!.x + 320,
    );
  });
});
