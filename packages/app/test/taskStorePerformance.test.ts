import { beforeEach, describe, expect, it } from 'vitest';
import { buildTopLevelCollisionRects, rectsOverlap, type Task } from '@todograph/shared';
import { useTaskStore } from '@/stores/useTaskStore';
import { useHistoryStore } from '@/stores/useHistoryStore';

const task = (id: string, x: number, y: number, parentId?: string): Task => ({
  id,
  title: id,
  status: 'todo',
  x,
  y,
  width: 180,
  ...(parentId ? { parentId } : {}),
});

beforeEach(() => {
  useTaskStore.setState({
    activePageId: null,
    nodes: [],
    edges: [],
    recommendationRevision: 0,
  });
  useHistoryStore.getState().clear();
});

describe('atomic hierarchy commands', () => {
  const worldPosition = (nodes: Task[], id: string) => {
    const byId = new Map(nodes.map((node) => [node.id, node]));
    let node = byId.get(id);
    let x = node?.x ?? 0;
    let y = node?.y ?? 0;
    while (node?.parentId) {
      node = byId.get(node.parentId);
      if (!node) break;
      x += node.x ?? 0;
      y += node.y ?? 0;
    }
    return { x, y };
  };

  it('stores measured sizes without adding an undo command', () => {
    useTaskStore.setState({ nodes: [task('a', 0, 0), task('b', 240, 0)] });

    useTaskStore.getState().syncMeasuredSizes([
      { id: 'a', width: 220, height: 144 },
      { id: 'b', width: 180, height: 56 },
    ]);

    expect(useTaskStore.getState().nodes.map(({ id, width, height }) => ({ id, width, height }))).toEqual([
      { id: 'a', width: 220, height: 144 },
      { id: 'b', width: 180, height: 56 },
    ]);
    expect(useHistoryStore.getState().undoStack).toHaveLength(0);
  });

  it('repairs sibling overlap caused by a measured height change', () => {
    useTaskStore.setState({
      nodes: [task('a', 0, 0), task('b', 0, 80)],
    });

    useTaskStore.getState().syncMeasuredSizes([{ id: 'a', width: 180, height: 120 }]);

    const [a, b] = buildTopLevelCollisionRects(useTaskStore.getState().nodes);
    expect(rectsOverlap(a!, b!, 12)).toBe(false);
    expect(useHistoryStore.getState().undoStack).toHaveLength(0);
  });

  it('keeps world position when a grandchild ascends one level', () => {
    useTaskStore.setState({
      nodes: [
        task('grandparent', 100, 200),
        task('parent', 20, 30, 'grandparent'),
        task('child', 400, 300, 'parent'),
      ],
    });
    const before = { x: 520, y: 530 };

    expect(useTaskStore.getState().ascendOneLevel('child')).toBe(true);

    const nodes = useTaskStore.getState().nodes;
    const child = nodes.find((node) => node.id === 'child')!;
    const grandparent = nodes.find((node) => node.id === 'grandparent')!;
    expect(child.parentId).toBe('grandparent');
    expect({
      x: (grandparent.x ?? 0) + (child.x ?? 0),
      y: (grandparent.y ?? 0) + (child.y ?? 0),
    }).toEqual(before);
  });

  it('moves across parents into an exact sibling slot as one undoable command', () => {
    useTaskStore.setState({
      nodes: [
        task('root', 100, 200),
        task('parent', 20, 30, 'root'),
        task('child', 40, 50, 'parent'),
        task('target', 300, 30, 'root'),
      ],
    });
    const before = worldPosition(useTaskStore.getState().nodes, 'child');

    expect(useTaskStore.getState().moveTaskToSibling('child', 'target', 'before', 'forward')).toBe(true);

    const nodes = useTaskStore.getState().nodes;
    expect(nodes.find((node) => node.id === 'child')?.parentId).toBe('root');
    expect(nodes.filter((node) => node.parentId === 'root').map((node) => node.id))
      .toEqual(['parent', 'child', 'target']);
    expect(worldPosition(nodes, 'child')).toEqual(before);
    expect(useHistoryStore.getState().undoStack).toHaveLength(1);

    expect(useTaskStore.getState().undo()).toBe(true);
    expect(useTaskStore.getState().nodes.find((node) => node.id === 'child')?.parentId).toBe('parent');
  });

  it('deletes a selection as one undoable command', () => {
    useTaskStore.setState({
      nodes: [task('a', 0, 0), task('b', 240, 0), task('c', 480, 0)],
    });

    useTaskStore.getState().deleteTasks(['a', 'b']);

    expect(useTaskStore.getState().nodes.map((node) => node.id)).toEqual(['c']);
    expect(useHistoryStore.getState().undoStack).toHaveLength(1);
    expect(useTaskStore.getState().undo()).toBe(true);
    expect(useTaskStore.getState().nodes.map((node) => node.id)).toEqual(['a', 'b', 'c']);
  });

  it('deduplicates batch deletion ids and ignores missing ids', () => {
    useTaskStore.setState({
      nodes: [task('a', 0, 0), task('b', 240, 0), task('c', 480, 0)],
    });

    useTaskStore.getState().deleteTasks(['a', 'missing', 'a']);

    expect(useTaskStore.getState().nodes.map((node) => node.id)).toEqual(['b', 'c']);
    expect(useHistoryStore.getState().undoStack).toHaveLength(1);
  });

  it('detaches a selection as one command and preserves world positions', () => {
    useTaskStore.setState({
      nodes: [
        task('group', 100, 200),
        task('a', 20, 30, 'group'),
        task('b', 240, 30, 'group'),
      ],
    });

    useTaskStore.getState().detachTasks(['a', 'b']);

    expect(useTaskStore.getState().nodes.find((node) => node.id === 'a')).toMatchObject({
      parentId: undefined,
      x: 120,
      y: 230,
    });
    expect(useTaskStore.getState().nodes.find((node) => node.id === 'b')).toMatchObject({
      parentId: undefined,
      x: 340,
      y: 230,
    });
    expect(useHistoryStore.getState().undoStack).toHaveLength(1);
  });

  it('preserves a deeply nested task position when grouping into another branch', () => {
    useTaskStore.setState({
      nodes: [
        task('left-root', 100, 100),
        task('left-parent', 20, 30, 'left-root'),
        task('child', 400, 300, 'left-parent'),
        task('right-root', 1000, 100),
        task('right-parent', 30, 40, 'right-root'),
      ],
    });
    const before = worldPosition(useTaskStore.getState().nodes, 'child');

    expect(useTaskStore.getState().groupTasks(['child'], { existingParentId: 'right-parent' }))
      .toBe('right-parent');

    const nodes = useTaskStore.getState().nodes;
    expect(nodes.find((node) => node.id === 'child')?.parentId).toBe('right-parent');
    expect(worldPosition(nodes, 'child')).toEqual(before);
  });
});

