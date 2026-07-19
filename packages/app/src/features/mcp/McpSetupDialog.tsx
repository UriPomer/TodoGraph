import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Bot, Check, Copy, Key, Plus, Trash2, X } from 'lucide-react';
import { api, getApiBase, type McpKeyInfo } from '@/api/client';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toaster-store';

interface GeneratedKey extends McpKeyInfo { key: string }
interface Props { open: boolean; onClose?: () => void; embedded?: boolean }

export function mcpConfig(apiKey: string): string {
  const origin = window.location.origin;
  const apiBase = getApiBase() || (origin.endsWith(':5174') ? origin.replace(':5174', ':5173') : origin);
  return JSON.stringify({
    mcpServers: {
      todograph: {
        command: 'npx',
        args: ['-y', '@todograph/mcp'],
        env: { TODOGRAPH_API_BASE: apiBase, TODOGRAPH_API_KEY: apiKey },
      },
    },
  }, null, 2);
}

export function McpSetupDialog({ open, onClose, embedded = false }: Props) {
  const [keys, setKeys] = useState<McpKeyInfo[]>([]);
  const [label, setLabel] = useState('');
  const [allowDestructive, setAllowDestructive] = useState(false);
  const [generated, setGenerated] = useState<GeneratedKey | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [copied, setCopied] = useState<'key' | 'config' | null>(null);

  const loadKeys = useCallback(async () => {
    setBusy('load');
    try { setKeys(await api.listMcpKeys()); }
    catch (error) { toast.error('加载 MCP Key 失败', String((error as Error).message ?? error)); }
    finally { setBusy(null); }
  }, []);

  useEffect(() => { if (open) void loadKeys(); }, [open, loadKeys]);

  const generate = async () => {
    setBusy('generate');
    try {
      setGenerated(await api.generateMcpKey(
        label.trim() || '默认设备',
        allowDestructive ? ['read', 'write', 'destructive'] : ['read', 'write'],
      ));
      setLabel('');
      await loadKeys();
    } catch (error) { toast.error('生成 MCP Key 失败', String((error as Error).message ?? error)); }
    finally { setBusy(null); }
  };

  const revoke = async (id: string) => {
    setBusy(id);
    try {
      await api.revokeMcpKey(id);
      if (generated?.id === id) setGenerated(null);
      await loadKeys();
    } catch (error) { toast.error('撤销 MCP Key 失败', String((error as Error).message ?? error)); }
    finally { setBusy(null); }
  };

  const copy = async (text: string, type: 'key' | 'config') => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(type); window.setTimeout(() => setCopied(null), 2000);
    } catch (error) { toast.error('复制失败', String((error as Error).message ?? error)); }
  };

  if (!open) return null;
  const config = generated ? mcpConfig(generated.key) : '';
  const panel = (
      <div className={embedded ? 'py-6' : 'relative max-h-full w-full max-w-lg overflow-y-auto rounded-xl border border-border bg-card p-5 shadow-2xl'}>
        <header className="mb-5 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-sm font-semibold"><Bot className="h-5 w-5 text-[hsl(var(--primary))]" />AI Agent 接入</h2>
          {!embedded && <button onClick={onClose} className="rounded p-1 text-muted-foreground hover:bg-accent"><X className="h-4 w-4" /></button>}
        </header>
        <p className="mb-5 text-xs leading-5 text-muted-foreground">生成 API Key，并将配置粘贴到 Claude Desktop、VS Code 或 Cursor。</p>
        <section className="mb-5 border-b border-border/60 pb-5">
          <h3 className="mb-3 flex items-center gap-1 text-xs font-semibold"><Plus className="h-3.5 w-3.5" />生成新 Key</h3>
          <div className="flex gap-3">
            <input value={label} onChange={(event) => setLabel(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void generate(); }} placeholder="设备名称" className={`min-w-0 flex-1 rounded-md border border-input bg-background px-3 text-xs ${embedded ? 'h-10' : 'h-8'}`} />
            <Button size="sm" className={embedded ? 'h-10 px-4' : undefined} onClick={() => void generate()} disabled={busy === 'generate'}>{busy === 'generate' ? '生成中...' : '生成'}</Button>
          </div>
          <label className="mt-3 flex items-start gap-2 text-xs text-muted-foreground">
            <input type="checkbox" checked={allowDestructive} onChange={(event) => setAllowDestructive(event.target.checked)} className="mt-0.5" />
            允许 AI 删除、恢复和跨页面移动数据
          </label>
          {generated && (
            <div className="mt-3 space-y-3">
              <div className="rounded-lg border border-[hsl(var(--primary))/0.2] bg-[hsl(var(--primary))/0.08] p-3">
                <p className="mb-1 text-[10px] text-muted-foreground">API Key 仅显示一次</p>
                <div className="flex items-center gap-2">
                  <code className="min-w-0 flex-1 break-all text-xs text-[hsl(var(--primary))]">{generated.key}</code>
                  <CopyButton copied={copied === 'key'} onClick={() => void copy(generated.key, 'key')} />
                </div>
              </div>
              <div className="relative">
                <pre className="overflow-x-auto rounded-md bg-muted p-3 pr-20 text-[11px]">{config}</pre>
                <Button size="sm" variant="secondary" className="absolute right-3 top-3 h-7 text-[10px]" onClick={() => void copy(config, 'config')}>
                  {copied === 'config' ? <Check className="mr-1 h-3 w-3" /> : <Copy className="mr-1 h-3 w-3" />}复制
                </Button>
              </div>
            </div>
          )}
        </section>
        <section>
          <h3 className="mb-3 flex items-center gap-1 text-xs font-semibold"><Key className="h-3.5 w-3.5" />已有 Key ({keys.length})</h3>
          {busy === 'load' ? <p className="text-xs text-muted-foreground">加载中...</p> : keys.length === 0 ? <p className="text-xs text-muted-foreground">暂无 Key</p> : (
            <div className="space-y-3">
              {keys.map((key) => (
                <div key={key.id} className="flex items-center rounded-md border border-border px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium">{key.label}</p>
                    <p className="truncate font-mono text-[10px] text-muted-foreground">{key.prefix}... · {new Date(key.createdAt).toLocaleString()}</p>
                    <p className="text-[10px] text-muted-foreground">{key.scopes.includes('destructive') ? '可执行破坏性操作' : '只读与安全写入'}</p>
                  </div>
                  <Button size="sm" variant="ghost" className="h-7 w-7 p-0 hover:text-destructive" disabled={busy === key.id} onClick={() => void revoke(key.id)}><Trash2 className="h-3.5 w-3.5" /></Button>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
  );
  if (embedded) return panel;
  return createPortal(
    <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/30 backdrop-blur-[2px]" onClick={onClose} />
      {panel}
    </div>,
    document.body,
  );
}

function CopyButton({ copied, onClick }: { copied: boolean; onClick: () => void }) {
  return <Button size="sm" variant="ghost" className="h-7 w-7 shrink-0 p-0" onClick={onClick}>{copied ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}</Button>;
}

export function McpSetupButton({ onClick }: { onClick: () => void }) {
  return <button onClick={onClick} className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground" title="AI Agent 接入"><Bot className="h-4 w-4" /><span className="hidden sm:inline">AI 接入</span></button>;
}
