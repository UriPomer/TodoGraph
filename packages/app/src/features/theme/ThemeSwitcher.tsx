import { Moon, Sun } from 'lucide-react';
import { useTheme } from './ThemeProvider';
import { Button } from '@/components/ui/button';

/**
 * 一键切换 dark / light。
 * - 显示"目标主题"的图标（深色下显示太阳，点一下变浅色）
 * - 需要更多皮肤时再改为下拉菜单
 */
export function ThemeSwitcher() {
  const { theme, setTheme } = useTheme();
  const isDark = theme === 'dark';
  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={() => setTheme(isDark ? 'light' : 'dark')}
      title={isDark ? '切换到浅色' : '切换到深色'}
      className="h-8 w-8"
    >
      {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </Button>
  );
}
