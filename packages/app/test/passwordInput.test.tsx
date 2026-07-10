import { act, create } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import { PasswordInput } from '../src/components/ui/password-input';

describe('PasswordInput', () => {
  it('toggles visibility and masks the next empty value', () => {
    const props = { value: 'secret', onChange: () => {}, visibilityLabel: '当前密码' };
    const renderer = create(<PasswordInput {...props} />);
    const input = () => renderer.root.findByType('input');
    const button = () => renderer.root.findByType('button');

    expect(input().props.type).toBe('password');
    expect(button().props['aria-label']).toBe('显示当前密码');

    act(() => button().props.onClick());
    expect(input().props.type).toBe('text');
    expect(button().props['aria-label']).toBe('隐藏当前密码');

    act(() => renderer.update(<PasswordInput {...props} value="" />));
    expect(input().props.type).toBe('password');
  });
});
