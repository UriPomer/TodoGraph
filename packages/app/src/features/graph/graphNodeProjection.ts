import type { Node as RFNode } from '@xyflow/react';
import {
  CHILD_DEFAULT_W,
  type Task,
  type computeNodeGeometryMap,
} from '@todograph/shared';
import type { HierarchyMetrics } from '@/lib/taskHierarchy';
import { measureTextWidth } from '@/lib/measureText';
import type { GroupNodeData } from './GroupNode';
import type { TaskNodeData } from './TaskNode';

export type ProjectedGraphNode = RFNode<TaskNodeData | GroupNodeData>;

interface ProjectionInput {
  nodes: Task[];
  hierarchy: HierarchyMetrics;
  geometryById: ReturnType<typeof computeNodeGeometryMap>;
  readySet: ReadonlySet<string>;
  recommendedId?: string;
  previousData?: ReadonlyMap<string, TaskNodeData | GroupNodeData>;
}

export function buildGraphNodeProjection(input: ProjectionInput): {
  nodes: ProjectedGraphNode[];
  dataById: Map<string, TaskNodeData | GroupNodeData>;
} {
  const { nodes, hierarchy, geometryById, readySet, recommendedId } = input;
  const { childIdsByParentId, byId, depthById } = hierarchy;
  const collapsedGroupIds = new Set(
    [...childIdsByParentId.keys()].filter(id => geometryById.get(id)?.collapsed),
  );

  const insideCollapsedGroup = (node: Task): boolean => {
    let parentId = node.parentId;
    const seen = new Set<string>();
    while (parentId && !seen.has(parentId)) {
      seen.add(parentId);
      if (collapsedGroupIds.has(parentId)) return true;
      parentId = byId.get(parentId)?.parentId;
    }
    return false;
  };
  const descendantsOf = (parentId: string): NonNullable<GroupNodeData['descendants']> => {
    const descendants: NonNullable<GroupNodeData['descendants']> = [];
    const visit = (id: string, depth: number, seen: Set<string>) => {
      if (seen.has(id)) return;
      seen.add(id);
      for (const childId of childIdsByParentId.get(id) ?? []) {
        const child = byId.get(childId);
        const geometry = geometryById.get(childId);
        if (!child || !geometry) continue;
        descendants.push({
          id: child.id,
          title: child.title,
          status: child.status,
          description: child.description,
          depth,
          width: geometry.displayedSize.w,
          height: geometry.displayedSize.h,
        });
        visit(child.id, depth + 1, seen);
      }
    };
    visit(parentId, 1, new Set());
    return descendants;
  };

  const dataById = new Map<string, TaskNodeData | GroupNodeData>();
  const projected = [...nodes]
    .sort((a, b) => (depthById.get(a.id) ?? 0) - (depthById.get(b.id) ?? 0))
    .map((node): ProjectedGraphNode => {
      const isGroup = childIdsByParentId.has(node.id);
      const leafWidth = isGroup ? undefined : measureTextWidth(node.title);
      const collapsed = collapsedGroupIds.has(node.id);
      const size = geometryById.get(node.id)?.displayedSize;
      const candidate: TaskNodeData | GroupNodeData = isGroup
        ? {
            title: node.title,
            status: node.status,
            ready: readySet.has(node.id),
            recommended: recommendedId === node.id,
            childrenCount: childIdsByParentId.get(node.id)?.length ?? 0,
            description: node.description,
            isHeightCollapsed: collapsed,
            descendants: collapsed ? descendantsOf(node.id) : undefined,
          }
        : {
            title: node.title,
            status: node.status,
            ready: readySet.has(node.id),
            recommended: recommendedId === node.id,
            description: node.description,
            nodeWidth: leafWidth,
          };
      const previous = input.previousData?.get(node.id);
      const data = previous && shallowEqualData(previous, candidate) ? previous : candidate;
      dataById.set(node.id, data);
      return {
        id: node.id,
        type: isGroup ? 'group' : 'task',
        position: { x: node.x ?? 0, y: node.y ?? 0 },
        data,
        hidden: insideCollapsedGroup(node),
        className: isGroup && collapsed ? 'group-scroll-node' : undefined,
        ...(node.parentId ? { parentId: node.parentId } : {}),
        ...(isGroup ? { dragHandle: '.group-drag-handle' } : {}),
        ...(isGroup && size
          ? { style: { width: size.w, height: size.h }, width: size.w, height: size.h }
          : {}),
        ...(!isGroup ? { style: { width: leafWidth ?? CHILD_DEFAULT_W } } : {}),
      };
    });
  return { nodes: projected, dataById };
}

function shallowEqualData(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => a[key] === b[key]);
}
