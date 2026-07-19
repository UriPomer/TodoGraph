import { z } from 'zod';
import type { FastifyPluginAsync } from 'fastify';
import type { McpKeyScope, McpKeyStore } from '../mcp-keys.js';
import { getAuthenticatedUserId } from '../auth.js';

const GenerateBody = z.object({
  label: z.string().min(1).max(50),
  scopes: z.array(z.enum(['read', 'write', 'destructive'])).default(['read', 'write']),
});

interface Opts {
  keyStore: McpKeyStore;
}

export const mcpRoutes: FastifyPluginAsync<Opts> = async (app, opts) => {
  const { keyStore } = opts;

  // GET /api/mcp/keys — 列出当前用户的所有 key
  app.get('/api/mcp/keys', async (req) => {
    const userId = getAuthenticatedUserId(req);
    const keys = await keyStore.listByUser(userId);
    return { keys };
  });

  // POST /api/mcp/keys — 生成新 key（返回完整 key，仅此一次）
  app.post('/api/mcp/keys', async (req, reply) => {
    const userId = getAuthenticatedUserId(req);
    const parsed = GenerateBody.safeParse(req.body);
    if (!parsed.success) {
      reply.status(400);
      return { ok: false, error: 'label is required (max 50 chars)' };
    }
    const result = await keyStore.generate(userId, parsed.data.label, parsed.data.scopes as McpKeyScope[]);
    return { ok: true, key: result.key, ...result.entry };
  });

  // DELETE /api/mcp/keys/:id — 撤销 key
  app.delete<{ Params: { id: string } }>('/api/mcp/keys/:id', async (req, reply) => {
    const userId = getAuthenticatedUserId(req);
    const ok = await keyStore.revokeById(req.params.id, userId);
    if (!ok) {
      reply.status(404);
      return { ok: false, error: 'key not found or not yours' };
    }
    return { ok: true };
  });
};