describe('task placement', () => {
  it('places a newly added top-level task without overlap', () => {
    useTaskStore.setState({ nodes: [task('existing', 0, 0)] });
    const added = useTaskStore.getState().addTask({ title: 'new', x: 0, y: 0 });
    const rects = buildTopLevelCollisionRects(useTaskStore.getState().nodes);
    expect(rectsOverlap(rects[0]!, rects[1]!, 12)).toBe(false);
    expect(added.x).toBe(rects[1]!.x);
  });

  it('moves a sibling when adding a child expands its parent', () => {
    useTaskStore.setState({
      nodes: [task('group', 0, 0), task('first-child', 24, 60, 'group'), task('sibling', 240, 0)],
    });
    useTaskStore.getState().addTask({ title: 'wide child', parentId: 'group', x: 500, y: 60 });
    const rects = buildTopLevelCollisionRects(useTaskStore.getState().nodes);
    expect(rectsOverlap(rects[0]!, rects[1]!, 12)).toBe(false);
  });

  it('keeps a directly positioned task pinned and pushes its sibling away', () => {
    useTaskStore.setState({ nodes: [task('a', 0, 0), task('b', 240, 0)] });

    useTaskStore.getState().updateTask('b', { x: 0, y: 0 });

    const nodes = useTaskStore.getState().nodes;
    expect(nodes.find((node) => node.id === 'b')).toMatchObject({ x: 0, y: 0 });
    const rects = buildTopLevelCollisionRects(nodes);
    expect(rectsOverlap(rects[0]!, rects[1]!, 12)).toBe(false);
  });

  it('repairs conflicting bulk positions deterministically', () => {
    useTaskStore.setState({ nodes: [task('a', 0, 0), task('b', 240, 0)] });

    useTaskStore.getState().updateTasksBulk([
      { id: 'a', patch: { x: 100, y: 100 } },
      { id: 'b', patch: { x: 100, y: 100 } },
    ]);

    const nodes = useTaskStore.getState().nodes;
    expect(nodes.find((node) => node.id === 'a')).toMatchObject({ x: 100, y: 100 });
    const rects = buildTopLevelCollisionRects(nodes);
    expect(rectsOverlap(rects[0]!, rects[1]!, 12)).toBe(false);
  });
});

