import { z } from 'zod';
import {
  MetaSchema, PageDataSchema, SYSTEM_HIERARCHY_PAGE_ID, SYSTEM_HIERARCHY_PAGE_TITLE,
  MAX_PAGE_TITLE_LENGTH, MAX_TASK_TITLE_LENGTH,
  assertProductPageCapacity, assertProductPageEditable, validateDependencyEdges,
  validateTaskHierarchy, type Meta, type PageData,
} from '@todograph/shared';
import { isDAG } from '@todograph/core';
import { deviceTransaction } from './deviceDatabase';

export const WorkspaceSnapshotSchema = z.object({
  exportedAt: z.string(), meta: MetaSchema, pages: z.record(PageDataSchema),
});
export type WorkspaceSnapshot = z.infer<typeof WorkspaceSnapshotSchema>;
export interface LocalRecord {
  meta: Meta;
  pages: Record<string, PageData>;
  backups: Record<string, Array<{ name: string; createdAt: string; data: PageData }>>;
  trash: Array<{ name: string; deletedAt: string; page: Meta['pages'][number]; data: PageData }>;
  history: WorkspaceSnapshot[];
  change: number;
}

export function emptyLocalWorkspace(): LocalRecord {
  const createdAt = new Date().toISOString();
  return {
    meta: { version: 2, revision: 0, activePageId: 'local-page', pages: [
      { id: SYSTEM_HIERARCHY_PAGE_ID, title: SYSTEM_HIERARCHY_PAGE_TITLE, order: 0, createdAt, kind: 'hierarchy' },
      { id: 'local-page', title: '我的页面', order: 1, createdAt, kind: 'graph' },
    ] },
    pages: { [SYSTEM_HIERARCHY_PAGE_ID]: { version: 0, nodes: [], edges: [] }, 'local-page': { version: 0, nodes: [], edges: [] } },
    backups: {}, trash: [], history: [], change: 0,
  };
}

export function validateLocalPage(value: unknown, hierarchy = false): PageData {
  const data = PageDataSchema.parse(value);
  if (data.nodes.length > 10_000 || data.edges.length > 50_000) throw new Error('页面任务或依赖数量超出上限');
  if (data.nodes.some(task => task.title.length > MAX_TASK_TITLE_LENGTH)) throw new Error('任务标题过长');
  if (!validateTaskHierarchy(data.nodes).valid || !validateDependencyEdges(data.nodes, data.edges).valid || !isDAG(data)) {
    throw new Error('任务层级或依赖关系无效');
  }
  if (hierarchy && data.edges.length) throw new Error('清单不支持依赖关系');
  return data;
}

export function validateSnapshot(value: unknown): WorkspaceSnapshot {
  const snapshot = WorkspaceSnapshotSchema.parse(value);
  const { meta, pages } = snapshot;
  const ids = new Set(meta.pages.map(page => page.id));
  if (ids.size !== meta.pages.length || !ids.has(meta.activePageId)
    || !ids.has(SYSTEM_HIERARCHY_PAGE_ID) || meta.pages.length < 2 || meta.pages.length > 500
    || Object.keys(pages).length !== ids.size) throw new Error('工作区页面结构无效');
  for (const page of meta.pages) {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(page.id) || ['__proto__', 'constructor', 'prototype'].includes(page.id)) throw new Error('页面标识无效');
    if (page.title.length > MAX_PAGE_TITLE_LENGTH || (page.id !== SYSTEM_HIERARCHY_PAGE_ID && page.kind === 'hierarchy')) throw new Error('工作区页面类型或标题无效');
    if (!Object.hasOwn(pages, page.id)) throw new Error('工作区缺少页面数据');
    pages[page.id] = validateLocalPage(pages[page.id], page.id === SYSTEM_HIERARCHY_PAGE_ID);
    if (page.id === SYSTEM_HIERARCHY_PAGE_ID) page.kind = 'hierarchy';
  }
  if (new Blob([JSON.stringify(snapshot)]).size > 20 * 1024 * 1024) throw new Error('工作区超出 20 MB 上限');
  return snapshot;
}

export function exportLocalRecord(record: LocalRecord): WorkspaceSnapshot {
  return structuredClone({ exportedAt: new Date().toISOString(), meta: record.meta, pages: record.pages });
}

export function retainLocalRecovery(record: LocalRecord) {
  record.history.unshift(exportLocalRecord(record));
  let bytes = 0;
  record.history = record.history.slice(0, 5).filter((snapshot, index) => {
    bytes += new Blob([JSON.stringify(snapshot)]).size;
    return index === 0 || bytes <= 32 * 1024 * 1024;
  });
}

export async function localTransaction<R>(operation: (record: LocalRecord) => R, write = true): Promise<R> {
  const result = await deviceTransaction('workspace', emptyLocalWorkspace, record => {
    const result = operation(record);
    if (write) {
      if (new Blob([JSON.stringify(record)]).size > 64 * 1024 * 1024) throw new Error('本地工作区与恢复点超出 64 MB，请导出并清理旧数据');
      record.change += 1;
    }
    return structuredClone(result);
  }, write);
  if (write) window.dispatchEvent(new Event('todograph-local-change'));
  return result;
}

export function assertLocalVersion(actual: number, expected: unknown, kind: 'page' | 'meta') {
  if (expected !== undefined && expected !== actual) throw Object.assign(new Error('另一窗口已修改此数据，请重新加载'), {
    status: 409, ...(kind === 'page' ? { serverVersion: actual } : { serverRevision: actual }),
  });
}

export { assertProductPageCapacity, assertProductPageEditable };
