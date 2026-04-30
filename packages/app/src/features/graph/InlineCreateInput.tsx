import { useEffect, useRef, useState } from 'react';

interface Props {
  /** 相对视图容器的屏幕坐标（左上角定位）。 */
  x: number;
  y: number;
  initial?: string;
  /** 提交标题。若返回 false 认为放弃。 */
  onCommit: (title: string) => void;
  /** 放弃（Esc / 空输入 blur）。 */
  onCancel: () => void;
}

/**
 * 从节点拉线后，在线结束位置浮起的内联输入框。
 * - 回车提交，Esc 放弃；
 * - 失焦：有内容则提交，无内容则取消；
 * - 语义与 UE Blueprint：拖线到空白处 → 在落点就地创建新节点。
 */
export function InlineCreateInput({ x, y, initial = '', onCommit, onCancel }: Props) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  return (
    <div
      className="absolute z-30 rounded-md border border-[hsl(var(--ring))] bg-card/95 p-1 shadow-lg backdrop-blur"
      style={{ left: x, top: y, width: 180 }}
    >
      <input
        ref={ref}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="新任务标题…"
        className="w-full bg-transparent text-sm outline-none px-1 py-0.5"
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            const t = value.trim();
            if (t) onCommit(t);
            else onCancel();
          } else if (e.key === 'Escape') {
            onCancel();
          }
        }}
        onBlur={() => {
          const t = value.trim();
          if (t) onCommit(t);
          else onCancel();
        }}
      />
    </div>
  );
}
