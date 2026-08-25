import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const patchScript = path.resolve(here, '../scripts/patch-librechat.mjs');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcc-librechat-patch-'));
  const service = path.join(root, 'packages/api/src/agents/responses/service.ts');
  const controller = path.join(root, 'api/server/controllers/agents/responses.js');
  fs.mkdirSync(path.dirname(service), { recursive: true });
  fs.mkdirSync(path.dirname(controller), { recursive: true });
  fs.writeFileSync(service, [
    "export interface InternalMessage {",
    "  role: 'system' | 'user' | 'assistant' | 'tool';",
    "}",
    "// Map developer role to system (LibreChat convention)",
    "      let role: InternalMessage['role'];",
    "      if (messageItem.role === 'developer') {",
    "        role = 'system';",
  ].join('\n'));
  fs.writeFileSync(controller, [
    "const { v4: uuidv4 } = require('uuid');",
    "    const conversationId = request.previous_response_id ?? uuidv4();",
    "    const parentMessageId = null;",
    "    // Merge previous messages with new input",
    "    const allMessages = [...previousMessages, ...inputMessages];",
    "",
    "    const toolSet = buildToolSet(primaryConfig);",
    "    const formatted = formatAgentMessages(stripActivityLabelParts(allMessages), {}, toolSet);",
    "    const formattedMessages = formatted.messages;",
  ].join('\n'));
  return { root, service, controller };
}

test('LibreChat patch is idempotent and preserves developer + conversation continuation hooks', () => {
  const { root, service, controller } = fixture();
  const first = spawnSync(process.execPath, [patchScript, root], { encoding: 'utf8' });
  assert.equal(first.status, 0, first.stderr || first.stdout);
  const second = spawnSync(process.execPath, [patchScript, root], { encoding: 'utf8' });
  assert.equal(second.status, 0, second.stderr || second.stdout);
  assert.match(second.stdout, /already patched/);

  const serviceText = fs.readFileSync(service, 'utf8');
  const controllerText = fs.readFileSync(controller, 'utf8');
  assert.match(serviceText, /'developer'/);
  assert.match(serviceText, /role = 'developer'/);
  assert.match(controllerText, /ChatMessage/);
  assert.match(controllerText, /X-LibreChat-Conversation-Id/);
  assert.match(controllerText, /role: 'developer'/);
});
