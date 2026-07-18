import { afterEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveConfig } from '../src/config.js';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('resolveConfig', () => {
  it('uses the repository-root data directory by default', () => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.DATA_DIR;
    delete process.env.DATA_FILE;

    expect(resolveConfig().dataDir).toBe(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..', 'data'),
    );
  });

  it('allows COOKIE_SECURE=false to override the production default', () => {
    process.env = {
      ...ORIGINAL_ENV,
      STATIC_DIR: '/tmp/app',
      COOKIE_SECURE: 'false',
    };

    const cfg = resolveConfig();

    expect(cfg.cookieSecure).toBe(false);
  });

  it('enables secure cookies from COOKIE_SECURE=true outside production mode', () => {
    process.env = {
      ...ORIGINAL_ENV,
      COOKIE_SECURE: 'true',
    };

    const cfg = resolveConfig();

    expect(cfg.staticDir).toBeUndefined();
    expect(cfg.cookieSecure).toBe(true);
  });
});
