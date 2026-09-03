const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

const { createMcpProxy } = require('../mcp-proxy');

function fakeChild() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {
    queueMicrotask(() => child.emit('exit', 0, null));
    return true;
  };
  return child;
}

function decodeLines(stream, target) {
  let buffer = '';
  stream.on('data', chunk => {
    buffer += chunk.toString('utf8');
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) target.push(JSON.parse(line));
    }
  });
}

function tick() {
  return new Promise(resolve => setImmediate(resolve));
}

test('initial initialize request and initialized notification reach the MCP child', async () => {
  const clientInput = new PassThrough();
  const clientOutput = new PassThrough();
  const child = fakeChild();
  const childMessages = [];
  const responses = [];
  decodeLines(child.stdin, childMessages);
  decodeLines(clientOutput, responses);

  const proxy = createMcpProxy({
    clientInput,
    clientOutput,
    log: () => {},
    spawnChild: () => child,
    ensureBrowser: async () => {}
  });
  await proxy.start();

  clientInput.write(JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' }
    }
  }) + '\n');
  await tick();

  assert.equal(childMessages.length, 1);
  assert.equal(childMessages[0].method, 'initialize');

  child.stdout.write(JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    result: { protocolVersion: '2025-06-18', capabilities: {} }
  }) + '\n');
  await tick();
  assert.equal(responses[0].id, 1);

  clientInput.write(JSON.stringify({
    jsonrpc: '2.0',
    method: 'notifications/initialized',
    params: {}
  }) + '\n');
  await tick();

  assert.equal(childMessages.length, 2);
  assert.equal(childMessages[1].method, 'notifications/initialized');
  await proxy.stop();
});

test('a completed initialize request is not failed again when the child restarts', async () => {
  const clientInput = new PassThrough();
  const clientOutput = new PassThrough();
  const first = fakeChild();
  const second = fakeChild();
  const firstMessages = [];
  const secondMessages = [];
  const responses = [];
  decodeLines(first.stdin, firstMessages);
  decodeLines(second.stdin, secondMessages);
  decodeLines(clientOutput, responses);
  const children = [first, second];
  let spawnCalls = 0;

  const proxy = createMcpProxy({
    clientInput,
    clientOutput,
    log: () => {},
    spawnChild: () => children[spawnCalls++],
    ensureBrowser: async () => {}
  });
  await proxy.start();

  clientInput.write(JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' }
    }
  }) + '\n');
  await tick();
  first.stdout.write(JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    result: { protocolVersion: '2025-06-18', capabilities: {} }
  }) + '\n');
  await tick();
  clientInput.write(JSON.stringify({
    jsonrpc: '2.0',
    method: 'notifications/initialized',
    params: {}
  }) + '\n');
  await tick();

  first.emit('exit', 1, null);
  await tick();
  const internal = secondMessages.find(message =>
    String(message.id || '').startsWith('__human_browser_reinit_')
  );
  assert.ok(internal);
  assert.equal(responses.filter(message => message.id === 1).length, 1);

  second.stdout.write(JSON.stringify({
    jsonrpc: '2.0',
    id: internal.id,
    result: { protocolVersion: '2025-06-18', capabilities: {} }
  }) + '\n');
  await tick();
  await proxy.stop();
});

test('an interrupted initialize request cannot capture a reused request id after recovery', async () => {
  const clientInput = new PassThrough();
  const clientOutput = new PassThrough();
  const first = fakeChild();
  const second = fakeChild();
  const secondMessages = [];
  const responses = [];
  decodeLines(second.stdin, secondMessages);
  decodeLines(clientOutput, responses);
  const children = [first, second];
  let spawnCalls = 0;

  const proxy = createMcpProxy({
    clientInput,
    clientOutput,
    log: () => {},
    spawnChild: () => children[spawnCalls++],
    ensureBrowser: async () => {}
  });
  await proxy.start();
  clientInput.write(JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' }
    }
  }) + '\n');
  await tick();

  first.emit('exit', 1, null);
  await tick();
  const internal = secondMessages.find(message =>
    String(message.id || '').startsWith('__human_browser_reinit_')
  );
  assert.ok(internal);
  second.stdout.write(JSON.stringify({
    jsonrpc: '2.0',
    id: internal.id,
    result: { protocolVersion: '2025-06-18', capabilities: {} }
  }) + '\n');
  await tick();

  clientInput.write(JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/list',
    params: {}
  }) + '\n');
  await tick();
  second.stdout.write(JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    result: { tools: [] }
  }) + '\n');
  await tick();

  const listed = responses.find(message =>
    message.id === 1 &&
    message.result &&
    Array.isArray(message.result.tools)
  );
  assert.ok(listed);
  assert.equal(
    listed.result.tools.some(tool => tool.name === 'close_browser_window'),
    true
  );
  await proxy.stop();
});

