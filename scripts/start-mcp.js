const path = require('node:path');
const { spawn, execFile } = require('node:child_process');

const { loadConfig, buildMcpArgs } = require('./config');
const { createWindowsBrowserAdapter } = require('./windows-browser');
const { createSessionRegistry, defaultIsProcessAlive } = require('./session-registry');
const { createBrowserRuntime, httpGetJson } = require('./browser-runtime');
const { createMcpProxy } = require('./mcp-proxy');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Startup sweep that removes orphan wrapper instances. A wrapper is orphaned
// when its parent process has exited: it can no longer drive a browser, hold
// the state guard, or run heartbeats, and it accumulates across agent
// restarts. The current process is never touched. Best-effort only: errors are
// logged and swallowed so cleanup can never block startup.
async function cleanupStaleWrappers({
  selfPid = process.pid,
  exec = execFile,
  log = () => {}
} = {}) {
  const script = [
    "$n=@('node.exe','node');",
    '$procs=Get-CimInstance -Namespace root/cimv2 -ClassName Win32_Process -ErrorAction SilentlyContinue |',
    '  Where-Object { $n -contains $_.Name };',
    '$self=' + Number(selfPid) + ';',
    "$stale=$procs | Where-Object { ($_.CommandLine -like '*start-mcp.js*') -and",
    '  ($_.ProcessId -ne $self) -and',
    '  ([int]$_.ParentProcessId -gt 0) -and',
    '  (-not (Get-Process -Id $($_.ParentProcessId) -ErrorAction SilentlyContinue)) };',
    'if ($stale) { $stale | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress }'
  ].join('');
  let output;
  try {
    output = await new Promise((resolve, reject) => {
      exec('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', script],
        { windowsHide: true, maxBuffer: 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error) { reject(new Error((stderr || error.message).trim())); return; }
          resolve(String(stdout || '').trim());
        }
      );
    });
  } catch (error) {
    log('orphan wrapper cleanup skipped: ' + error.message);
    return { swept: [] };
  }
  if (!output || output === 'null') return { swept: [] };
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    log('orphan wrapper cleanup: could not parse result: ' + output.slice(0, 200));
    return { swept: [] };
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  const swept = [];
  for (const item of list) {
    const target = Number(item && item.ProcessId);
    if (!Number.isInteger(target) || target <= 0 || target === selfPid) continue;
    const failure = await new Promise(resolve => {
      exec('taskkill.exe', ['/PID', String(target), '/T', '/F'],
        { windowsHide: true },
        (error, _stdout, stderr) => resolve(error ? (stderr || error.message).trim() : null)
      );
    });
    if (failure) {
      log('orphan wrapper cleanup: taskkill ' + target + ' failed: ' + failure);
      continue;
    }
    swept.push(target);
    log('orphan wrapper cleanup: killed stale wrapper pid ' + target);
  }
  return { swept };
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

  // Remove orphaned wrapper instances before doing anything else. Disabled in
  // tests (override.cleanStaleWrappers === false) so the unit suite never
  // shells out to taskkill.
  if (overrides.cleanStaleWrappers !== false) {
    const sweep = overrides.runStaleWrapperCleanup || cleanupStaleWrappers;
    await sweep({ selfPid: process.pid, log });
  }

  const registry = overrides.registry || createSessionRegistry({
    stateDir,
    pid: process.pid,
    parentPid: process.ppid,
    guardTimeoutMs: config.guardTimeoutMs,
    launchClaimTimeoutMs: config.launchClaimTimeoutMs,
    heartbeatTimeoutMs: config.heartbeatTimeoutMs,
    log
  });
  const registration = await registry.registerSession();
  // registerSession returns { record, degraded } in the real registry; older
  // or test fakes may return a bare record, so read the flag defensively.
  const degraded = registration && typeof registration === 'object'
    && registration.degraded === true;
  if (degraded) {
    log('starting with degraded (in-memory) state; shared browser state will be unavailable to other wrappers');
  }

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
    ensureBrowser: () => runtime.ensureBrowser(),
    claimBrowserClose: registry.claimBrowserClose
      ? registry.claimBrowserClose.bind(registry)
      : undefined,
    completeBrowserCleanup: registry.completeBrowserCleanup
      ? registry.completeBrowserCleanup.bind(registry)
      : undefined,
    abortBrowserCleanup: registry.abortBrowserCleanup
      ? registry.abortBrowserCleanup.bind(registry)
      : undefined,
    closeOwnedBrowser: runtime.closeOwnedBrowser.bind(runtime)
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
        try {
          await runtime.closeOwnedBrowser(claim.browser);
          await registry.completeBrowserCleanup(claim.cleanupToken);
        } catch (error) {
          if (registry.abortBrowserCleanup) {
            await registry.abortBrowserCleanup(
              claim.cleanupToken,
              error.message
            ).catch(abortError =>
              log('browser cleanup abort failed: ' + abortError.message)
            );
          }
          throw error;
        }
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

module.exports = { main, spawnMcpChild, validateMcpToken, cleanupStaleWrappers };
