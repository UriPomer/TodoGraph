import { z } from 'zod';
import type { FastifyPluginAsync } from 'fastify';
import type { McpKeyStore } from '../mcp-keys.js';

const GenerateBody = z.object({
  label: z.string().min(1).max(50),
});

interface Opts {
  keyStore: McpKeyStore;
}

export const mcpRoutes: FastifyPluginAsync<Opts> = async (app, opts) => {
  const { keyStore } = opts;

  // GET /api/mcp/keys — 列出当前用户的所有 key
  app.get('/api/mcp/keys', async (req) => {
    const userId = req.session.userId!;
    const keys = await keyStore.listByUser(userId);
    return { keys };
  });

  // POST /api/mcp/keys — 生成新 key（返回完整 key，仅此一次）
  app.post('/api/mcp/keys', async (req, reply) => {
    const userId = req.session.userId!;
    const parsed = GenerateBody.safeParse(req.body);
    if (!parsed.success) {
      reply.status(400);
      return { ok: false, error: 'label is required (max 50 chars)' };
    }
    const result = await keyStore.generate(userId, parsed.data.label);
    return { ok: true, key: result.key, ...result.entry };
  });

  // DELETE /api/mcp/keys/:key — 撤销 key
  app.delete<{ Params: { key: string } }>('/api/mcp/keys/:key', async (req, reply) => {
    const userId = req.session.userId!;
    const ok = await keyStore.revoke(req.params.key, userId);
    if (!ok) {
      reply.status(404);
      return { ok: false, error: 'key not found or not yours' };
    }
    return { ok: true };
  });
};
