import {
  pageSupportsDependencyGraph,
  placeMovedNodesOnTarget,
  resolveNodeOverlaps,
  type MoveNodesResponse,
  type PageData,
  type Task,
} from '@todograph/shared';
import { isDAG } from '@todograph/core';
import type { WorkspaceRepository } from '../repositories/Repository.js';

/** Applies a cross-page move as one repository transaction, including descendants and internal edges. */
export async function moveNodesBetweenPages(
  repo: WorkspaceRepository,
  sourceId: string,
  targetId: string,
  userSelected: string[],
  expectedSourceVersion?: number,
  expectedTargetVersion?: number,
): Promise<MoveNodesResponse> {
  const [meta, source, target] = await Promise.all([
    repo.loadMeta(),
    repo.loadPage(sourceId),
    repo.loadPage(targetId),
  ]);
  const targetSupportsDependencies = pageSupportsDependencyGraph(
    meta.pages.find((page) => page.id === targetId),
  );

  const byIdSrc = new Map(source.nodes.map((node) => [node.id, node]));
  const childrenOf = new Map<string, string[]>();
  for (const node of source.nodes) {
    if (!node.parentId) continue;
    const children = childrenOf.get(node.parentId);
    if (children) children.push(node.id);
    else childrenOf.set(node.parentId, [node.id]);
  }

  const toMove = new Set<string>();
  const userSet = new Set<string>();
  for (const id of userSelected) {
    if (!byIdSrc.has(id)) continue;
    userSet.add(id);
    collectSubtree(id, childrenOf, toMove);
  }
  if (toMove.size === 0) throw new Error('no valid nodes to move');

  let droppedParentLinks = 0;
  const movedNodes: Task[] = [];
  for (const id of toMove) {
    const node = byIdSrc.get(id)!;
    if (node.parentId && !toMove.has(node.parentId)) {
      let x = node.x ?? 0;
      let y = node.y ?? 0;
      let ancestorId: string | undefined = node.parentId;
      const seen = new Set<string>([node.id]);
      while (ancestorId && !seen.has(ancestorId)) {
        seen.add(ancestorId);
        const ancestor = byIdSrc.get(ancestorId);
        if (!ancestor) break;
        x += ancestor.x ?? 0;
        y += ancestor.y ?? 0;
        if (!ancestor.parentId || toMove.has(ancestor.parentId)) break;
        ancestorId = ancestor.parentId;
      }
      const copy: Task = { ...node, x, y };
      delete copy.parentId;
      droppedParentLinks++;
      movedNodes.push(copy);
    } else {
      movedNodes.push(node);
    }
  }

  const internalMovedEdges = source.edges.filter((edge) => toMove.has(edge.from) && toMove.has(edge.to));
  const movedEdges = targetSupportsDependencies ? internalMovedEdges : [];
  const lostEdges = source.edges.filter(
    (edge) => (toMove.has(edge.from) && !toMove.has(edge.to)) || (!toMove.has(edge.from) && toMove.has(edge.to)),
  ).length + (targetSupportsDependencies ? 0 : internalMovedEdges.length);

  const targetIds = new Set(target.nodes.map((node) => node.id));
  for (const node of movedNodes) {
    if (targetIds.has(node.id)) throw new Error(`node id conflict: ${node.id} already exists on target page`);
  }

  const newSource: PageData = {
    nodes: resolveNodeOverlaps(source.nodes.filter((node) => !toMove.has(node.id))).nodes,
    edges: source.edges.filter((edge) => !toMove.has(edge.from) && !toMove.has(edge.to)),
  };
  const safeTargetNodes = resolveNodeOverlaps(target.nodes).nodes;
  const newTarget: PageData = {
    nodes: [...safeTargetNodes, ...placeMovedNodesOnTarget(safeTargetNodes, movedNodes)],
    edges: [...target.edges, ...movedEdges],
  };
  if (!isDAG(newSource) || !isDAG(newTarget)) throw new Error('resulting page would contain a cycle');

  await repo.savePages([
    { pageId: sourceId, data: newSource, expectedVersion: expectedSourceVersion ?? source.version },
    { pageId: targetId, data: newTarget, expectedVersion: expectedTargetVersion ?? target.version },
  ]);

  return {
    movedNodes: toMove.size,
    movedEdges: movedEdges.length,
    autoIncludedChildren: toMove.size - userSet.size,
    lostEdges,
    droppedParentLinks,
  };
}

function collectSubtree(rootId: string, childrenOf: Map<string, string[]>, out: Set<string>): void {
  if (out.has(rootId)) return;
  out.add(rootId);
  for (const child of childrenOf.get(rootId) ?? []) collectSubtree(child, childrenOf, out);
}
