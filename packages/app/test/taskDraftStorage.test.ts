import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearTaskDraftIfMatching,
  listTaskDrafts,
  loadTaskDraft,
  saveTaskDraft,
} from '../src/stores/taskDraftStorage';

describe('task draft storage', () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      get length() { return values.size; },
      key: (index: number) => [...values.keys()][index] ?? null,
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });
  });

  it('round-trips drafts inside a user-specific namespace', () => {
    saveTaskDraft('u1', 'p1', 7, [{ id: 'n1', title: 'draft', status: 'todo' }], []);

    expect(loadTaskDraft('u1', 'p1')).toMatchObject({
      ownerId: 'u1',
      pageId: 'p1',
      baseVersion: 7,
      nodes: [{ id: 'n1', title: 'draft', status: 'todo' }],
    });
    expect(loadTaskDraft('u2', 'p1')).toBeNull();
  });

  it('does not clear a newer draft after an older save finishes', () => {
    const older = saveTaskDraft('u1', 'p1', 7, [{ id: 'old', title: 'old', status: 'todo' }], []);
    saveTaskDraft('u1', 'p1', 7, [{ id: 'new', title: 'new', status: 'todo' }], []);

    clearTaskDraftIfMatching('u1', older!);

    expect(loadTaskDraft('u1', 'p1')?.nodes[0]?.id).toBe('new');
  });

  it('lists only the current user drafts', () => {
    saveTaskDraft('u1', 'p1', 1, [{ id: 'one', title: 'one', status: 'todo' }], []);
    saveTaskDraft('u2', 'p2', 1, [{ id: 'other', title: 'other', status: 'todo' }], []);
    saveTaskDraft('u1', 'p3', 2, [{ id: 'three', title: 'three', status: 'todo' }], []);

    expect(listTaskDrafts('u1').map((draft) => draft.pageId).sort()).toEqual(['p1', 'p3']);
  });

  it('includes drafts written by the previous aggregate storage format', () => {
    localStorage.setItem('todograph.task-drafts.v1', JSON.stringify({
      'u1:legacy': {
        ownerId: 'u1', pageId: 'legacy', baseVersion: 2,
        nodes: [{ id: 'kept', title: 'kept', status: 'todo' }], edges: [],
        savedAt: '2026-07-01T00:00:00.000Z',
      },
    }));

    expect(listTaskDrafts('u1').map((draft) => draft.pageId)).toContain('legacy');
  });
});
