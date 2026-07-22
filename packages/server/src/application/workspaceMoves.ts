import { pageSupportsDependencyGraph, type MoveNodesResponse } from '@todograph/shared';
import type { WorkspaceRepository } from '../repositories/Repository.js';
import { planWorkspaceMove } from '../domain/workspaceMovePlan.js';

/** Applies a cross-page move as one repository transaction, including descendants and internal edges. */
export async function moveNodesBetweenPages(
  repo: WorkspaceRepository,
  sourceId: string,
  targetId: string,
  userSelected: string[],
  expectedSourceVersion?: number,
  expectedTargetVersion?: number,
): Promise<MoveNodesResponse> {
  const [meta, source, target] = await Promise.all([
    repo.loadMeta(),
    repo.loadPage(sourceId),
    repo.loadPage(targetId),
  ]);
  const plan = planWorkspaceMove(
    source,
    target,
    userSelected,
    pageSupportsDependencyGraph(meta.pages.find((page) => page.id === targetId)),
  );
  await repo.savePages([
    { pageId: sourceId, data: plan.source, expectedVersion: expectedSourceVersion ?? source.version },
    { pageId: targetId, data: plan.target, expectedVersion: expectedTargetVersion ?? target.version },
  ]);
  return plan.result;
}
