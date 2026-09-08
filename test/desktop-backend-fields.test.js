import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

test('native backup success does not promise local startup settings are included', async () => {
  const html = fs.readFileSync(new URL('../public/desktop-startup.html', import.meta.url), 'utf8');
  const start = html.indexOf('document.getElementById("backupDataBtn").onclick');
  const end = html.indexOf('document.getElementById("dataDirBtn").onclick', start);
  assert.ok(start >= 0 && end > start);
  const fields = { backupDataBtn: {}, settingsErr: {} };
  const ctx = vm.createContext({
    document: { getElementById: id => fields[id] },
    invoke: async command => { assert.equal(command, 'backup_data'); return '/private/backup'; },
  });
  vm.runInContext(html.slice(start, end), ctx);
  await fields.backupDataBtn.onclick();
  assert.match(fields.settingsErr.textContent, /状態と会話履歴/);
  assert.match(fields.settingsErr.textContent, /起動設定は含みません/);
  assert.equal(fields.backupDataBtn.title, '/private/backup');
  assert.equal(fields.backupDataBtn.disabled, false);
});

test('local settings ignore unused LibreChat URL without weakening model URL checks', () => {
  const html = fs.readFileSync(new URL('../public/desktop-startup.html', import.meta.url), 'utf8');
  const start = html.indexOf('function validateSettings(cfg)');
  const end = html.indexOf('\n      function errorMessage', start);
  assert.ok(start >= 0 && end > start);
  const fields = {};
  const ctx = vm.createContext({ URL, document: { getElementById: id => fields[id] ||= { focus() {} } } });
  vm.runInContext(html.slice(start, end), ctx);
  ctx.cfg = { backend: 'local', librechat_url: 'unused-invalid', model_url: 'http://127.0.0.1:8080', manage_model: false, multicontext_port: 4317 };
  assert.equal(vm.runInContext('validateSettings(cfg)', ctx), true);
  ctx.cfg.backend = 'librechat';
  assert.equal(vm.runInContext('validateSettings(cfg)', ctx), false);
  ctx.cfg.backend = 'local'; ctx.cfg.model_url = 'not-a-url';
  assert.equal(vm.runInContext('validateSettings(cfg)', ctx), false);
});

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
