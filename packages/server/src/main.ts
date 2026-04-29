import { buildApp } from './app.js';
import { resolveConfig } from './config.js';
import { FileRepository } from './repositories/FileRepository.js';

async function main(): Promise<void> {
  const cfg = resolveConfig();
  const repo = new FileRepository(cfg.dataFile);
  const app = await buildApp({ repo, staticDir: cfg.staticDir });

  try {
    const addr = await app.listen({ port: cfg.port, host: cfg.host });
    app.log.info(`TodoGraph server ready at ${addr}`);
    app.log.info(`Data file: ${cfg.dataFile}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

void main();