test('tools/list exposes close_browser_window with a valid MCP tool name', async () => {
  const clientInput = new PassThrough();
  const clientOutput = new PassThrough();
  const child = fakeChild();
  const childMessages = [];
  const responses = [];
  decodeLines(child.stdin, childMessages);
  decodeLines(clientOutput, responses);

  const proxy = createMcpProxy({
    clientInput,
    clientOutput,
    log: () => {},
    spawnChild: () => child,
    ensureBrowser: async () => {}
  });
  await proxy.start();

  clientInput.write(JSON.stringify({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list',
    params: {}
  }) + '\n');
  await tick();
  assert.equal(childMessages[0].method, 'tools/list');

  child.stdout.write(JSON.stringify({
    jsonrpc: '2.0',
    id: 2,
    result: {
      tools: [{
        name: 'list_pages',
        description: 'List pages',
        inputSchema: { type: 'object' }
      }],
      nextCursor: 'upstream-cursor'
    }
  }) + '\n');
  await tick();

  const listed = responses.find(message => message.id === 2);
  assert.ok(listed);
  assert.deepEqual(
    listed.result.tools.map(tool => tool.name),
    ['close_browser_window', 'list_pages']
  );
  assert.equal(listed.result.nextCursor, 'upstream-cursor');
  await proxy.stop();
});

test('server requests that reuse a client id do not consume tools/list correlation', async () => {
  const clientInput = new PassThrough();
  const clientOutput = new PassThrough();
  const child = fakeChild();
  const responses = [];
  decodeLines(clientOutput, responses);

  const proxy = createMcpProxy({
    clientInput,
    clientOutput,
    log: () => {},
    spawnChild: () => child,
    ensureBrowser: async () => {}
  });
  await proxy.start();

  clientInput.write(JSON.stringify({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list',
    params: {}
  }) + '\n');
  await tick();
  child.stdout.write(JSON.stringify({
    jsonrpc: '2.0',
    id: 2,
    method: 'sampling/createMessage',
    params: {}
  }) + '\n');
  await tick();
  child.stdout.write(JSON.stringify({
    jsonrpc: '2.0',
    id: 2,
    result: { tools: [] }
  }) + '\n');
  await tick();

  const listed = responses.find(message =>
    message.id === 2 && message.result && Array.isArray(message.result.tools)
  );
  assert.ok(listed);
  assert.equal(
    listed.result.tools.some(tool => tool.name === 'close_browser_window'),
    true
  );
  await proxy.stop();
});

test('tools/list is immediate and tools/call waits for one browser ensure', async () => {
  const clientInput = new PassThrough();
  const clientOutput = new PassThrough();
  const child = fakeChild();
  const childMessages = [];
  decodeLines(child.stdin, childMessages);
  let ensureCalls = 0;
  let releaseEnsure;
  const gate = new Promise(resolve => { releaseEnsure = resolve; });

  const proxy = createMcpProxy({
    clientInput,
    clientOutput,
    log: () => {},
    spawnChild: () => child,
    ensureBrowser: async () => {
      ensureCalls += 1;
      await gate;
    }
  });
  await proxy.start();

  clientInput.write(JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/list',
    params: {}
  }) + '\n');
  await tick();
  assert.equal(childMessages[0].method, 'tools/list');
  assert.equal(ensureCalls, 0);

  clientInput.write(JSON.stringify({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'list_pages', arguments: {} }
  }) + '\n');
  await tick();
  assert.equal(ensureCalls, 1);
  assert.equal(childMessages.some(message => message.id === 2), false);

  releaseEnsure();
  await tick();
  assert.equal(childMessages.filter(message => message.id === 2).length, 1);
  await proxy.stop();
});

