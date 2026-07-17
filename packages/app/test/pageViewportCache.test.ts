import { describe, expect, it } from 'vitest';
import {
  arePageViewportNodesReady,
  areViewportDimensionsCompatible,
  type PageViewportCache,
  PageViewportController,
  recallPageViewport,
  rememberPageViewport,
} from '@/features/graph/pageViewportCache';

const dimensions = { width: 1000, height: 700 };

describe('page viewport LRU cache', () => {
  it('stores and restores a page viewport', () => {
    const cache: PageViewportCache = new Map();
    rememberPageViewport(cache, 'a', 'desktop', { x: 10, y: 20, zoom: 1.5 }, dimensions);
    expect(recallPageViewport(cache, 'a', 'desktop')).toEqual({
      viewport: { x: 10, y: 20, zoom: 1.5 },
      dimensions,
    });
  });

  it('refreshes page recency when a viewport is recalled', () => {
    const cache: PageViewportCache = new Map();
    rememberPageViewport(cache, 'a', 'desktop', { x: 1, y: 1, zoom: 1 }, dimensions, 2);
    rememberPageViewport(cache, 'b', 'desktop', { x: 2, y: 2, zoom: 1 }, dimensions, 2);
    recallPageViewport(cache, 'a', 'desktop');
    rememberPageViewport(cache, 'c', 'desktop', { x: 3, y: 3, zoom: 1 }, dimensions, 2);
    expect(cache.has('a')).toBe(true);
    expect(cache.has('b')).toBe(false);
  });

  it('stores both layouts without consuming another page slot', () => {
    const cache: PageViewportCache = new Map();
    rememberPageViewport(cache, 'a', 'desktop', { x: 1, y: 2, zoom: 1 }, dimensions);
    rememberPageViewport(cache, 'a', 'mobile', { x: 3, y: 4, zoom: 0.2 }, dimensions);
    expect(cache.size).toBe(1);
    expect(recallPageViewport(cache, 'a', 'desktop')?.viewport).toEqual({ x: 1, y: 2, zoom: 1 });
    expect(recallPageViewport(cache, 'a', 'mobile')?.viewport).toEqual({ x: 3, y: 4, zoom: 0.2 });
  });

  it('accepts small size changes but rejects materially different canvases', () => {
    expect(areViewportDimensionsCompatible(dimensions, { width: 1100, height: 650 })).toBe(true);
    expect(areViewportDimensionsCompatible({ width: 1100, height: 650 }, dimensions)).toBe(true);
    expect(areViewportDimensionsCompatible(dimensions, { width: 700, height: 1000 })).toBe(false);
  });
});

