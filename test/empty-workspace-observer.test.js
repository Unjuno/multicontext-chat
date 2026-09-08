import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

test('unselected workspace refresh discovers externally created workspaces', async () => {
  const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const start = source.indexOf('async function refresh(expectedId = currentId) {');
  const end = source.indexOf('  refreshController?.abort();', start);
  assert.ok(start >= 0 && end > start);
  let lists = 0;
  const ctx = vm.createContext({ currentId: null, refreshList: async expected => {
    assert.equal(expected, null); lists++;
  } });
  // Execute the production early-return branch, without a synthetic DOM or
  // a model request. The rest is the selected-workspace refresh path.
  vm.runInContext(source.slice(start, end) + 'throw Error("unexpected selected path");}', ctx);
  await vm.runInContext('refresh()', ctx);
  assert.equal(lists, 1);
  assert.match(source, /initRuntimeStatus\(\);\s*\/\/[^\n]*\n\s*scheduleNext\(\);/);
});
