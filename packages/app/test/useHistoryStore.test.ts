import { describe, it, expect, beforeEach } from 'vitest';
import { useHistoryStore } from '@/stores/useHistoryStore';
import type { Snapshot } from '@/stores/useHistoryStore';

const snap = (label: string): Snapshot => ({
  nodes: [{ id: 'a', title: label, status: 'todo' }],
  edges: [],
});

describe('useHistoryStore', () => {
  beforeEach(() => {
    useHistoryStore.getState().clear();
  });

  it('empty → canUndo=false canRedo=false', () => {
    const s = useHistoryStore.getState();
    expect(s.canUndo()).toBe(false);
    expect(s.canRedo()).toBe(false);
  });

  it('push → canUndo=true', () => {
    useHistoryStore.getState().push(snap('1'));
    expect(useHistoryStore.getState().canUndo()).toBe(true);
  });

  it('undo returns the most recently pushed snapshot (pre-mutation state)', () => {
    useHistoryStore.getState().push(snap('pre1'));
    useHistoryStore.getState().push(snap('pre2'));
    const popped = useHistoryStore.getState().undo(snap('current'));
    expect(popped?.nodes[0]?.title).toBe('pre2');
  });

  it('redo replays forward', () => {
    useHistoryStore.getState().push(snap('a'));
    useHistoryStore.getState().push(snap('b'));
    useHistoryStore.getState().undo(snap('current'));
    const forward = useHistoryStore.getState().redo(snap('previous'));
    expect(forward?.nodes[0]?.title).toBe('current');
  });

  it('new push after undo clears redo stack', () => {
    useHistoryStore.getState().push(snap('a'));
    useHistoryStore.getState().push(snap('b'));
    useHistoryStore.getState().undo(snap('current'));
    useHistoryStore.getState().push(snap('c'));
    expect(useHistoryStore.getState().canRedo()).toBe(false);
  });

  it('respects max size (100)', () => {
    for (let i = 0; i < 150; i++) useHistoryStore.getState().push(snap(String(i)));
    // only last 100 kept → undo 100 times should work
    let last = null;
    for (let i = 0; i < 100; i++) last = useHistoryStore.getState().undo(snap('current'));
    expect(last).not.toBeNull();
    expect(useHistoryStore.getState().canUndo()).toBe(false);
  });

  it('clear resets both stacks', () => {
    useHistoryStore.getState().push(snap('a'));
    useHistoryStore.getState().push(snap('b'));
    useHistoryStore.getState().undo(snap('current'));
    useHistoryStore.getState().clear();
    expect(useHistoryStore.getState().canUndo()).toBe(false);
    expect(useHistoryStore.getState().canRedo()).toBe(false);
  });

  it('undo on empty returns null', () => {
    expect(useHistoryStore.getState().undo(snap('current'))).toBeNull();
  });

  it('redo on empty returns null', () => {
    expect(useHistoryStore.getState().redo(snap('previous'))).toBeNull();
  });
});
