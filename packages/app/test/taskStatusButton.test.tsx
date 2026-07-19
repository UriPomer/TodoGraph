import { create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { TaskStatusButton } from '@/features/graph/TaskStatusButton';

describe('TaskStatusButton', () => {
  it('keeps the normal 14px indicator inside an expanded touch target', () => {
    const compact = create(<TaskStatusButton status="done" onClick={vi.fn()} />);
    const touchFriendly = create(
      <TaskStatusButton status="done" touchTarget onClick={vi.fn()} />,
    );

    expect(compact.root.findByType('button').props.className).toContain('h-[14px] w-[14px]');
    expect(touchFriendly.root.findByType('button').props.className).toContain('h-11 w-11');

    const compactIndicator = compact.root.findAllByType('span')[0];
    const touchIndicator = touchFriendly.root.findAllByType('span')[0];
    expect(compactIndicator.props.className).toBe(touchIndicator.props.className);
    expect(touchIndicator.props.className).toContain('h-[14px] w-[14px]');
  });
});
