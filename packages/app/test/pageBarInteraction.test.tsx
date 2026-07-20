import { act, create } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SYSTEM_HIERARCHY_PAGE_ID, type PageInfo } from '@todograph/shared';
import type { ReactNode } from 'react';
import { PageBar } from '../src/components/PageBar';
import { useWorkspaceStore } from '../src/stores/useWorkspaceStore';

vi.mock('../src/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuItem: ({ children, onSelect }: { children: ReactNode; onSelect?: () => void }) => (
    <button type="button" data-dropdown-item="true" onClick={onSelect}>{children}</button>
  ),
}));

const pages: PageInfo[] = [
  { id: SYSTEM_HIERARCHY_PAGE_ID, title: '清单', order: 0, kind: 'hierarchy' },
  { id: 'today', title: 'Today', order: 1 },
];

afterEach(() => {
  useWorkspaceStore.setState(useWorkspaceStore.getInitialState(), true);
});

function installDeferredSwitch() {
  let finishSwitch!: () => void;
  const switchFinished = new Promise<void>((resolve) => { finishSwitch = resolve; });
  const meta = { version: 2 as const, revision: 0, activePageId: SYSTEM_HIERARCHY_PAGE_ID, pages };
  useWorkspaceStore.setState({
    ...useWorkspaceStore.getInitialState(),
    meta,
    switchPage: async (pageId: string) => {
      await switchFinished;
      useWorkspaceStore.setState({ meta: { ...meta, activePageId: pageId } });
    },
  }, true);
  return { finishSwitch, switchFinished };
}

describe('PageBar mode switching', () => {
  it('reports graph mode only after the first toggle finishes switching pages', async () => {
    const deferred = installDeferredSwitch();
    const onModeChange = vi.fn();
    let renderer: ReturnType<typeof create>;

    await act(async () => { renderer = create(<PageBar onModeChange={onModeChange} />); });
    act(() => renderer.root.findAllByProps({ 'data-workspace-mode-toggle': 'true' })[0]!.props.onClick());
    expect(onModeChange).not.toHaveBeenCalled();

    await act(async () => { deferred.finishSwitch(); await deferred.switchFinished; });
    expect(onModeChange).toHaveBeenCalledWith('graph');
    act(() => renderer.unmount());
  });

  it('waits for a selected graph page before reporting graph mode', async () => {
    const deferred = installDeferredSwitch();
    const onModeChange = vi.fn();
    let renderer: ReturnType<typeof create>;

    await act(async () => { renderer = create(<PageBar onModeChange={onModeChange} />); });
    const today = renderer.root.findAllByProps({ 'data-dropdown-item': 'true' })[0]!;
    act(() => today.props.onClick());
    expect(onModeChange).not.toHaveBeenCalled();

    await act(async () => { deferred.finishSwitch(); await deferred.switchFinished; });
    expect(onModeChange).toHaveBeenCalledWith('graph');
    act(() => renderer.unmount());
  });
});
