import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { PageInfo } from '@todograph/shared';
import { MobilePageSelectorView } from '../src/components/PageBar';

const pages: PageInfo[] = [
  { id: 'backlog', title: 'Backlog', order: 2 },
  { id: 'today', title: 'Today', order: 1 },
  { id: 'later', title: 'Later', order: 3 },
];

describe('MobilePageSelectorView', () => {
  it('renders pages as a polished mobile menu trigger instead of native select or draggable chips', () => {
    const html = renderToStaticMarkup(
      <MobilePageSelectorView
        pages={pages}
        activePageId="today"
        onSwitchPage={vi.fn()}
        onCreatePage={vi.fn()}
      />,
    );

    expect(html).toContain('aria-label="选择页面"');
    expect(html).toContain('data-mobile-page-trigger="true"');
    expect(html).toContain('bg-card');
    expect(html).toContain('border-border');
    expect(html).not.toContain('bg-[#17151a]');
    expect(html).toContain('Today');
    expect(html).not.toContain('<select');
    expect(html).not.toContain('draggable="true"');
  });
});
