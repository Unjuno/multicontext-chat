#!/usr/bin/env node
// Recheck saved traces without issuing model requests or overwriting run results.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createSearchEvidence, recordSearchEvidence } from '../src/search-evidence.js';

if (!process.argv[2]) throw new Error('Specify an existing ns-structure experiment directory');
const directory = path.resolve(process.argv[2]);
const raw = fs.readFileSync(path.join(directory, 'trace.json'), 'utf8');
const trace = JSON.parse(raw);
const { roles } = JSON.parse(fs.readFileSync(path.join(directory, 'setup.json'), 'utf8'));
const members = roles.map(role => {
  const evidence = createSearchEvidence();
  for (const turn of trace.filter(t => t.method === 'continueAgent' && t.input.metadata?.member_id === role.id)) {
    const items = turn.input.orderedItems || [];
    recordSearchEvidence(evidence, items.filter(i => i.type === 'function_call'), items.filter(i => i.type === 'function_call_output'));
  }
  return { memberId: role.id, name: role.name, evidence };
});
const audit = { checkedAt: new Date().toISOString(), traceSha256: createHash('sha256').update(raw).digest('hex'),
  scope: 'RECORDED_MULTICONTEXT_TOOL_RESULTS_ONLY', members,
  allRolesSearched: members.every(m => m.evidence.succeeded > 0), mathematicalProof: 'NOT_ESTABLISHED' };
fs.writeFileSync(path.join(directory, `search-evidence-recheck-${Date.now()}.json`), JSON.stringify(audit, null, 2), { mode: 0o600, flag: 'wx' });
console.log(JSON.stringify(audit, null, 2));
