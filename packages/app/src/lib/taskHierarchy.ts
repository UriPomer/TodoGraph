import { MAX_HIERARCHY_DEPTH, type Task } from '@todograph/shared';

export interface HierarchyIndex {
  byId: Map<string, Task>;
  childIdsByParentId: Map<string, string[]>;
}

export interface HierarchyMetrics extends HierarchyIndex {
  depthById: Map<string, number>;
  subtreeHeightById: Map<string, number>;
}

export function buildHierarchyIndex(nodes: Task[]): HierarchyIndex {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const childIdsByParentId = new Map<string, string[]>();
  for (const n of nodes) {
    if (!n.parentId) continue;
    const arr = childIdsByParentId.get(n.parentId);
    if (arr) arr.push(n.id);
    else childIdsByParentId.set(n.parentId, [n.id]);
  }
  return { byId, childIdsByParentId };
}

function depthOfFromIndex(index: HierarchyIndex, id: string): number {
  let depth = 0;
  let cur = index.byId.get(id);
  const seen = new Set<string>();
  while (cur?.parentId) {
    if (seen.has(cur.id)) break; // 防御环
    seen.add(cur.id);
    cur = index.byId.get(cur.parentId);
    depth++;
  }
  return depth;
}

export function worldPositionFromIndex(index: HierarchyIndex, id: string): { x: number; y: number } {
  let node = index.byId.get(id);
  let x = node?.x ?? 0;
  let y = node?.y ?? 0;
  const seen = new Set<string>([id]);
  while (node?.parentId && !seen.has(node.parentId)) {
    seen.add(node.parentId);
    node = index.byId.get(node.parentId);
    if (!node) break;
    x += node.x ?? 0;
    y += node.y ?? 0;
  }
  return { x, y };
}

export function subtreeHeightFromIndex(index: HierarchyIndex, id: string): number {
  const walk = (root: string, seen = new Set<string>()): number => {
    if (seen.has(root)) return 0;
    seen.add(root);
    const childIds = index.childIdsByParentId.get(root);
    if (!childIds || childIds.length === 0) return 0;
    let best = 0;
    for (const childId of childIds) {
      const height = 1 + walk(childId, seen);
      if (height > best) best = height;
    }
    return best;
  };
  return walk(id);
}

export function wouldExceedMaxDepthFromIndex(
  index: HierarchyIndex,
  childId: string,
  newParentId: string | null,
): boolean {
  if (!newParentId) return false;
  const parentDepth = depthOfFromIndex(index, newParentId); // 根=0 ...
  const childHeight = subtreeHeightFromIndex(index, childId); // 叶=0 ...
  return parentDepth + 1 + childHeight + 1 > MAX_HIERARCHY_DEPTH;
}

export function buildHierarchyMetrics(nodes: Task[]): HierarchyMetrics {
  const index = buildHierarchyIndex(nodes);
  return {
    ...index,
    depthById: new Map([...index.byId.keys()].map(id => [id, depthOfFromIndex(index, id)])),
    subtreeHeightById: new Map([...index.byId.keys()].map(id => [id, subtreeHeightFromIndex(index, id)])),
  };
}

export function wouldCreateParentCycleFromIndex(
  index: HierarchyIndex,
  childId: string,
  newParentId: string,
): boolean {
  if (childId === newParentId) return true;
  let cur: string | undefined = newParentId;
  const seen = new Set<string>();
  while (cur) {
    if (cur === childId) return true;
    if (seen.has(cur)) return true; // 防御已有环
    seen.add(cur);
    cur = index.byId.get(cur)?.parentId;
  }
  return false;
}

/** 节点到根的距离（根 = 0；其父 = 1；祖父 = 2）。 */
export function depthOf(nodes: Task[], id: string): number {
  return depthOfFromIndex(buildHierarchyIndex(nodes), id);
}

/** 以 id 为根的子树高度（叶 = 0；有直接子 = 1）。 */
export function subtreeHeight(nodes: Task[], id: string): number {
  return subtreeHeightFromIndex(buildHierarchyIndex(nodes), id);
}

/**
 * 把 childId 挂到 newParentId 下是否会让树深度超出上限。
 * 深度 = newParentId 的深度 + 1（child 自身）+ childId 的子树高度 + 1 ≤ MAX。
 * 传入 null 表示 child 要变成顶层 —— 永远不会超深度。
 */
export function wouldExceedMaxDepth(
  nodes: Task[],
  childId: string,
  newParentId: string | null,
): boolean {
  return wouldExceedMaxDepthFromIndex(buildHierarchyIndex(nodes), childId, newParentId);
}
