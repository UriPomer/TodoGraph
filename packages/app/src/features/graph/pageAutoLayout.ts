import { arePageViewportNodesReady } from './pageViewportCache';

export function claimPageForAutoLayout(
  checkedPages: Set<string>,
  pageId: string,
  nodeIds: readonly string[],
  renderedNodes: Parameters<typeof arePageViewportNodesReady>[1],
): boolean {
  if (checkedPages.has(pageId) || !arePageViewportNodesReady(nodeIds, renderedNodes)) return false;
  checkedPages.add(pageId);
  return true;
}

export function fitPageAfterAutoLayout(
  fitView: (options: { padding: number; duration: number }) => unknown,
  schedule: (callback: FrameRequestCallback) => number = requestAnimationFrame,
): number {
  return schedule(() => { void fitView({ padding: 0.2, duration: 250 }); });
}
