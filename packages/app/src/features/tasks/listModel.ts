import { buildAdj } from '@todograph/core';
import type { PageData, Task } from '@todograph/shared';

export type DepInfo = { undone: number; total: number; parentTitles: string[] };
export type FlatItem = { task: Task; depth: number };

export function isDescendant(
  byId: ReadonlyMap<string, Task>,
  descendantId: string,
  ancestorId: string,
): boolean {
  if (descendantId === ancestorId) return true;
  let current = byId.get(descendantId);
  const visited = new Set<string>();
  while (current?.parentId && !visited.has(current.id)) {
    if (current.parentId === ancestorId) return true;
    visited.add(current.id);
    current = byId.get(current.parentId);
  }
  return false;
}

export function buildTaskListModel(
  nodes: Task[],
  graph: PageData,
  readySet: Set<string>,
  recommendedId: string | undefined,
  collapsed: Record<string, boolean>,
  previousDepInfo = new Map<string, DepInfo>(),
) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const children = new Map<string, Task[]>();
  for (const node of nodes) {
    if (!node.parentId || !byId.has(node.parentId)) continue;
    const siblings = children.get(node.parentId);
    if (siblings) siblings.push(node);
    else children.set(node.parentId, [node]);
  }

  const depInfo = new Map<string, DepInfo>();
  const { parents } = buildAdj(graph);
  for (const node of nodes) {
    const ids = [...(parents.get(node.id) ?? [])];
    if (!ids.length) continue;
    const candidate: DepInfo = {
      undone: ids.filter((id) => byId.get(id)?.status !== 'done').length,
      total: ids.length,
      parentTitles: ids.map((id) => byId.get(id)?.title ?? id),
    };
    const previous = previousDepInfo.get(node.id);
    const unchanged = previous?.undone === candidate.undone &&
      previous.total === candidate.total &&
      previous.parentTitles.every((title, index) => title === candidate.parentTitles[index]);
    depInfo.set(node.id, unchanged ? previous : candidate);
  }

  type Section = 'ready' | 'blocked' | 'done';
  const sectionOf = (task: Task): Section =>
    task.status === 'done' ? 'done' : readySet.has(task.id) ? 'ready' : 'blocked';
  const roots = nodes.filter((node) => !node.parentId || !byId.has(node.parentId));
  const originalOrder = new Map(nodes.map((node, index) => [node.id, index]));
  const sections: Record<Section, FlatItem[]> = { ready: [], blocked: [], done: [] };
  const visited = new Set<string>();
  const append = (task: Task, depth: number, section: Section) => {
    if (visited.has(task.id)) return;
    visited.add(task.id);
    sections[section].push({ task, depth });
    if (!collapsed[task.id]) {
      for (const child of children.get(task.id) ?? []) {
        const belongsInSection = section === 'done'
          ? child.status === 'done'
          : child.status !== 'done';
        if (belongsInSection) append(child, depth + 1, section);
      }
    }
  };
  const priority = (task: Task) =>
    (task.id === recommendedId ? 2 : 0) + (task.status === 'doing' ? 1 : 0);
  for (const section of ['ready', 'blocked', 'done'] as const) {
    const sectionRoots = section === 'done'
      ? nodes.filter((node) =>
          node.status === 'done' && byId.get(node.parentId ?? '')?.status !== 'done',
        )
      : roots.filter((root) => sectionOf(root) === section);
    if (section !== 'done') {
      sectionRoots.sort((a, b) =>
        priority(b) - priority(a) || originalOrder.get(b.id)! - originalOrder.get(a.id)!,
      );
    }
    for (const root of sectionRoots) append(root, 0, section);
  }
  for (const node of nodes) {
    if (!visited.has(node.id)) append(node, 0, sectionOf(node));
  }

  return { ...sections, childMap: children, depInfo };
}
