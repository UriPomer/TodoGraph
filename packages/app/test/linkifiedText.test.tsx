import { create } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LinkifiedText } from '@/components/LinkifiedText';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('LinkifiedText compact URLs', () => {
  it('shortens only the label and opens the complete URL with Ctrl+click', () => {
    const url = 'https://www.example.com/a/very/long/path';
    const open = vi.fn();
    vi.stubGlobal('window', { open });
    const view = create(<LinkifiedText text={`链接 ${url}`} compactUrls />);
    const link = view.root.findAllByType('span').find(
      (span) => typeof span.props.className === 'string' && span.props.className.includes('underline'),
    )!;
    const event = { ctrlKey: true, metaKey: false, stopPropagation: vi.fn() };

    expect(link.children).toEqual(['www.example...']);
    expect(link.props.className).toContain('whitespace-nowrap');
    link.props.onClick(event);

    expect(event.stopPropagation).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledWith(url, '_blank', 'noopener,noreferrer');
  });

  it('keeps the complete label when compact mode is disabled', () => {
    const url = 'https://www.example.com/full';
    const view = create(<LinkifiedText text={url} />);
    const link = view.root.findAllByType('span').find(
      (span) => typeof span.props.className === 'string' && span.props.className.includes('underline'),
    )!;

    expect(link.children).toEqual([url]);
    expect(link.props.className).not.toContain('whitespace-nowrap');
  });
});
