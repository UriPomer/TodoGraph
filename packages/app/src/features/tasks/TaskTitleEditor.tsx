import { useEffect, useRef, useState } from 'react';
import { MAX_TITLE_LENGTH } from '@/lib/measureText';
import { useTaskStore } from '@/stores/useTaskStore';

/** An editing session owns its draft; list and graph choose caret placement and styling. */
export function TaskTitleEditor({ id, title, caret, className, onClose }: {
  id: string;
  title: string;
  caret?: number;
  className: string;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(title);
  const inputRef = useRef<HTMLInputElement>(null);
  const finished = useRef(false);
  useEffect(() => {
    const input = inputRef.current;
    input?.focus();
    if (caret === undefined) input?.select();
    else input?.setSelectionRange(caret, caret);
  }, [caret]);
  const finish = (save: boolean) => {
    if (finished.current) return;
    finished.current = true;
    const next = draft.trim();
    if (save && next && next !== title) useTaskStore.getState().updateTask(id, { title: next });
    onClose();
  };
  return (
    <input
      ref={inputRef}
      value={draft}
      maxLength={MAX_TITLE_LENGTH}
      className={className}
      onChange={event => setDraft(event.target.value)}
      onBlur={() => finish(true)}
      onKeyDown={event => {
        if (event.key === 'Enter' || event.key === 'Escape') finish(event.key === 'Enter');
      }}
    />
  );
}
