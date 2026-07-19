import type { Node as RFNode } from '@xyflow/react';
import {
  CHILD_DEFAULT_W,
  type Task,
  type computeNodeGeometryMap,
} from '@todograph/shared';
import type { HierarchyMetrics } from '@/stores/useTaskStore';
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
  groupSizes: Map<string, { w: number; h: number }>;
} {
  const { nodes, hierarchy, geometryById, readySet, recommendedId } = input;
  const { childIdsByParentId, byId, depthById } = hierarchy;
  const groupIds = [...childIdsByParentId.keys()].sort(
    (a, b) => (depthById.get(b) ?? 0) - (depthById.get(a) ?? 0),
  );
  const groupSizes = new Map<string, { w: number; h: number }>();
  const collapsedGroupIds = new Set<string>();
  for (const id of groupIds) {
    const geometry = geometryById.get(id);
    if (!geometry) continue;
    if (geometry.collapsed) collapsedGroupIds.add(id);
    groupSizes.set(id, geometry.displayedSize);
  }

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
      const size = groupSizes.get(node.id);
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
  return { nodes: projected, dataById, groupSizes };
}

function shallowEqualData(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => a[key] === b[key]);
}
