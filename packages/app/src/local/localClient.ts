import { ProductAccessError, SYSTEM_HIERARCHY_PAGE_ID, MAX_PAGE_TITLE_LENGTH } from '@todograph/shared';
import { planWorkspaceMove, scoreRecommendations } from '@todograph/core';
import { getLocalEntitlements } from '@/platform/workspaceRuntime';
import {
  localTransaction, assertLocalVersion, assertProductPageCapacity, assertProductPageEditable,
  validateLocalPage, validateSnapshot, exportLocalRecord, retainLocalRecovery, type LocalRecord,
} from './localWorkspace';

function title(value: unknown): string {
  if (typeof value !== 'string' || value.length > MAX_PAGE_TITLE_LENGTH) throw new Error('页面名称无效');
  return value.trim() || '新页面';
}
const bump = (record: LocalRecord) => { record.meta.revision += 1; return record.meta; };
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomUUID().slice(0, 8) + '.json';
const size = (data: unknown) => new Blob([JSON.stringify(data)]).size;
function backup(record: LocalRecord, id: string) {
  const entries = record.backups[id] ?? [];
  entries.unshift({ name: stamp(), createdAt: new Date().toISOString(), data: structuredClone(record.pages[id]!) });
  let bytes = 0;
  record.backups[id] = entries.slice(0, 20).filter((entry, index) => { bytes += size(entry.data); return index === 0 || bytes <= 8 * 1024 * 1024; });
}

