import { describe, expect, it } from 'vitest';
import { claimPageForAutoLayout } from '@/features/graph/pageAutoLayout';

describe('page auto-layout gate', () => {
  it('waits for the current page node set before claiming it', () => {
    const checked = new Set<string>();
    expect(claimPageForAutoLayout(checked, 'a', ['1', '2'], [])).toBe(false);
    expect(claimPageForAutoLayout(checked, 'a', ['1', '2'], ['1', 'old'])).toBe(false);
    expect(claimPageForAutoLayout(checked, 'a', ['1', '2'], ['2', '1'])).toBe(true);
  });

  it('claims each synchronized page only once', () => {
    const checked = new Set<string>();
    expect(claimPageForAutoLayout(checked, 'a', ['1'], ['1'])).toBe(true);
    expect(claimPageForAutoLayout(checked, 'a', ['1'], ['1'])).toBe(false);
    expect(claimPageForAutoLayout(checked, 'b', ['2'], ['2'])).toBe(true);
  });
});
