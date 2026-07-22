import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { SYSTEM_HIERARCHY_PAGE_ID, type PageInfo } from '@todograph/shared';
import { MobilePageSelectorView } from '../src/components/PageBar';

const pages: PageInfo[] = [
  { id: 'backlog', title: 'Backlog', order: 2 },
  { id: 'today', title: 'Today', order: 1 },
  { id: 'later', title: 'Later', order: 3 },
  { id: SYSTEM_HIERARCHY_PAGE_ID, title: '清单', order: 0, kind: 'hierarchy' },
];

describe('MobilePageSelectorView', () => {
  it('renders pages as a polished mobile menu trigger instead of native select or draggable chips', () => {
    const html = renderToStaticMarkup(
      <MobilePageSelectorView
        pages={pages}
        activePageId="today"
        onSwitchPage={vi.fn()}
        onCreatePage={vi.fn()}
        isChecklistMode={false}
        onToggleMode={vi.fn()}
      />,
    );

    expect(html).toContain('aria-label="选择页面"');
    expect(html).toContain('data-mobile-page-trigger="true"');
    expect(html).toContain('data-selector-mode="page"');
    expect(html).toContain('max-w-[calc(100%-2.75rem)]');
    expect(html).not.toContain('min-w-0 flex-1 items-center');
    expect(html).toContain('bg-card');
    expect(html).toContain('border-border');
    expect(html).not.toContain('bg-[#17151a]');
    expect(html).toContain('Today');
    expect(html).not.toContain('<select');
    expect(html).not.toContain('draggable="true"');
    expect(html).toContain('data-workspace-mode-toggle="true"');
    expect(html).toContain('aria-label="切换到清单模式"');
    expect(html.indexOf('data-workspace-mode-toggle="true"')).toBeLessThan(
      html.indexOf('data-mobile-page-trigger="true"'),
    );
    expect(html).not.toContain('data-mobile-system-page="true"');
  });

  it('shows a green list-only selector immediately after the mode toggle', () => {
    const html = renderToStaticMarkup(
      <MobilePageSelectorView
        pages={pages}
        activePageId={SYSTEM_HIERARCHY_PAGE_ID}
        onSwitchPage={vi.fn()}
        onCreatePage={vi.fn()}
        isChecklistMode
        onToggleMode={vi.fn()}
      />,
    );

    expect(html).toContain('aria-label="切换到页面模式"');
    expect(html).toContain('data-mode="checklist"');
    expect(html).toContain('data-selector-mode="checklist"');
    expect(html).toContain('清单模式');
    expect(html).toContain('border-[hsl(var(--success)/0.55)]');
    expect(html.indexOf('data-workspace-mode-toggle="true"')).toBeLessThan(
      html.indexOf('data-mobile-page-trigger="true"'),
    );
    expect(html).toContain('data-mobile-page-controls="true"');
    expect(html).toContain('ml-auto');
  });
});
