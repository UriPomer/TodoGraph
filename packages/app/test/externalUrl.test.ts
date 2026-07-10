import { describe, expect, it } from 'vitest';
import { isSafeExternalUrl, isSameOrigin } from '../src/lib/externalUrl';

describe('external URL security', () => {
  it('allows only credential-free HTTP(S) URLs', () => {
    expect(isSafeExternalUrl('https://example.com/path')).toBe(true);
    expect(isSafeExternalUrl('http://example.com/path')).toBe(true);
    expect(isSafeExternalUrl('https://user:pass@example.com')).toBe(false);
    expect(isSafeExternalUrl('file:///C:/Windows/System32/calc.exe')).toBe(false);
    expect(isSafeExternalUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeExternalUrl('data:text/html,hello')).toBe(false);
    expect(isSafeExternalUrl('not a URL')).toBe(false);
  });

  it('compares parsed origins instead of string prefixes', () => {
    expect(isSameOrigin('http://127.0.0.1:5173/a', 'http://127.0.0.1:5173/b')).toBe(true);
    expect(isSameOrigin('http://127.0.0.1.evil.test/a', 'http://127.0.0.1/b')).toBe(false);
  });
});
