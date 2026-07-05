import { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { X, Copy, Check, Key, Trash2, Plus, Bot } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { api } from '@/api/client';
import { cn } from '@/lib/utils';

interface McpKeyInfo {
  id: string;
  prefix: string;
  label: string;
  createdAt: string;
  lastUsedAt?: string;
}

interface GeneratedKey extends McpKeyInfo {
  key: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
}

export function McpSetupDialog({ open, onClose }: Props) {
  const [keys, setKeys] = useState<McpKeyInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [label, setLabel] = useState('');
  const [generated, setGenerated] = useState<GeneratedKey | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [copiedConfig, setCopiedConfig] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);

  const loadKeys = useCallback(async () => {
    try {
      setLoading(true);
      const list = await api.listMcpKeys();
      setKeys(list);
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) loadKeys();
  }, [open, loadKeys]);

  const handleGenerate = async () => {
    const name = label.trim() || '默认设备';
    try {
      setGenerating(true);
      const result = await api.generateMcpKey(name);
      setGenerated(result);
      setLabel('');
      loadKeys();
    } catch (err) {
      // handled by error boundary / toast
      console.error('generate key failed', err);
    } finally {
      setGenerating(false);
    }
  };

  const handleRevoke = async (id: string) => {
    try {
      setRevoking(id);
      await api.revokeMcpKey(id);
      if (generated?.id === id) setGenerated(null);
      loadKeys();
    } catch (err) {
      console.error('revoke key failed', err);
    } finally {
      setRevoking(null);
    }
  };

  const isLocal = (() => {
    const origin = window.location.origin;
    return (
      origin.startsWith('http://127.0.0.1') ||
      origin.startsWith('http://localhost') ||
      origin.startsWith('http://[::1]')
    );
  })();

  // 本地 dev 时浏览器访问 Vite(5174)，但 MCP 要直连 Fastify(5173)
  const getApiBase = () => {
    const origin = window.location.origin;
    // Vite dev server proxy: 5174 → 5173
    if (origin.endsWith(':5174')) return origin.replace(':5174', ':5173');
    return origin;
  };

  // 本地用户：直接用项目里的 dist/index.js
  // 云用户：npx 自动下载 npm 包
  const getConfigJson = (apiKey: string) => {
    const apiBase = getApiBase();
    if (isLocal) {
      return JSON.stringify(
        {
          mcpServers: {
            todograph: {
              command: 'node',
              args: ['./packages/mcp/dist/index.js'],
              env: {
                TODOGRAPH_API_BASE: apiBase,
                TODOGRAPH_API_KEY: apiKey,
              },
            },
          },
        },
        null,
        2,
      );
    }
    // 云服务器：npx 自动下载 npm 包，无需源码
    return JSON.stringify(
      {
        mcpServers: {
          todograph: {
            command: 'npx',
            args: ['-y', '@todograph/mcp'],
            env: {
              TODOGRAPH_API_BASE: apiBase,
              TODOGRAPH_API_KEY: apiKey,
            },
          },
        },
      },
      null,
      2,
    );
  };

  const copyToClipboard = async (text: string, type: 'key' | 'config') => {
    await navigator.clipboard.writeText(text);
    if (type === 'key') {
      setCopiedKey(text);
      setTimeout(() => setCopiedKey(null), 2000);
    } else {
      setCopiedConfig(true);
      setTimeout(() => setCopiedConfig(false), 2000);
    }
  };

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
      {/* 遮罩 */}
      <div
        className="absolute inset-0 bg-black/30 backdrop-blur-[2px]"
        onClick={onClose}
      />

      {/* 卡片 */}
      <div className="relative w-full max-w-lg max-h-full overflow-y-auto rounded-xl border border-border bg-card p-5 shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Bot className="w-5 h-5 text-[hsl(var(--primary))]" />
            <h2 className="text-sm font-semibold text-foreground">AI Agent 接入</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <p className="text-xs text-muted-foreground mb-4">
          生成 API Key 后，将配置粘贴到 Claude Desktop / VS Code / Cursor 中，
          AI 即可帮你管理任务依赖、自动布局图表、批量创建任务。
        </p>

        {/* Generate new key */}
        <div className="border border-border rounded-lg p-3 mb-4">
          <h3 className="text-xs font-semibold text-foreground mb-2 flex items-center gap-1">
            <Plus className="w-3.5 h-3.5" />
            生成新 Key
          </h3>
          <div className="flex gap-2">
            <input
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="设备名称（如：我的Mac）"
              className="flex-1 rounded-md border border-input bg-background px-3 py-1.5 text-xs outline-none focus:border-[hsl(var(--primary))]"
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleGenerate();
              }}
            />
            <Button size="sm" onClick={handleGenerate} disabled={generating}>
              {generating ? '生成中...' : '生成'}
            </Button>
          </div>

          {/* Generated key display */}
          {generated && (
            <div className="mt-3 space-y-3">
              <div className="bg-[hsl(var(--primary))/0.08] border border-[hsl(var(--primary))/0.2] rounded-lg p-3">
                <p className="text-[10px] text-muted-foreground mb-1">
                  API Key（仅显示一次，请立即复制）
                </p>
                <div className="flex items-center gap-2">
                  <code className="flex-1 text-xs font-mono text-[hsl(var(--primary))] break-all select-all">
                    {generated.key}
                  </code>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="shrink-0 h-7 w-7 p-0"
                    onClick={() => copyToClipboard(generated.key, 'key')}
                  >
                    {copiedKey === generated.key ? (
                      <Check className="w-3.5 h-3.5 text-green-500" />
                    ) : (
                      <Copy className="w-3.5 h-3.5" />
                    )}
                  </Button>
                </div>
              </div>

              {/* MCP Config prompt */}
              <div>
                <p className="text-[10px] text-muted-foreground mb-1">
                  将以下配置粘贴到 AI 客户端的 MCP 设置中
                </p>
                <div className="relative">
                  <pre className="bg-muted rounded-md p-3 pr-16 text-[11px] font-mono text-foreground overflow-x-auto whitespace-pre">
{getConfigJson(generated.key)}</pre>
                  <Button
                    size="sm"
                    variant="secondary"
                    className="absolute top-2 right-2 h-7 text-[10px]"
                    onClick={() => copyToClipboard(getConfigJson(generated.key), 'config')}
                  >
                    {copiedConfig ? (
                      <>
                        <Check className="w-3 h-3 mr-1" />已复制
                      </>
                    ) : (
                      <>
                        <Copy className="w-3 h-3 mr-1" />复制
                      </>
                    )}
                  </Button>
                </div>
                {isLocal ? (
                  <p className="text-[10px] text-muted-foreground mt-1.5">
                    配置文件位置：<br />
                    • Claude Desktop: <code className="text-[10px] bg-muted px-1 rounded">%APPDATA%\Claude\claude_desktop_config.json</code><br />
                    • VS Code / Cursor: <code className="text-[10px] bg-muted px-1 rounded">.vscode/mcp.json</code>
                  </p>
                ) : (
                  <div className="text-[10px] text-muted-foreground mt-1.5 space-y-1">
                    <p>
                      通过 <code className="text-[10px] bg-muted px-1 rounded">npx @todograph/mcp</code> 运行，
                      首次自动下载，无需源码。
                    </p>
                    <p className="text-[10px] text-foreground/60 mt-1">
                      配置文件位置：<br />
                      • Claude Desktop: <code className="text-[10px] bg-muted px-1 rounded">%APPDATA%\Claude\claude_desktop_config.json</code><br />
                      • VS Code / Cursor: <code className="text-[10px] bg-muted px-1 rounded">.vscode/mcp.json</code>
                    </p>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Existing keys */}
        <div>
          <h3 className="text-xs font-semibold text-foreground mb-2 flex items-center gap-1">
            <Key className="w-3.5 h-3.5" />
            已有 Key ({keys.length})
          </h3>
          {loading ? (
            <p className="text-xs text-muted-foreground">加载中...</p>
          ) : keys.length === 0 ? (
            <p className="text-xs text-muted-foreground">暂无 Key，请生成第一个</p>
          ) : (
            <div className="space-y-2">
              {keys.map((k) => (
                <div
                  key={k.id}
                  className="flex items-center justify-between border border-border rounded-md px-3 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium text-foreground">{k.label}</p>
                    <p className="text-[10px] text-muted-foreground font-mono truncate">
                      {k.prefix}...
                    </p>
                    <p className="text-[10px] text-muted-foreground">
                      {new Date(k.createdAt).toLocaleString()}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="shrink-0 h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                    onClick={() => handleRevoke(k.id)}
                    disabled={revoking === k.id}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** 快捷打开按钮 */
export function McpSetupButton() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className={cn(
          'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5',
          'text-xs font-medium text-muted-foreground',
          'hover:bg-accent hover:text-foreground transition-colors',
        )}
        title="AI Agent 接入"
      >
        <Bot className="w-4 h-4" />
        <span className="hidden sm:inline">AI 接入</span>
      </button>
      <McpSetupDialog open={open} onClose={() => setOpen(false)} />
    </>
  );
}
