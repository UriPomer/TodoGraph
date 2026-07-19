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
