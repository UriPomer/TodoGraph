import { describe, expect, it } from 'vitest';
import { electronServerHost } from '../../desktop-host/src/index';

describe('electronServerHost', () => {
  it('allows only loopback renderer hosts', () => {
    expect(electronServerHost(null)).toBe('127.0.0.1');
    expect(electronServerHost(new URL('http://localhost:5174'))).toBe('localhost');
    expect(electronServerHost(new URL('http://127.0.0.1:5174'))).toBe('127.0.0.1');
    expect(electronServerHost(new URL('http://[::1]:5174'))).toBe('::1');
    expect(() => electronServerHost(new URL('http://0.0.0.0:5174'))).toThrow('loopback');
    expect(() => electronServerHost(new URL('http://192.168.1.10:5174'))).toThrow('loopback');
  });
});
