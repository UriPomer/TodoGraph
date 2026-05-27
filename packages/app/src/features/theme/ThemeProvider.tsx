import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { DEFAULT_THEME, THEMES, THEME_STORAGE_KEY, type ThemeDef } from './themes';

interface ThemeContextValue {
  theme: string;
  setTheme: (id: string) => void;
  themes: readonly ThemeDef[];
  currentThemeDef: ThemeDef | undefined;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function readInitialTheme(): string {
  if (typeof window === 'undefined') return DEFAULT_THEME;
  const saved = localStorage.getItem(THEME_STORAGE_KEY);
  if (saved && THEMES.some((t) => t.id === saved)) return saved;
  return DEFAULT_THEME;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<string>(readInitialTheme);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem(THEME_STORAGE_KEY, theme);

    // Toggle .dark class on <html> for Tailwind dark: variant support
    const def = THEMES.find((t) => t.id === theme);
    if (def?.mode === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }

    // 同步 theme-color meta（Android Chrome；Safari 26 已弃用）
    // Safari 26 读 html 的 background-color 来定状态栏颜色，设 inline style 确保能读到
    const card = getComputedStyle(document.documentElement).getPropertyValue('--card').trim();
    if (card) {
      const meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute('content', `hsl(${card})`);
      document.documentElement.style.backgroundColor = `hsl(${card})`;
    }
  }, [theme]);

  const setTheme = useCallback((id: string) => {
    if (!THEMES.some((t) => t.id === id)) return;
    setThemeState(id);
  }, []);

  const currentThemeDef = THEMES.find((t) => t.id === theme);

  return (
    <ThemeContext.Provider value={{ theme, setTheme, themes: THEMES, currentThemeDef }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within <ThemeProvider>');
  return ctx;
}
