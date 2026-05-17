const URL_RE = /https?:\/\/\S+/gi;

export interface TextSegment {
  text: string;
  isUrl: boolean;
}

export function parseLinks(text: string): TextSegment[] {
  const segments: TextSegment[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  URL_RE.lastIndex = 0;

  while ((match = URL_RE.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ text: text.slice(lastIndex, match.index), isUrl: false });
    }
    segments.push({ text: match[0], isUrl: true });
    lastIndex = URL_RE.lastIndex;
  }
  if (lastIndex < text.length) {
    segments.push({ text: text.slice(lastIndex), isUrl: false });
  }
  return segments;
}
