import { describe, expect, it } from 'vitest';
import { computeNodeGeometryMap, type Task } from '@todograph/shared';
import { buildGraphNodeProjection } from '@/features/graph/graphNodeProjection';
import { buildHierarchyMetrics } from '@/stores/useTaskStore';

const tasks: Task[] = [
  { id: 'group', title: 'Group', status: 'todo', x: 10, y: 20 },
  { id: 'child', title: 'Child', status: 'doing', parentId: 'group', x: 24, y: 48 },
];

describe('graph node projection', () => {
  it('projects hierarchy and preserves semantic data references for coordinate-only changes', () => {
    const first = buildGraphNodeProjection({
      nodes: tasks,
      hierarchy: buildHierarchyMetrics(tasks),
      geometryById: computeNodeGeometryMap(tasks),
      readySet: new Set(['child']),
      recommendedId: 'child',
    });
    expect(first.nodes.map((node) => [node.id, node.type, node.parentId])).toEqual([
      ['group', 'group', undefined],
      ['child', 'task', 'group'],
    ]);

    const moved = tasks.map((task) => task.id === 'child' ? { ...task, x: 120 } : task);
    const second = buildGraphNodeProjection({
      nodes: moved,
      hierarchy: buildHierarchyMetrics(moved),
      geometryById: computeNodeGeometryMap(moved),
      readySet: new Set(['child']),
      recommendedId: 'child',
      previousData: first.dataById,
    });
    expect(second.dataById.get('child')).toBe(first.dataById.get('child'));
    expect(second.nodes.find((node) => node.id === 'child')?.position.x).toBe(120);
  });
});
