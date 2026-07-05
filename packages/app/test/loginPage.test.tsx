import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { LoginPage } from '../src/features/auth/LoginPage';

describe('LoginPage', () => {
  it('does not apply new-password length rules to login passwords', () => {
    const html = renderToStaticMarkup(
      <LoginPage onLogin={vi.fn()} onRegister={vi.fn()} />,
    );

    const passwordInput = html.match(/<input[^>]*type="password"[^>]*>/)?.[0];
    expect(passwordInput).toBeTruthy();
    expect(passwordInput).toContain('autoComplete="current-password"');
    expect(passwordInput).not.toContain('minLength');
  });
});
