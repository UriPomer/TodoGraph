import { describe, expect, it } from 'vitest';
import {
  LIST_DOUBLE_TAP_MS,
  LIST_LONG_PRESS_MS,
  LIST_SWIPE_COMMIT_PX,
  LIST_SWIPE_START_PX,
  LIST_TAP_SLOP_PX,
} from '@/features/tasks/gesturePolicy';

describe('list gesture policy', () => {
  it('GEST-001 locks the documented timing and movement thresholds', () => {
    expect({
      doubleTapMs: LIST_DOUBLE_TAP_MS,
      longPressMs: LIST_LONG_PRESS_MS,
      tapSlopPx: LIST_TAP_SLOP_PX,
      swipeStartPx: LIST_SWIPE_START_PX,
      swipeCommitPx: LIST_SWIPE_COMMIT_PX,
    }).toEqual({
      doubleTapMs: 320,
      longPressMs: 400,
      tapSlopPx: 8,
      swipeStartPx: 18,
      swipeCommitPx: 96,
    });
  });
});
