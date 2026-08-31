import test from 'node:test';
import assert from 'node:assert/strict';
import { isLoopback, validateMcpConfig } from '../src/config.js';

test('isLoopback detects loopback', () => {
  assert.equal(isLoopback('127.0.0.1'), true);
  assert.equal(isLoopback('localhost'), true);
  assert.equal(isLoopback('::1'), true);
  assert.equal(isLoopback('::ffff:127.0.0.1'), true);
  assert.equal(isLoopback('LOCALHOST'), true);
  assert.equal(isLoopback(' 127.0.0.1 '), true);
});

test('isLoopback rejects non-loopback', () => {
  assert.equal(isLoopback('0.0.0.0'), false);
  assert.equal(isLoopback('::'), false);
  assert.equal(isLoopback('192.168.1.1'), false);
  assert.equal(isLoopback('10.0.0.1'), false);
  assert.equal(isLoopback('example.com'), false);
  assert.equal(isLoopback(''), false);
});

test('loopback + token empty => allowed', () => {
  assert.doesNotThrow(() => validateMcpConfig({ host: '127.0.0.1', mcpHost: '127.0.0.1', mcpEnabled: true, mcpToken: '' }));
  assert.doesNotThrow(() => validateMcpConfig({ host: 'localhost', mcpHost: 'localhost', mcpEnabled: true, mcpToken: '' }));
  assert.doesNotThrow(() => validateMcpConfig({ host: '::1', mcpHost: '::1', mcpEnabled: true, mcpToken: '' }));
});

test('loopback + token => allowed', () => {
  assert.doesNotThrow(() => validateMcpConfig({ host: '127.0.0.1', mcpHost: '127.0.0.1', mcpEnabled: true, mcpToken: 'tok' }));
});

test('0.0.0.0 + token => allowed', () => {
  assert.doesNotThrow(() => validateMcpConfig({ host: '0.0.0.0', mcpHost: '0.0.0.0', mcpEnabled: true, mcpToken: 'tok' }));
});

test('0.0.0.0 + token empty => rejection', () => {
  assert.throws(() => validateMcpConfig({ host: '0.0.0.0', mcpHost: '0.0.0.0', mcpEnabled: true, mcpToken: '' }), (e) => e.message.includes('MULTICONTEXT_MCP_TOKEN'));
});

test(':: + token empty => rejection', () => {
  assert.throws(() => validateMcpConfig({ host: '::', mcpHost: '::', mcpEnabled: true, mcpToken: '' }), (e) => e.message.includes('MULTICONTEXT_MCP_TOKEN'));
});

test('MCP disabled => no token requirement', () => {
  assert.doesNotThrow(() => validateMcpConfig({ host: '0.0.0.0', mcpHost: '0.0.0.0', mcpEnabled: false, mcpToken: '' }));
  assert.doesNotThrow(() => validateMcpConfig({ host: '::', mcpHost: '::', mcpEnabled: false, mcpToken: '' }));
});

test('mcpHost separate loopback check', () => {
  // host loopback but mcpHost non-loopback without token should still fail
  assert.throws(() => validateMcpConfig({ host: '127.0.0.1', mcpHost: '0.0.0.0', mcpEnabled: true, mcpToken: '' }), (e) => e.message.includes('MULTICONTEXT_MCP_TOKEN'));
  // host non-loopback but mcpHost loopback with no token? Should still fail because host is non-loopback
  assert.throws(() => validateMcpConfig({ host: '0.0.0.0', mcpHost: '127.0.0.1', mcpEnabled: true, mcpToken: '' }), (e) => e.message.includes('MULTICONTEXT_MCP_TOKEN'));
});
