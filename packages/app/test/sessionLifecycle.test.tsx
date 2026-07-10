import { act, create } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  auth: {
    user: null as { id: string; username: string } | null,
    loading: true,
    login: vi.fn(),
    register: vi.fn(),
    logout: vi.fn(),
  },
  workspace: {
    sessionUserId: null as string | null,
    loaded: false,
    bootstrap: vi.fn(),
    resetSession: vi.fn(),
  },
}));

vi.mock('@/features/auth/useAuth', () => ({ useAuth: () => mocks.auth }));
vi.mock('@/stores/useWorkspaceStore', () => ({
  useWorkspaceStore: (selector: (state: typeof mocks.workspace) => unknown) =>
    selector(mocks.workspace),
}));

import App from '../src/App';

describe('App session lifecycle', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    mocks.auth.user = null;
    mocks.auth.loading = true;
    mocks.workspace.sessionUserId = null;
    mocks.workspace.loaded = false;
  });

  it('does not invalidate the initial authentication request before it completes', () => {
    const eventTarget = { addEventListener: vi.fn(), removeEventListener: vi.fn() };
    vi.stubGlobal('window', eventTarget);
    vi.stubGlobal('document', {
      ...eventTarget,
      documentElement: { style: { setProperty: vi.fn() } },
    });

    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(<App />);
    });
    expect(mocks.workspace.resetSession).not.toHaveBeenCalled();

    act(() => {
      mocks.auth.loading = false;
      renderer.update(<App />);
    });
    expect(mocks.workspace.resetSession).not.toHaveBeenCalled();

    act(() => {
      mocks.workspace.sessionUserId = 'u1';
      renderer.update(<App />);
    });
    expect(mocks.workspace.resetSession).toHaveBeenCalledOnce();

    act(() => renderer.unmount());
  });
});
