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

  it('derives leaf width from the compact URL label instead of stale persisted width', () => {
    const urlTask: Task = {
      id: 'link',
      title: 'https://www.example.com/a/very/long/path',
      status: 'todo',
      width: 400,
    };
    const projection = buildGraphNodeProjection({
      nodes: [urlTask],
      hierarchy: buildHierarchyMetrics([urlTask]),
      geometryById: computeNodeGeometryMap([urlTask]),
      readySet: new Set(),
    });
    const node = projection.nodes[0]!;
    expect(node.data.nodeWidth).toBe(180);
    expect(node.style).toMatchObject({ width: 180 });
  });

  it('HIER-003 keeps ten children visible and hides descendants starting with the eleventh', () => {
    const project = (childCount: number) => {
      const nodes: Task[] = [
        { id: 'parent', title: 'Parent', status: 'todo' },
        ...Array.from({ length: childCount }, (_, index) => ({
          id: `child-${index}`,
          title: `Child ${index}`,
          status: 'todo' as const,
          parentId: 'parent',
          x: 24,
          y: 60 + index * 68,
        })),
      ];
      return buildGraphNodeProjection({
        nodes,
        hierarchy: buildHierarchyMetrics(nodes),
        geometryById: computeNodeGeometryMap(nodes),
        readySet: new Set(),
      });
    };

    const ten = project(10);
    expect(ten.nodes.find((node) => node.id === 'parent')?.data.isHeightCollapsed).toBe(false);
    expect(ten.nodes.filter((node) => node.parentId === 'parent').every((node) => !node.hidden)).toBe(true);

    const eleven = project(11);
    const parent = eleven.nodes.find((node) => node.id === 'parent')!;
    expect(parent.data.isHeightCollapsed).toBe(true);
    expect(parent.data.descendants).toHaveLength(11);
    expect(eleven.nodes.filter((node) => node.parentId === 'parent').every((node) => node.hidden)).toBe(true);
  });
});
