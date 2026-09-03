const test = require('node:test');
const assert = require('node:assert/strict');

const { main, cleanupStaleWrappers } = require('../start-mcp');

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

test('final shutdown aborts its cleanup claim when owned browser termination fails', async () => {
  const calls = [];
  const browser = {
    kind: 'chrome',
    pid: 301,
    launchedByWrapper: true
  };
  const registry = {
    registerSession: async () => {},
    touchSession: async () => {},
    unregisterSession: async () => ({
      isLastSession: true,
      browser,
      cleanupToken: 'cleanup-failure'
    }),
    completeBrowserCleanup: async () => {
      throw new Error('completion must not run');
    },
    abortBrowserCleanup: async (token, message) => {
      calls.push('abort:' + token + ':' + message);
    }
  };
  const runtime = {
    ensureBrowser: async () => browser,
    closeOwnedBrowser: async () => {
      throw new Error('BROWSER_OWNERSHIP_CHANGED');
    }
  };
  const proxy = {
    start: async () => {},
    stop: async () => {}
  };
  const instance = await main({
    config: { heartbeatIntervalMs: 2000 },
    registry,
    runtime,
    proxy,
    installSignalHandlers: false,
    log: () => {}
  });

  await assert.rejects(
    instance.shutdown('test-cleanup-failure'),
    /BROWSER_OWNERSHIP_CHANGED/
  );
  assert.deepEqual(calls, [
    'abort:cleanup-failure:BROWSER_OWNERSHIP_CHANGED'
  ]);
});

test('orphan wrapper cleanup kills only stale wrapper pids', async () => {
  const calls = [];
  const exec = (command, args, _options, callback) => {
    if (command === 'powershell.exe') {
      callback(null, JSON.stringify([
        { ProcessId: 999, ParentProcessId: 5, Name: 'node.exe' },
        { ProcessId: 1000, ParentProcessId: 6, Name: 'node.exe' }
      ]), '');
      return;
    }
    if (command === 'taskkill.exe') {
      calls.push(args);
      callback(null, '', '');
      return;
    }
    callback(null, '', '');
  };
  const result = await cleanupStaleWrappers({ selfPid: 999, exec });
  // Self pid 999 is excluded; only 1000 is killed.
  assert.deepEqual(result.swept, [1000]);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes('1000'));
});

test('orphan wrapper cleanup is a no-op when there are no stale wrappers', async () => {
  const exec = (command, _args, _options, callback) => {
    if (command === 'powershell.exe') {
      callback(null, '', '');
      return;
    }
    callback(null, '', '');
  };
  const result = await cleanupStaleWrappers({ selfPid: 999, exec });
  assert.deepEqual(result.swept, []);
});

test('orphan wrapper cleanup swallows a PowerShell failure', async () => {
  const exec = (command, _args, _options, callback) => {
    if (command === 'powershell.exe') {
      callback(new Error('CIM denied'), '', 'CIM denied');
      return;
    }
    callback(null, '', '');
  };
  const result = await cleanupStaleWrappers({ selfPid: 999, exec });
  assert.deepEqual(result.swept, []);
});
