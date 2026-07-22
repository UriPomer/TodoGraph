import {
  MAX_PAGE_TITLE_LENGTH,
  MAX_TASK_TITLE_LENGTH,
  PageDataSchema,
  findCompletedParentWithIncompleteChild,
  validateDependencyEdges,
  validateNoSiblingOverlaps,
  validateTaskHierarchy,
  type PageData,
} from '@todograph/shared';
import { isDAG } from '@todograph/core';
import { NodeOverlapError, TaskTitleTooLongError } from './Repository.js';

const MAX_NODES_PER_PAGE = 10_000;
const MAX_EDGES_PER_PAGE = 50_000;
const MAX_TASK_METADATA_BYTES = 64 * 1024;
const MAX_TASK_METADATA_DEPTH = 10;
export const MAX_PAGE_DATA_BYTES = 4 * 1024 * 1024;
export const MAX_WORKSPACE_DATA_BYTES = 128 * 1024 * 1024;

export function serializedJsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value, null, 2), 'utf-8');
}

export function assertPageCapacity(page: PageData, pageId: string): void {
  if (serializedJsonBytes(page) > MAX_PAGE_DATA_BYTES) {
    throw new Error(`page exceeds ${MAX_PAGE_DATA_BYTES} serialized bytes: ${pageId}`);
  }
  if (page.nodes.length > MAX_NODES_PER_PAGE) {
    throw new Error(`page exceeds ${MAX_NODES_PER_PAGE} tasks: ${pageId}`);
  }
  if (page.edges.length > MAX_EDGES_PER_PAGE) {
    throw new Error(`page exceeds ${MAX_EDGES_PER_PAGE} edges: ${pageId}`);
  }
  for (const node of page.nodes) {
    if (!node.metadata) continue;
    if (Buffer.byteLength(JSON.stringify(node.metadata), 'utf-8') > MAX_TASK_METADATA_BYTES) {
      throw new Error(`task metadata exceeds ${MAX_TASK_METADATA_BYTES} bytes: ${node.id}`);
    }
    if (valueDepth(node.metadata) > MAX_TASK_METADATA_DEPTH) {
      throw new Error(`task metadata exceeds depth ${MAX_TASK_METADATA_DEPTH}: ${node.id}`);
    }
  }
}

export function parseValidPageData(
  data: unknown,
  pageId: string,
  allowedLegacyTitles?: ReadonlyMap<string, string>,
  enforceTitleLimit = true,
): PageData {
  let page = PageDataSchema.parse(data);
  if (enforceTitleLimit) {
    const oversized = page.nodes.find(
      (node) => node.title.length > MAX_TASK_TITLE_LENGTH && allowedLegacyTitles?.get(node.id) !== node.title,
    );
    if (oversized) throw new TaskTitleTooLongError(oversized.id, MAX_TASK_TITLE_LENGTH);

    const dependencies = validateDependencyEdges(page.nodes, page.edges);
    if (!dependencies.valid) {
      throw new Error(`page contains invalid dependency (${dependencies.reason}, edge ${dependencies.edgeIndex}): ${pageId}`);
    }
  } else {
    const ids = new Set(page.nodes.map((node) => node.id));
    const seen = new Set<string>();
    page = {
      ...page,
      edges: page.edges.filter((edge) => {
        const key = `${edge.from}\0${edge.to}`;
        if (edge.from === edge.to || !ids.has(edge.from) || !ids.has(edge.to) || seen.has(key)) return false;
        seen.add(key);
        return true;
      }),
    };
  }
  if (!isDAG(page)) throw new Error(`page contains dependency cycle: ${pageId}`);
  const hierarchy = validateTaskHierarchy(page.nodes);
  if (!hierarchy.valid) {
    throw new Error(`page contains invalid hierarchy (${hierarchy.reason}, task ${hierarchy.taskId}): ${pageId}`);
  }
  if (enforceTitleLimit) {
    const invalidParent = findCompletedParentWithIncompleteChild(page.nodes);
    if (invalidParent) {
      throw new Error(`completed parent has incomplete child: ${invalidParent.id}`);
    }
  }
  return page;
}

export function assertNoNodeOverlaps(page: PageData, pageId: string): void {
  const overlap = validateNoSiblingOverlaps(page.nodes);
  if (!overlap.valid) throw new NodeOverlapError(pageId, overlap.conflicts);
}

export function collectLegacyLongTaskTitles(data: unknown): Map<string, string> {
  const page = PageDataSchema.safeParse(data);
  if (!page.success) return new Map();
  return new Map(
    page.data.nodes
      .filter((node) => node.title.length > MAX_TASK_TITLE_LENGTH)
      .map((node) => [node.id, node.title]),
  );
}

export function assertPageTitleLength(title: string): void {
  if (title.length > MAX_PAGE_TITLE_LENGTH) {
    throw new Error(`page title exceeds ${MAX_PAGE_TITLE_LENGTH} characters`);
  }
}

export function isSafePageId(id: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(id) && id.length > 0 && id.length <= 64;
}

function valueDepth(value: unknown): number {
  let maxDepth = 0;
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  while (pending.length > 0) {
    const current = pending.pop()!;
    maxDepth = Math.max(maxDepth, current.depth);
    if (maxDepth > MAX_TASK_METADATA_DEPTH) return maxDepth;
    if (current.value === null || typeof current.value !== 'object') continue;
    const children = Array.isArray(current.value) ? current.value : Object.values(current.value);
    for (const child of children) pending.push({ value: child, depth: current.depth + 1 });
  }
  return maxDepth;
}
