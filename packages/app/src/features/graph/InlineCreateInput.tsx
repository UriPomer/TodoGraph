import { useEffect, useRef, useState } from 'react';
import { Check, X } from 'lucide-react';

interface Props {
  onCommit: (title: string) => void;
  onCancel: () => void;
}

/** 居中浮在屏幕上的内联输入框，不随画布移动。 */
export function InlineCreateInput({ onCommit, onCancel }: Props) {
  const [value, setValue] = useState('');
  const ref = useRef<HTMLInputElement>(null);
  const graceRef = useRef(true);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
    const id = setTimeout(() => { graceRef.current = false; }, 600);
    return () => clearTimeout(id);
  }, []);

  const commit = () => {
    graceRef.current = false;
    const t = value.trim();
    if (t) onCommit(t);
    else onCancel();
  };

  const cancel = () => {
    graceRef.current = false;
    onCancel();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20" onClick={cancel}>
      <div
        className="rounded-md border border-[hsl(var(--ring))] bg-card p-2 shadow-lg"
        style={{ width: 240 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-1.5">
          <input
            ref={ref}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="新任务标题…"
            className="flex-1 min-w-0 bg-transparent text-sm outline-none px-1 py-1.5"
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit();
              else if (e.key === 'Escape') cancel();
            }}
            onBlur={() => {
              if (graceRef.current) return;
              const t = value.trim();
              if (t) onCommit(t);
              else onCancel();
            }}
          />
          <button
            onMouseDown={(e) => { e.preventDefault(); commit(); }}
            onTouchStart={(e) => { e.preventDefault(); commit(); }}
            className="shrink-0 rounded p-1.5 text-[hsl(var(--success))] hover:bg-accent active:scale-90 transition-transform"
            aria-label="确认"
          >
            <Check className="h-4 w-4" />
          </button>
          <button
            onMouseDown={(e) => { e.preventDefault(); cancel(); }}
            onTouchStart={(e) => { e.preventDefault(); cancel(); }}
            className="shrink-0 rounded p-1.5 text-muted-foreground hover:bg-accent active:scale-90 transition-transform"
            aria-label="取消"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
