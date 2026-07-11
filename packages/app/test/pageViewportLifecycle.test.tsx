import { act, create } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OnMove, ReactFlowInstance, Viewport } from '@xyflow/react';
import { usePageViewportLifecycle } from '@/features/graph/usePageViewportLifecycle';

let onMove: OnMove | null = null;

function Harness({
  activePageId,
  cache,
  rf,
}: {
  activePageId: string;
  cache: Map<string, Viewport>;
  rf: ReactFlowInstance;
}) {
  onMove = usePageViewportLifecycle({
    activePageId,
    nodeIds: [],
    renderedNodes: [],
    cache,
    rf,
    updateViewportCenter: vi.fn(),
  });
  return null;
}

describe('page viewport lifecycle', () => {
  afterEach(() => {
    onMove = null;
    vi.unstubAllGlobals();
  });

  it('rebinds the controller when the session cache identity changes', async () => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());

    let currentViewport = { x: 0, y: 0, zoom: 1 };
    let finishOldRestore!: (success: boolean) => void;
    const oldRestore = new Promise<boolean>((resolve) => { finishOldRestore = resolve; });
    const setViewport = vi
      .fn<(viewport: Viewport) => Promise<boolean>>()
      .mockImplementationOnce(() => oldRestore)
      .mockImplementation(async (viewport) => {
        currentViewport = viewport;
        return true;
      });
    const rf = {
      getViewport: () => currentViewport,
      setViewport,
    } as unknown as ReactFlowInstance;
    const firstCache = new Map<string, Viewport>();
    const secondCache = new Map<string, Viewport>();

    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(<Harness activePageId="a" cache={firstCache} rf={rf} />);
    });
    await act(async () => {
      renderer.update(<Harness activePageId="b" cache={secondCache} rf={rf} />);
    });
    act(() => {
      onMove?.(null, { x: 20, y: 30, zoom: 1.2 });
    });

    expect(secondCache.get('b')).toEqual({ x: 20, y: 30, zoom: 1.2 });
    expect(firstCache.has('b')).toBe(false);

    await act(async () => finishOldRestore(true));
    act(() => renderer.unmount());
  });
});
