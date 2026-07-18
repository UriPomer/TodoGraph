import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GroupContentsDialog } from '@/features/graph/GroupContentsDialog';

vi.mock('react-dom', () => ({ createPortal: (children: unknown) => children }));

describe('GroupContentsDialog', () => {
  let renderer!: ReactTestRenderer;
  let keydown: ((event: KeyboardEvent) => void) | undefined;

  beforeEach(() => {
    vi.stubGlobal('document', {
      body: { style: { overflow: '' } },
      activeElement: null,
      getElementById: () => null,
    });
    vi.stubGlobal('window', {
      addEventListener: (type: string, listener: (event: KeyboardEvent) => void) => {
        if (type === 'keydown') keydown = listener;
      },
      removeEventListener: () => {},
    });
    vi.stubGlobal('requestAnimationFrame', (callback: () => void) => {
      callback();
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});
  });

  afterEach(() => {
    act(() => renderer?.unmount());
    vi.unstubAllGlobals();
  });

  const renderDialog = (onClose: () => void, returnFocus = vi.fn()) => {
    act(() => {
      renderer = create(
        <GroupContentsDialog
          title="父节点"
          descendants={[{ id: 'child', title: '子节点', status: 'todo', depth: 1, width: 180, height: 56 }]}
          returnFocus={{ focus: returnFocus } as HTMLButtonElement}
          onClose={onClose}
        />,
      );
    });
    return returnFocus;
  };

  it('closes from the backdrop, close button, and Escape', () => {
    const onClose = vi.fn();
    renderDialog(onClose);
    const dialog = renderer.root.findByProps({ role: 'dialog' });
    const backdrop = dialog.parent!;

    act(() => backdrop.props.onClick({ target: backdrop, currentTarget: backdrop }));
    act(() => renderer.root.findByProps({ 'aria-label': '关闭' }).props.onClick());
    act(() => keydown?.({ key: 'Escape', preventDefault: vi.fn() } as unknown as KeyboardEvent));

    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('restores focus when unmounted', () => {
    const returnFocus = renderDialog(vi.fn());

    act(() => renderer.unmount());

    expect(returnFocus).toHaveBeenCalledOnce();
  });
});
