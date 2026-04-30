import { describe, it, expect } from 'vitest';
import { pureNormalizeGroupBounds } from '@/stores/useTaskStore';
import { GROUP_PADDING_X, GROUP_PADDING_Y } from '@/features/graph/computeGroupSize';
import type { Task } from '@todograph/shared';

const mk = (id: string, x: number, y: number, parentId?: string): Task => ({
  id,
  title: id,
  status: 'todo',
  x,
  y,
  ...(parentId ? { parentId } : {}),
});

describe('pureNormalizeGroupBounds', () => {
  it('returns original when parent not found', () => {
    const nodes = [mk('c', 50, 50)];
    const out = pureNormalizeGroupBounds(nodes, 'missing');
    expect(out).toBe(nodes);
  });

  it('returns original when parent has no children', () => {
    const nodes = [mk('p', 100, 100)];
    const out = pureNormalizeGroupBounds(nodes, 'p');
    expect(out).toBe(nodes);
  });

  it('no-op when leftmost child already at padding', () => {
    const nodes = [
      mk('p', 100, 100),
      mk('c', GROUP_PADDING_X, GROUP_PADDING_Y, 'p'),
    ];
    const out = pureNormalizeGroupBounds(nodes, 'p');
    expect(out).toBe(nodes);
  });

  it('pulls parent right + children left when children offset too far right (bug 3)', () => {
    // leftmost child at x=200, padding should be 24 → shift parent +(200-24)=+176, children -176
    const nodes = [mk('p', 100, 100), mk('c', 200, 50, 'p')];
    const out = pureNormalizeGroupBounds(nodes, 'p');
    const p = out.find((n) => n.id === 'p')!;
    const c = out.find((n) => n.id === 'c')!;
    expect(p.x).toBe(100 + (200 - GROUP_PADDING_X));
    expect(c.x).toBe(GROUP_PADDING_X);
    // world position preserved: parent.x + child.x must equal original
    expect((p.x ?? 0) + (c.x ?? 0)).toBe(100 + 200);
  });

  it('handles negative relative coord (old behavior still works)', () => {
    const nodes = [mk('p', 100, 100), mk('c', -50, 0, 'p')];
    const out = pureNormalizeGroupBounds(nodes, 'p');
    const c = out.find((n) => n.id === 'c')!;
    // After normalization child x should be exactly GROUP_PADDING_X
    expect(c.x).toBe(GROUP_PADDING_X);
  });

  it('uses minimum among multiple children', () => {
    const nodes = [
      mk('p', 100, 100),
      mk('a', 300, 60, 'p'),
      mk('b', 250, 130, 'p'), // leftmost
      mk('c', 280, 200, 'p'),
    ];
    const out = pureNormalizeGroupBounds(nodes, 'p');
    const b = out.find((n) => n.id === 'b')!;
    expect(b.x).toBe(GROUP_PADDING_X);
  });

  it('does not touch unrelated nodes', () => {
    const nodes = [
      mk('p', 100, 100),
      mk('c', 200, 60, 'p'),
      mk('other', 999, 999),
    ];
    const out = pureNormalizeGroupBounds(nodes, 'p');
    const other = out.find((n) => n.id === 'other')!;
    expect(other.x).toBe(999);
    expect(other.y).toBe(999);
  });
});