test('close_browser_window is local and requires shared wrapper ownership and user intent', async () => {
  const clientInput = new PassThrough();
  const clientOutput = new PassThrough();
  const child = fakeChild();
  const childMessages = [];
  const responses = [];
  decodeLines(child.stdin, childMessages);
  decodeLines(clientOutput, responses);
  const calls = [];
  const proxy = createMcpProxy({
    clientInput,
    clientOutput,
    log: () => {},
    spawnChild: () => child,
    ensureBrowser: async () => {},
    claimBrowserClose: async intent => {
      calls.push('claim:' + intent);
      return {
        allowed: true,
        closeNow: true,
        intent,
        reason: 'CLOSE_ALLOWED',
        browser: { pid: 301, launchedByWrapper: true },
        browserPid: 301,
        cleanupToken: 'cleanup-301',
        sharedByOtherSessions: true
      };
    },
    completeBrowserCleanup: async token => {
      calls.push('complete:' + token);
    },
    abortBrowserCleanup: async () => {
      throw new Error('abort must not run after a successful close');
    },
    closeOwnedBrowser: async browser => {
      calls.push('close:' + browser.pid);
    }
  });
  await proxy.start();

  clientInput.write(JSON.stringify({
    jsonrpc: '2.0',
    id: 10,
    method: 'tools/call',
    params: {
      name: 'close_browser_window',
      arguments: {
        intent: 'close-after-requested',
        reason: 'user asked to close the browser window'
      }
    }
  }) + '\n');
  await tick();
  await tick();

  const closed = responses.find(message => message.id === 10);
  assert.ok(closed, 'close_browser_window should answer locally');
  assert.equal(closed.error, undefined);
  const text = closed.result.content.find(item => item.type === 'text').text;
  assert.match(text, /"closed":true/);
  assert.match(text, /"sharedByOtherSessions":true/);
  assert.doesNotMatch(text, /deferredToFinalSession/);
  assert.equal(closed.result.isError, false);
  assert.deepEqual(calls, [
    'claim:close-after-requested',
    'close:301',
    'complete:cleanup-301'
  ]);
  assert.equal(childMessages.some(message => message.id === 10), false);
  await proxy.stop();
});

test('proxy stop waits for an in-flight local browser close', async () => {
  const clientInput = new PassThrough();
  const clientOutput = new PassThrough();
  const child = fakeChild();
  let releaseClose;
  let signalCloseStarted;
  const closeStarted = new Promise(resolve => {
    signalCloseStarted = resolve;
  });
  const closeGate = new Promise(resolve => {
    releaseClose = resolve;
  });
  const calls = [];

  const proxy = createMcpProxy({
    clientInput,
    clientOutput,
    log: () => {},
    spawnChild: () => child,
    ensureBrowser: async () => {},
    claimBrowserClose: async () => ({
      allowed: true,
      closeNow: true,
      reason: 'CLOSE_ALLOWED',
      browser: { pid: 301, launchedByWrapper: true },
      browserPid: 301,
      cleanupToken: 'cleanup-301',
      sharedByOtherSessions: false
    }),
    closeOwnedBrowser: async () => {
      calls.push('close-started');
      signalCloseStarted();
      await closeGate;
      calls.push('close-finished');
    },
    completeBrowserCleanup: async token => {
      calls.push('complete:' + token);
    }
  });
  await proxy.start();

  clientInput.write(JSON.stringify({
    jsonrpc: '2.0',
    id: 14,
    method: 'tools/call',
    params: {
      name: 'close_browser_window',
      arguments: {
        intent: 'close-after-requested',
        reason: 'user requested close'
      }
    }
  }) + '\n');
  await closeStarted;

  let stopResolved = false;
  const stopping = proxy.stop().then(() => {
    stopResolved = true;
  });
  await tick();
  assert.equal(stopResolved, false);
  assert.deepEqual(calls, ['close-started']);

  releaseClose();
  await stopping;
  assert.deepEqual(calls, [
    'close-started',
    'close-finished',
    'complete:cleanup-301'
  ]);
});

