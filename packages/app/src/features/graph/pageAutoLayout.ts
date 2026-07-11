export function claimPageForAutoLayout(
  checkedPages: Set<string>,
  pageId: string,
  nodeIds: readonly string[],
  renderedNodeIds: readonly string[],
): boolean {
  if (checkedPages.has(pageId) || renderedNodeIds.length !== nodeIds.length) return false;
  const rendered = new Set(renderedNodeIds);
  if (nodeIds.some((id) => !rendered.has(id))) return false;
  checkedPages.add(pageId);
  return true;
}
