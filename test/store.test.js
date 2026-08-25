import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StateStore, searchMemberMessages } from '../src/store.js';

const makeStore = () => new StateStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mcc-')), 'state.json'));

test('broadcast fans out into independent FIFO queues', () => {
  const store = makeStore();
  const workspace = store.createWorkspace({ name: 'x' });
  const a = store.addMember(workspace.id, { name: 'A' });
  const b = store.addMember(workspace.id, { name: 'B' });
  store.broadcast(workspace.id, 'hello');
  assert.equal(store.requireMember(workspace.id, a.id).member.queue.length, 1);
  assert.equal(store.requireMember(workspace.id, b.id).member.queue.length, 1);
  assert.notEqual(store.requireMember(workspace.id, a.id).member.queue, store.requireMember(workspace.id, b.id).member.queue);
});

test('search returns relevant snippets, not whole foreign history', () => {
  const store = makeStore();
  const workspace = store.createWorkspace();
  const member = store.addMember(workspace.id, { name: 'A' });

  store.enqueue(workspace.id, member.id, 'question one');
  const first = store.beginNext(workspace.id, member.id);
  store.completeRun(workspace.id, member.id, first.item.id, { id: 'r1', text: 'alpha beta' });

  store.enqueue(workspace.id, member.id, 'question two');
  const second = store.beginNext(workspace.id, member.id);
  store.completeRun(workspace.id, member.id, second.item.id, { id: 'r2', text: 'unrelated' });

  const results = searchMemberMessages(store.requireMember(workspace.id, member.id).member, 'alpha', 5);
  assert.equal(results.length, 1);
  assert.match(results[0].content, /alpha/);
});
