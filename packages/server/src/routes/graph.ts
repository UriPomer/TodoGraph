import { GraphSchema } from '@todograph/shared';
import { isDAG } from '@todograph/core';
import type { FastifyPluginAsync } from 'fastify';
import type { GraphRepository } from '../repositories/Repository.js';

interface Opts {
  repo: GraphRepository;
}

export const graphRoutes: FastifyPluginAsync<Opts> = async (app, opts) => {
  const { repo } = opts;

  app.get('/api/graph', async () => {
    return repo.load();
  });

  app.put('/api/graph', async (req, reply) => {
    const parsed = GraphSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.status(400);
      return { ok: false, error: 'invalid payload', issues: parsed.error.issues };
    }
    if (!isDAG(parsed.data)) {
      reply.status(400);
      return { ok: false, error: 'graph contains a cycle' };
    }
    await repo.save(parsed.data);
    return { ok: true };
  });
};
