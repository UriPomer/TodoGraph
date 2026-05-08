import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
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

export function TaskInput({ focusTrigger }: { focusTrigger?: number }) {
  const [title, setTitle] = useState('');
  const [priority, setPriority] = useState('2');
  const addTask = useTaskStore((s) => s.addTask);
  const inputRef = useRef<HTMLInputElement>(null);
  const pullModeRef = useRef(false); // 下拉触发的提交应强制优先级 3

  // 外部触发聚焦（如：下拉手势）→ 默认高优先级 + 聚焦
  useEffect(() => {
    if (focusTrigger !== undefined && focusTrigger > 0) {
      pullModeRef.current = true;
      setPriority('3');
      inputRef.current?.focus();
    }
  }, [focusTrigger]);

  const submit = () => {
    const t = title.trim();
    if (!t) return;
    const s = useTaskStore.getState();
    const pos = defaultPositionFor({ nodes: s.nodes, viewportCenter: s.viewportCenter });
    // 下拉触发时强制优先级 3，绕过 React 批处理时序问题
    const p = pullModeRef.current ? 3 : Number(priority);
    addTask({ title: t, priority: p, x: pos.x, y: pos.y });
    setTitle('');
    if (pullModeRef.current) {
      pullModeRef.current = false;
      setPriority('2'); // 恢复默认
    }
    inputRef.current?.blur(); // 关闭键盘
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
