export type MultiDragStopAction = 'single' | 'commit' | 'ignore';

export class MultiDragSession {
  private pendingStops = new Set<string>();
  private committed = false;

  start(selectedIds: readonly string[]): void {
    this.pendingStops = selectedIds.length > 1 ? new Set(selectedIds) : new Set();
    this.committed = false;
  }

  get active(): boolean {
    return this.pendingStops.size > 0 && !this.committed;
  }

  stop(nodeId: string): MultiDragStopAction {
    if (!this.pendingStops.has(nodeId)) return 'single';
    this.pendingStops.delete(nodeId);
    if (this.committed) return 'ignore';
    this.committed = true;
    return 'commit';
  }
}
