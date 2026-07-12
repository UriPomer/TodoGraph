import { describe, expect, it } from 'vitest';
import type { Task } from '@todograph/shared';
import { buildTaskListModel, isDescendant } from '../src/features/tasks/listModel';

const task = (id: string, parentId?: string): Task => ({
  id,
  title: id,
  status: 'todo',
  ...(parentId ? { parentId } : {}),
});

describe('task list model', () => {
  it('shows an orphan once as a root', () => {
    const orphan = task('orphan', 'missing');
    const model = buildTaskListModel([orphan], { nodes: [orphan], edges: [] }, new Set(['orphan']), undefined, {});
    expect(model.ready).toEqual([{ task: orphan, depth: 0 }]);
  });

  it('terminates and shows every node once when legacy data contains a hierarchy cycle', () => {
    const nodes = [task('a', 'b'), task('b', 'a')];
    const model = buildTaskListModel(nodes, { nodes, edges: [] }, new Set(['a', 'b']), undefined, {});
    expect(model.ready.map(({ task: item }) => item.id).sort()).toEqual(['a', 'b']);
    expect(isDescendant(model.childMap, 'b', 'a')).toBe(true);
    expect(isDescendant(model.childMap, 'missing', 'a')).toBe(false);
  });

  it('keeps children beside their sorted root', () => {
    const nodes = [task('old'), task('child', 'old'), { ...task('doing'), status: 'doing' as const }];
    const model = buildTaskListModel(nodes, { nodes, edges: [] }, new Set(nodes.map(({ id }) => id)), undefined, {});
    expect(model.ready.map(({ task: item, depth }) => [item.id, depth])).toEqual([
      ['doing', 0],
      ['old', 0],
      ['child', 1],
    ]);
  });

  it('preserves completed task order', () => {
    const nodes = [
      { ...task('first'), status: 'done' as const },
      task('ready'),
      { ...task('second'), status: 'done' as const },
    ];
    const model = buildTaskListModel(nodes, { nodes, edges: [] }, new Set(['ready']), undefined, {});
    expect(model.done.map(({ task: item }) => item.id)).toEqual(['first', 'second']);
  });
});
