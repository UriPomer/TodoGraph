import { useEffect, useState, type InputHTMLAttributes } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { cn } from '@/lib/utils';

interface PasswordInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  visibilityLabel?: string;
}

export function PasswordInput({
  className,
  visibilityLabel = '密码',
  value,
  ...props
}: PasswordInputProps) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (value === '') setVisible(false);
  }, [value]);

  return (
    <div className="relative">
      <input
        {...props}
        type={visible ? 'text' : 'password'}
        value={value}
        className={cn(className, 'pr-10')}
      />
      <button
        type="button"
        onClick={() => setVisible((current) => !current)}
        aria-label={`${visible ? '隐藏' : '显示'}${visibilityLabel}`}
        aria-pressed={visible}
        className="absolute inset-y-0 right-0 flex w-10 items-center justify-center rounded-r-md text-muted-foreground transition-colors hover:text-foreground"
      >
        {visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </button>
    </div>
  );
}
