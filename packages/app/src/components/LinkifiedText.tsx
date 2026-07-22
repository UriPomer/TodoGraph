import { compactUrlLabel, parseLinks } from '@/lib/linkify';

interface Props {
  text: string;
  className?: string;
  compactUrls?: boolean;
}

export function LinkifiedText({ text, className, compactUrls = false }: Props) {
  const segments = parseLinks(text);
  if (segments.length === 0) return null;
  if (segments.length === 1 && !segments[0]!.isUrl) {
    return <span className={className}>{segments[0]!.text}</span>;
  }
  return (
    <span className={className}>
      {segments.map((seg, i) =>
        seg.isUrl ? (
          <a
            key={i}
            href={seg.text}
            target="_blank"
            rel="noopener noreferrer"
            className={`nodrag nopan text-[hsl(var(--link))] underline cursor-pointer${compactUrls ? ' whitespace-nowrap' : ''}`}
            onPointerDown={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
          >
            {compactUrls ? compactUrlLabel(seg.text) : seg.text}
          </a>
        ) : (
          <span key={i}>{seg.text}</span>
        ),
      )}
    </span>
  );
}
