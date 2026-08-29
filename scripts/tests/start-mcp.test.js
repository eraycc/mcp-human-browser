const test = require('node:test');
const assert = require('node:assert/strict');

const { main } = require('../start-mcp');

test('main starts once and final shutdown closes the claimed browser once', async () => {
  const calls = [];
  const browser = {
    kind: 'chrome',
    pid: 301,
    launchedByWrapper: true
  };
  const registry = {
    registerSession: async () => { calls.push('register'); },
    touchSession: async () => { calls.push('touch'); },
    unregisterSession: async () => {
      calls.push('unregister');
      return { isLastSession: true, browser, cleanupToken: 'cleanup-1' };
    },
    completeBrowserCleanup: async token => {
      calls.push('complete:' + token);
    }
  };
  const runtime = {
    ensureBrowser: async () => browser,
    closeOwnedBrowser: async record => {
      calls.push('close:' + record.pid);
    }
  };
  const proxy = {
    start: async () => { calls.push('proxy-start'); },
    stop: async () => { calls.push('proxy-stop'); }
  };

  const instance = await main({
    config: {
      heartbeatIntervalMs: 2000
    },
    registry,
    runtime,
    proxy,
    installSignalHandlers: false,
    log: () => {}
  });
  assert.deepEqual(calls, ['register', 'proxy-start']);

  await Promise.all([
    instance.shutdown('test'),
    instance.shutdown('test-again')
  ]);
  assert.deepEqual(calls, [
    'register',
    'proxy-start',
    'proxy-stop',
    'unregister',
    'close:301',
    'complete:cleanup-1'
  ]);
});
