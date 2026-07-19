import type { MouseEventHandler } from 'react';
import { Check } from 'lucide-react';
import type { TaskStatus } from '@todograph/shared';
import { cn } from '@/lib/utils';

export function TaskStatusButton({
  status,
  onClick,
  onDoubleClick,
  ariaLabel = '切换状态',
  touchTarget = false,
  className,
}: {
  status: TaskStatus;
  onClick: MouseEventHandler<HTMLButtonElement>;
  onDoubleClick?: MouseEventHandler<HTMLButtonElement>;
  ariaLabel?: string;
  touchTarget?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      title="切换状态"
      className={cn(
        'relative flex shrink-0 items-center justify-center rounded-full transition-transform duration-150 hover:scale-110 active:scale-90',
        touchTarget ? 'h-11 w-11' : 'h-[14px] w-[14px]',
        className,
      )}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
    >
      <span className="relative flex h-[14px] w-[14px] items-center justify-center rounded-full">
        <span
          className={cn(
            'absolute inset-0 rounded-full border',
            status === 'todo' && 'border-muted-foreground/60',
            status === 'doing' && 'border-[hsl(var(--primary))]',
            status === 'done' && 'border-transparent bg-muted-foreground/70',
          )}
        />
        {status === 'doing' && (
          <span className="relative h-[5px] w-[5px] rounded-full bg-[hsl(var(--primary))]" />
        )}
        {status === 'done' && (
          <Check className="relative h-3 w-3 text-[hsl(var(--card))]" strokeWidth={3} />
        )}
      </span>
    </button>
  );
}
