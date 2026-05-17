import { parseLinks } from '@/lib/linkify';

interface Props {
  text: string;
  className?: string;
}

export function LinkifiedText({ text, className }: Props) {
  const segments = parseLinks(text);
  if (segments.length === 0) return null;
  if (segments.length === 1 && !segments[0]!.isUrl) {
    return <span className={className}>{segments[0]!.text}</span>;
  }
  return (
    <span className={className}>
      {segments.map((seg, i) =>
        seg.isUrl ? (
          <span
            key={i}
            className="text-[hsl(var(--link))] underline cursor-pointer"
            onMouseDown={(e) => {
              if (e.metaKey || e.ctrlKey) {
                e.stopPropagation();
                e.preventDefault();
              }
            }}
            onClick={(e) => {
              if (e.metaKey || e.ctrlKey) {
                e.stopPropagation();
                window.open(seg.text, '_blank', 'noopener,noreferrer');
              }
            }}
          >
            {seg.text}
          </span>
        ) : (
          <span key={i}>{seg.text}</span>
        ),
      )}
    </span>
  );
}
