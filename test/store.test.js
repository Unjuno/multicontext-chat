import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StateStore, searchMemberMessages } from '../src/store.js';

const makeStore=()=>new StateStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(),'mcc-')),'state.json'));
test('broadcast fans out into independent FIFO queues',()=>{const s=makeStore();const w=s.createWorkspace({name:'x'});const a=s.addMember(w.id,{name:'A'});const b=s.addMember(w.id,{name:'B'});s.broadcast(w.id,'hello');assert.equal(s.requireMember(w.id,a.id).member.queue.length,1);assert.equal(s.requireMember(w.id,b.id).member.queue.length,1);assert.notEqual(s.requireMember(w.id,a.id).member.queue,s.requireMember(w.id,b.id).member.queue)});
test('search returns relevant snippets, not whole foreign history',()=>{const s=makeStore();const w=s.createWorkspace();const a=s.addMember(w.id,{name:'A'});s.appendMessage(w.id,a.id,{role:'assistant',content:'alpha beta'});s.appendMessage(w.id,a.id,{role:'assistant',content:'unrelated'});const r=searchMemberMessages(s.requireMember(w.id,a.id).member,'alpha',5);assert.equal(r.length,1);assert.match(r[0].content,/alpha/)});
