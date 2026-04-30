import { useState, type KeyboardEvent } from 'react';
import { Plus } from 'lucide-react';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useTaskStore } from '@/stores/useTaskStore';

export function TaskInput() {
  const [title, setTitle] = useState('');
  const [priority, setPriority] = useState('2');
  const addTask = useTaskStore((s) => s.addTask);

  const submit = () => {
    const t = title.trim();
    if (!t) return;
    // 优先使用图视口中心（如果图视图已经挂载过）；否则回落到随机位置避免重叠在 (0,0)
    const center = useTaskStore.getState().viewportCenter;
    const pos = center
      ? { x: center.x - 90, y: center.y - 28 } // 减半个节点尺寸使其视觉上居中
      : { x: 120 + Math.random() * 500, y: 120 + Math.random() * 300 };
    addTask({
      title: t,
      priority: Number(priority),
      x: pos.x,
      y: pos.y,
    });
    setTitle('');
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') submit();
  };

  return (
    <div className="flex items-center gap-1.5">
      <Plus className="h-4 w-4 text-muted-foreground/70" />
      <Input
        placeholder="新任务...（回车添加）"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={onKey}
        autoFocus
        className="h-8 border-transparent bg-transparent px-1 text-sm focus-visible:ring-0 focus-visible:border-border"
      />
      <Select value={priority} onValueChange={setPriority}>
        <SelectTrigger className="h-7 w-[56px] text-xs border-transparent bg-transparent hover:bg-accent">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="3">高</SelectItem>
          <SelectItem value="2">中</SelectItem>
          <SelectItem value="1">低</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}
