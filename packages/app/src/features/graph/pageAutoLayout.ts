import { computeNodeSizeMap, type Task } from '@todograph/shared';

import { arePageViewportNodesReady } from './pageViewportCache';

export function claimPageForAutoLayout(
  checkedPages: Set<string>,
  pageId: string,
  nodeIds: readonly string[],
  renderedNodes: Parameters<typeof arePageViewportNodesReady>[1],
): boolean {
  if (checkedPages.has(pageId) || !arePageViewportNodesReady(nodeIds, renderedNodes)) return false;
  checkedPages.add(pageId);
  return true;
}

export function fitPageAfterAutoLayout(
  fitView: (options: { padding: number; duration: number }) => unknown,
  schedule: (callback: FrameRequestCallback) => number = requestAnimationFrame,
): number {
  return schedule(() => {
    void fitView({ padding: 0.2, duration: 250 });
  });
}

export function buildAlignedPatches(
  nodes: Task[],
  ids: readonly string[],
  axis: 'horizontal' | 'vertical',
): Array<{ id: string; patch: Partial<Task> }> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const selected = ids.map((id) => byId.get(id)).filter((node): node is Task => Boolean(node));
  if (selected.length === 0) return [];
  const anchor = selected[0]!;
  const sizeMap = computeNodeSizeMap(nodes);
  const ordered = [...selected].sort((a, b) =>
    axis === 'horizontal'
      ? (a.x ?? 0) - (b.x ?? 0) || (a.y ?? 0) - (b.y ?? 0) || a.id.localeCompare(b.id)
      : (a.y ?? 0) - (b.y ?? 0) || (a.x ?? 0) - (b.x ?? 0) || a.id.localeCompare(b.id),
  );
  let cursor = -Infinity;
  const patches = new Map<string, Partial<Task>>();
  for (const node of ordered) {
    const size = sizeMap.get(node.id)!;
    if (axis === 'horizontal') {
      const x = Math.max(node.x ?? 0, cursor);
      patches.set(node.id, { x, y: anchor.y ?? 0 });
      cursor = x + size.w + 12;
    } else {
      const y = Math.max(node.y ?? 0, cursor);
      patches.set(node.id, { x: anchor.x ?? 0, y });
      cursor = y + size.h + 12;
    }
  }
  return ids.flatMap((id) => {
    const patch = patches.get(id);
    return patch ? [{ id, patch }] : [];
  });
}
