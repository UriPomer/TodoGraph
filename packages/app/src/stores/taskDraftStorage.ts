import { PageDataSchema, type Edge, type Task } from '@todograph/shared';

const LEGACY_STORAGE_KEY = 'todograph.task-drafts.v1';
const STORAGE_PREFIX = 'todograph.task-draft.v1:';

export interface TaskDraft {
  ownerId: string;
  pageId: string;
  baseVersion: number;
  nodes: Task[];
  edges: Edge[];
  savedAt: string;
}

function draftKey(ownerId: string, pageId: string): string {
  return `${STORAGE_PREFIX}${encodeURIComponent(ownerId)}:${encodeURIComponent(pageId)}`;
}

function parseDraft(raw: string | null, ownerId?: string, pageId?: string): TaskDraft | null {
  if (!raw) return null;
  try {
    const draft = JSON.parse(raw) as TaskDraft;
    if (!draft || draft.ownerId !== (ownerId ?? draft.ownerId) || draft.pageId !== (pageId ?? draft.pageId)) {
      return null;
    }
    const page = PageDataSchema.safeParse({
      version: draft.baseVersion,
      nodes: draft.nodes,
      edges: draft.edges,
    });
    return page.success ? { ...draft, nodes: page.data.nodes, edges: page.data.edges } : null;
  } catch {
    return null;
  }
}

function readLegacyDraft(ownerId: string, pageId: string): TaskDraft | null {
  try {
    const record = JSON.parse(localStorage.getItem(LEGACY_STORAGE_KEY) ?? '{}') as Record<string, TaskDraft>;
    return parseDraft(JSON.stringify(record[`${ownerId}:${pageId}`] ?? null), ownerId, pageId);
  } catch {
    return null;
  }
}

function clearLegacyDraft(ownerId: string, pageId: string): void {
  try {
    const record = JSON.parse(localStorage.getItem(LEGACY_STORAGE_KEY) ?? '{}') as Record<string, TaskDraft>;
    delete record[`${ownerId}:${pageId}`];
    if (Object.keys(record).length === 0) localStorage.removeItem(LEGACY_STORAGE_KEY);
    else localStorage.setItem(LEGACY_STORAGE_KEY, JSON.stringify(record));
  } catch {
    // A corrupt legacy record is ignored by reads and must not block current draft cleanup.
  }
}

export function saveTaskDraft(
  ownerId: string,
  pageId: string,
  baseVersion: number,
  nodes: Task[],
  edges: Edge[],
): TaskDraft | null {
  const draft: TaskDraft = {
    ownerId,
    pageId,
    baseVersion,
    nodes,
    edges,
    savedAt: new Date().toISOString(),
  };
  try {
    localStorage.setItem(draftKey(ownerId, pageId), JSON.stringify(draft));
    return draft;
  } catch {
    return null;
  }
}

export function loadTaskDraft(ownerId: string, pageId: string): TaskDraft | null {
  if (typeof localStorage === 'undefined') return null;
  return parseDraft(localStorage.getItem(draftKey(ownerId, pageId)), ownerId, pageId)
    ?? readLegacyDraft(ownerId, pageId);
}

export function listTaskDrafts(ownerId: string): TaskDraft[] {
  if (typeof localStorage === 'undefined') return [];
  const drafts = new Map<string, TaskDraft>();
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (!key?.startsWith(STORAGE_PREFIX)) continue;
    const draft = parseDraft(localStorage.getItem(key));
    if (draft?.ownerId === ownerId) drafts.set(draft.pageId, draft);
  }
  try {
    const legacy = JSON.parse(localStorage.getItem(LEGACY_STORAGE_KEY) ?? '{}') as Record<string, TaskDraft>;
    for (const candidate of Object.values(legacy)) {
      const draft = parseDraft(JSON.stringify(candidate));
      if (draft?.ownerId === ownerId && !drafts.has(draft.pageId)) drafts.set(draft.pageId, draft);
    }
  } catch {
    // Corrupt legacy storage is ignored; current per-page drafts remain available.
  }
  return [...drafts.values()].sort((a, b) => b.savedAt.localeCompare(a.savedAt));
}

export function clearTaskDraftIfMatching(ownerId: string, draft: TaskDraft): void {
  if (typeof localStorage === 'undefined') return;
  const key = draftKey(ownerId, draft.pageId);
  const current = loadTaskDraft(ownerId, draft.pageId);
  if (!current || JSON.stringify(current) !== JSON.stringify(draft)) return;
  localStorage.removeItem(key);
  clearLegacyDraft(ownerId, draft.pageId);
}

export function clearTaskDraft(ownerId: string, pageId: string): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.removeItem(draftKey(ownerId, pageId));
  clearLegacyDraft(ownerId, pageId);
}
