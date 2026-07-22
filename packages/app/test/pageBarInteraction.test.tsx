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
  const switchPage = vi.fn(async (pageId: string) => {
    await switchFinished;
    useWorkspaceStore.setState({ meta: { ...meta, activePageId: pageId } });
  });
  useWorkspaceStore.setState({
    ...useWorkspaceStore.getInitialState(),
    meta,
    pageModeContext: { pageId: 'today', view: 'graph' },
    switchPage,
  }, true);
  return { finishSwitch, switchFinished, switchPage };
}

function installImmediateSwitch(activePageId = 'today') {
  const switchPage = vi.fn(async (pageId: string) => {
    useWorkspaceStore.setState((state) => ({
      meta: state.meta ? { ...state.meta, activePageId: pageId } : state.meta,
    }));
  });
  useWorkspaceStore.setState({
    ...useWorkspaceStore.getInitialState(),
    meta: { version: 2, revision: 0, activePageId, pages },
    switchPage,
  }, true);
  return switchPage;
}

describe('PageBar mode switching', () => {
  it('NAV-006 ignores repeated clicks while restoring a remembered graph view', async () => {
    const deferred = installDeferredSwitch();
    const onModeChange = vi.fn();
    let renderer: ReturnType<typeof create>;

    await act(async () => { renderer = create(<PageBar mode="list" onModeChange={onModeChange} />); });
    const toggle = renderer.root.findAllByProps({ 'data-workspace-mode-toggle': 'true' })[0]!;
    act(() => { toggle.props.onClick(); toggle.props.onClick(); toggle.props.onClick(); });
    expect(deferred.switchPage).toHaveBeenCalledOnce();
    expect(onModeChange).not.toHaveBeenCalled();

    await act(async () => { deferred.finishSwitch(); await deferred.switchFinished; });
    expect(onModeChange).toHaveBeenCalledWith('graph');
    act(() => renderer.unmount());
  });

  it('NAV-001/NAV-002 restores graph after an actual page → checklist → page round trip', async () => {
    const switchPage = installImmediateSwitch();
    const onModeChange = vi.fn();
    let renderer: ReturnType<typeof create>;

    await act(async () => { renderer = create(<PageBar mode="graph" onModeChange={onModeChange} />); });
    await act(async () => {
      renderer.root.findAllByProps({ 'data-workspace-mode-toggle': 'true' })[0]!.props.onClick();
    });
    expect(switchPage).toHaveBeenLastCalledWith(SYSTEM_HIERARCHY_PAGE_ID);
    expect(onModeChange).toHaveBeenLastCalledWith('list');

    await act(async () => { renderer.update(<PageBar mode="list" onModeChange={onModeChange} />); });
    await act(async () => {
      renderer.root.findAllByProps({ 'data-workspace-mode-toggle': 'true' })[0]!.props.onClick();
    });

    expect(switchPage).toHaveBeenLastCalledWith('today');
    expect(onModeChange).toHaveBeenLastCalledWith('graph');
    act(() => renderer.unmount());
  });

  it('keeps the current tab when selecting another page', async () => {
    const deferred = installDeferredSwitch();
    const onModeChange = vi.fn();
    let renderer: ReturnType<typeof create>;

    await act(async () => { renderer = create(<PageBar mode="list" onModeChange={onModeChange} />); });
    const today = renderer.root.findAllByProps({ 'data-dropdown-item': 'true' })[0]!;
    act(() => today.props.onClick());
    expect(onModeChange).not.toHaveBeenCalled();

    await act(async () => { deferred.finishSwitch(); await deferred.switchFinished; });
    expect(onModeChange).not.toHaveBeenCalled();
    expect(renderer.root.findAllByProps({ 'data-workspace-mode-toggle': 'true' })[0]!.props['data-mode']).toBe('page');
    act(() => renderer.unmount());
  });

  it('returns from the hierarchy list to the workspace mode it left', async () => {
    const switchPage = installImmediateSwitch();
    const onModeChange = vi.fn();
    let renderer: ReturnType<typeof create>;

    await act(async () => { renderer = create(<PageBar mode="list" onModeChange={onModeChange} />); });
    await act(async () => {
      renderer.root.findAllByProps({ 'data-workspace-mode-toggle': 'true' })[0]!.props.onClick();
    });
    expect(switchPage).toHaveBeenLastCalledWith(SYSTEM_HIERARCHY_PAGE_ID);

    await act(async () => { renderer.update(<PageBar mode="list" onModeChange={onModeChange} />); });
    await act(async () => {
      renderer.root.findAllByProps({ 'data-workspace-mode-toggle': 'true' })[0]!.props.onClick();
    });

    expect(switchPage).toHaveBeenLastCalledWith('today');
    expect(onModeChange).toHaveBeenLastCalledWith('list');
    act(() => renderer.unmount());
  });
});
