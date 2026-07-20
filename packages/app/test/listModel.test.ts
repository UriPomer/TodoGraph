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
    const model = buildTaskListModel([orphan], { nodes: [orphan], edges: [] }, new Set(['orphan']), {});
    expect(model.ready).toEqual([{ task: orphan, depth: 0 }]);
  });

  it('terminates and shows every node once when legacy data contains a hierarchy cycle', () => {
    const nodes = [task('a', 'b'), task('b', 'a')];
    const model = buildTaskListModel(nodes, { nodes, edges: [] }, new Set(['a', 'b']), {});
    const byId = new Map(nodes.map((node) => [node.id, node]));
    expect(model.ready.map(({ task: item }) => item.id).sort()).toEqual(['a', 'b']);
    expect(isDescendant(byId, 'b', 'a')).toBe(true);
    expect(isDescendant(byId, 'missing', 'a')).toBe(false);
  });

  it('checks ancestry without scanning unrelated branches', () => {
    const nodes = [
      task('root'),
      task('parent', 'root'),
      task('leaf', 'parent'),
      ...Array.from({ length: 10_000 }, (_, index) => task(`unrelated-${index}`, 'root')),
    ];
    const source = new Map(nodes.map((node) => [node.id, node]));
    let lookups = 0;
    const byId = {
      get(id: string) {
        lookups += 1;
        return source.get(id);
      },
    } as ReadonlyMap<string, Task>;

    expect(isDescendant(byId, 'leaf', 'root')).toBe(true);
    expect(lookups).toBe(2);
  });

  it('keeps children beside their sorted root', () => {
    const nodes = [task('old'), task('child', 'old'), { ...task('doing'), status: 'doing' as const }];
    const model = buildTaskListModel(nodes, { nodes, edges: [] }, new Set(nodes.map(({ id }) => id)), {});
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
    const model = buildTaskListModel(nodes, { nodes, edges: [] }, new Set(['ready']), {});
    expect(model.done.map(({ task: item }) => item.id)).toEqual(['first', 'second']);
  });

  it('keeps manual root order ahead of doing or recommendation priority', () => {
    const doing = { ...task('doing'), status: 'doing' as const };
    const newer = task('newer');
    const nodes = [doing, newer];
    const model = buildTaskListModel(
      nodes,
      { nodes, edges: [] },
      new Set(nodes.map(({ id }) => id)),
      {},
    );
    expect(model.ready.map(({ task: item }) => item.id)).toEqual(['newer', 'doing']);
  });

  it('moves completed children of an unfinished parent into the done section', () => {
    const parent = task('parent');
    const doneChild = { ...task('done-child', parent.id), status: 'done' as const };
    const todoChild = task('todo-child', parent.id);
    const nodes = [parent, doneChild, todoChild];

    const model = buildTaskListModel(
      nodes,
      { nodes, edges: [] },
      new Set(nodes.map(({ id }) => id)),
      {},
    );

    expect(model.ready.map(({ task: item, depth }) => [item.id, depth])).toEqual([
      ['parent', 0],
      ['todo-child', 1],
    ]);
    expect(model.done.map(({ task: item, depth }) => [item.id, depth])).toEqual([
      ['done-child', 0],
    ]);
  });
});
