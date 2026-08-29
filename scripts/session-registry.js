const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

function createEmptyState() {
  return { version: 1, sessions: [], browser: null };
}

function defaultIsProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function createSessionRegistry(options) {
  const stateDir = options.stateDir;
  const statePath = path.join(stateDir, 'runtime-state.json');
  const guardPath = path.join(stateDir, 'runtime-state.guard');
  const pid = options.pid || process.pid;
  const parentPid = options.parentPid || process.ppid;
  const now = options.now || Date.now;
  const sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const isProcessAlive = options.isProcessAlive || defaultIsProcessAlive;
  const randomId = options.randomId || randomUUID;
  const guardTimeoutMs = options.guardTimeoutMs || 5000;
  const launchClaimTimeoutMs = options.launchClaimTimeoutMs || 40000;
  const heartbeatTimeoutMs = options.heartbeatTimeoutMs || 10000;
  const sessionId = String(randomId());
  let registered = false;

  async function readJson(file, fallback) {
    try {
      return JSON.parse(await fs.readFile(file, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return fallback;
      throw error;
    }
  }

  async function writeState(state) {
    await fs.mkdir(stateDir, { recursive: true });
    const temp = statePath + '.' + pid + '.' + randomId() + '.tmp';
    await fs.writeFile(temp, JSON.stringify(state, null, 2), 'utf8');
    await fs.rename(temp, statePath);
  }

  async function acquireGuard() {
    await fs.mkdir(stateDir, { recursive: true });
    const deadline = now() + guardTimeoutMs * 4;
    for (;;) {
      try {
        const handle = await fs.open(guardPath, 'wx');
        await handle.writeFile(JSON.stringify({ pid, acquiredAt: now() }), 'utf8');
        return handle;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        let stale = false;
        try {
          const guard = await readJson(guardPath, null);
          stale = !guard ||
            !isProcessAlive(Number(guard.pid)) ||
            now() - Number(guard.acquiredAt || 0) > guardTimeoutMs;
        } catch {
          const info = await fs.stat(guardPath).catch(() => null);
          stale = !info || now() - info.mtimeMs > guardTimeoutMs;
        }
        if (stale) {
          await fs.unlink(guardPath).catch(() => {});
          continue;
        }
        if (now() >= deadline) throw new Error('SESSION_GUARD_TIMEOUT');
        await sleep(25);
      }
    }
  }

  async function withState(mutator) {
    const handle = await acquireGuard();
    try {
      const state = await readJson(statePath, createEmptyState());
      const result = await mutator(state);
      await writeState(state);
      return result;
    } finally {
      await handle.close().catch(() => {});
      await fs.unlink(guardPath).catch(() => {});
    }
  }

  function pruneSessions(state) {
    const cutoff = now() - heartbeatTimeoutMs;
    state.sessions = state.sessions.filter(session => {
      if (session.id === sessionId) return true;
      if (isProcessAlive(Number(session.pid))) return true;
      return Number(session.lastSeenAt || 0) >= cutoff &&
        isProcessAlive(Number(session.parentPid));
    });
  }

  async function registerSession() {
    return withState(state => {
      pruneSessions(state);
      const record = {
        id: sessionId,
        pid,
        parentPid,
        startedAt: now(),
        lastSeenAt: now()
      };
      state.sessions = state.sessions.filter(session => session.id !== sessionId);
      state.sessions.push(record);
      registered = true;
      return record;
    });
  }

  async function touchSession() {
    if (!registered) return;
    await withState(state => {
      pruneSessions(state);
      const session = state.sessions.find(item => item.id === sessionId);
      if (session) session.lastSeenAt = now();
    });
  }

  async function getSnapshot() {
    return withState(state => {
      pruneSessions(state);
      return JSON.parse(JSON.stringify(state));
    });
  }

  async function claimBrowserLaunch(selection) {
    return withState(state => {
      pruneSessions(state);
      if (state.browser && state.browser.phase === 'ready') {
        return { status: 'ready', browser: { ...state.browser } };
      }
      if (state.browser && state.browser.phase === 'starting' &&
          now() - Number(state.browser.claimAt || 0) <= launchClaimTimeoutMs) {
        return { status: 'waiting', token: state.browser.claimToken };
      }
      const token = String(randomId());
      state.browser = {
        phase: 'starting',
        claimToken: token,
        claimOwnerSessionId: sessionId,
        claimAt: now(),
        ...selection,
        pid: null,
        debuggingPort: selection.debuggingPort || 9222,
        launchedByWrapper: null,
        processCreatedAt: null,
        updatedAt: now()
      };
      return { status: 'claimed', token };
    });
  }

  async function completeBrowserLaunch(token, record) {
    return withState(state => {
      if (!state.browser ||
          state.browser.phase !== 'starting' ||
          state.browser.claimToken !== token) {
        throw new Error('BROWSER_LAUNCH_CLAIM_LOST');
      }
      state.browser = {
        phase: 'ready',
        claimToken: null,
        claimOwnerSessionId: null,
        claimAt: null,
        ...record,
        updatedAt: now()
      };
    });
  }

  async function failBrowserLaunch(token, message) {
    return withState(state => {
      if (state.browser &&
          state.browser.phase === 'starting' &&
          state.browser.claimToken === token) {
        state.browser = null;
        state.lastBrowserError = { message, at: now() };
      }
    });
  }

  async function recordExternalBrowser(record) {
    return withState(state => {
      state.browser = {
        phase: 'ready',
        claimToken: null,
        claimOwnerSessionId: null,
        claimAt: null,
        ...record,
        launchedByWrapper: false,
        updatedAt: now()
      };
      return { ...state.browser };
    });
  }

  async function unregisterSession() {
    if (!registered) {
      return { isLastSession: false, browser: null, cleanupToken: null };
    }
    registered = false;
    return withState(state => {
      state.sessions = state.sessions.filter(session => session.id !== sessionId);
      pruneSessions(state);
      const isLastSession = state.sessions.length === 0;
      if (!isLastSession) {
        return { isLastSession: false, browser: null, cleanupToken: null };
      }
      if (state.browser &&
          state.browser.phase === 'ready' &&
          state.browser.launchedByWrapper === true) {
        const cleanupToken = String(randomId());
        const browser = { ...state.browser };
        state.browser = {
          ...state.browser,
          phase: 'closing',
          cleanupToken,
          updatedAt: now()
        };
        return { isLastSession: true, browser, cleanupToken };
      }
      state.browser = null;
      return { isLastSession: true, browser: null, cleanupToken: null };
    });
  }

  async function completeBrowserCleanup(token) {
    return withState(state => {
      if (state.browser &&
          state.browser.phase === 'closing' &&
          state.browser.cleanupToken === token) {
        state.browser = null;
      }
    });
  }

  return {
    sessionId,
    statePath,
    registerSession,
    touchSession,
    getSnapshot,
    claimBrowserLaunch,
    completeBrowserLaunch,
    failBrowserLaunch,
    recordExternalBrowser,
    unregisterSession,
    completeBrowserCleanup
  };
}

module.exports = { createSessionRegistry, createEmptyState, defaultIsProcessAlive };
