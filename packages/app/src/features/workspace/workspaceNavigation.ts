import { SYSTEM_HIERARCHY_PAGE_ID, type Meta } from '@todograph/shared';

export type WorkspaceMode = 'checklist' | 'page';
export type WorkspaceView = 'list' | 'graph';

export interface PageModeContext {
  pageId: string | null;
  view: WorkspaceView;
}

export const DEFAULT_PAGE_MODE_CONTEXT: PageModeContext = { pageId: null, view: 'list' };

export function workspaceModeForPage(pageId: string | null | undefined): WorkspaceMode {
  return pageId === SYSTEM_HIERARCHY_PAGE_ID ? 'checklist' : 'page';
}

export function rememberPageModeContext(
  context: PageModeContext,
  pageId: string | null | undefined,
  view: WorkspaceView,
): PageModeContext {
  if (!pageId || workspaceModeForPage(pageId) === 'checklist') return context;
  if (context.pageId === pageId && context.view === view) return context;
  return { pageId, view };
}

export function resolvePageModeReturn(meta: Meta, context: PageModeContext): PageModeContext | null {
  const pages = meta.pages
    .filter((page) => page.id !== SYSTEM_HIERARCHY_PAGE_ID)
    .sort((a, b) => a.order - b.order);
  const page = pages.find((candidate) => candidate.id === context.pageId) ?? pages[0];
  return page ? { pageId: page.id, view: context.view } : null;
}
