#!/usr/bin/env node
import * as esbuild from 'esbuild';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const entry = path.join(root, 'src/server.js');
const outDir = path.join(root, 'dist');
const outFile = path.join(outDir, 'server.bundle.mjs');

fs.mkdirSync(outDir, { recursive: true });

await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outfile: outFile,
  external: [],
  // Bundle all deps including @modelcontextprotocol/* and zod
  packages: 'bundle',
  sourcemap: false,
  minify: false,
  // Keep dynamic import for mcp handler bundled; esbuild will inline it if possible
  splitting: false,
  banner: { js: '// Bundled MultiContext server - includes MCP SDK and zod' },
  logLevel: 'info',
});

console.log(`Bundled server -> ${outFile} (${(fs.statSync(outFile).size/1024).toFixed(1)} KB)`);

// Also copy public dir manifest for verification
const publicDir = path.join(root, 'public');
if (fs.existsSync(publicDir)) {
  console.log('Public dir ready for Tauri resources');
}
