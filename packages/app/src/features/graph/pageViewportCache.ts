import type { Viewport } from '@xyflow/react';

export const PAGE_VIEWPORT_CACHE_LIMIT = 20;

export function rememberPageViewport(
  cache: Map<string, Viewport>,
  pageId: string,
  viewport: Viewport,
  limit = PAGE_VIEWPORT_CACHE_LIMIT,
): void {
  cache.delete(pageId);
  cache.set(pageId, viewport);
  while (cache.size > limit) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

export function recallPageViewport(
  cache: Map<string, Viewport>,
  pageId: string,
): Viewport | undefined {
  const viewport = cache.get(pageId);
  if (!viewport) return undefined;
  cache.delete(pageId);
  cache.set(pageId, viewport);
  return viewport;
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
    private readonly cache = new Map<string, Viewport>(),
  ) {
    this.desiredPageId = initialPageId;
  }

  switchTo(pageId: string | null, currentViewport: Viewport): void {
    if (this.ownerPageId && this.ownerPageId !== pageId) {
      rememberPageViewport(this.cache, this.ownerPageId, currentViewport);
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
    const token: PageViewportRestoreToken = {
      pageId,
      generation: this.generation,
      cachedViewport: recallPageViewport(this.cache, pageId),
    };
    this.inFlight = token;
    return token;
  }

  completeRestore(
    token: PageViewportRestoreToken,
    success: boolean,
    fallbackViewport: Viewport,
  ): PageViewportRestoreResult {
    if (this.inFlight !== token) return 'stale';
    this.inFlight = null;
    if (token.generation !== this.generation || token.pageId !== this.desiredPageId) {
      return 'stale';
    }
    if (success) {
      this.desiredPageId = null;
      this.ownerPageId = token.pageId;
      this.attempts = 0;
      return 'settled';
    }
    this.attempts += 1;
    if (this.attempts < 3) return 'retry';
    this.desiredPageId = null;
    this.ownerPageId = token.pageId;
    rememberPageViewport(this.cache, token.pageId, fallbackViewport);
    return 'adopted';
  }

  recordMove(viewport: Viewport): void {
    if (!this.ownerPageId || this.desiredPageId || this.inFlight) return;
    rememberPageViewport(this.cache, this.ownerPageId, viewport);
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
