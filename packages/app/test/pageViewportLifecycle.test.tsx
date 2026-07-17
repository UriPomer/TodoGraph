import { act, create } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactFlowInstance, Viewport } from '@xyflow/react';
import {
  type PageViewportLifecycle,
  usePageViewportLifecycle,
} from '@/features/graph/usePageViewportLifecycle';
import type { PageViewportCache } from '@/features/graph/pageViewportCache';

let viewportLifecycle: PageViewportLifecycle | null = null;

function Harness({
  activePageId,
  cache,
  rf,
  viewportScope = 'desktop',
  minZoom = 0.5,
  withNode = false,
}: {
  activePageId: string;
  cache: PageViewportCache;
  rf: ReactFlowInstance;
  viewportScope?: 'desktop' | 'mobile';
  minZoom?: number;
  withNode?: boolean;
}) {
  viewportLifecycle = usePageViewportLifecycle({
    activePageId,
    renderedPageId: activePageId,
    viewportScope,
    minZoom,
    nodeIds: withNode ? ['node'] : [],
    renderedNodes: withNode ? [{ id: 'node', width: 180, height: 56 }] : [],
    cache,
    rf,
    getViewportDimensions: () => ({ width: 360, height: 700 }),
    updateViewportCenter: vi.fn(),
  });
  return null;
}

describe('page viewport lifecycle', () => {
  afterEach(() => {
    viewportLifecycle = null;
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
    const firstCache: PageViewportCache = new Map();
    const secondCache: PageViewportCache = new Map();

    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(<Harness activePageId="a" cache={firstCache} rf={rf} />);
    });
    await act(async () => {
      renderer.update(<Harness activePageId="b" cache={secondCache} rf={rf} />);
    });
    act(() => {
      viewportLifecycle?.onMoveEnd(null, { x: 20, y: 30, zoom: 1.2 });
    });

    expect(secondCache.get('b')?.desktop?.viewport).toEqual({ x: 20, y: 30, zoom: 1.2 });
    expect(firstCache.has('b')).toBe(false);

    await act(async () => finishOldRestore(true));
    act(() => renderer.unmount());
  });

  it('clamps a cached viewport to the graph zoom limit', async () => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());

    const cache: PageViewportCache = new Map([
      ['a', { desktop: {
        viewport: { x: 20, y: 30, zoom: 1.8 },
        dimensions: { width: 360, height: 700 },
      } }],
    ]);
    const setViewport = vi.fn(async () => true);
    const rf = {
      getViewport: () => ({ x: 0, y: 0, zoom: 1 }),
      setViewport,
    } as unknown as ReactFlowInstance;

    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(<Harness activePageId="a" cache={cache} rf={rf} />);
    });

    expect(setViewport).toHaveBeenCalledWith({ x: 20, y: 30, zoom: 1 });
    expect(viewportLifecycle?.isRestoring).toBe(false);
    act(() => renderer.unmount());
  });

  it('does not restore a desktop viewport into the mobile graph', async () => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());

    const cache: PageViewportCache = new Map([
      ['a', { desktop: {
        viewport: { x: 200, y: 100, zoom: 0.5 },
        dimensions: { width: 1200, height: 800 },
      } }],
    ]);
    const setViewport = vi.fn(async () => true);
    const fitView = vi.fn(async () => true);
    const rf = {
      getViewport: () => ({ x: 0, y: 0, zoom: 1 }),
      setViewport,
      fitView,
    } as unknown as ReactFlowInstance;

    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(
        <Harness
          activePageId="a"
          cache={cache}
          rf={rf}
          viewportScope="mobile"
          minZoom={0.1}
          withNode
        />,
      );
    });

    expect(fitView).toHaveBeenCalledWith({ padding: 0.3, minZoom: 0.1, maxZoom: 1 });
    expect(setViewport).not.toHaveBeenCalledWith({ x: 200, y: 100, zoom: 0.5 });
    act(() => renderer.unmount());
  });

  it('keeps a new page hidden until its relaxed fit view settles', async () => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());

    let currentViewport = { x: 0, y: 0, zoom: 1 };
    let finishSecondFit!: (success: boolean) => void;
    const secondFit = new Promise<boolean>((resolve) => { finishSecondFit = resolve; });
    const fitView = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(true)
      .mockImplementationOnce(() => secondFit);
    const rf = {
      getViewport: () => currentViewport,
      fitView,
    } as unknown as ReactFlowInstance;
    const cache: PageViewportCache = new Map();

    function FitHarness({
      activePageId,
      renderedPageId,
    }: {
      activePageId: string;
      renderedPageId: string;
    }) {
      viewportLifecycle = usePageViewportLifecycle({
        activePageId,
        renderedPageId,
        viewportScope: 'desktop',
        minZoom: 0.5,
        nodeIds: ['node'],
        renderedNodes: [{ id: 'node', width: 180, height: 56 }],
        cache,
        rf,
        getViewportDimensions: () => ({ width: 1200, height: 800 }),
        updateViewportCenter: vi.fn(),
      });
      return null;
    }

    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(<FitHarness activePageId="a" renderedPageId="a" />);
    });
    expect(viewportLifecycle?.isRestoring).toBe(false);

    await act(async () => {
      renderer.update(<FitHarness activePageId="b" renderedPageId="a" />);
    });
    expect(viewportLifecycle?.isRestoring).toBe(true);
    expect(fitView).toHaveBeenCalledTimes(1);

    await act(async () => {
      renderer.update(<FitHarness activePageId="b" renderedPageId="b" />);
    });
    expect(viewportLifecycle?.isRestoring).toBe(true);
    expect(fitView).toHaveBeenLastCalledWith({ padding: 0.3, minZoom: 0.5, maxZoom: 1 });

    currentViewport = { x: 30, y: 40, zoom: 0.9 };
    await act(async () => finishSecondFit(true));
    expect(viewportLifecycle?.isRestoring).toBe(false);

    act(() => renderer.unmount());
  });

  it('enters performance mode only for the active viewport gesture', async () => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());

    const cache: PageViewportCache = new Map();
    const updateViewportCenter = vi.fn();
    let currentViewport = { x: 0, y: 0, zoom: 1 };
    const rf = {
      getViewport: () => currentViewport,
      setViewport: vi.fn(async (viewport: Viewport) => {
        currentViewport = viewport;
        return true;
      }),
    } as unknown as ReactFlowInstance;

    function PerformanceHarness() {
      viewportLifecycle = usePageViewportLifecycle({
        activePageId: 'a',
        renderedPageId: 'a',
        viewportScope: 'desktop',
        minZoom: 0.5,
        nodeIds: [],
        renderedNodes: [],
        cache,
        rf,
        getViewportDimensions: () => ({ width: 1200, height: 800 }),
        updateViewportCenter,
      });
      return null;
    }

    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(<PerformanceHarness />);
    });
    act(() => {
      viewportLifecycle?.onMoveStart(null, currentViewport);
    });
    expect(viewportLifecycle?.isMoving).toBe(true);

    const settledViewport = { x: 40, y: 60, zoom: 1.1 };
    act(() => {
      viewportLifecycle?.onMoveEnd(null, settledViewport);
    });
    expect(viewportLifecycle?.isMoving).toBe(false);
    expect(cache.get('a')?.desktop?.viewport).toEqual(settledViewport);
    expect(updateViewportCenter).toHaveBeenCalled();

    act(() => renderer.unmount());
  });
});
