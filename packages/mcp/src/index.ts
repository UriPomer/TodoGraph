#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { MCP_VERSION } from './version.js';
import { client } from './client.js';
import { registerPageTools } from './tools/pages.js';
import { registerTaskTools } from './tools/tasks.js';
import { registerDependencyTools } from './tools/dependencies.js';
import { registerLayoutTools } from './tools/layout.js';

async function main() {
  const server = new McpServer({
    name: 'todograph',
    version: MCP_VERSION,
  });

  registerPageTools(server, client);
  registerTaskTools(server, client);
  registerDependencyTools(server, client);
  registerLayoutTools(server, client);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('MCP server failed to start:', err);
  process.exit(1);
});
