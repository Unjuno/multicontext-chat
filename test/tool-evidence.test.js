import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createToolEvidence, recordToolEvidence } from '../src/tool-evidence.js';
import { toolEvidenceLabel, compileToolAuditLabel, compileRecordMarkdown } from '../public/tool-evidence.js';
import { StateStore } from '../src/store.js';
import { Scheduler } from '../src/scheduler.js';
import { createApplication } from '../src/application.js';

test('tool evidence attributes safe bounded facts without copying peer prompts or inspected content', () => {
  const evidence = createToolEvidence();
  const calls = [
    { call_id: 'calc-1', name: 'calculate', arguments: '{"expression":"2/(1-3/6)"}' },
    { call_id: 'send-1', name: 'send_to_chat', arguments: '{"targets":["peer"],"prompt":"PRIVATE PEER CONTENT"}' },
    { call_id: 'search-1', name: 'search_sources', arguments: '{"query":"secret query","source":"papers"}' },
    { call_id: 'inspect-1', name: 'inspect_chat', arguments: '{"target":"peer","query":"PRIVATE QUERY"}' },
  ];
  const results = [
    { call_id: 'calc-1', output: '{"ok":true,"expression":"2/(1-3/6)","value":4,"arithmetic":"IEEE754_FLOAT64","proofVerified":true}' },
    { call_id: 'send-1', output: '{"replayed":true,"deliveries":[{"target":{"name":"Peer A"}}]}' },
    { call_id: 'search-1', output: '{"ok":false,"error":{"code":"SEARCH_UNAVAILABLE","message":"private detail"}}' },
    { call_id: 'inspect-1', output: '{"messages":[{"content":"PRIVATE INSPECTED CONTENT"}]}' },
  ];
  recordToolEvidence(evidence, calls, results);
  assert.deepEqual([evidence.attempted, evidence.succeeded, evidence.failed, evidence.replayed], [4, 2, 1, 1]);
  assert.deepEqual(evidence.calls[0].calculation, { expression: '2/(1-3/6)', value: 4, arithmetic: 'IEEE754_FLOAT64', proofVerified: false });
  assert.deepEqual(evidence.calls[1].delivery, { count: 1, targets: ['Peer A'] });
  assert.equal(evidence.calls[2].errorCode, 'SEARCH_UNAVAILABLE');
  assert.deepEqual(evidence.calls[3].inspection, { target: 'peer', resultCount: 1 });
  const serialized = JSON.stringify(evidence);
  for (const privateText of ['PRIVATE PEER CONTENT', 'secret query', 'private detail', 'PRIVATE QUERY', 'PRIVATE INSPECTED CONTENT']) {
    assert.ok(!serialized.includes(privateText));
  }
  assert.match(toolEvidenceLabel(evidence), /calculate×1/);
  assert.match(toolEvidenceLabel(evidence), /成功 2/);
  assert.match(toolEvidenceLabel(undefined), /旧履歴/);
  assert.match(toolEvidenceLabel(createToolEvidence()), /実行なし/);
});

test('tool evidence keeps eight calls and counts omitted records', () => {
  const evidence = createToolEvidence();
  for (let i = 0; i < 20; i++) recordToolEvidence(evidence,
    [{ call_id: `c${i}`, name: 'calculate', arguments: '{"expression":"1+1"}' }],
    [{ call_id: `c${i}`, output: '{"ok":true,"expression":"1+1","value":2}' }]);
  assert.equal(evidence.attempted, 20);
  assert.equal(evidence.calls.length, 8);
  assert.equal(evidence.omittedCalls, 12);
});

test('Compile audit label and export keep deterministic telemetry separate from model prose', () => {
  const toolAudit = { scope: 'COMPILE_SNAPSHOT_SCHEDULER_TOOL_AUDIT',
    totals: { attempted: 2, succeeded: 2, failed: 0, replayed: 0 },
    byTool: { calculate: { attempted: 1 }, search_sources: { attempted: 1 } }, calls: [],
    coverage: { sourceOmittedCalls: 0, unrecordedAssistantMessages: 0 } };
  assert.match(compileToolAuditLabel(toolAudit), /calculate×1/);
  assert.match(compileToolAuditLabel(toolAudit), /内容の正しさや証明を保証しません/);
  const markdown = compileRecordMarkdown({ text: 'MODEL SUMMARY', toolAudit });
  assert.match(markdown, /MultiContext確定ツール集計/);
  assert.match(markdown, /"attempted": 2/);
  assert.match(markdown, /モデルによる統合/);
  assert.match(markdown, /MODEL SUMMARY/);
  assert.equal(compileRecordMarkdown({ text: 'legacy' }), 'legacy');
  const appJs = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(appJs, /<details class="compile-audit">/);
  assert.match(appJs, /モデルによる統合（未検証）/);
});

test('scheduler persists calculator attribution for the correct member and Compile', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcc-tool-attribution-'));
  try {
    const store = new StateStore(path.join(dir, 'state.json'));
    const workspace = store.createWorkspace({ defaultAgentId: 'model', compileAgentId: 'model' });
    store.addMember(workspace.id, { name: 'Metadata verifier', agentId: 'model' });
    const algebra = store.addMember(workspace.id, { name: 'Algebra reviser', agentId: 'model' });
    let compilePrompt = '';
    const client = {
      mode: 'native', listAgents: async () => [{ id: 'model', name: 'Model' }],
      runAgent: async args => {
        if (args.metadata?.purpose === 'compile') { compilePrompt = args.prompt; return { id: 'compile', text: 'UNREVIEWED synthesis', raw: { output: [] } }; }
        return { id: 'first', conversationId: 'conv', text: '', raw: { output: [
          { type: 'function_call', call_id: 'calc-b2', name: 'calculate', arguments: '{"expression":"2/(1-3/6)"}' },
        ] } };
      },
      continueAgent: async () => ({ id: 'answer', conversationId: 'conv2', text: 'Delivered.', raw: { output: [] } }),
    };
    const scheduler = new Scheduler({ store, client });
    const app = createApplication({ config: {}, store, client, scheduler });
    scheduler.setApp(app);
    await app.send(workspace.id, algebra.id, 'calculate');
    while (scheduler.running.size) await new Promise(resolve => setTimeout(resolve, 5));
    const message = store.getMember(workspace.id, algebra.id).messages.filter(item => item.role === 'assistant').at(-1);
    assert.equal(message.toolEvidence.calls[0].callId, 'calc-b2');
    assert.equal(message.toolEvidence.calls[0].calculation.value, 4);
    const before = JSON.stringify(store.getWorkspace(workspace.id).members);
    await app.compile(workspace.id);
    assert.equal(JSON.stringify(store.getWorkspace(workspace.id).members), before);
    assert.match(compilePrompt, /Algebra reviser/);
    assert.match(compilePrompt, /calc-b2/);
    assert.match(compilePrompt, /"value": 4/);
    const audit = store.getWorkspace(workspace.id).lastCompile.toolAudit;
    assert.equal(audit.totals.attempted, 1);
    assert.equal(audit.byTool.calculate.attempted, 1);
    assert.deepEqual(audit.calls.map(call => [call.memberName, call.callId, call.calculation.value]), [['Algebra reviser', 'calc-b2', 4]]);
  } finally { fs.rmSync(dir, { recursive: true }); }
});
