// Explicit deployed llama-server template check; does not invoke generation.
import assert from 'node:assert/strict';
const base = new URL(process.argv[2] || 'http://127.0.0.1:8080');
assert.equal(base.protocol, 'http:');
assert.ok(['127.0.0.1', '[::1]'].includes(base.hostname));
const markers = ['MCC_SYSTEM_ROLE_438', 'MCC_DEVELOPER_ROLE_438', 'MCC_USER_ROLE_438'];
const response = await fetch(new URL('/apply-template', base), {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ messages: ['system', 'developer', 'user'].map((role, i) => ({ role, content: markers[i] })) }),
  signal: AbortSignal.timeout(5000), redirect: 'error',
});
assert.ok(response.ok, `Template endpoint HTTP ${response.status}`);
const { prompt } = await response.json();
assert.equal(typeof prompt, 'string');
for (let i = 0; i < markers.length; i++) {
  assert.equal(prompt.split(markers[i]).length - 1, 1, `${['system', 'developer', 'user'][i]} instruction must occur exactly once`);
  const position = prompt.indexOf(markers[i]);
  const role = ['system', 'developer', 'user'][i];
  assert.ok(prompt.lastIndexOf(`<|start|>${role}`, position) > prompt.lastIndexOf('<|end|>', position), `${role} instruction in wrong role`);
}
assert.ok(prompt.indexOf(markers[0]) < prompt.indexOf(markers[1]) && prompt.indexOf(markers[1]) < prompt.indexOf(markers[2]));
console.log('Deployed system/developer/user role preservation verified');
