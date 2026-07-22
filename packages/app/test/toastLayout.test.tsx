import { describe, expect, it } from 'vitest';
import { TOAST_BASE_CLASSNAME, TOAST_VIEWPORT_CLASSNAME } from '../src/components/ui/toast';

describe('toast mobile layout', () => {
  it('keeps undo feedback compact and above the bottom navigation', () => {
    expect(TOAST_BASE_CLASSNAME).toContain('rounded-xl');
    expect(TOAST_BASE_CLASSNAME).toContain('p-3');
    expect(TOAST_VIEWPORT_CLASSNAME).toContain('bottom-[calc(3.5rem+env(safe-area-inset-bottom))]');
    expect(TOAST_VIEWPORT_CLASSNAME).toContain('max-w-sm');
    expect(TOAST_VIEWPORT_CLASSNAME).not.toContain('bottom-0');
  });
});
