import { resolveNodeOverlaps, type Task } from '@todograph/shared';

export function repairGeometry(
  nodes: Task[],
  changedIds?: readonly string[],
  pinnedIds: readonly string[] = changedIds ?? [],
): Task[] {
  return resolveNodeOverlaps(nodes, { changedIds, pinnedIds }).nodes;
}
