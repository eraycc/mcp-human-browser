#!/usr/bin/env node
'use strict';

const { spawn } = require('node:child_process');
const readline = require('node:readline');
const path = require('node:path');
const { assertSmokeResults } = require('../live-smoke-assertions');

const entry = path.resolve(__dirname, '..', 'start-mcp.js');
const child = spawn(process.execPath, [entry], {
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
});

const pending = new Map();
let stderr = '';
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-16384); });

const lines = readline.createInterface({ input: child.stdout });
lines.on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  const waiter = pending.get(message.id);
  if (waiter) {
    pending.delete(message.id);
    waiter.resolve(message);
  }
});

function request(id, method, params, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timed out waiting for response ${id} (${method})`));
    }, timeoutMs);
    pending.set(id, {
      resolve(message) {
        clearTimeout(timer);
        resolve(message);
      },
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

async function listenerAvailable() {
  try {
    const response = await fetch('http://127.0.0.1:9222/json/version', {
      signal: AbortSignal.timeout(1000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForListener(expected, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await listenerAvailable()) === expected) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

function responseText(response) {
  return (response.result?.content || [])
    .filter((item) => item.type === 'text')
    .map((item) => item.text)
    .join('\n');
}

function parseWebdriver(response) {
  const output = responseText(response);
  const named = output.match(/["']?webdriver["']?\s*:\s*(true|false)/i);
  if (named) return named[1].toLowerCase() === 'true';

  const scalar = output.match(/(?:^|[\s`])(true|false)(?:[\s`]|$)/i);
  if (scalar) return scalar[1].toLowerCase() === 'true';

  throw new Error(`Could not parse navigator.webdriver from evaluate_script response: ${output}`);
}

async function collectSmokeResults() {
  const result = {
    listenerBefore: await listenerAvailable(),
  };

  const initialized = await request(1, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'mcp-human-browser-live-smoke', version: '1.0.0' },
  }, 30000);
  if (initialized.error) {
    throw new Error(`initialize failed: ${JSON.stringify(initialized.error)}`);
  }
  notify('notifications/initialized', {});

  result.listenerAfterInitialize = await listenerAvailable();

  const tools = await request(2, 'tools/list', {}, 30000);
  if (tools.error) throw new Error(`tools/list failed: ${JSON.stringify(tools.error)}`);
  const evaluateTool = tools.result?.tools?.find((tool) => tool.name === 'evaluate_script');
  result.pageIdRequired = Boolean(evaluateTool?.inputSchema?.required?.includes('pageId'));

  const pages = await request(3, 'tools/call', {
    name: 'list_pages',
    arguments: {},
  }, 60000);
  if (pages.error) throw new Error(`list_pages failed: ${JSON.stringify(pages.error)}`);
  result.listenerDuring = await waitForListener(true);

  const pageText = responseText(pages);
  const pageMatch = pageText.match(/^([0-9]+):/m);
  if (!pageMatch) throw new Error('list_pages did not return a numeric page ID');

  const evaluated = await request(4, 'tools/call', {
    name: 'evaluate_script',
    arguments: {
      pageId: Number(pageMatch[1]),
      function: '() => ({ webdriver: navigator.webdriver, userAgent: navigator.userAgent })',
      waitForStableDom: false,
    },
  }, 30000);
  if (evaluated.error) throw new Error(`evaluate_script failed: ${JSON.stringify(evaluated.error)}`);

  result.webdriver = parseWebdriver(evaluated);
  result.protocolVersion = initialized.result?.protocolVersion;
  result.unknownArgumentWarning = /Unknown arguments?/i.test(stderr);
  return result;
}

async function stopChild() {
  if (!child.killed) child.stdin.end();
  const exited = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 25000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
  if (!exited) child.kill();
  return waitForListener(false, 10000);
}

async function run() {
  let result;
  let failure;
  try {
    result = await collectSmokeResults();
  } catch (error) {
    failure = error;
  }

  const listenerClosed = await stopChild();

  if (failure) {
    throw new Error(`${failure.stack}\nlistenerAfterExit=${!listenerClosed}\n${stderr}`);
  }

  result.listenerAfterExit = !listenerClosed;
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  assertSmokeResults(result);
}

run().catch((error) => {
  process.stderr.write(error.stack + '\n');
  process.exitCode = 1;
});