test('close_browser_window preserves an in-flight shared close result without deferral', async () => {
  const clientInput = new PassThrough();
  const clientOutput = new PassThrough();
  const child = fakeChild();
  const childMessages = [];
  const responses = [];
  decodeLines(child.stdin, childMessages);
  decodeLines(clientOutput, responses);
  const calls = [];

  const proxy = createMcpProxy({
    clientInput,
    clientOutput,
    log: () => {},
    spawnChild: () => child,
    ensureBrowser: async () => {},
    claimBrowserClose: async intent => {
      calls.push('claim:' + intent);
      return {
        allowed: true,
        closeNow: false,
        intent,
        reason: 'BROWSER_NOT_READY',
        browser: null,
        browserPid: 302,
        cleanupToken: null,
        sharedByOtherSessions: true
      };
    },
    completeBrowserCleanup: async token => {
      calls.push('complete:' + token);
    },
    abortBrowserCleanup: async token => {
      calls.push('abort:' + token);
    },
    closeOwnedBrowser: async browser => {
      calls.push('close:' + browser.pid);
    }
  });
  await proxy.start();

  clientInput.write(JSON.stringify({
    jsonrpc: '2.0',
    id: 11,
    method: 'tools/call',
    params: {
      name: 'close_browser_window',
      arguments: {
        intent: 'close-after-task',
        reason: 'user requested close after task completion'
      }
    }
  }) + '\n');
  await tick();
  await tick();

  const closed = responses.find(message => message.id === 11);
  assert.ok(closed);
  const text = closed.result.content.find(item => item.type === 'text').text;
  assert.match(text, /"closed":false/);
  assert.match(text, /BROWSER_NOT_READY/);
  assert.match(text, /"sharedByOtherSessions":true/);
  assert.doesNotMatch(text, /deferredToFinalSession/);
  assert.deepEqual(calls, ['claim:close-after-task']);
  await proxy.stop();
});

test('close_browser_window does not close when ownership is not authorized', async () => {
  const clientInput = new PassThrough();
  const clientOutput = new PassThrough();
  const child = fakeChild();
  const childMessages = [];
  const responses = [];
  decodeLines(child.stdin, childMessages);
  decodeLines(clientOutput, responses);
  const calls = [];

  const proxy = createMcpProxy({
    clientInput,
    clientOutput,
    log: () => {},
    spawnChild: () => child,
    ensureBrowser: async () => {},
    claimBrowserClose: async intent => {
      calls.push('claim:' + intent);
      throw new Error('an unauthorized invocation must not claim a browser close');
    },
    completeBrowserCleanup: async token => {
      calls.push('complete:' + token);
    },
    abortBrowserCleanup: async token => {
      calls.push('abort:' + token);
    },
    closeOwnedBrowser: async browser => {
      calls.push('close:' + browser.pid);
    }
  });
  await proxy.start();

  clientInput.write(JSON.stringify({
    jsonrpc: '2.0',
    id: 12,
    method: 'tools/call',
    params: {
      name: 'close_browser_window',
      arguments: {
        intent: 'keep',
        reason: 'no explicit close authorization'
      }
    }
  }) + '\n');
  await tick();
  await tick();

  const closed = responses.find(message => message.id === 12);
  assert.ok(closed);
  const text = closed.result.content.find(item => item.type === 'text').text;
  assert.match(text, /"closed":false/);
  assert.match(text, /BROWSER_CLOSE_NOT_AUTHORIZED/);
  assert.deepEqual(calls, []);
  assert.equal(childMessages.some(message => message.id === 12), false);
  await proxy.stop();
});

test('close_browser_window reports close failure when ownership changes before termination', async () => {
  const clientInput = new PassThrough();
  const clientOutput = new PassThrough();
  const child = fakeChild();
  const childMessages = [];
  const responses = [];
  decodeLines(child.stdin, childMessages);
  decodeLines(clientOutput, responses);
  const calls = [];

  const proxy = createMcpProxy({
    clientInput,
    clientOutput,
    log: () => {},
    spawnChild: () => child,
    ensureBrowser: async () => {},
    claimBrowserClose: async intent => {
      calls.push('claim:' + intent);
      return {
        allowed: true,
        closeNow: true,
        intent,
        reason: 'CLOSE_ALLOWED',
        browser: { pid: 301, launchedByWrapper: true },
        browserPid: 301,
        cleanupToken: 'cleanup-301',
        sharedByOtherSessions: false
      };
    },
    completeBrowserCleanup: async token => {
      calls.push('complete:' + token);
    },
    abortBrowserCleanup: async (token, message) => {
      calls.push('abort:' + token + ':' + message);
    },
    closeOwnedBrowser: async browser => {
      calls.push('close:' + browser.pid);
      throw new Error('BROWSER_OWNERSHIP_CHANGED: cleanup fingerprint did not match');
    }
  });
  await proxy.start();

  clientInput.write(JSON.stringify({
    jsonrpc: '2.0',
    id: 13,
    method: 'tools/call',
    params: {
      name: 'close_browser_window',
      arguments: {
        intent: 'close-after-task',
        reason: 'task completed; user authorized close'
      }
    }
  }) + '\n');
  await tick();
  await tick();

  const closed = responses.find(message => message.id === 13);
  assert.ok(closed);
  const text = closed.result.content.find(item => item.type === 'text').text;
  assert.match(text, /"closed":false/);
  assert.match(text, /BROWSER_CLOSE_FAILED/);
  assert.match(text, /BROWSER_OWNERSHIP_CHANGED/);
  assert.deepEqual(calls, [
    'claim:close-after-task',
    'close:301',
    'abort:cleanup-301:BROWSER_OWNERSHIP_CHANGED: cleanup fingerprint did not match'
  ]);
  assert.equal(closed.result.isError, true);
  assert.equal(childMessages.some(message => message.id === 13), false);
  await proxy.stop();
});

