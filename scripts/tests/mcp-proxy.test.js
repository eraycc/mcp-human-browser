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
