import { useState, useEffect } from 'react';
import { Check, Droplets, Moon, Sun, Palette } from 'lucide-react';
import { useTheme } from './ThemeProvider';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import type { ThemeDef } from './themes';

const HUE_STORAGE_KEY = 'todograph.brand-hue';
const DEFAULT_HUE = 256;
const LEFT_PANEL_OPAQUE_KEY = 'todograph.left-panel-opaque';

const ICON_MAP: Record<string, typeof Palette> = {
  droplets: Droplets,
  moon: Moon,
  sun: Sun,
};

function ThemeIcon({ icon }: { icon: string }) {
  const Icon = ICON_MAP[icon] ?? Palette;
  return <Icon className="h-4 w-4" />;
}

function HueSlider() {
  const [hue, setHue] = useState(() => {
    const saved = localStorage.getItem(HUE_STORAGE_KEY);
    return saved ? Number(saved) : DEFAULT_HUE;
  });

  useEffect(() => {
    document.documentElement.style.setProperty('--brand-hue', String(hue));
    localStorage.setItem(HUE_STORAGE_KEY, String(hue));
  }, [hue]);

  return (
    <div className="px-2 py-1.5">
      <div className="mb-1 text-[11px] text-muted-foreground flex items-center justify-between">
        <span>色相</span>
        <span>{hue}°</span>
      </div>
      <input
        type="range"
        min={0}
        max={360}
        value={hue}
        onChange={(e) => setHue(Number(e.target.value))}
        className="w-full h-1.5 rounded-full appearance-none cursor-pointer"
        style={{
          background: `linear-gradient(to right,
            hsl(0, 80%, 60%), hsl(40, 80%, 60%), hsl(80, 80%, 60%),
            hsl(160, 80%, 60%), hsl(220, 80%, 60%), hsl(280, 80%, 60%),
            hsl(320, 80%, 60%), hsl(360, 80%, 60%))`,
          accentColor: `hsl(${hue}, 80%, 60%)`,
        }}
      />
    </div>
  );
}

function LeftPanelOpaqueToggle() {
  const [opaque, setOpaque] = useState(() => {
    return localStorage.getItem(LEFT_PANEL_OPAQUE_KEY) === 'true';
  });

  useEffect(() => {
    if (opaque) {
      document.documentElement.setAttribute('data-left-panel-opaque', 'true');
    } else {
      document.documentElement.removeAttribute('data-left-panel-opaque');
    }
    localStorage.setItem(LEFT_PANEL_OPAQUE_KEY, String(opaque));
  }, [opaque]);

  return (
    <div className="px-2 py-1.5">
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-muted-foreground">列表视图不透明</span>
        <button
          type="button"
          role="switch"
          aria-checked={opaque}
          onClick={() => setOpaque((v) => !v)}
          className={cn(
            'relative inline-flex h-4 w-7 shrink-0 rounded-full border-2 border-transparent',
            'transition-colors duration-200 ease-in-out',
            'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
            opaque ? 'bg-[hsl(var(--primary))]' : 'bg-muted',
          )}
        >
          <span
            className={cn(
              'pointer-events-none inline-block h-3 w-3 rounded-full bg-white shadow-sm',
              'transition-transform duration-200 ease-in-out',
              opaque ? 'translate-x-3' : 'translate-x-0',
            )}
          />
        </button>
      </div>
    </div>
  );
}

export function ThemeSwitcher() {
  const { theme, setTheme, themes, currentThemeDef } = useTheme();
  const isGlass = currentThemeDef?.id.startsWith('glass');

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="h-8 w-8" title="切换主题">
          <Palette className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[190px]">
        {themes.map((t: ThemeDef) => (
          <DropdownMenuItem
            key={t.id}
            onClick={() => setTheme(t.id)}
            className={cn('flex items-center gap-2.5', theme === t.id && 'bg-accent')}
          >
            <span
              className="h-4 w-4 shrink-0 rounded-full border border-border/50"
              style={t.preview ? { background: t.preview } : { background: 'hsl(var(--muted))' }}
            />
            <ThemeIcon icon={t.icon} />
            <span className="flex-1">{t.label}</span>
            {theme === t.id && <Check className="h-3.5 w-3.5 text-primary" />}
          </DropdownMenuItem>
        ))}
        {isGlass && (
          <div className="border-t border-border mt-1 pt-1">
            <HueSlider />
            <LeftPanelOpaqueToggle />
          </div>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