describe('recommendation revision', () => {
  it('does not change for coordinate-only updates', () => {
    useTaskStore.setState({ nodes: [task('a', 0, 0)], recommendationRevision: 3 });
    useTaskStore.getState().updateTask('a', { x: 100, y: 50 });
    expect(useTaskStore.getState().recommendationRevision).toBe(3);
  });

  it('changes for status, node, and edge mutations', () => {
    useTaskStore.setState({ nodes: [task('a', 0, 0), task('b', 240, 0)] });
    const initial = useTaskStore.getState().recommendationRevision;
    useTaskStore.getState().setStatus('a', 'doing');
    useTaskStore.getState().addEdge('a', 'b');
    useTaskStore.getState().addTask({ title: 'c', x: 480, y: 0 });
    expect(useTaskStore.getState().recommendationRevision).toBe(initial + 3);
  });
});

describe('list revision', () => {
  it('ignores coordinate-only updates but tracks list semantics', () => {
    useTaskStore.setState({
      nodes: [task('a', 0, 0), task('b', 240, 0)],
      listRevision: 7,
    });
    useTaskStore.getState().updateTask('a', { x: 100, y: 50 });
    expect(useTaskStore.getState().listRevision).toBe(7);

    useTaskStore.getState().updateTask('a', { title: 'renamed' });
    useTaskStore.getState().setParent('b', 'a');
    useTaskStore.getState().addEdge('a', 'b');
    expect(useTaskStore.getState().listRevision).toBe(10);

    useTaskStore.getState().updateTask('a', { description: 'details' });
    useTaskStore.getState().updateTask('a', { description: undefined });
    expect(useTaskStore.getState().listRevision).toBe(12);
  });
});

describe('parent status progression', () => {
  it('allows a parent to start but blocks completion until its children are done', () => {
    useTaskStore.setState({
      nodes: [task('parent', 0, 0), { ...task('child', 40, 60), parentId: 'parent' }],
    });
    expect(useTaskStore.getState().toggleStatus('parent')).toBe(true);
    expect(useTaskStore.getState().nodes.find((node) => node.id === 'parent')?.status).toBe('doing');
    expect(useTaskStore.getState().toggleStatus('parent')).toBe(false);
    expect(useTaskStore.getState().nodes.find((node) => node.id === 'parent')?.status).toBe('doing');

    useTaskStore.getState().setStatus('child', 'done');
    expect(useTaskStore.getState().toggleStatus('parent')).toBe(true);
    expect(useTaskStore.getState().nodes.find((node) => node.id === 'parent')?.status).toBe('done');
  });
});
