import { beforeEach, describe, expect, it } from 'vitest';
import { useTaskStore } from '@/stores/useTaskStore';
import { useHistoryStore } from '@/stores/useHistoryStore';

function markCurrentBackupDone(): void {
  const { activePageId, backupRevision, markBackupDone } = useTaskStore.getState();
  markBackupDone(activePageId!, backupRevision);
}

describe('autoBackup (store)', () => {
  beforeEach(() => {
    useTaskStore.setState({
      activePageId: null, nodes: [], edges: [], loaded: false,
      backupDirty: false, backupRevision: 0,
    });
    useHistoryStore.getState().clear();
  });

  it('starts clean', () => {
    expect(useTaskStore.getState().backupDirty).toBe(false);
  });

  it('clears only the revision that was backed up', () => {
    useTaskStore.setState({ activePageId: 'test-page' });
    useTaskStore.getState().addTask({ title: 'before backup' });
    const revision = useTaskStore.getState().backupRevision;
    useTaskStore.getState().addTask({ title: 'during backup' });
    useTaskStore.getState().markBackupDone('test-page', revision);
    expect(useTaskStore.getState().backupDirty).toBe(true);
    markCurrentBackupDone();
    expect(useTaskStore.getState().backupDirty).toBe(false);
  });

  it.each([
    ['update', () => {
      const { id } = useTaskStore.getState().addTask({ title: 'existing' });
      markCurrentBackupDone();
      useTaskStore.getState().updateTasksBulk([{ id, patch: { title: 'renamed' } }]);
    }],
    ['delete', () => {
      const { id } = useTaskStore.getState().addTask({ title: 'existing' });
      markCurrentBackupDone();
      useTaskStore.getState().deleteTask(id);
    }],
    ['undo', () => {
      useTaskStore.getState().addTask({ title: 'undoable' });
      markCurrentBackupDone();
      useTaskStore.getState().undo();
    }],
    ['redo', () => {
      useTaskStore.getState().addTask({ title: 'first' });
      useTaskStore.getState().addTask({ title: 'second' });
      useTaskStore.getState().undo();
      markCurrentBackupDone();
      useTaskStore.getState().redo();
    }],
  ])('%s marks the backup dirty', (_name, mutate) => {
    useTaskStore.setState({ activePageId: 'test-page' });
    mutate();
    expect(useTaskStore.getState().backupDirty).toBe(true);
  });
});
