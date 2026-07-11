import { beforeEach, describe, expect, it } from 'vitest';
import { buildTopLevelCollisionRects, rectsOverlap, type Task } from '@todograph/shared';
import { useTaskStore } from '@/stores/useTaskStore';

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
