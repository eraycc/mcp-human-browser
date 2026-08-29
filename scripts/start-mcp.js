const path = require('node:path');
const { spawn } = require('node:child_process');

const { loadConfig, buildMcpArgs } = require('./config');
const { createWindowsBrowserAdapter } = require('./windows-browser');
const { createSessionRegistry, defaultIsProcessAlive } = require('./session-registry');
const { createBrowserRuntime, httpGetJson } = require('./browser-runtime');
const { createMcpProxy } = require('./mcp-proxy');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function validateMcpToken(value) {
  const token = String(value);
  if (!/^[A-Za-z0-9@._:\/=-]+$/.test(token)) {
    throw new Error('Unsafe MCP command token: ' + token);
  }
  return token;
}

function spawnMcpChild(config, spawnProcess = spawn) {
  const args = buildMcpArgs(config).map(validateMcpToken);
  if (process.platform === 'win32') {
    const command = ['npx', ...args].join(' ');
    return spawnProcess(
      process.env.ComSpec || 'cmd.exe',
      ['/d', '/s', '/c', command],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false
      }
    );
  }
  return spawnProcess('npx', args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false
  });
}

async function main(overrides = {}) {
  const config = overrides.config || loadConfig();
  const stateDir = overrides.stateDir ||
    path.win32.join(process.env.LOCALAPPDATA, 'HumanBrowser');
  const log = overrides.log ||
    (message => process.stderr.write('[mcp-human-browser] ' + message + '\n'));

  const registry = overrides.registry || createSessionRegistry({
    stateDir,
    pid: process.pid,
    parentPid: process.ppid,
    guardTimeoutMs: config.guardTimeoutMs,
    launchClaimTimeoutMs: config.launchClaimTimeoutMs,
    heartbeatTimeoutMs: config.heartbeatTimeoutMs,
    log
  });
  await registry.registerSession();

  const runtime = overrides.runtime || createBrowserRuntime({
    config,
    registry,
    adapter: createWindowsBrowserAdapter(),
    httpGetJson,
    sleep,
    log
  });

  const proxy = overrides.proxy || createMcpProxy({
    clientInput: overrides.clientInput || process.stdin,
    clientOutput: overrides.clientOutput || process.stdout,
    log,
    spawnChild: overrides.spawnMcpChild || (() => spawnMcpChild(config)),
    ensureBrowser: () => runtime.ensureBrowser()
  });

  let shutdownPromise = null;
  let heartbeatTimer = null;
  let parentTimer = null;
  const signalHandlers = [];

  async function shutdown(reason) {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (parentTimer) clearInterval(parentTimer);
      log('shutdown: ' + reason);
      try {
        await proxy.stop();
      } catch (error) {
        log('proxy stop failed: ' + error.message);
      }
      const claim = await registry.unregisterSession();
      if (claim.browser) {
        await runtime.closeOwnedBrowser(claim.browser);
        await registry.completeBrowserCleanup(claim.cleanupToken);
      }
    })();
    return shutdownPromise;
  }

  await proxy.start();

  if (overrides.installSignalHandlers !== false) {
    const parentIsAlive = overrides.parentIsAlive || defaultIsProcessAlive;
    heartbeatTimer = setInterval(() => {
      void registry.touchSession().catch(error =>
        log('session heartbeat failed: ' + error.message)
      );
    }, config.heartbeatIntervalMs);
    parentTimer = setInterval(() => {
      if (!parentIsAlive(process.ppid)) {
        void shutdown('parent-exited').finally(() => process.exit(0));
      }
    }, config.heartbeatIntervalMs);
    heartbeatTimer.unref();
    parentTimer.unref();

    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
      const handler = () => {
        void shutdown(signal).finally(() => process.exit(0));
      };
      process.once(signal, handler);
      signalHandlers.push([signal, handler]);
    }
    process.stdin.once('end', () => {
      void shutdown('stdin-ended');
    });
  }

  return {
    shutdown,
    proxy,
    runtime,
    registry,
    signalHandlers
  };
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write('[mcp-human-browser] fatal: ' + (error.stack || error.message) + '\n');
    process.exitCode = 1;
  });
}

module.exports = { main, spawnMcpChild, validateMcpToken };
