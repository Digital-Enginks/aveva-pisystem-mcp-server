#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootstrap } from './bootstrap/composition-root.js';

// Load a local .env file from the project root when present, so the documented
// "copy a template to .env and start the server" workflow works for standalone
// runs (npm start). Resolved relative to this file rather than the working
// directory so it is found regardless of where the process is launched.
// Variables already present in the environment (e.g. injected by the MCP host)
// take precedence over the file, so host configuration always wins.
const envFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');
if (fs.existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

bootstrap().catch(err => {
  console.error('Fatal initialization error:', err.message);
  process.exit(1);
});
