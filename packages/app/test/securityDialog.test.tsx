import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-dom', async () => {
  const actual = await vi.importActual<typeof import('react-dom')>('react-dom');
  return { ...actual, createPortal: (children: unknown) => children };
});

import { api } from '../src/api/client';
import { SecurityDialog } from '../src/features/security/SecurityDialog';
import { useTaskStore } from '../src/stores/useTaskStore';
import { useWorkspaceStore } from '../src/stores/useWorkspaceStore';

describe('SecurityDialog password change', () => {
  beforeEach(() => {
    useTaskStore.setState(useTaskStore.getInitialState(), true);
    useWorkspaceStore.setState(useWorkspaceStore.getInitialState(), true);
    vi.restoreAllMocks();
    vi.spyOn(api, 'listBackups').mockResolvedValue([]);
  });

  it('blocks mismatches, respects cancellation, and submits confirmed passwords', async () => {
    const changePassword = vi.spyOn(api, 'changePassword').mockResolvedValue();
    const confirm = vi.fn(() => false);
    vi.stubGlobal('window', { confirm });
    vi.stubGlobal('document', { body: {} });
    let renderer: ReturnType<typeof create>;

    await act(async () => {
      renderer = create(<SecurityDialog open onClose={vi.fn()} />);
    });
    const input = (placeholder: string) => renderer.root.findByProps({ placeholder });
    const submit = () => renderer.root.findAllByType('button').find(
      (button) => Array.isArray(button.props.children) && button.props.children.includes('更新密码'),
    )!;

    act(() => {
      input('当前密码').props.onChange({ target: { value: 'secret123' } });
      input('新密码，至少 8 位且包含字母和数字').props.onChange({ target: { value: 'newsecret123' } });
      input('再次输入新密码').props.onChange({ target: { value: 'different123' } });
    });
    expect(JSON.stringify(renderer.toJSON())).toContain('两次输入的新密码不一致');
    expect(changePassword).not.toHaveBeenCalled();

    act(() => input('再次输入新密码').props.onChange({ target: { value: 'newsecret123' } }));
    act(() => submit().props.onClick());
    expect(confirm).toHaveBeenCalledOnce();
    expect(changePassword).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    await act(async () => submit().props.onClick());
    expect(changePassword).toHaveBeenCalledWith('secret123', 'newsecret123');

    act(() => renderer.unmount());
    vi.unstubAllGlobals();
  });

  it('reserves consistent right-side space for the backup chevron', async () => {
    useTaskStore.setState({ activePageId: 'p-1' });
    vi.mocked(api.listBackups).mockResolvedValue([{
      name: '2026-07-10T16-29-05-000Z.json',
      createdAt: '2026-07-10T16:29:05.000Z',
      size: 8_400,
    }]);
    let renderer: ReturnType<typeof create>;

    await act(async () => { renderer = create(<SecurityDialog open embedded />); });

    const select = renderer.root.findByType('select');
    expect(select.props.className).toContain('appearance-none');
    expect(select.props.className).toContain('!pr-12');
    expect(JSON.stringify(renderer.toJSON())).toContain('right-4');
    act(() => renderer.unmount());
  });
});
