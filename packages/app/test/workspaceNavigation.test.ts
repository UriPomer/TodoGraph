import { describe, expect, it } from 'vitest';
import { SYSTEM_HIERARCHY_PAGE_ID, type Meta } from '@todograph/shared';
import {
  DEFAULT_PAGE_MODE_CONTEXT,
  rememberPageModeContext,
  resolvePageModeReturn,
  workspaceModeForPage,
} from '../src/features/workspace/workspaceNavigation';

const meta: Meta = {
  version: 2,
  revision: 0,
  activePageId: SYSTEM_HIERARCHY_PAGE_ID,
  pages: [
    { id: SYSTEM_HIERARCHY_PAGE_ID, title: '清单', order: 0, kind: 'hierarchy' },
    { id: 'a', title: 'A', order: 1 },
    { id: 'b', title: 'B', order: 2 },
  ],
};

describe('workspace navigation policy', () => {
  it('NAV-001/NAV-002 keeps the exact page and graph view across checklist mode', () => {
    const remembered = rememberPageModeContext(DEFAULT_PAGE_MODE_CONTEXT, 'b', 'graph');
    expect(resolvePageModeReturn(meta, remembered)).toEqual({ pageId: 'b', view: 'graph' });
  });

  it('NAV-002 falls back to the first page without losing the remembered view', () => {
    expect(resolvePageModeReturn(meta, { pageId: 'deleted', view: 'graph' })).toEqual({
      pageId: 'a', view: 'graph',
    });
  });

  it('NAV-003 does not overwrite page context while checklist data is active', () => {
    const context = { pageId: 'b', view: 'graph' } as const;
    expect(rememberPageModeContext(context, SYSTEM_HIERARCHY_PAGE_ID, 'list')).toBe(context);
    expect(workspaceModeForPage(SYSTEM_HIERARCHY_PAGE_ID)).toBe('checklist');
  });
});
