#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { ModelEngine } from './engine.js';
import { startServer } from './server.js';

interface CliOptions { config: string; transport: 'stdio' | 'http'; host?: string; port?: number; help: boolean }
function usage(): string { return 'Usage: model-as-tool-mcp [--config path] [--transport stdio|http] [--host host] [--port port]'; }
export function parseArgs(argv: string[]): CliOptions {
  const out: CliOptions = { config: 'config.json', transport: 'stdio', help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') { out.help = true; continue; }
    if (arg === '--config') { const value = argv[++i]; if (!value) throw new Error('--config requires a path.'); out.config = value; continue; }
    if (arg === '--transport') { const value = argv[++i]; if (value !== 'stdio' && value !== 'http') throw new Error('--transport must be stdio or http.'); out.transport = value; continue; }
    if (arg === '--host') { const value = argv[++i]; if (!value) throw new Error('--host requires a value.'); out.host = value; continue; }
    if (arg === '--port') { const value = Number(argv[++i]); if (!Number.isInteger(value) || value < 0 || value > 65535) throw new Error('--port must be an integer from 0 to 65535.'); out.port = value; continue; }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return out;
}
export async function main(argv = process.argv.slice(2)): Promise<void> {
  try {
    const opts = parseArgs(argv);
    if (opts.help) { process.stdout.write(`${usage()}\n`); return; }
    const config = await loadConfig(opts.config);
    const engine = new ModelEngine(config);
    const running = await startServer({ config, engine, transport: opts.transport, host: opts.host, port: opts.port });
    if (opts.transport === 'http') process.stderr.write(`model-as-tool-mcp listening on ${opts.host ?? config.http.host}:${running.port}\n`);
    const shutdown = () => { void running.close().finally(() => process.exit(0)); };
    process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Startup failed.'}\n`);
    process.exitCode = 1;
  }
}
const entry = process.argv[1];
const invokedDirectly = !!entry && (() => { try { return pathToFileURL(realpathSync(entry)).href === import.meta.url; } catch { return false; } })();
if (invokedDirectly) void main();
