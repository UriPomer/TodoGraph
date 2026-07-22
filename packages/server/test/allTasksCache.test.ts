import { describe, expect, it } from 'vitest';
import { AllTasksCacheStore, type AllTasksCache } from '../src/routes/workspace.js';

function cache(title: string): AllTasksCache {
  return {
    key: title,
    mtimes: new Map(),
    response: {
      tasks: [{
        id: title,
        title,
        status: 'todo',
        _pageId: 'page',
        _pageTitle: 'Page',
        _ready: true,
      }],
    },
  };
}

describe('AllTasksCacheStore', () => {
  it('evicts least-recently-used users and invalidates only the selected user', () => {
    const store = new AllTasksCacheStore(1024 * 1024, 2);
    store.set('a', cache('a'));
    store.set('b', cache('b'));
    expect(store.get('a')?.key).toBe('a');
    store.set('c', cache('c'));

    expect(store.get('b')).toBeNull();
    expect(store.get('a')?.key).toBe('a');
    store.delete('a');
    expect(store.get('a')).toBeNull();
    expect(store.get('c')?.key).toBe('c');
  });

  it('does not retain a response larger than the byte budget', () => {
    const store = new AllTasksCacheStore(32, 10);
    store.set('large', cache('a title that exceeds the tiny cache budget'));
    expect(store.get('large')).toBeNull();
  });
});
