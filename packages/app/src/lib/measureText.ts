import { MAX_TASK_TITLE_LENGTH } from '@todograph/shared';
import { compactLinksForDisplay } from './linkify';

const canvas = typeof document !== 'undefined'
  ? document.createElement('canvas')
  : null;
const ctx = canvas?.getContext('2d');

const FONT = '12px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

export const MAX_LEAF_WIDTH = 400;
export const MIN_LEAF_WIDTH = 180;
export const MAX_TITLE_LENGTH = MAX_TASK_TITLE_LENGTH;

/** Measure single-line text width. Returns pixel width clamped to [180, 400]. */
export function measureTextWidth(text: string): number {
  if (!ctx) return MIN_LEAF_WIDTH;
  ctx.font = FONT;
  const measured = ctx.measureText(compactLinksForDisplay(text)).width;
  // Padding for: px-3(24) + gap-2×3(24) + status dot(14) + pencil(12) + delete(14) = 88, round to 90 for safety
  const padding = 90;
  const total = Math.ceil(measured + padding);
  return Math.max(MIN_LEAF_WIDTH, Math.min(MAX_LEAF_WIDTH, total));
}
