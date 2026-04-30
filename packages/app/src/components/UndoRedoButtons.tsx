import { Undo2, Redo2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useTaskStore } from '@/stores/useTaskStore';
import { useHistoryStore } from '@/stores/useHistoryStore';

/**
 * 工具栏上的 ↶ ↷ 按钮 —— 点击直接调用 useTaskStore.undo/redo。
 * disabled 状态订阅 useHistoryStore 的栈长度，零状态时按钮灰掉。
 */
export function UndoRedoButtons() {
  const undoLen = useHistoryStore((s) => s.undoStack.length);
  const redoLen = useHistoryStore((s) => s.redoStack.length);
  return (
    <div className="flex items-center gap-1">
      <Button
        variant="outline"
        size="sm"
        className="h-7 px-2"
        disabled={undoLen === 0}
        onClick={() => useTaskStore.getState().undo()}
        title="撤销 (⌘Z)"
      >
        <Undo2 className="h-3.5 w-3.5" />
      </Button>
      <Button
        variant="outline"
        size="sm"
        className="h-7 px-2"
        disabled={redoLen === 0}
        onClick={() => useTaskStore.getState().redo()}
        title="重做 (⌘⇧Z / ⌘Y)"
      >
        <Redo2 className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}
