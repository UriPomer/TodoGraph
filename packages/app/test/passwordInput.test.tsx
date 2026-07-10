import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PasswordInput } from '../src/components/ui/password-input';

describe('PasswordInput', () => {
  it('masks the value and exposes an accessible visibility toggle', () => {
    const html = renderToStaticMarkup(
      <PasswordInput value="secret" onChange={() => {}} visibilityLabel="当前密码" />,
    );

    expect(html).toContain('type="password"');
    expect(html).toContain('aria-label="显示当前密码"');
    expect(html).toContain('aria-pressed="false"');
  });
});