/** Local persistence adapter for the existing API boundary; performs no HTTP requests. */
export async function localRequest(path: string, init?: RequestInit): Promise<Response> {
  const method = init?.method ?? 'GET';
  if (init?.signal?.aborted) throw new DOMException('已取消', 'AbortError');
  try {
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {};
    const plan = getLocalEntitlements().plan;
    const result = await localTransaction(record => {
      const { meta, pages } = record;
      if (path === '/api/entitlements') return getLocalEntitlements();
      if (path === '/api/meta') return meta;
      if (path === '/api/workspace/export.json') return exportLocalRecord(record);
      if (path === '/api/workspace/recovery') return { snapshots: record.history };
      if (path === '/api/workspace/import') {
        const snapshot = validateSnapshot(body);
        assertProductPageCapacity(snapshot.meta, plan, 0);
        retainLocalRecovery(record);
        record.meta = { ...snapshot.meta, revision: meta.revision + 1 };
        record.pages = Object.fromEntries(Object.entries(snapshot.pages).map(([id, data]) => [id, { ...data, version: (pages[id]?.version ?? 0) + 1 }]));
        return { ok: true, meta: record.meta };
      }
      if (path === '/api/all-tasks') return { tasks: meta.pages.flatMap(info => {
        const page = pages[info.id]!;
        const scores = new Map(scoreRecommendations(page).map(item => [item.task.id, item.downstreamCount]));
        return page.nodes.map(node => ({ ...node, _pageId: info.id, _pageTitle: info.title, _ready: scores.has(node.id), ...(scores.has(node.id) ? { _downstream: scores.get(node.id) } : {}) }));
      }) };
      if (path === '/api/workspace/markdown') return meta.pages.map(info =>
        `# ${info.title}\n\n${pages[info.id]!.nodes.map(node => `${'  '.repeat(node.parentId ? 1 : 0)}- [${node.status === 'done' ? 'x' : ' '}] ${node.title}${node.description ? '\n  ' + node.description : ''}`).join('\n')}`,
      ).join('\n\n');
      if (path === '/api/pages' && method === 'POST') {
        assertLocalVersion(meta.revision, body.expectedRevision, 'meta');
        assertProductPageCapacity(meta, plan);
        const page = { id: crypto.randomUUID(), title: title(body.title), order: Math.max(...meta.pages.map(info => info.order)) + 1, createdAt: new Date().toISOString(), kind: 'graph' as const };
        pages[page.id] = { version: 0, nodes: [], edges: [] };
        meta.pages.push(page);
        return { page, meta: bump(record) };
      }
      if (path === '/api/pages/reorder') {
        assertLocalVersion(meta.revision, body.expectedRevision, 'meta');
        const ids = body.ids as string[];
        if (!Array.isArray(ids) || ids.length !== meta.pages.length || new Set(ids).size !== ids.length || ids.some(id => !pages[id])) throw new Error('页面排序无效');
        meta.pages = [SYSTEM_HIERARCHY_PAGE_ID, ...ids.filter(id => id !== SYSTEM_HIERARCHY_PAGE_ID)].map((id, order) => ({ ...meta.pages.find(info => info.id === id)!, order }));
        return { ok: true, meta: bump(record) };
      }
      if (path === '/api/trash/pages') return { pages: record.trash.map(({ data, ...entry }) => ({ ...entry, size: size(data) })) };
      const trashMatch = path.match(/^\/api\/trash\/pages\/([^/]+)\/restore$/);
      if (trashMatch) {
        assertLocalVersion(meta.revision, body.expectedRevision, 'meta');
        assertProductPageCapacity(meta, plan);
        const entry = record.trash.find(item => item.name === decodeURIComponent(trashMatch[1]!));
        if (!entry || pages[entry.page.id]) throw new Error('恢复页面不存在或已经恢复');
        retainLocalRecovery(record);
        const page = { ...entry.page, order: Math.max(...meta.pages.map(info => info.order)) + 1 };
        pages[page.id] = { ...entry.data, version: (entry.data.version ?? 0) + 1 };
        meta.pages.push(page);
        record.trash = record.trash.filter(item => item !== entry);
        return { ok: true, page, data: pages[page.id], meta: bump(record) };
      }
      const match = path.match(/^\/api\/pages\/([^/]+)(?:\/(.+))?$/);
      if (!match) throw new Error('此功能需要服务器账号；本地工作区支持任务、页面和备份');
      const id = decodeURIComponent(match[1]!);
      const action = match[2];
      const data = pages[id];
      if (!data) throw Object.assign(new Error('页面不存在'), { status: 404 });
      if (!action && method === 'GET') return data;
      if (action === 'backups') return { backups: (record.backups[id] ?? []).map(entry => ({ name: entry.name, createdAt: entry.createdAt, size: size(entry.data) })) };
      if (action === 'backup') { backup(record, id); return { ok: true }; }
      if (action === 'restore') {
        assertProductPageEditable(meta, id, plan);
        assertLocalVersion(data.version ?? 0, body.expectedVersion, 'page');
        const entry = (record.backups[id] ?? []).find(item => !body.backupName || item.name === body.backupName);
        if (!entry) throw new Error('没有可用备份');
        const restored = validateLocalPage(entry.data, id === SYSTEM_HIERARCHY_PAGE_ID);
        backup(record, id);
        pages[id] = { ...restored, version: (data.version ?? 0) + 1 };
        return { ok: true, data: pages[id] };
      }
      if (!action && method === 'PUT') {
        assertProductPageEditable(meta, id, plan);
        assertLocalVersion(data.version ?? 0, body.expectedVersion, 'page');
        pages[id] = { ...validateLocalPage(body, id === SYSTEM_HIERARCHY_PAGE_ID), version: (data.version ?? 0) + 1 };
        return { ok: true, version: pages[id]!.version };
      }
      if (action === 'move-nodes' || action === 'merge') {
        const targetId = body.targetPageId as string;
        if (id === targetId || !pages[targetId] || (action === 'merge' && id === SYSTEM_HIERARCHY_PAGE_ID)) throw new Error('移动目标无效');
        assertProductPageEditable(meta, id, plan);
        assertProductPageEditable(meta, targetId, plan);
        assertLocalVersion(data.version ?? 0, body.expectedSourceVersion, 'page');
        assertLocalVersion(pages[targetId]!.version ?? 0, body.expectedTargetVersion, 'page');
        const move = planWorkspaceMove(data, pages[targetId]!, action === 'merge' ? data.nodes.map(node => node.id) : body.nodeIds as string[], targetId !== SYSTEM_HIERARCHY_PAGE_ID);
        validateLocalPage(move.source, id === SYSTEM_HIERARCHY_PAGE_ID);
        validateLocalPage(move.target, targetId === SYSTEM_HIERARCHY_PAGE_ID);
        retainLocalRecovery(record);
        pages[id] = { ...move.source, version: (data.version ?? 0) + 1 };
        pages[targetId] = { ...move.target, version: (pages[targetId]!.version ?? 0) + 1 };
        if (action === 'merge') {
          delete pages[id]; meta.pages = meta.pages.filter(info => info.id !== id);
          if (meta.activePageId === id) meta.activePageId = targetId;
          bump(record);
        }
        return move.result;
      }
      assertLocalVersion(meta.revision, body.expectedRevision, 'meta');
      if (!action && method === 'PATCH') {
        if (body.title !== undefined) { assertProductPageEditable(meta, id, plan); meta.pages.find(info => info.id === id)!.title = title(body.title); }
        if (body.activate) meta.activePageId = id;
        return { ok: true, meta: bump(record) };
      }
      if (!action && method === 'DELETE') {
        if (id === SYSTEM_HIERARCHY_PAGE_ID || meta.pages.filter(info => info.id !== SYSTEM_HIERARCHY_PAGE_ID).length <= 1) throw new Error('不能删除清单或最后一个页面');
        record.trash.unshift({ name: stamp(), deletedAt: new Date().toISOString(), page: meta.pages.find(info => info.id === id)!, data });
        let bytes = 0;
        record.trash = record.trash.slice(0, 50).filter((entry, index) => { bytes += size(entry); return index === 0 || bytes <= 16 * 1024 * 1024; });
        delete pages[id]; delete record.backups[id];
        meta.pages = meta.pages.filter(info => info.id !== id);
        if (meta.activePageId === id) meta.activePageId = meta.pages.find(info => info.id !== SYSTEM_HIERARCHY_PAGE_ID)!.id;
        return { ok: true, meta: bump(record) };
      }
      throw new Error('本地工作区不支持此操作');
    }, method !== 'GET');
    if (path.endsWith('/markdown')) return new Response(result as string, { headers: { 'Content-Type': 'text/plain' } });
    return Response.json(result);
  } catch (error) {
    const detail = error as Error & { status?: number; serverVersion?: number; serverRevision?: number };
    return Response.json({ ok: false, error: detail.message, ...(error instanceof ProductAccessError ? { code: error.code } : {}), serverVersion: detail.serverVersion, serverRevision: detail.serverRevision }, { status: error instanceof ProductAccessError ? 403 : detail.status ?? 400 });
  }
}
