export interface ThemeDef {
  id: string;
  label: string;
  mode: 'light' | 'dark';
  icon: string;
  preview?: string;
}

export const THEMES = [
  {
    id: 'glass-dark',
    label: '玻璃·深色',
    mode: 'dark',
    icon: 'droplets',
    preview: 'linear-gradient(135deg, #6366f1, #3b82f6, #06b6d4)',
  },
  {
    id: 'glass-light',
    label: '玻璃·浅色',
    mode: 'light',
    icon: 'droplets',
    preview: 'linear-gradient(135deg, #a5b4fc, #93c5fd, #67e8f9)',
  },
  {
    id: 'default-dark',
    label: '经典·深色',
    mode: 'dark',
    icon: 'moon',
  },
  {
    id: 'default-light',
    label: '经典·浅色',
    mode: 'light',
    icon: 'sun',
  },
  {
    id: 'muted-warm',
    label: '暖素',
    mode: 'light',
    icon: 'sun',
    preview: 'linear-gradient(135deg, #F8F7F4, #e0d8c8, #b8c9a8)',
  },
  {
    id: 'muted-cool',
    label: '冷素',
    mode: 'light',
    icon: 'moon',
    preview: 'linear-gradient(135deg, #F5F6F8, #e0e5ec, #b8c4d4)',
  },
] as const satisfies readonly ThemeDef[];

export type ThemeId = (typeof THEMES)[number]['id'];

export const DEFAULT_THEME: ThemeId = 'glass-dark';
export const THEME_STORAGE_KEY = 'todograph.theme';
