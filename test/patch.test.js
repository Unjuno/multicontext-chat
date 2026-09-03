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
    "const db = require('~/models');",
    "  const request = envelope.payload;",
    "  const { principal } = envelope;",
    "    const conversationId = request.previous_response_id ?? uuidv4();",
    "    const parentMessageId = null;",
    "    // Merge previous messages with new input",
    "    const allMessages = [...previousMessages, ...inputMessages];",
    "",
    "    const toolSet = buildToolSet(primaryConfig);",
    "    const formatted = formatAgentMessages(stripActivityLabelParts(allMessages), {}, toolSet);",
    "    const formattedMessages = formatted.messages;",
    "      // Use Responses API-specific callback that emits librechat:attachment events",
    "      const toolEndCallback = createResponsesToolEndCallback({",
    "        req,",
    "        res,",
    "        tracker,",
    "        artifactPromises,",
    "      });",
    "",
    "      // Create tool execute options for event-driven tool execution",
    "      const toolExecuteOptions = {",
    "        loadTools: async (toolNames, agentId, _configurable, callerCapabilityProjection) => {",
    "          const ctx =",
    "      const toolEndCallback = createToolEndCallback({ req, res, artifactPromises, streamId: null });",
    "",
    "      const toolExecuteOptions = {",
    "        loadTools: async (toolNames, agentId, _configurable, callerCapabilityProjection) => {",
    "          const ctx =",
    "      await run.processStream({ messages: formattedMessages }, config, {",
    "        callbacks: {",
    "          [Callback.TOOL_ERROR]: (graph, error, toolId) => {",
    '            logger.error(`[Responses API] Tool Error "${toolId}"`, getSafeErrorMetadata(error));',
    "          },",
    "        },",
    "      });",
    "      await run.processStream({ messages: formattedMessages }, config, {",
    "        callbacks: {",
    "          [Callback.TOOL_ERROR]: (graph, error, toolId) => {",
    '            logger.error(`[Responses API] Tool Error "${toolId}"`, getSafeErrorMetadata(error));',
    "          },",
    "        },",
    "      });",
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
  // Upstream bug fix: Remote Agents API-key auth sets only req.user while
  // message persistence reads userId off the request object.
  assert.match(controllerText, /req\.userId = req\.userId \?\? req\.user\?\.id/);
  // Request-level cross-chat tools forwarding (native CROSS_CHAT_TOOLS).
  assert.match(controllerText, /req\._crossChatTools/);
  assert.match(controllerText, /primaryConfig\.toolDefinitions/);
  // Deferred/external execution: cross-chat tools are exposed to the model
  // but never executed inside LibreChat; the run turn unwinds so the caller
  // receives function_call items for external execution + continuation.
  assert.match(controllerText, /class ExternalCrossChatToolCall/);
  assert.match(controllerText, /EXTERNAL_TOOL_DEFERRED/);
  assert.match(controllerText, /AIMessage/);
  assert.match(controllerText, /new ToolMessage/);
  assert.match(controllerText, /isToolRoundTripMessage/);
  const deferrals = controllerText.match(/throwIfExternalCrossChatTools\(req, toolNames\);/g) || [];
  assert.equal(deferrals.length, 2);
  // Only the non-streaming branch (last processStream occurrence) unwinds;
  // the streaming branch keeps stock behavior.
  const catches = controllerText.match(/} catch \(streamError\) \{/g) || [];
  assert.equal(catches.length, 1);
  assert.ok(controllerText.lastIndexOf('await run.processStream') < controllerText.indexOf('} catch (streamError) {'));
});
