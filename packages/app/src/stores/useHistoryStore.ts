import { create } from 'zustand';
import type { Edge, Task } from '@todograph/shared';

export interface Snapshot {
  nodes: Task[];
  edges: Edge[];
}

interface HistoryStore {
  undoStack: Snapshot[];
  redoStack: Snapshot[];
  push: (s: Snapshot) => void;
  undo: (current: Snapshot) => Snapshot | null;
  redo: (current: Snapshot) => Snapshot | null;
  clear: () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;
}

/** 栈上限 —— 老快照被挤掉；线性历史，不支持分支 */
const MAX = 100;

/**
 * 撤销 / 重做 栈。
 *
 * 设计契约：
 *  - `push(s)` 记录的是"一次 mutation 的 **前态**" —— 调用方在真正改之前 push。
 *    这样 undo() 返回的 snapshot 直接就能 set 到 store 里实现回滚。
 *  - `undo(current)` 弹出上一次前态，同时把当前态压入 redoStack。
 *  - `redo(current)` 弹出待重做状态，同时把当前态压入 undoStack。
 *  - 任何 `push` 都会清空 redoStack（线性历史的经典做法）。
 *  - `clear()` 两栈清空 —— 切页时调用。
 *
 * 不使用 Immer：snapshot 里的 nodes/edges 引用是"前态"的原数组；应用时
 * 直接作为新的 state 写回即可。useTaskStore 的写操作都是 immutable 的，
 * 所以共享引用安全。
 */
export const useHistoryStore = create<HistoryStore>((set, get) => {
  const travel = (from: 'undoStack' | 'redoStack', current: Snapshot): Snapshot | null => {
    const to = from === 'undoStack' ? 'redoStack' : 'undoStack';
    const state = get();
    const snapshot = state[from].at(-1);
    if (!snapshot) return null;
    set({ [from]: state[from].slice(0, -1), [to]: [...state[to], current] });
    return snapshot;
  };
  return {
    undoStack: [],
    redoStack: [],

    push: (s) => {
      const { undoStack } = get();
      const next =
        undoStack.length >= MAX
          ? [...undoStack.slice(-(MAX - 1)), s]
          : [...undoStack, s];
      set({ undoStack: next, redoStack: [] });
    },

    undo: (current) => travel('undoStack', current),
    redo: (current) => travel('redoStack', current),

    clear: () => set({ undoStack: [], redoStack: [] }),

    canUndo: () => get().undoStack.length > 0,
    canRedo: () => get().redoStack.length > 0,
  };
});
