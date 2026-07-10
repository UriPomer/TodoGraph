import { renderToStaticMarkup } from 'react-dom/server';
import { act, create } from 'react-test-renderer';
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

  it('masks the registration key and provides a visibility toggle', () => {
    const renderer = create(<LoginPage onLogin={vi.fn()} onRegister={vi.fn()} />);
    const registerModeButton = renderer.root.findByProps({
      className: 'underline hover:text-foreground',
    });

    act(() => registerModeButton.props.onClick());

    const registrationKeyInput = renderer.root.find(
      (node) => node.type === 'input' && node.props.placeholder === '如不需要则留空',
    );
    expect(registrationKeyInput.props.type).toBe('password');
    expect(renderer.root.findByProps({ 'aria-label': '显示邀请码' })).toBeTruthy();
  });
});
