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

    expect(result.positions.get('b')!.y).toBeGreaterThan(result.positions.get('a')!.y);
    expect(result.positions.get('c')!.y).toBeGreaterThan(result.positions.get('b')!.y);
    expect(result.positions.get('outer-leaf')!.y).toBeGreaterThan(result.positions.get('inner')!.y);
    expect(result.sizes.get('outer')?.width).toBeGreaterThan(result.sizes.get('inner')!.width);
  });

  it('uses authoritative widths before React Flow has measured a node', () => {
    const nodes = [
      node('group', 0, 0),
      { ...node('wide', 0, 60), parentId: 'group', width: undefined },
      { ...node('right', 0, 128), parentId: 'group', width: undefined },
    ];
    const widths = new Map([['wide', 282], ['right', 180]]);
    const result = layoutNestedGroupChildren(
      nodes,
      ['group'],
      new Map([['group', ['wide', 'right']]]),
      (child) => ({ width: widths.get(child.id) ?? 180, height: 56 }),
    );

    expect(result.positions.get('right')!.x).toBe(result.positions.get('wide')!.x);
    expect(result.positions.get('right')!.y).toBeGreaterThan(result.positions.get('wide')!.y);
    expect(result.sizes.get('group')!.width).toBeGreaterThan(282);
  });

});

describe('capGroupSize', () => {
  it('keeps ten children expanded and folds the eleventh', () => {
    expect(capGroupSize({ w: 960, h: 1200 }, 10)).toEqual({ w: 960, h: 1200 });
    expect(capGroupSize({ w: 960, h: 1200 }, 11)).toEqual({
      w: 960,
      h: GROUP_COLLAPSED_MAX_H,
    });
  });
});

describe('layoutChildrenInTwoColumns', () => {
  it('keeps six children in one column', () => {
    const children = [
      node('a', 10, 10),
      node('b', 20, 20),
      node('c', 30, 30),
      node('d', 40, 40),
      node('e', 50, 50),
      node('f', 60, 60),
    ];
    const result = layoutChildrenInTwoColumns(children, (child) => ({
      width: child.width ?? 180,
      height: child.height ?? 56,
    }));

    const positions = [...result.positions.values()];
    expect(new Set(positions.map((position) => position.x)).size).toBe(1);
    expect(positions[1]!.y).toBeGreaterThan(positions[0]!.y);
  });

  it('starts a second column with the seventh child', () => {
    const children = Array.from({ length: 7 }, (_, index) =>
      node(String(index), 0, index * 10),
    );
    const result = layoutChildrenInTwoColumns(children, (child) => ({
      width: child.width ?? 180,
      height: child.height ?? 56,
    }));

    expect(new Set([...result.positions.values()].map((position) => position.x)).size).toBe(2);
    expect(result.positions.get('0')?.y).toBe(result.positions.get('1')?.y);
  });

  it('uses the widest first-column child to avoid overlap', () => {
    const result = layoutChildrenInTwoColumns(
      [
        node('wide', 0, 0, 320),
        node('right', 0, 1),
        ...Array.from({ length: 5 }, (_, index) => node(`next-${index}`, 0, index + 2)),
      ],
      (child) => ({ width: child.width ?? 180, height: child.height ?? 56 }),
    );

    expect(result.positions.get('right')!.x).toBeGreaterThanOrEqual(
      result.positions.get('wide')!.x + 320,
    );
  });
});
