import { describe, expect, it } from 'vitest';
import { claimPageForAutoLayout } from '@/features/graph/pageAutoLayout';
import { buildAlignedPatches } from '@/features/graph/GraphView';
import type { Task } from '@todograph/shared';

describe('page auto-layout gate', () => {
  it('waits for the current page node set before claiming it', () => {
    const checked = new Set<string>();
    expect(claimPageForAutoLayout(checked, 'a', ['1', '2'], [])).toBe(false);
    expect(claimPageForAutoLayout(checked, 'a', ['1', '2'], ['1', 'old'])).toBe(false);
    expect(claimPageForAutoLayout(checked, 'a', ['1', '2'], ['2', '1'])).toBe(true);
  });

  it('claims each synchronized page only once', () => {
    const checked = new Set<string>();
    expect(claimPageForAutoLayout(checked, 'a', ['1'], ['1'])).toBe(true);
    expect(claimPageForAutoLayout(checked, 'a', ['1'], ['1'])).toBe(false);
    expect(claimPageForAutoLayout(checked, 'b', ['2'], ['2'])).toBe(true);
  });
});

describe('buildAlignedPatches', () => {
  const task = (id: string, x: number, y: number): Task => ({
    id,
    title: id,
    status: 'todo',
    x,
    y,
    width: 180,
  });

  it('preserves the horizontal axis and spaces nodes along x', () => {
    const patches = buildAlignedPatches(
      [task('a', 0, 20), task('b', 100, 80), task('c', 400, 120)],
      ['a', 'b', 'c'],
      'horizontal',
    );

    expect(patches).toEqual([
      { id: 'a', patch: { x: 0, y: 20 } },
      { id: 'b', patch: { x: 192, y: 20 } },
      { id: 'c', patch: { x: 400, y: 20 } },
    ]);
  });

  it('preserves the vertical axis and spaces nodes along y', () => {
    const patches = buildAlignedPatches(
      [task('a', 20, 0), task('b', 80, 20)],
      ['a', 'b'],
      'vertical',
    );

    expect(patches).toEqual([
      { id: 'a', patch: { x: 20, y: 0 } },
      { id: 'b', patch: { x: 20, y: 68 } },
    ]);
  });
});
