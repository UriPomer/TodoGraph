import { describe, expect, it, vi } from 'vitest';
import { claimPageForAutoLayout, fitPageAfterAutoLayout } from '@/features/graph/pageAutoLayout';
import { buildAlignedPatches } from '@/features/graph/GraphView';
import type { Task } from '@todograph/shared';

describe('page auto-layout gate', () => {
  it('waits for the current page node set before claiming it', () => {
    const checked = new Set<string>();
    expect(claimPageForAutoLayout(checked, 'a', ['1', '2'], [])).toBe(false);
    expect(claimPageForAutoLayout(checked, 'a', ['1', '2'], [
      { id: '1', measured: { width: 180, height: 56 } },
      { id: 'old', measured: { width: 180, height: 56 } },
    ])).toBe(false);
    expect(claimPageForAutoLayout(checked, 'a', ['1', '2'], [
      { id: '2', measured: { width: 180, height: 56 } },
      { id: '1', measured: { width: 180, height: 144 } },
    ])).toBe(true);
  });

  it('does not claim a page before visible nodes are measured', () => {
    const checked = new Set<string>();
    expect(claimPageForAutoLayout(checked, 'a', ['1'], [{ id: '1' }])).toBe(false);
    expect(claimPageForAutoLayout(checked, 'a', ['1'], [
      { id: '1', measured: { width: 180, height: 144 } },
    ])).toBe(true);
  });

  it('claims each synchronized page only once', () => {
    const checked = new Set<string>();
    const one = [{ id: '1', measured: { width: 180, height: 56 } }];
    const two = [{ id: '2', measured: { width: 180, height: 56 } }];
    expect(claimPageForAutoLayout(checked, 'a', ['1'], one)).toBe(true);
    expect(claimPageForAutoLayout(checked, 'a', ['1'], one)).toBe(false);
    expect(claimPageForAutoLayout(checked, 'b', ['2'], two)).toBe(true);
  });

  it('fits the viewport on the frame after layout positions commit', () => {
    let scheduled!: FrameRequestCallback;
    const fitView = vi.fn();

    fitPageAfterAutoLayout(fitView, (callback) => {
      scheduled = callback;
      return 7;
    });

    expect(fitView).not.toHaveBeenCalled();
    scheduled(0);
    expect(fitView).toHaveBeenCalledWith({ padding: 0.2, duration: 250 });
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
