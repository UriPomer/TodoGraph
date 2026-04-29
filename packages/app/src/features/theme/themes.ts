export interface ThemeDef {
  id: 'dark' | 'light';
  label: string;
}

/**
 * 新增皮肤只需：
 *  1) 扩展此处 id 联合类型 + THEMES 数组
 *  2) 在 styles/globals.css 追加 [data-theme="id"] { ... } 变量块
 */
export const THEMES: ThemeDef[] = [
  { id: 'dark', label: '深色' },
  { id: 'light', label: '浅色' },
];

export const DEFAULT_THEME: ThemeDef['id'] = 'dark';
export const THEME_STORAGE_KEY = 'todograph.theme';
