import { useEffect, useRef, useState } from 'react';
import { useDialogStore } from './dialog-store';

/**
 * 命令式弹窗渲染容器。
 * 一次只显示队首弹窗，resolve 后自动出队显示下一个。
 */
export function DialogContainer() {
  const dialogs = useDialogStore((s) => s.dialogs);
  const dequeue = useDialogStore((s) => s.dequeue);
  const current = dialogs[0];

  // 不渲染任何东西时
  if (!current) return null;

  return <DialogInstance key={current.id} dialog={current} onDone={() => dequeue(current.id)} />;
}

function DialogInstance({
  dialog,
  onDone,
}: {
  dialog: ReturnType<typeof useDialogStore.getState>['dialogs'][number];
  onDone: () => void;
}) {
  const [visible, setVisible] = useState(false);
  const [promptValue, setPromptValue] = useState(
    dialog.type === 'prompt' ? (dialog.defaultValue ?? '') : '',
  );
  const inputRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  // 入场动画：下一帧设为 visible
  useEffect(() => {
    const raf = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  // 自动聚焦
  useEffect(() => {
    if (dialog.type === 'prompt') {
      inputRef.current?.focus();
      inputRef.current?.select();
    } else {
      confirmRef.current?.focus();
    }
  }, [dialog.type]);

  const resolve = (value: boolean | string | null) => {
    setVisible(false);
    // 等出场动画播完
    setTimeout(() => {
      dialog.resolve(value as never);
      onDone();
    }, 180);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (dialog.type === 'prompt') resolve(promptValue);
      else resolve(true);
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      if (dialog.type === 'prompt') resolve(null);
      else resolve(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center"
      onKeyDown={handleKeyDown}
    >
      {/* 遮罩 */}
      <div
        className={`absolute inset-0 bg-black/30 backdrop-blur-[2px] transition-opacity transition-duration-[180ms] ${
          visible ? 'opacity-100' : 'opacity-0'
        }`}
        onClick={() => {
          if (dialog.type === 'confirm') resolve(false);
        }}
      />

      {/* 卡片 */}
      <div
        className={`relative w-[calc(100vw-2rem)] max-w-sm rounded-xl border border-border bg-card p-5 shadow-2xl transition-[opacity,transform] transition-duration-[180ms] ${
          visible ? 'opacity-100 scale-100' : 'opacity-0 scale-95'
        }`}
      >
        <p className="text-sm font-semibold text-foreground">{dialog.title}</p>

        {dialog.type === 'confirm' && dialog.description && (
          <p className="mt-1.5 text-xs text-muted-foreground">{dialog.description}</p>
        )}

        {dialog.type === 'prompt' && (
          <input
            ref={inputRef}
            type="text"
            value={promptValue}
            onChange={(e) => setPromptValue(e.target.value)}
            placeholder={dialog.placeholder}
            className="mt-3 w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:border-[hsl(var(--primary))]"
          />
        )}

        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={() => {
              if (dialog.type === 'prompt') resolve(null);
              else resolve(false);
            }}
            className="rounded-md px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
          >
            {dialog.type === 'prompt' ? (dialog.cancelLabel ?? '取消') : (dialog.cancelLabel ?? '取消')}
          </button>
          <button
            ref={confirmRef}
            onClick={() => {
              if (dialog.type === 'prompt') resolve(promptValue);
              else resolve(true);
            }}
            className={`rounded-md px-4 py-1.5 text-xs font-semibold transition-colors ${
              dialog.type === 'confirm' && dialog.danger
                ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
                : 'bg-[hsl(var(--primary))] text-primary-foreground hover:bg-[hsl(var(--primary))]/90'
            }`}
          >
            {dialog.type === 'prompt' ? (dialog.confirmLabel ?? '确定') : (dialog.confirmLabel ?? '确定')}
          </button>
        </div>
      </div>
    </div>
  );
}
