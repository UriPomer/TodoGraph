import type { Task } from './schema.js';

export const MAX_HIERARCHY_DEPTH = 3;

/** A parent may only be completed after all of its direct children are complete. */
export function hasIncompleteDirectChild(nodes: readonly Task[], parentId: string): boolean {
  return nodes.some((node) => node.parentId === parentId && node.status !== 'done');
}

export function findCompletedParentWithIncompleteChild(nodes: readonly Task[]): Task | undefined {
  return nodes.find((node) => node.status === 'done' && hasIncompleteDirectChild(nodes, node.id));
}

export type HierarchyValidationResult =
  | { valid: true }
  | {
      valid: false;
      reason: 'duplicate-id' | 'missing-parent' | 'cycle' | 'max-depth';
      taskId: string;
    };

/** Validate parentId references, acyclicity, and the shared maximum nesting depth. */
export function validateTaskHierarchy(
  nodes: Task[],
  maxDepth = MAX_HIERARCHY_DEPTH,
): HierarchyValidationResult {
  const byId = new Map<string, Task>();
  for (const node of nodes) {
    if (byId.has(node.id)) return { valid: false, reason: 'duplicate-id', taskId: node.id };
    byId.set(node.id, node);
  }
  for (const node of nodes) {
    const seen = new Set<string>();
    let current = node;
    let depth = 1;
    while (current.parentId) {
      seen.add(current.id);
      const parent = byId.get(current.parentId);
      if (!parent) return { valid: false, reason: 'missing-parent', taskId: current.id };
      if (seen.has(parent.id)) return { valid: false, reason: 'cycle', taskId: parent.id };
      if (++depth > maxDepth) return { valid: false, reason: 'max-depth', taskId: node.id };
      current = parent;
    }
  }
  return { valid: true };
}

export type DependencyValidationResult =
  | { valid: true }
  | { valid: false; reason: 'self-edge' | 'missing-endpoint' | 'duplicate-edge'; edgeIndex: number };

export function validateDependencyEdges(
  nodes: Task[],
  edges: Array<{ from: string; to: string }>,
): DependencyValidationResult {
  const ids = new Set(nodes.map((node) => node.id));
  const seen = new Set<string>();
  for (let edgeIndex = 0; edgeIndex < edges.length; edgeIndex += 1) {
    const edge = edges[edgeIndex]!;
    if (edge.from === edge.to) return { valid: false, reason: 'self-edge', edgeIndex };
    if (!ids.has(edge.from) || !ids.has(edge.to)) {
      return { valid: false, reason: 'missing-endpoint', edgeIndex };
    }
    const key = `${edge.from}\0${edge.to}`;
    if (seen.has(key)) return { valid: false, reason: 'duplicate-edge', edgeIndex };
    seen.add(key);
  }
  return { valid: true };
}
