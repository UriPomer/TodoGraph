import { create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { LinkifiedText } from '@/components/LinkifiedText';

describe('LinkifiedText compact URLs', () => {
  it('shortens only the label while keeping a normally clickable complete URL', () => {
    const url = 'https://www.example.com/a/very/long/path';
    const view = create(<LinkifiedText text={`链接 ${url}`} compactUrls />);
    const link = view.root.findByType('a');
    const event = { stopPropagation: vi.fn() };

    expect(link.children).toEqual(['www.example...']);
    expect(link.props.className).toContain('whitespace-nowrap');
    expect(link.props.href).toBe(url);
    expect(link.props.target).toBe('_blank');
    expect(link.props.rel).toBe('noopener noreferrer');
    link.props.onClick(event);

    expect(event.stopPropagation).toHaveBeenCalledOnce();
  });

  it('keeps the complete label when compact mode is disabled', () => {
    const url = 'https://www.example.com/full';
    const view = create(<LinkifiedText text={url} />);
    const link = view.root.findByType('a');

    expect(link.children).toEqual([url]);
    expect(link.props.className).not.toContain('whitespace-nowrap');
  });
});
