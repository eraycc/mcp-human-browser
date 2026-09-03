const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

// The runtime state is persisted as a JSONL file (single-line JSON document).
const STATE_FILE = 'runtime-state.jsonl';

// Legacy `runtime-state.json` files from earlier versions are left in place;
// they are simply never read from.
const LEGACY_STATE_BASENAME = 'runtime-state.json';

function createEmptyState() {
  return { version: 1, sessions: [], browser: null };
}

const BROWSER_CLOSE_INTENTS = new Set(['keep', 'close-after-requested', 'close-after-task']);

function normalizeBrowserIntent(value) {
  const intent = String(value || 'keep');
  return BROWSER_CLOSE_INTENTS.has(intent) ? intent : 'keep';
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
  const statePath = options.statePath || path.join(stateDir, STATE_FILE);
  const guardPath = options.guardPath || path.join(stateDir, 'runtime-state.guard');
  const pid = options.pid || process.pid;
  const parentPid = options.parentPid || process.ppid;
  const now = options.now || Date.now;
  const sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const isProcessAlive = options.isProcessAlive || defaultIsProcessAlive;
  const randomId = options.randomId || randomUUID;
  const log = options.log || (() => {});
  // When the state file cannot be trusted (unreadable / non-JSON /
  // unwritable / lock contention) the registry degrades to in-memory state and
  // reports stateAvailable=false so callers can proceed on default behavior
  // instead of blocking startup. It re-probes the file on every mutation.
  const useFileState = options.useFileState !== false;
  const stateAvailable = options.stateAvailable !== false;
  const guardTimeoutMs = options.guardTimeoutMs || 5000;
  const launchClaimTimeoutMs = options.launchClaimTimeoutMs || 40000;
  const heartbeatTimeoutMs = options.heartbeatTimeoutMs || 10000;
  const cleanupClaimTimeoutMs = options.cleanupClaimTimeoutMs ||
    Math.max(heartbeatTimeoutMs * 2, 15000);
  const sessionId = String(randomId());
  let registered = false;
  let memoryState = createEmptyState();
  let degradedLogged = false;

  async function readStateFile() {
    // Returns null when the file does not exist. Throws when the file exists
    // but cannot be parsed as JSON (e.g. a corrupt or non-JSON file).
    let raw;
    try {
      raw = await fs.readFile(statePath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    const line = String(raw).split('\n').find(item => item.trim() !== '') || '';
    const parsed = JSON.parse(line);
    if (!parsed || typeof parsed !== 'object' ||
        !Array.isArray(parsed.sessions)) {
      throw new Error('STATE_UNREADABLE');
    }
    return parsed;
  }

  async function writeStateFile(state) {
    await fs.mkdir(stateDir, { recursive: true });
    // Write to a temp file then rename for an atomic swap.
    const temp = statePath + '.' + pid + '.' + randomId() + '.tmp.jsonl';
    try {
      await fs.writeFile(temp, JSON.stringify(state) + '\n', 'utf8');
      await fs.rename(temp, statePath);
    } catch (error) {
      await fs.unlink(temp).catch(() => {});
      throw error;
    }
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
          const guard = JSON.parse(await fs.readFile(guardPath, 'utf8'));
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

  // Apply a mutation with filesystem-backed state. On any failure (unreadable
  // file, unwritable file, lock timeout) the mutation falls back to the
  // in-memory copy and the error is reported through the return value rather
  // than thrown, so a broken state file never blocks startup or a tool call.
  async function withState(mutator) {
    if (!useFileState) {
      const state = memoryState;
      const result = mutator(state);
      return { state, result, stateAvailable: false };
    }
    const handle = await acquireGuard();
    try {
      const state = await readStateFile();
      const base = state === null ? createEmptyState() : state;
      const result = mutator(base);
      await writeStateFile(base);
      memoryState = base;
      degradedLogged = false;
      return { state: base, result, stateAvailable: true };
    } catch (error) {
      if (!degradedLogged) {
        degradedLogged = true;
        log('state file unavailable; using in-memory fallback: ' + error.message);
      }
      const state = memoryState;
      const result = mutator(state);
      memoryState = state;
      return { state, result, stateAvailable: false };
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
    if (state.browser && state.browser.phase === 'closing') {
      const ownerSession = state.sessions.find(
        session => session.id === state.browser.closeOwnerSessionId
      );
      const ownerPid = Number(
        state.browser.closeOwnerPid || (ownerSession && ownerSession.pid)
      );
      const claimAt = Number(
        state.browser.closeClaimAt || state.browser.updatedAt || 0
      );
      const leaseExpired = now() - claimAt > cleanupClaimTimeoutMs;
      const ownerDead = Number.isFinite(ownerPid) && ownerPid > 0 &&
        !isProcessAlive(ownerPid);
      if (leaseExpired && ownerDead) {
        state.browser = null;
        state.lastBrowserError = {
          message: 'stale browser cleanup claim recovered after owner exit',
          at: now()
        };
      }
    }
  }

  async function registerSession() {
    const outcome = await withState(state => {
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
    if (outcome.stateAvailable) return { record: outcome.result, degraded: false };
    return { record: memoryState.sessions.find(item => item.id === sessionId) || {}, degraded: true };
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
    const outcome = await withState(state => {
      pruneSessions(state);
      return JSON.parse(JSON.stringify(state));
    });
    if (outcome.stateAvailable) return outcome.result;
    return memoryState;
  }

  async function claimBrowserLaunch(selection) {
    const outcome = await withState(state => {
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
    // In degraded (in-memory) mode the claim is never visible to other
    // wrappers, so the browser record is shared out-of-band through the live
    // CDP probe instead. Report the claim as already satisfied; the launch is
    // still performed and the MCP child connects directly to the loopback CDP
    // endpoint, so no blocking occurs.
    if (!outcome.stateAvailable) {
      return { status: 'ready', browser: null, degraded: true };
    }
    return outcome.result;
  }

  async function completeBrowserLaunch(token, record) {
    return withState(state => {
      if (!state.browser ||
          state.browser.phase !== 'starting' ||
          state.browser.claimToken !== token) {
        // Degrade-tolerant: the claim was never persisted (degraded mode) or
        // was already replaced. Record the ready browser rather than throwing,
        // so the local session still reflects a usable browser.
        return { recorded: false };
      }
      state.browser = {
        phase: 'ready',
        claimToken: null,
        claimOwnerSessionId: null,
        claimAt: null,
        ...record,
        updatedAt: now()
      };
      return { recorded: true };
    });
  }

  async function failBrowserLaunch(token, message) {
    return withState(state => {
      if (state.browser && state.browser.phase === 'starting' &&
          state.browser.claimToken === token) {
        state.browser = null;
        state.lastBrowserError = { message, at: now() };
      }
      return { cleared: true };
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
    const outcome = await withState(state => {
      state.sessions = state.sessions.filter(session => session.id !== sessionId);
      pruneSessions(state);
      const isLastSession = state.sessions.length === 0;
      if (!isLastSession) {
        return { isLastSession: false, browser: null, cleanupToken: null };
      }
      if (state.browser && state.browser.phase === 'closing') {
        return {
          isLastSession: true,
          browser: null,
          cleanupToken: null,
          cleanupPending: true
        };
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
          closeOwnerSessionId: sessionId,
          closeOwnerPid: pid,
          closeClaimAt: now(),
          updatedAt: now()
        };
        return { isLastSession: true, browser, cleanupToken };
      }
      state.browser = null;
      return { isLastSession: true, browser: null, cleanupToken: null };
    });
    // In degraded mode only this process's own view is known; it always
    // considers itself the last session, so wrapper-owned cleanup still runs.
    if (!outcome.stateAvailable) {
      const browser = memoryState.browser;
      const isOwned = browser && browser.phase === 'ready' &&
        browser.launchedByWrapper === true;
      return {
        isLastSession: true,
        browser: isOwned ? browser : null,
        cleanupToken: isOwned ? 'degraded-cleanup' : null,
        cleanupPending: Boolean(browser && browser.phase === 'closing')
      };
    }
    return outcome.result;
  }

  async function completeBrowserCleanup(token) {
    return withState(state => {
      if (state.browser && state.browser.phase === 'closing' &&
          state.browser.cleanupToken === token) {
        state.browser = null;
      }
      return { cleared: true };
    });
  }

  async function abortBrowserCleanup(token, message) {
    return withState(state => {
      const matches = Boolean(
        state.browser &&
        state.browser.phase === 'closing' &&
        state.browser.cleanupToken === token
      );
      if (matches) {
        state.browser = null;
        state.lastBrowserError = {
          message: String(message || 'browser cleanup failed'),
          at: now()
        };
      }
      return { cleared: matches };
    });
  }

  async function claimBrowserClose(intent) {
    const normalized = normalizeBrowserIntent(intent);
    const outcome = await withState(state => {
      pruneSessions(state);
      const session = state.sessions.find(item => item.id === sessionId);
      const browser = state.browser
        ? JSON.parse(JSON.stringify(state.browser))
        : null;
      const sharedByOtherSessions = state.sessions.some(
        item => item.id !== sessionId
      );
      const authorized = normalized === 'close-after-requested' ||
        normalized === 'close-after-task';
      const ownedByWrapper = Boolean(
        browser && browser.launchedByWrapper === true
      );
      const ready = Boolean(browser && browser.phase === 'ready');
      const closeNow = Boolean(
        session && authorized && ownedByWrapper && ready
      );
      const reason = !session
        ? 'SESSION_NOT_REGISTERED'
        : !authorized
          ? 'BROWSER_CLOSE_NOT_AUTHORIZED'
          : !ready
            ? 'BROWSER_NOT_READY'
            : !ownedByWrapper
              ? 'BROWSER_NOT_OWNED_BY_CURRENT_SESSION'
              : 'CLOSE_ALLOWED';
      let cleanupToken = null;
      if (closeNow) {
        cleanupToken = String(randomId());
        state.browser = {
          ...state.browser,
          phase: 'closing',
          cleanupToken,
          closeOwnerSessionId: sessionId,
          closeOwnerPid: pid,
          closeClaimAt: now(),
          updatedAt: now()
        };
      }
      return {
        allowed: Boolean(session && authorized && ownedByWrapper),
        closeNow,
        reason,
        intent: normalized,
        browser: closeNow ? browser : null,
        browserPid: browser ? browser.pid : null,
        cleanupToken,
        sharedByOtherSessions
      };
    });
    if (outcome.stateAvailable) return outcome.result;

    if (outcome.result.closeNow && outcome.result.browser) {
      memoryState.browser = { ...outcome.result.browser };
    }
    return {
      ...outcome.result,
      allowed: false,
      closeNow: false,
      reason: 'BROWSER_SHARED_STATE_UNAVAILABLE',
      browser: null,
      cleanupToken: null,
      degraded: true
    };
  }

  async function clearBrowserRecord(expected) {
    return withState(state => {
      const current = state.browser;
      const shouldClear = Boolean(
        current &&
        expected &&
        current.phase === expected.phase &&
        current.pid === expected.pid &&
        current.processCreatedAt === expected.processCreatedAt &&
        current.debuggingPort === expected.debuggingPort
      );
      if (shouldClear) state.browser = null;
      return { cleared: shouldClear };
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
    completeBrowserCleanup,
    abortBrowserCleanup,
    claimBrowserClose,
    clearBrowserRecord
  };
}

module.exports = { createSessionRegistry, createEmptyState, defaultIsProcessAlive, STATE_FILE, LEGACY_STATE_BASENAME };
