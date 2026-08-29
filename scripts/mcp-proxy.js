function createJsonLineDecoder(onMessage, onError) {
  let buffer = '';
  return chunk => {
    buffer += chunk.toString('utf8');
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      try {
        onMessage(JSON.parse(line));
      } catch (error) {
        onError(error, line);
      }
    }
  };
}

function writeJsonLine(stream, message) {
  stream.write(JSON.stringify(message) + '\n');
}

function cloneMessage(message) {
  return JSON.parse(JSON.stringify(message));
}

function createMcpProxy(options) {
  const { clientInput, clientOutput, spawnChild, ensureBrowser } = options;
  const log = options.log || (() => {});
  const initializeTimeoutMs = options.initializeTimeoutMs || 10000;
  const maxRestartAttempts = options.maxRestartAttempts || 2;
  let child = null;
  let stopping = false;
  let started = false;
  let ensurePromise = null;
  let cachedInitialize = null;
  let cachedInitialized = null;
  let recoveryPromise = null;
  let reinitialize = null;
  let permanentlyFailed = false;
  const pending = new Map();

  function unavailableMessage(detail) {
    return 'MCP_CHILD_UNAVAILABLE: ' + detail;
  }

  function emitError(id, code, message) {
    writeJsonLine(clientOutput, {
      jsonrpc: '2.0',
      id: id === undefined ? null : id,
      error: { code, message }
    });
  }

  function sendToChild(message) {
    if (!child || !child.stdin || child.stdin.destroyed) {
      throw new Error(unavailableMessage('child process is not ready'));
    }
    writeJsonLine(child.stdin, message);
  }

  function rejectReinitialize(error) {
    if (!reinitialize) return;
    const current = reinitialize;
    reinitialize = null;
    clearTimeout(current.timer);
    current.reject(error);
  }

  function failPendingCalls() {
    for (const id of pending.keys()) {
      emitError(
        id,
        -32071,
        'MCP_CHILD_RESTARTED: acquire list_pages and a fresh snapshot, then continue under the current session authorization'
      );
    }
    pending.clear();
  }

  async function waitForChildReady() {
    if (permanentlyFailed) {
      throw new Error(
        unavailableMessage('restart failed after ' + maxRestartAttempts + ' attempts')
      );
    }
    if (recoveryPromise) await recoveryPromise;
    if (!child || !child.stdin || child.stdin.destroyed) {
      throw new Error(unavailableMessage('child process is not ready'));
    }
  }

  async function forward(message) {
    await waitForChildReady();
    if (message.id !== undefined) pending.set(message.id, message);
    try {
      sendToChild(message);
    } catch (error) {
      if (message.id !== undefined) pending.delete(message.id);
      throw error;
    }
  }

  async function routeClientMessage(message) {
    if (message.method === 'initialize') cachedInitialize = cloneMessage(message);
    if (message.method === 'notifications/initialized') {
      cachedInitialized = cloneMessage(message);
    }

    if (message.method !== 'tools/call') {
      try {
        await forward(message);
      } catch (error) {
        emitError(message.id, -32072, error.message);
      }
      return;
    }

    try {
      await waitForChildReady();
    } catch (error) {
      emitError(message.id, -32072, error.message);
      return;
    }

    if (!ensurePromise) {
      ensurePromise = Promise.resolve().then(ensureBrowser).finally(() => {
        ensurePromise = null;
      });
    }
    try {
      await ensurePromise;
    } catch (error) {
      emitError(message.id, -32070, error.message);
      return;
    }

    try {
      await forward(message);
    } catch (error) {
      emitError(message.id, -32072, error.message);
    }
  }

  const onClientData = createJsonLineDecoder(
    message => { void routeClientMessage(message); },
    error => emitError(null, -32700, 'Invalid JSON-RPC: ' + error.message)
  );

  function handleChildMessage(message) {
    if (reinitialize && message.id === reinitialize.id) {
      if (message.error) {
        rejectReinitialize(
          new Error(
            'MCP child initialize failed: ' +
            (message.error.message || JSON.stringify(message.error))
          )
        );
        return;
      }
      if (cachedInitialized) sendToChild(cachedInitialized);
      const current = reinitialize;
      reinitialize = null;
      clearTimeout(current.timer);
      current.resolve();
      return;
    }
    if (message.id !== undefined) pending.delete(message.id);
    writeJsonLine(clientOutput, message);
  }

  async function attachChild() {
    const next = await Promise.resolve(spawnChild());
    child = next;
    const decodeChild = createJsonLineDecoder(
      handleChildMessage,
      error => log('invalid child JSON-RPC: ' + error.message)
    );
    child.stdout.on('data', decodeChild);
    child.stderr.on('data', chunk => log(chunk.toString('utf8').trimEnd()));
    child.once('error', error => log('chrome-devtools-mcp error: ' + error.message));
    child.once('exit', (code, signal) => {
      void handleChildExit(next, code, signal);
    });
  }

  function initializeReplacement(attempt) {
    if (!cachedInitialize) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const id = '__human_browser_reinit_' + attempt + '_' + Date.now();
      const timer = setTimeout(() => {
        if (!reinitialize || reinitialize.id !== id) return;
        reinitialize = null;
        reject(new Error('MCP child initialize timed out'));
      }, initializeTimeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      reinitialize = { id, timer, resolve, reject };
      const message = cloneMessage(cachedInitialize);
      message.id = id;
      try {
        sendToChild(message);
      } catch (error) {
        rejectReinitialize(error);
      }
    });
  }

  function discardChild(target) {
    if (!target) return;
    if (target === child) child = null;
    if (target.stdin && !target.stdin.destroyed) target.stdin.end();
    if (typeof target.kill === 'function') target.kill();
  }

  async function recoverChild() {
    let lastError = null;
    for (let attempt = 1; attempt <= maxRestartAttempts; attempt += 1) {
      if (stopping) throw new Error('MCP proxy is stopping');
      let replacement = null;
      try {
        await attachChild();
        replacement = child;
        await initializeReplacement(attempt);
        log('chrome-devtools-mcp recovered on attempt ' + attempt);
        return;
      } catch (error) {
        lastError = error;
        rejectReinitialize(error);
        discardChild(replacement || child);
        log(
          'chrome-devtools-mcp recovery attempt ' + attempt +
          ' failed: ' + error.message
        );
      }
    }
    permanentlyFailed = true;
    throw new Error(
      unavailableMessage(
        'restart failed after ' + maxRestartAttempts + ' attempts' +
        (lastError ? ': ' + lastError.message : '')
      )
    );
  }

  function beginRecovery() {
    if (stopping || permanentlyFailed) return recoveryPromise;
    if (recoveryPromise) return recoveryPromise;
    const active = recoverChild();
    recoveryPromise = active;
    void active
      .catch(error => log('chrome-devtools-mcp recovery failed: ' + error.message))
      .finally(() => {
        if (recoveryPromise === active) recoveryPromise = null;
      });
    return active;
  }

  async function handleChildExit(exitedChild, code, signal) {
    if (exitedChild !== child) return;
    child = null;
    rejectReinitialize(new Error('MCP child exited during initialize'));
    failPendingCalls();
    if (stopping) return;
    log('chrome-devtools-mcp exited: code=' + code + ' signal=' + signal);
    beginRecovery();
  }

  async function start() {
    if (started) return;
    started = true;
    await attachChild();
    clientInput.on('data', onClientData);
  }

  async function stop() {
    if (stopping) return;
    stopping = true;
    clientInput.off('data', onClientData);
    rejectReinitialize(new Error('MCP proxy is stopping'));
    const current = child;
    child = null;
    if (current && current.stdin && !current.stdin.destroyed) current.stdin.end();
    if (current && typeof current.kill === 'function') current.kill();
    if (recoveryPromise) {
      await recoveryPromise.catch(() => {});
    }
  }

  return { start, stop };
}

module.exports = { createMcpProxy, createJsonLineDecoder, writeJsonLine };
