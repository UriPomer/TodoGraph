import { describe, expect, it } from 'vitest';
import { MultiDragSession } from '@/features/graph/multiDragSession';

describe('MultiDragSession', () => {
  it('commits only the first stop in a multi-selection gesture', () => {
    const session = new MultiDragSession();
    session.start(['a', 'b', 'c']);
    expect(session.active).toBe(true);
    expect(session.stop('b')).toBe('commit');
    expect(session.stop('a')).toBe('ignore');
    expect(session.stop('c')).toBe('ignore');
  });

  it('treats a single-node gesture as normal', () => {
    const session = new MultiDragSession();
    session.start(['a']);
    expect(session.active).toBe(false);
    expect(session.stop('a')).toBe('single');
  });

  it('resets stale stops when a new gesture starts', () => {
    const session = new MultiDragSession();
    session.start(['a', 'b']);
    expect(session.stop('a')).toBe('commit');
    session.start(['c', 'd']);
    expect(session.stop('c')).toBe('commit');
    expect(session.stop('b')).toBe('single');
  });
});
