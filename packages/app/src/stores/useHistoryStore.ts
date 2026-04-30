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
  undo: () => Snapshot | null;
  redo: () => Snapshot | null;
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
 *  - `undo()` 从 undoStack 弹出最顶的 snapshot，顺便压入 redoStack。
 *  - `redo()` 反向 —— 从 redoStack 弹出压回 undoStack。
 *  - 任何 `push` 都会清空 redoStack（线性历史的经典做法）。
 *  - `clear()` 两栈清空 —— 切页时调用。
 *
 * 不使用 Immer：snapshot 里的 nodes/edges 引用是"前态"的原数组；应用时
 * 直接作为新的 state 写回即可。useTaskStore 的写操作都是 immutable 的，
 * 所以共享引用安全。
 */
export const useHistoryStore = create<HistoryStore>((set, get) => ({
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

  undo: () => {
    const { undoStack, redoStack } = get();
    if (undoStack.length === 0) return null;
    const s = undoStack[undoStack.length - 1]!;
    set({ undoStack: undoStack.slice(0, -1), redoStack: [...redoStack, s] });
    return s;
  },

  redo: () => {
    const { undoStack, redoStack } = get();
    if (redoStack.length === 0) return null;
    const s = redoStack[redoStack.length - 1]!;
    set({ undoStack: [...undoStack, s], redoStack: redoStack.slice(0, -1) });
    return s;
  },

  clear: () => set({ undoStack: [], redoStack: [] }),

  canUndo: () => get().undoStack.length > 0,
  canRedo: () => get().redoStack.length > 0,
}));