describe('page viewport switching', () => {
  it('ignores delayed move events until the new page owns the viewport', () => {
    const controller = new PageViewportController('a');
    const initial = controller.beginRestore('a')!;
    controller.completeRestore(initial, true, { x: 0, y: 0, zoom: 1 });
    controller.switchTo('b', { x: 10, y: 20, zoom: 1 });
    controller.recordMove({ x: 999, y: 999, zoom: 3 });
    const next = controller.beginRestore('b')!;
    expect(next.cachedViewport).toBeUndefined();
    controller.completeRestore(next, true, { x: 0, y: 0, zoom: 1 });

    controller.switchTo('a', { x: 30, y: 40, zoom: 2 });
    expect(controller.beginRestore('a')?.cachedViewport).toEqual({ x: 10, y: 20, zoom: 1 });
  });

  it('keeps a page pending when restoration fails', () => {
    const controller = new PageViewportController('a');
    const token = controller.beginRestore('a')!;
    expect(controller.completeRestore(token, false, { x: 0, y: 0, zoom: 1 })).toBe('retry');
    expect(controller.shouldRestore('a')).toBe(true);
  });

  it('keeps only the latest target during rapid page switches', () => {
    const controller = new PageViewportController('a');
    controller.switchTo('b', { x: 0, y: 0, zoom: 1 });
    controller.switchTo('c', { x: 0, y: 0, zoom: 1 });
    expect(controller.shouldRestore('b')).toBe(false);
    expect(controller.shouldRestore('c')).toBe(true);
  });

  it('restores cached pages after the graph controller is remounted', () => {
    const sessionCache: PageViewportCache = new Map();
    const firstMount = new PageViewportController('a', sessionCache);
    const token = firstMount.beginRestore('a')!;
    firstMount.completeRestore(token, true, { x: 0, y: 0, zoom: 1 });
    firstMount.recordMove({ x: 70, y: 80, zoom: 1.4 });

    const secondMount = new PageViewportController('a', sessionCache);
    expect(secondMount.beginRestore('a')?.cachedViewport).toEqual({ x: 70, y: 80, zoom: 1.4 });
  });

  it('discards a cached viewport after a material canvas resize', () => {
    const sessionCache: PageViewportCache = new Map();
    const firstMount = new PageViewportController(
      'a',
      sessionCache,
      'mobile',
      () => ({ width: 360, height: 700 }),
    );
    const token = firstMount.beginRestore('a')!;
    firstMount.completeRestore(token, true, { x: 0, y: 0, zoom: 1 });
    firstMount.recordMove({ x: 70, y: 80, zoom: 0.4 });

    const rotatedMount = new PageViewportController(
      'a',
      sessionCache,
      'mobile',
      () => ({ width: 700, height: 360 }),
    );
    const rotatedToken = rotatedMount.beginRestore('a')!;
    expect(rotatedToken.cachedViewport).toBeUndefined();
    rotatedMount.completeRestore(rotatedToken, true, { x: 10, y: 20, zoom: 0.2 });

    const nextMount = new PageViewportController(
      'a',
      sessionCache,
      'mobile',
      () => ({ width: 700, height: 360 }),
    );
    expect(nextMount.beginRestore('a')?.cachedViewport).toEqual({ x: 10, y: 20, zoom: 0.2 });
  });

  it('serializes restores and rejects completion from an old page', () => {
    const controller = new PageViewportController('a');
    const oldToken = controller.beginRestore('a')!;
    controller.switchTo('b', { x: 1, y: 2, zoom: 1 });

    expect(controller.shouldRestore('b')).toBe(false);
    expect(controller.completeRestore(oldToken, true, { x: 99, y: 99, zoom: 3 })).toBe('stale');
    expect(controller.shouldRestore('b')).toBe(true);

    const currentToken = controller.beginRestore('b')!;
    expect(controller.completeRestore(currentToken, true, { x: 3, y: 4, zoom: 1 })).toBe('settled');
  });

  it('does not carry failed attempts from a stale restoration to the latest page', () => {
    const controller = new PageViewportController('a');
    const oldToken = controller.beginRestore('a')!;
    controller.switchTo('b', { x: 0, y: 0, zoom: 1 });
    expect(controller.completeRestore(oldToken, false, { x: 0, y: 0, zoom: 1 })).toBe('stale');

    const currentToken = controller.beginRestore('b')!;
    expect(controller.completeRestore(currentToken, false, { x: 0, y: 0, zoom: 1 })).toBe('retry');
  });

  it('adopts the current viewport after three failed attempts', () => {
    const cache: PageViewportCache = new Map();
    const controller = new PageViewportController('a', cache);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const token = controller.beginRestore('a')!;
      expect(controller.completeRestore(token, false, { x: 4, y: 5, zoom: 0.8 })).toBe('retry');
    }
    const finalToken = controller.beginRestore('a')!;
    expect(controller.completeRestore(finalToken, false, { x: 4, y: 5, zoom: 0.8 })).toBe('adopted');
    controller.recordMove({ x: 9, y: 10, zoom: 1.2 });
    expect(recallPageViewport(cache, 'a', 'desktop')?.viewport).toEqual({ x: 9, y: 10, zoom: 1.2 });
  });
});

describe('page viewport node readiness', () => {
  it('requires the exact page node set with measured dimensions', () => {
    expect(arePageViewportNodesReady(['a'], [])).toBe(false);
    expect(arePageViewportNodesReady(['a'], [{ id: 'a' }])).toBe(false);
    expect(arePageViewportNodesReady(['a'], [{ id: 'a', measured: { width: 100, height: 50 } }])).toBe(true);
    expect(arePageViewportNodesReady(['a'], [
      { id: 'a', width: 100, height: 50 },
      { id: 'stale', width: 100, height: 50 },
    ])).toBe(false);
  });

  it('considers an empty page ready only when no rendered nodes remain', () => {
    expect(arePageViewportNodesReady([], [])).toBe(true);
    expect(arePageViewportNodesReady([], [{ id: 'old', width: 100, height: 50 }])).toBe(false);
  });
});
