import dagre from 'dagre';
import { isDAG } from '@todograph/core';
import {
  resolveNodeOverlaps,
  hasIncompleteDirectChild,
  validateDependencyEdges,
  validateTaskHierarchy,
  type PageData,
  type Task,
  type TaskStatus,
} from '@todograph/shared';
import type { WorkspaceRepository } from '../repositories/Repository.js';

export type TaskCommand =
  | { type: 'delete_tasks'; taskIds: string[] }
  | {
      type: 'create_task';
      title: string;
      status?: TaskStatus;
      description?: string;
      dependsOn?: string[];
    }
  | {
      type: 'create_tasks';
      tasks: Array<{ title: string; status?: TaskStatus; description?: string }>;
      edges?: Array<{ from: number; to: number }>;
    }
  | {
      type: 'update_task';
      taskId: string;
      title?: string;
      status?: TaskStatus;
      description?: string;
      x?: number;
      y?: number;
    }
  | {
      type: 'manage_dependencies';
      add?: Array<{ from: string; to: string }>;
      remove?: Array<{ from: string; to: string }>;
    };

const DEFAULT_WIDTH = 180;
const DEFAULT_HEIGHT = 56;

function generateId(): string {
  return `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function layoutNewNodes(
  allNodes: Task[],
  newNodeIds: Set<string>,
  edges: Array<{ from: string; to: string }>,
): void {
  const graph = new dagre.graphlib.Graph();
  graph.setDefaultEdgeLabel(() => ({}));
  graph.setGraph({ rankdir: 'LR', nodesep: 40, ranksep: 80, marginx: 20, marginy: 20 });

  const seen = new Set<string>();
  for (const node of allNodes) {
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    const width = node.width ?? DEFAULT_WIDTH;
    const height = node.height ?? DEFAULT_HEIGHT;
    if (newNodeIds.has(node.id)) {
      graph.setNode(node.id, { width, height });
    } else {
      graph.setNode(node.id, {
        width,
        height,
        x: (node.x ?? 0) + width / 2,
        y: (node.y ?? 0) + height / 2,
        fixed: true,
      });
    }
  }
  for (const edge of edges) graph.setEdge(edge.from, edge.to);
  dagre.layout(graph);

  for (const node of allNodes) {
    if (!newNodeIds.has(node.id)) continue;
    const position = graph.node(node.id);
    if (!position) continue;
    node.x = Math.round(position.x - (node.width ?? DEFAULT_WIDTH) / 2);
    node.y = Math.round(position.y - (node.height ?? DEFAULT_HEIGHT) / 2);
  }
}

async function saveMutation(
  repo: WorkspaceRepository,
  pageId: string,
  page: PageData,
  next: PageData,
): Promise<void> {
  const dependencies = validateDependencyEdges(next.nodes, next.edges);
  if (!dependencies.valid) throw new Error('invalid dependency');
  if (!isDAG(next)) throw new Error('graph contains a cycle');
  const hierarchy = validateTaskHierarchy(next.nodes);
  if (!hierarchy.valid) throw new Error('invalid task hierarchy');

  await repo.createBackup(pageId);
  await repo.savePage(pageId, next, page.version);
}

export async function executeTaskCommand(
  repo: WorkspaceRepository,
  pageId: string,
  command: TaskCommand,
): Promise<unknown> {
  const page = await repo.loadPage(pageId);

  switch (command.type) {
    case 'delete_tasks': {
      const ids = new Set(command.taskIds);
      const removed = page.nodes.filter((node) => ids.has(node.id)).map((node) => node.id);
      if (removed.length === 0) {
        return { removed: 0, warning: 'none of the requested task_ids were found' };
      }

      const byId = new Map(page.nodes.map((node) => [node.id, node]));
      const releasedIds: string[] = [];
      const keptNodes = page.nodes.filter((node) => !ids.has(node.id)).map((node) => {
        if (!node.parentId || !ids.has(node.parentId)) return node;
        let x = node.x ?? 0;
        let y = node.y ?? 0;
        let parentId: string | undefined = node.parentId;
        const seen = new Set<string>();
        while (parentId && !seen.has(parentId)) {
          seen.add(parentId);
          const parent = byId.get(parentId);
          if (!parent) break;
          x += parent.x ?? 0;
          y += parent.y ?? 0;
          parentId = parent.parentId;
        }
        releasedIds.push(node.id);
        return { ...node, parentId: undefined, x, y };
      });
      const nodes = resolveNodeOverlaps(keptNodes, {
        changedIds: releasedIds,
        pinnedIds: releasedIds,
      }).nodes;
      const edges = page.edges.filter((edge) => !ids.has(edge.from) && !ids.has(edge.to));
      await saveMutation(repo, pageId, page, { nodes, edges });
      return { removed: removed.length, removedIds: removed };
    }

    case 'create_task': {
      const id = generateId();
      const node: Task = {
        id,
        title: command.title,
        status: command.status ?? 'todo',
        ...(command.description ? { description: command.description } : {}),
      };
      const existingIds = new Set(page.nodes.map((candidate) => candidate.id));
      const rejectedDependencies: string[] = [];
      const edges = [...page.edges];
      for (const dependencyId of new Set(command.dependsOn ?? [])) {
        if (existingIds.has(dependencyId)) edges.push({ from: dependencyId, to: id });
        else rejectedDependencies.push(dependencyId);
      }
      const nodes = [...resolveNodeOverlaps(page.nodes).nodes, node];
      layoutNewNodes(nodes, new Set([id]), edges);
      const resolved = resolveNodeOverlaps(nodes, { changedIds: [id], pinnedIds: [id], gap: 48 }).nodes;
      await saveMutation(repo, pageId, page, { nodes: resolved, edges });
      const saved = resolved.find((candidate) => candidate.id === id)!;
      return {
        task: { id, title: command.title, status: command.status ?? 'todo', x: saved.x, y: saved.y },
        ...(rejectedDependencies.length ? { rejectedDependencies } : {}),
      };
    }

    case 'create_tasks': {
      const ids = command.tasks.map(() => generateId());
      const newNodes: Task[] = command.tasks.map((task, index) => ({
        id: ids[index]!,
        title: task.title,
        status: task.status ?? 'todo',
        ...(task.description ? { description: task.description } : {}),
      }));
      const edges = [...page.edges];
      const rejectedEdges: Array<{ from: number; to: number; reason: string }> = [];
      const edgeKeys = new Set<string>();
      for (const edge of command.edges ?? []) {
        if (edge.from === edge.to) {
          rejectedEdges.push({ ...edge, reason: 'self-loop' });
          continue;
        }
        if (edge.from < 0 || edge.from >= ids.length || edge.to < 0 || edge.to >= ids.length) {
          rejectedEdges.push({ ...edge, reason: 'index out of range' });
          continue;
        }
        const key = `${edge.from}:${edge.to}`;
        if (edgeKeys.has(key)) {
          rejectedEdges.push({ ...edge, reason: 'duplicate' });
          continue;
        }
        edgeKeys.add(key);
        edges.push({ from: ids[edge.from]!, to: ids[edge.to]! });
      }
      const nodes = [...resolveNodeOverlaps(page.nodes).nodes, ...newNodes];
      layoutNewNodes(nodes, new Set(ids), edges);
      const resolved = resolveNodeOverlaps(nodes, { changedIds: ids, pinnedIds: ids, gap: 48 }).nodes;
      await saveMutation(repo, pageId, page, { nodes: resolved, edges });
      return {
        created: ids.map((id) => resolved.find((node) => node.id === id)!).map((node) => ({
          id: node.id,
          title: node.title ?? '',
          status: node.status ?? 'todo',
          x: node.x,
          y: node.y,
        })),
        edgesCreated: (command.edges?.length ?? 0) - rejectedEdges.length,
        ...(rejectedEdges.length ? { rejectedEdges } : {}),
      };
    }

    case 'update_task': {
      if (
        command.title === undefined && command.status === undefined && command.description === undefined &&
        command.x === undefined && command.y === undefined
      ) throw new Error('no fields to update');
      const nodes = resolveNodeOverlaps(page.nodes).nodes;
      const index = nodes.findIndex((node) => node.id === command.taskId);
      if (index === -1) throw new Error(`task not found: ${command.taskId}`);
      if (command.status === 'done' && hasIncompleteDirectChild(nodes, command.taskId)) {
        throw new Error('parent task cannot be completed before all direct children are done');
      }
      const updated = { ...nodes[index]! };
      if (command.title !== undefined) updated.title = command.title;
      if (command.status !== undefined) updated.status = command.status;
      if (command.description !== undefined) updated.description = command.description;
      if (command.x !== undefined) updated.x = command.x;
      if (command.y !== undefined) updated.y = command.y;
      nodes[index] = updated;
      const resolved = resolveNodeOverlaps(nodes, {
        changedIds: [updated.id], pinnedIds: [updated.id], gap: 48,
      }).nodes;
      await saveMutation(repo, pageId, page, { nodes: resolved, edges: page.edges });
      return { task: resolved.find((node) => node.id === updated.id)! };
    }

    case 'manage_dependencies': {
      const nodeIds = new Set(page.nodes.map((node) => node.id));
      const edges = new Map(page.edges.map((edge) => [`${edge.from}\u0000${edge.to}`, edge]));
      const rejected: Array<{ from: string; to: string; reason: string }> = [];
      let removed = 0;
      let added = 0;
      for (const edge of command.remove ?? []) {
        if (edges.delete(`${edge.from}\u0000${edge.to}`)) removed++;
      }
      for (const edge of command.add ?? []) {
        const key = `${edge.from}\u0000${edge.to}`;
        let reason: string | undefined;
        if (edge.from === edge.to) reason = 'self-loop';
        else if (!nodeIds.has(edge.from)) reason = `node not found: ${edge.from}`;
        else if (!nodeIds.has(edge.to)) reason = `node not found: ${edge.to}`;
        else if (edges.has(key)) reason = 'duplicate';
        if (reason) rejected.push({ ...edge, reason });
        else {
          edges.set(key, edge);
          added++;
        }
      }
      await saveMutation(repo, pageId, page, {
        nodes: resolveNodeOverlaps(page.nodes).nodes,
        edges: [...edges.values()],
      });
      return { added, removed, ...(rejected.length ? { rejected } : {}) };
    }
  }
}
