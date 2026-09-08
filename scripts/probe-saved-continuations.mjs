// Explicit real-model diagnostic: replay saved failed model requests only.
// Never executes returned tools or changes the original workspace/transcripts.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { LocalModelClient } from '../src/local-model.js';
import { config } from '../src/config.js';

const source = path.resolve(process.argv[2] || '');
if (!process.argv[2]) throw new Error('Pass an experiment directory');
const traceBytes = await fs.readFile(path.join(source, 'trace.json'));
const failed = JSON.parse(traceBytes).filter(entry => entry.error && entry.method === 'continueAgent');
if (!failed.length) throw new Error('No failed continuation requests');
const directory = await fs.mkdtemp(path.join(source, 'continuation-probe-'));
await fs.cp(path.join(source, 'state.json.local-conversations'), path.join(directory, 'conversations'), { recursive: true });
const client = new LocalModelClient({ baseUrl: config.localModelUrl, directory: path.join(directory, 'conversations') });
const record = { sourceTraceSha256: createHash('sha256').update(traceBytes).digest('hex'), results: [] };
console.log(JSON.stringify({ directory, requests: failed.length }));
for (const entry of failed) {
  const result = { input: entry.input, startedAt: new Date().toISOString() };
  const start = Date.now();
  try { result.response = await client.continueAgent(entry.input); }
  catch (error) { result.error = { name: error.name, message: error.message }; }
  result.elapsedMs = Date.now() - start;
  record.results.push(result);
  await fs.writeFile(path.join(directory, 'result.json'), JSON.stringify(record, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ member: entry.input.metadata?.member_id, elapsedMs: result.elapsedMs,
    error: result.error, text: result.response?.text, pendingCalls: result.response?.raw?.output }));
}
if (record.results.some(result => result.error)) process.exitCode = 1;