test('browser startup failure returns the original request id', async () => {
  const clientInput = new PassThrough();
  const clientOutput = new PassThrough();
  const child = fakeChild();
  const responses = [];
  decodeLines(clientOutput, responses);

  const proxy = createMcpProxy({
    clientInput,
    clientOutput,
    log: () => {},
    spawnChild: () => child,
    ensureBrowser: async () => {
      throw new Error('BROWSER_NOT_FOUND: Chrome and Edge were not detected');
    }
  });
  await proxy.start();
  clientInput.write(JSON.stringify({
    jsonrpc: '2.0',
    id: 7,
    method: 'tools/call',
    params: { name: 'list_pages', arguments: {} }
  }) + '\n');
  await tick();
  assert.equal(responses[0].id, 7);
  assert.equal(responses[0].error.code, -32070);
  assert.match(responses[0].error.message, /BROWSER_NOT_FOUND/);
  await proxy.stop();
});

test('child recovery retries when the first replacement cannot spawn', async () => {
  const clientInput = new PassThrough();
  const clientOutput = new PassThrough();
  const first = fakeChild();
  const replacement = fakeChild();
  const firstMessages = [];
  const replacementMessages = [];
  decodeLines(first.stdin, firstMessages);
  decodeLines(replacement.stdin, replacementMessages);
  let spawnCalls = 0;

  const proxy = createMcpProxy({
    clientInput,
    clientOutput,
    log: () => {},
    spawnChild: () => {
      spawnCalls += 1;
      if (spawnCalls === 1) return first;
      if (spawnCalls === 2) throw new Error('replacement spawn failed');
      return replacement;
    },
    ensureBrowser: async () => {}
  });
  await proxy.start();

  clientInput.write(JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' }
    }
  }) + '\n');
  await tick();
  first.stdout.write(JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    result: { protocolVersion: '2025-06-18', capabilities: {} }
  }) + '\n');
  clientInput.write(JSON.stringify({
    jsonrpc: '2.0',
    method: 'notifications/initialized',
    params: {}
  }) + '\n');
  await tick();

  first.emit('exit', 1, null);
  await tick();
  await tick();

  assert.equal(spawnCalls, 3);
  assert.equal(
    replacementMessages.some(message =>
      String(message.id || '').startsWith('__human_browser_reinit_')
    ),
    true
  );
  await proxy.stop();
});

test('child recovery rejects an initialize error and tries the next replacement', async () => {
  const clientInput = new PassThrough();
  const clientOutput = new PassThrough();
  const first = fakeChild();
  const second = fakeChild();
  const third = fakeChild();
  const secondMessages = [];
  const thirdMessages = [];
  decodeLines(second.stdin, secondMessages);
  decodeLines(third.stdin, thirdMessages);
  const children = [first, second, third];
  let spawnCalls = 0;

  const proxy = createMcpProxy({
    clientInput,
    clientOutput,
    log: () => {},
    spawnChild: () => children[spawnCalls++],
    ensureBrowser: async () => {},
    initializeTimeoutMs: 1000
  });
  await proxy.start();

  clientInput.write(JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' }
    }
  }) + '\n');
  await tick();
  first.stdout.write(JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    result: { protocolVersion: '2025-06-18', capabilities: {} }
  }) + '\n');
  await tick();

  first.emit('exit', 1, null);
  await tick();
  const internal = secondMessages.find(message =>
    String(message.id || '').startsWith('__human_browser_reinit_')
  );
  assert.ok(internal);
  second.stdout.write(JSON.stringify({
    jsonrpc: '2.0',
    id: internal.id,
    error: { code: -32603, message: 'initialize failed' }
  }) + '\n');
  await tick();
  await tick();

  assert.equal(spawnCalls, 3);
  assert.equal(
    thirdMessages.some(message =>
      String(message.id || '').startsWith('__human_browser_reinit_')
    ),
    true
  );
  await proxy.stop();
});
