import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MCP_VERSION } from '../src/version.js';
import { toolResult } from '../src/tools/result.js';
import { handleMergePages } from '../src/tools/pages.js';

describe('HTTP client', () => {
  let client: typeof import('../src/client.js').client;

  beforeEach(async () => {
    vi.stubEnv('TODOGRAPH_API_BASE', 'http://test:9999');
    vi.stubEnv('TODOGRAPH_API_KEY', 'test-key');
    const mod = await import('../src/client.js');
    client = mod.client;
  });

  it('constructs GET URL correctly', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    vi.stubGlobal('fetch', mockFetch);

    await client.get('/api/meta');

    expect(mockFetch).toHaveBeenCalledWith('http://test:9999/api/meta', expect.objectContaining({
      method: 'GET',
      headers: {
        Authorization: 'Bearer test-key',
        'X-TodoGraph-MCP-Version': MCP_VERSION,
      },
      body: undefined,
      signal: expect.any(AbortSignal),
    }));
  });

  it('constructs POST with body correctly', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    vi.stubGlobal('fetch', mockFetch);

    await client.post('/api/pages', { title: 'test' });

    expect(mockFetch).toHaveBeenCalledWith('http://test:9999/api/pages', expect.objectContaining({
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer test-key',
        'X-TodoGraph-MCP-Version': MCP_VERSION,
      },
      body: JSON.stringify({ title: 'test' }),
      signal: expect.any(AbortSignal),
    }));
  });

  it('keeps compatible operations successful and shows the MCP update notice', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'X-TodoGraph-MCP-Latest-Version': '9.0.0' },
      }),
    ));

    const result = await toolResult(() => client.get('/api/meta'));

    expect(result.content).toHaveLength(2);
    expect(result.content[0]?.text).toContain(`当前 MCP 版本为 ${MCP_VERSION}`);
    expect(result.content[0]?.text).toContain('npx -y @todograph/mcp@latest');
    expect(result.content[1]?.text).toContain('"ok": true');
  });

  it('isolates MCP update notices between concurrent tool calls', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string | URL | Request) => {
      const needsUpdate = String(input).endsWith('/api/outdated');
      await Promise.resolve();
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: needsUpdate ? { 'X-TodoGraph-MCP-Latest-Version': '9.0.0' } : {},
      });
    }));

    const [outdated, current] = await Promise.all([
      toolResult(() => client.get('/api/outdated')),
      toolResult(() => client.get('/api/current')),
    ]);

    expect(outdated.content).toHaveLength(2);
    expect(current.content).toHaveLength(1);
  });

  it('throws on 4xx with error from body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ok: false, error: 'bad request' }), { status: 400 }),
      ),
    );

    await expect(client.get('/api/pages/nonexistent')).rejects.toThrow('bad request');
  });

  it('throws on 409 with conflict error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ok: false, error: '版本冲突' }), { status: 409 }),
      ),
    );

    await expect(client.put('/api/pages/p1', {})).rejects.toThrow('版本冲突');
  });

  it('handles non-JSON response body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('plain text error', { status: 500 }),
      ),
    );

    await expect(client.get('/api/meta')).rejects.toThrow('plain text error');
  });

  it('turns request timeouts into an actionable error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('timed out', 'TimeoutError')));

    await expect(client.get('/api/meta')).rejects.toThrow('TodoGraph request timed out');
  });
});

describe('page merge safety', () => {
  it('delegates the complete merge and its recovery preconditions to one server request', async () => {
    const fakeClient = {
      post: vi.fn().mockResolvedValue({ movedNodes: 2 }),
    };

    await expect(handleMergePages(fakeClient as never, {
      source_page_id: 'source',
      target_page_id: 'target',
    })).resolves.toMatchObject({ movedNodes: 2 });
    expect(fakeClient.post).toHaveBeenCalledWith('/api/pages/source/merge', {
      targetPageId: 'target',
    });
  });
});
