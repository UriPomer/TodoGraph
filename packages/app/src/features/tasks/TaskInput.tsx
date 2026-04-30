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
import { defaultPositionFor } from '@/lib/defaultPosition';

export function TaskInput() {
  const [title, setTitle] = useState('');
  const [priority, setPriority] = useState('2');
  const addTask = useTaskStore((s) => s.addTask);

  const submit = () => {
    const t = title.trim();
    if (!t) return;
    const s = useTaskStore.getState();
    const pos = defaultPositionFor({ nodes: s.nodes, viewportCenter: s.viewportCenter });
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
