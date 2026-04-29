import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { DEFAULT_THEME, THEMES, THEME_STORAGE_KEY } from './themes';

interface ThemeContextValue {
  theme: string;
  setTheme: (id: string) => void;
  themes: typeof THEMES;
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
  }, [theme]);

  const setTheme = useCallback((id: string) => {
    if (!THEMES.some((t) => t.id === id)) return;
    setThemeState(id);
  }, []);

  return (
    <ThemeContext.Provider value={{ theme, setTheme, themes: THEMES }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within <ThemeProvider>');
  return ctx;
}
