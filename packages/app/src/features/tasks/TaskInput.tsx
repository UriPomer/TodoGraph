import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Plus } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { useTaskStore } from '@/stores/useTaskStore';
import { defaultPositionFor } from '@/lib/defaultPosition';

export function TaskInput({ focusTrigger }: { focusTrigger?: number }) {
  const [title, setTitle] = useState('');
  const addTask = useTaskStore((s) => s.addTask);
  const inputRef = useRef<HTMLInputElement>(null);

  // 外部触发聚焦（如：下拉手势）
  useEffect(() => {
    if (focusTrigger !== undefined && focusTrigger > 0) {
      inputRef.current?.focus();
    }
  }, [focusTrigger]);

  const submit = () => {
    const t = title.trim();
    if (!t) return;
    const s = useTaskStore.getState();
    const pos = defaultPositionFor({ nodes: s.nodes, viewportCenter: s.viewportCenter });
    addTask({ title: t, x: pos.x, y: pos.y });
    setTitle('');
    inputRef.current?.blur();
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') submit();
  };

  return (
    <div className="flex items-center gap-1.5">
      <Plus className="h-4 w-4 text-muted-foreground/70" />
      <Input
        ref={inputRef}
        placeholder="新任务...（回车添加）"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={onKey}
        className="h-8 border-transparent bg-transparent px-1 text-sm focus-visible:ring-0 focus-visible:border-border"
      />
    </div>
  );
}
