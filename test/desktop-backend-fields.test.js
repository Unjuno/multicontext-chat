import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

test('native settings hide only LibreChat fields in local mode and preserve their values', () => {
  const html = fs.readFileSync(new URL('../public/desktop-startup.html', import.meta.url), 'utf8');
  const start = html.indexOf('function updateBackendFields()');
  const end = html.indexOf('\n      document.getElementById("backend").addEventListener', start);
  assert.ok(start >= 0 && end > start);
  const elements = Object.fromEntries(['backend', 'backendHelp', 'librechatPath', 'apiKey', 'librechatUrl'].map(id => {
    const field = { hidden: false };
    return [id, { value: id === 'backend' ? 'local' : `preserved-${id}`, closest: selector => {
      assert.equal(selector, '.field'); return field;
    }, field }];
  }));
  const ctx = vm.createContext({ document: { getElementById: id => elements[id] } });
  vm.runInContext(html.slice(start, end), ctx);
  vm.runInContext('updateBackendFields()', ctx);
  for (const id of ['librechatPath', 'apiKey', 'librechatUrl']) {
    assert.equal(elements[id].field.hidden, true);
    assert.equal(elements[id].value, `preserved-${id}`);
  }
  assert.match(elements.backendHelp.textContent, /不要/);
  elements.backend.value = 'librechat';
  vm.runInContext('updateBackendFields()', ctx);
  for (const id of ['librechatPath', 'apiKey', 'librechatUrl']) assert.equal(elements[id].field.hidden, false);
});
