import type { Viewport } from '@xyflow/react';

export const PAGE_VIEWPORT_CACHE_LIMIT = 20;
export const PAGE_VIEWPORT_SIZE_TOLERANCE = 0.15;

export type ViewportScope = 'desktop' | 'mobile';

export interface ViewportDimensions {
  width: number;
  height: number;
}

export interface CachedPageViewport {
  viewport: Viewport;
  dimensions: ViewportDimensions;
}

export type PageViewportCache = Map<
  string,
  Partial<Record<ViewportScope, CachedPageViewport>>
>;

const DEFAULT_DIMENSIONS: ViewportDimensions = { width: 1, height: 1 };

export function rememberPageViewport(
  cache: PageViewportCache,
  pageId: string,
  scope: ViewportScope,
  viewport: Viewport,
  dimensions: ViewportDimensions,
  limit = PAGE_VIEWPORT_CACHE_LIMIT,
): void {
  const variants = cache.get(pageId) ?? {};
  cache.delete(pageId);
  cache.set(pageId, {
    ...variants,
    [scope]: { viewport, dimensions },
  });
  while (cache.size > limit) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

export function recallPageViewport(
  cache: PageViewportCache,
  pageId: string,
  scope: ViewportScope,
): CachedPageViewport | undefined {
  const variants = cache.get(pageId);
  const cached = variants?.[scope];
  if (!cached) return undefined;
  cache.delete(pageId);
  cache.set(pageId, variants);
  return cached;
}

export function areViewportDimensionsCompatible(
  cached: ViewportDimensions,
  current: ViewportDimensions,
): boolean {
  if (cached.width <= 0 || cached.height <= 0 || current.width <= 0 || current.height <= 0) {
    return false;
  }
  const relativeDifference = (a: number, b: number) => Math.abs(a - b) / Math.max(a, b);
  return (
    relativeDifference(current.width, cached.width) <= PAGE_VIEWPORT_SIZE_TOLERANCE &&
    relativeDifference(current.height, cached.height) <= PAGE_VIEWPORT_SIZE_TOLERANCE
  );
}

export interface PageViewportRestoreToken {
  readonly pageId: string;
  readonly generation: number;
  readonly cachedViewport: Viewport | undefined;
}

export type PageViewportRestoreResult = 'settled' | 'retry' | 'stale' | 'adopted';

export class PageViewportController {
  private ownerPageId: string | null = null;
  private desiredPageId: string | null;
  private generation = 0;
  private attempts = 0;
  private inFlight: PageViewportRestoreToken | null = null;

  constructor(
    initialPageId: string | null,
    private readonly cache: PageViewportCache = new Map(),
    private readonly scope: ViewportScope = 'desktop',
    private readonly getDimensions: () => ViewportDimensions = () => DEFAULT_DIMENSIONS,
  ) {
    this.desiredPageId = initialPageId;
  }

  switchTo(pageId: string | null, currentViewport: Viewport): void {
    if (this.ownerPageId && this.ownerPageId !== pageId) {
      rememberPageViewport(
        this.cache,
        this.ownerPageId,
        this.scope,
        currentViewport,
        this.getDimensions(),
      );
    }
    this.ownerPageId = null;
    this.desiredPageId = pageId;
    this.generation += 1;
    this.attempts = 0;
  }

  shouldRestore(pageId: string): boolean {
    return this.desiredPageId === pageId && this.inFlight === null;
  }

  beginRestore(pageId: string): PageViewportRestoreToken | null {
    if (!this.shouldRestore(pageId)) return null;
    const cached = recallPageViewport(this.cache, pageId, this.scope);
    const token: PageViewportRestoreToken = {
      pageId,
      generation: this.generation,
      cachedViewport:
        cached && areViewportDimensionsCompatible(cached.dimensions, this.getDimensions())
          ? cached.viewport
          : undefined,
    };
    this.inFlight = token;
    return token;
  }

  completeRestore(
    token: PageViewportRestoreToken,
    success: boolean,
    currentViewport: Viewport,
  ): PageViewportRestoreResult {
    if (this.inFlight !== token) return 'stale';
    this.inFlight = null;
    if (token.generation !== this.generation || token.pageId !== this.desiredPageId) {
      return 'stale';
    }
    if (success) {
      rememberPageViewport(
        this.cache,
        token.pageId,
        this.scope,
        currentViewport,
        this.getDimensions(),
      );
      this.desiredPageId = null;
      this.ownerPageId = token.pageId;
      this.attempts = 0;
      return 'settled';
    }
    this.attempts += 1;
    if (this.attempts < 3) return 'retry';
    this.desiredPageId = null;
    this.ownerPageId = token.pageId;
    rememberPageViewport(
      this.cache,
      token.pageId,
      this.scope,
      currentViewport,
      this.getDimensions(),
    );
    return 'adopted';
  }

  recordMove(viewport: Viewport): void {
    if (!this.ownerPageId || this.desiredPageId || this.inFlight) return;
    rememberPageViewport(
      this.cache,
      this.ownerPageId,
      this.scope,
      viewport,
      this.getDimensions(),
    );
  }
}

export function arePageViewportNodesReady(
  nodeIds: readonly string[],
  renderedNodes: ReadonlyArray<{
    id: string;
    width?: number;
    height?: number;
    measured?: { width?: number; height?: number };
  }>,
): boolean {
  if (renderedNodes.length !== nodeIds.length) return false;
  const renderedIds = new Set(renderedNodes.map((node) => node.id));
  if (nodeIds.some((id) => !renderedIds.has(id))) return false;
  return renderedNodes.every((node) =>
    Boolean((node.measured?.width ?? node.width) && (node.measured?.height ?? node.height)),
  );
}
