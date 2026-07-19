const URL_RE = /https?:\/\/\S+/gi;
const COMPACT_URL_CHARS = 12;

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

export function compactUrlLabel(url: string): string {
  const schemeEnd = url.indexOf('://');
  const content = schemeEnd >= 0 ? url.slice(schemeEnd + 3) : url;
  const preview = content.slice(0, COMPACT_URL_CHARS).replace(/[./]+$/, '');
  return `${preview}...`;
}

/** The exact text shown by compact graph nodes. */
export function compactLinksForDisplay(text: string): string {
  return parseLinks(text)
    .map((segment) => segment.isUrl ? compactUrlLabel(segment.text) : segment.text)
    .join('');
}
