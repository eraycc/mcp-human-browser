const http = require('node:http');
const path = require('node:path');

function sleepDefault(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function httpGetJson(url, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { timeout: timeoutMs }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error('CDP_HTTP_' + response.statusCode));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(new Error('CDP_INVALID_JSON: ' + error.message));
        }
      });
    });
    request.on('timeout', () => request.destroy(new Error('CDP_TIMEOUT')));
    request.on('error', reject);
  });
}

function normalizePath(value) {
  return path.win32.normalize(String(value || '')).toLowerCase();
}

function commandHasFlag(commandLine, name, value) {
  const text = String(commandLine || '').toLowerCase();
  const plain = ('--' + name + '=' + String(value)).toLowerCase();
  const quoted = ('--' + name + '="' + String(value) + '"').toLowerCase();
  return text.includes(plain) || text.includes(quoted);
}

function createBrowserRuntime(options) {
  const { config, registry, adapter } = options;
  const getJson = options.httpGetJson || httpGetJson;
  const sleep = options.sleep || sleepDefault;
  const now = options.now || Date.now;
  const log = options.log || (() => {});
  let ensurePromise = null;

  async function probeBrowser() {
    const listeners = await adapter.queryListener(config.debuggingPort);
    if (!listeners.length) return { ready: false };
    if (listeners.some(item => !['127.0.0.1', '::1'].includes(item.address))) {
      throw new Error('BROWSER_PORT_EXPOSED: port 9222 is not loopback-only');
    }

    const processes = await adapter.queryBrowserProcesses(['chrome.exe', 'msedge.exe']);
    const owners = listeners.map(listener =>
      processes.find(process => process.pid === listener.pid)
    );
    if (owners.some(owner => !owner)) {
      throw new Error('BROWSER_PORT_OCCUPIED: listener owner is not Chrome or Edge');
    }
    const names = new Set(owners.map(owner => owner.name.toLowerCase()));
    if (names.size !== 1) {
      throw new Error('BROWSER_PORT_OCCUPIED: mixed browser owners');
    }
    const kind = names.has('msedge.exe') ? 'edge' : 'chrome';
    const version = await getJson(
      'http://' + config.debuggingAddress + ':' + config.debuggingPort + '/json/version',
      3000
    );
    if (!version.webSocketDebuggerUrl) {
      throw new Error('BROWSER_CDP_INVALID: webSocketDebuggerUrl is missing');
    }
    if (kind === 'edge' && !String(version.Browser || '').startsWith('Edg/')) {
      throw new Error('BROWSER_PRODUCT_MISMATCH: expected Edge');
    }
    if (kind === 'chrome' && !String(version.Browser || '').startsWith('Chrome/')) {
      throw new Error('BROWSER_PRODUCT_MISMATCH: expected Chrome');
    }

    const expectedProfile = kind === 'edge'
      ? config.edgeUserDataDir
      : config.chromeUserDataDir;
    const processName = kind === 'edge' ? 'msedge.exe' : 'chrome.exe';
    const candidates = processes.filter(process =>
      process.name.toLowerCase() === processName &&
      commandHasFlag(process.commandLine, 'remote-debugging-port', config.debuggingPort) &&
      commandHasFlag(process.commandLine, 'user-data-dir', expectedProfile)
    );
    const browserProcess = candidates.find(process =>
      owners.some(owner => owner.pid === process.pid)
    ) || candidates[0];
    if (!browserProcess) {
      throw new Error('BROWSER_PROFILE_MISMATCH: port 9222 is not using the dedicated profile');
    }

    return {
      ready: true,
      version,
      record: {
        kind,
        executablePath: browserProcess.executablePath,
        processName,
        userDataDir: expectedProfile,
        pid: browserProcess.pid,
        debuggingPort: config.debuggingPort,
        launchedByWrapper: false,
        processCreatedAt: browserProcess.createdAt
      }
    };
  }

  async function profileInUse(selection) {
    const processes = await adapter.queryBrowserProcesses([selection.processName]);
    return processes.some(process =>
      commandHasFlag(process.commandLine, 'user-data-dir', selection.userDataDir) &&
      !commandHasFlag(process.commandLine, 'remote-debugging-port', config.debuggingPort)
    );
  }

  async function waitForReady(selection, deadline) {
    let lastError = null;
    while (now() < deadline) {
      try {
        const probe = await probeBrowser();
        if (probe.ready &&
            probe.record.kind === selection.kind &&
            normalizePath(probe.record.executablePath) === normalizePath(selection.executablePath)) {
          return probe.record;
        }
      } catch (error) {
        lastError = error;
      }
      await sleep(250);
    }
    throw new Error(
      'BROWSER_STARTUP_TIMEOUT' + (lastError ? ': ' + lastError.message : '')
    );
  }

  async function waitForOtherSession(deadline) {
    while (now() < deadline) {
      const snapshot = await registry.getSnapshot();
      if (snapshot.browser && snapshot.browser.phase === 'ready') {
        return { ...snapshot.browser };
      }
      if (!snapshot.browser || snapshot.browser.phase !== 'starting') return null;
      await sleep(100);
    }
    throw new Error('BROWSER_STARTUP_BUSY_TIMEOUT');
  }

  async function waitForBrowserClose(deadline) {
    while (now() < deadline) {
      const snapshot = await registry.getSnapshot();
      if (!snapshot.browser || snapshot.browser.phase !== 'closing') {
        return snapshot;
      }
      await sleep(100);
    }
    throw new Error('BROWSER_CLOSE_BUSY_TIMEOUT');
  }

  async function ensureBrowserOnce(staleRetry = 0) {
    let snapshot = await registry.getSnapshot();
    if (snapshot.browser && snapshot.browser.phase === 'closing') {
      snapshot = await waitForBrowserClose(
        now() + config.browserStartupTimeoutMs
      );
    }
    try {
      const existing = await probeBrowser();
      if (existing.ready) {
        if (snapshot.browser &&
            snapshot.browser.phase === 'ready' &&
            snapshot.browser.pid === existing.record.pid &&
            snapshot.browser.processCreatedAt === existing.record.processCreatedAt) {
          return { ...snapshot.browser };
        }
        return registry.recordExternalBrowser(existing.record);
      }
    } catch (error) {
      if (!String(error.message).startsWith('connect ECONNREFUSED')) throw error;
    }

    if (snapshot.browser &&
        snapshot.browser.phase === 'ready' &&
        typeof registry.clearBrowserRecord === 'function') {
      const cleared = await registry.clearBrowserRecord(snapshot.browser);
      const didClear = Boolean(
        cleared && (
          (cleared.result && cleared.result.cleared) ||
          cleared.cleared
        )
      );
      if (!didClear) {
        if (staleRetry < 2) return ensureBrowserOnce(staleRetry + 1);
        throw new Error('BROWSER_STATE_CHANGED_DURING_STALE_CLEANUP');
      }
      snapshot = await registry.getSnapshot();
    }

    const selection = adapter.resolveBrowser(config);
    const claim = await registry.claimBrowserLaunch({
      ...selection,
      debuggingPort: config.debuggingPort
    });
    if (claim.status === 'ready') {
      // Degraded (state file unavailable) mode: the claim is not shared with
      // other wrappers, so launch directly on the default parameters. The MCP
      // child connects to the live loopback CDP endpoint regardless, so no
      // startup blocking occurs.
      if (claim.degraded) {
        return launchDegradeTolerant(selection);
      }
      const claimedProbe = await probeBrowser();
      if (claimedProbe.ready &&
          claim.browser &&
          claim.browser.pid === claimedProbe.record.pid &&
          claim.browser.processCreatedAt === claimedProbe.record.processCreatedAt) {
        return claim.browser;
      }
      if (typeof registry.clearBrowserRecord === 'function') {
        await registry.clearBrowserRecord(claim.browser);
      }
      if (staleRetry < 2) return ensureBrowserOnce(staleRetry + 1);
      throw new Error('BROWSER_STALE_READY_RECORD');

    }
    if (claim.status === 'waiting') {
      const record = await waitForOtherSession(now() + config.browserStartupTimeoutMs);
      if (record) return record;
      throw new Error('BROWSER_LAUNCH_CLAIM_LOST');
    }

    let launched = null;
    try {
      if (await profileInUse(selection)) {
        throw new Error(
          'BROWSER_PROFILE_IN_USE: close the dedicated ' + selection.kind + ' window'
        );
      }
      if (typeof adapter.ensureProfileWritable === 'function') {
        await adapter.ensureProfileWritable(selection);
      }
      launched = await adapter.launchBrowser(
        selection,
        adapter.buildBrowserArgs(config, selection)
      );
      const record = await waitForReady(
        selection,
        now() + config.browserStartupTimeoutMs
      );
      record.launchedByWrapper = true;
      await registry.completeBrowserLaunch(claim.token, record);
      return record;
    } catch (error) {
      const stderrTail = launched &&
        typeof launched.getStderrTail === 'function'
        ? launched.getStderrTail()
        : '';
      const failure = stderrTail
        ? new Error(error.message + '; browser stderr: ' + stderrTail)
        : error;
      if (launched && Number.isInteger(launched.pid) && launched.pid > 0) {
        try {
          await adapter.terminateProcessTree(launched.pid);
        } catch (cleanupError) {
          log(
            'failed to clean up browser after launch error: ' +
            cleanupError.message
          );
        }
      }
      await registry.failBrowserLaunch(claim.token, failure.message);
      throw failure;
    }
  }

  // Launch used when the shared state file is unavailable (degraded mode).
  // It intentionally skips the claim bookkeeping (claim/complete/fail) that
  // requires a writable state file; the MCP child reaches the browser through
  // the live loopback CDP endpoint, so correctness does not depend on the
  // persisted record.
  async function launchDegradeTolerant(selection) {
    let launched = null;
    try {
      if (await profileInUse(selection)) {
        throw new Error(
          'BROWSER_PROFILE_IN_USE: close the dedicated ' + selection.kind + ' window'
        );
      }
      if (typeof adapter.ensureProfileWritable === 'function') {
        await adapter.ensureProfileWritable(selection);
      }
      launched = await adapter.launchBrowser(
        selection,
        adapter.buildBrowserArgs(config, selection)
      );
      const record = await waitForReady(
        selection,
        now() + config.browserStartupTimeoutMs
      );
      record.launchedByWrapper = true;
      return record;
    } catch (error) {
      const stderrTail = launched &&
        typeof launched.getStderrTail === 'function'
        ? launched.getStderrTail()
        : '';
      const failure = stderrTail
        ? new Error(error.message + '; browser stderr: ' + stderrTail)
        : error;
      if (launched && Number.isInteger(launched.pid) && launched.pid > 0) {
        try {
          await adapter.terminateProcessTree(launched.pid);
        } catch (cleanupError) {
          log(
            'failed to clean up browser after launch error: ' +
            cleanupError.message
          );
        }
      }
      log('degraded-mode browser launch failed: ' + failure.message);
      throw failure;
    }
  }

  function ensureBrowser() {
    if (!ensurePromise) {
      ensurePromise = ensureBrowserOnce().finally(() => {
        ensurePromise = null;
      });
    }
    return ensurePromise;
  }

  async function closeOwnedBrowser(record) {
    if (!record || record.launchedByWrapper !== true) return;
    const processes = await adapter.queryBrowserProcesses([record.processName]);
    const current = processes.find(process => process.pid === record.pid);
    const listeners = await adapter.queryListener(record.debuggingPort);
    const ownsLoopbackListener = listeners.some(listener =>
      listener.pid === record.pid &&
      ['127.0.0.1', '::1'].includes(listener.address)
    );
    const strongFingerprint = current &&
      current.name.toLowerCase() === record.processName.toLowerCase() &&
      normalizePath(current.executablePath) === normalizePath(record.executablePath) &&
      current.createdAt === record.processCreatedAt &&
      ownsLoopbackListener;
    const commandLine = String(current && current.commandLine || '').trim();
    const commandFingerprint = !commandLine || (
      commandHasFlag(commandLine, 'user-data-dir', record.userDataDir) &&
      commandHasFlag(commandLine, 'remote-debugging-port', record.debuggingPort)
    );
    if (!strongFingerprint || !commandFingerprint) {
      throw new Error('BROWSER_OWNERSHIP_CHANGED: cleanup fingerprint did not match');
    }
    await adapter.terminateProcessTree(record.pid);
    const deadline = now() + 5000;
    while (now() < deadline) {
      const listeners = await adapter.queryListener(record.debuggingPort);
      if (!listeners.length) return;
      await sleep(100);
    }
    log('browser process closed but port remained open after 5 seconds');
  }

  return { ensureBrowser, probeBrowser, closeOwnedBrowser };
}

module.exports = {
  createBrowserRuntime,
  httpGetJson,
  normalizePath,
  commandHasFlag
};
