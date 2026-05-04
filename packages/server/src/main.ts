import { buildApp } from './app.js';
import { resolveConfig } from './config.js';

async function main(): Promise<void> {
  const cfg = resolveConfig();
  const app = await buildApp({
    dataDir: cfg.dataDir,
    staticDir: cfg.staticDir,
    registrationKey: cfg.registrationKey,
    sessionSecret: cfg.sessionSecret,
  });

  try {
    const addr = await app.listen({ port: cfg.port, host: cfg.host });
    app.log.info(`TodoGraph server ready at ${addr}`);
    app.log.info(`Data dir: ${cfg.dataDir}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

void main();
