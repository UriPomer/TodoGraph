import { describe, expect, it, beforeEach } from 'vitest';
import { useTaskStore } from '@/stores/useTaskStore';
import { useHistoryStore } from '@/stores/useHistoryStore';

describe('autoBackup (store)', () => {
  beforeEach(() => {
    // 重置 store 到初始态，避免测试间状态污染
    useTaskStore.setState({
      activePageId: null,
      nodes: [],
      edges: [],
      loaded: false,
      backupDirty: false,
    });
    useHistoryStore.getState().clear();
  });

  it('backupDirty starts false', () => {
    expect(useTaskStore.getState().backupDirty).toBe(false);
  });

  it('markBackupDone sets backupDirty to false', () => {
    useTaskStore.setState({ backupDirty: true });
    expect(useTaskStore.getState().backupDirty).toBe(true);
    useTaskStore.getState().markBackupDone();
    expect(useTaskStore.getState().backupDirty).toBe(false);
  });

  it('addTask sets backupDirty to true', () => {
    useTaskStore.setState({ activePageId: 'test-page' });
    useTaskStore.getState().addTask({ title: 'test task' });
    expect(useTaskStore.getState().backupDirty).toBe(true);
  });

  it('addTask + markBackupDone clears dirty', () => {
    useTaskStore.setState({ activePageId: 'test-page' });
    useTaskStore.getState().addTask({ title: 'a' });
    expect(useTaskStore.getState().backupDirty).toBe(true);
    useTaskStore.getState().markBackupDone();
    expect(useTaskStore.getState().backupDirty).toBe(false);
  });

  it('updateTasksBulk sets backupDirty', () => {
    useTaskStore.setState({ activePageId: 'test-page' });

    // 先加一个节点并清脏，作为基线
    const { id } = useTaskStore.getState().addTask({ title: 'existing' });
    useTaskStore.getState().markBackupDone();

    useTaskStore.getState().updateTasksBulk([
      { id, patch: { title: 'renamed' } },
    ]);
    expect(useTaskStore.getState().backupDirty).toBe(true);
  });

  it('deleteTask sets backupDirty', () => {
    useTaskStore.setState({ activePageId: 'test-page' });
    const { id } = useTaskStore.getState().addTask({ title: 'to-delete' });
    useTaskStore.getState().markBackupDone();

    useTaskStore.getState().deleteTask(id);
    expect(useTaskStore.getState().backupDirty).toBe(true);
  });

  it('undo sets backupDirty', () => {
    useTaskStore.setState({ activePageId: 'test-page', backupDirty: false });
    useTaskStore.getState().addTask({ title: 'undoable' });
    useTaskStore.getState().markBackupDone();
    expect(useTaskStore.getState().backupDirty).toBe(false);

    useTaskStore.getState().undo();
    expect(useTaskStore.getState().backupDirty).toBe(true);
  });

  it('redo sets backupDirty', () => {
    useTaskStore.setState({ activePageId: 'test-page', backupDirty: false });
    useTaskStore.getState().addTask({ title: 'first' });
    useTaskStore.getState().addTask({ title: 'second' });
    useTaskStore.getState().undo();
    useTaskStore.getState().markBackupDone();
    expect(useTaskStore.getState().backupDirty).toBe(false);

    useTaskStore.getState().redo();
    expect(useTaskStore.getState().backupDirty).toBe(true);
  });
});
