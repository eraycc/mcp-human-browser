const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

const { createDefaults, validateConfig, loadConfig, buildMcpArgs } = require('../config');
const {
  resolveBrowser,
  buildBrowserArgs,
  createWindowsBrowserAdapter
} = require('../windows-browser');
const { createSessionRegistry } = require('../session-registry');
const { createBrowserRuntime } = require('../browser-runtime');

const env = {
  ProgramFiles: 'C:\\Program Files',
  'ProgramFiles(x86)': 'C:\\Program Files (x86)',
  LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local'
};

test('Chrome is preferred and Edge is the fallback', () => {
  const config = createDefaults(env.LOCALAPPDATA);
  const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

  const preferred = resolveBrowser(config, {
    env,
    existsSync: value => value === chrome || value === edge
  });
  assert.equal(preferred.kind, 'chrome');
  assert.equal(preferred.executablePath, chrome);
  assert.match(preferred.userDataDir, /HumanChromeProfile$/);

  const fallback = resolveBrowser(config, {
    env,
    existsSync: value => value === edge
  });
  assert.deepEqual(fallback, {
    kind: 'edge',
    executablePath: edge,
    processName: 'msedge.exe',
    userDataDir: 'C:\\Users\\tester\\AppData\\Local\\HumanEdgeProfile'
  });
});

test('portable profile paths expand LOCALAPPDATA before browser launch', () => {
  const config = loadConfig({
    localAppData: env.LOCALAPPDATA,
    configPath: 'C:\\portable-config.json',
    existsSync: () => true,
    readFileSync: () => JSON.stringify({
      chromeUserDataDir: '%LOCALAPPDATA%\\HumanChromeProfile',
      edgeUserDataDir: '%localappdata%\\HumanEdgeProfile'
    })
  });

  assert.equal(
    config.chromeUserDataDir,
    'C:\\Users\\tester\\AppData\\Local\\HumanChromeProfile'
  );
  assert.equal(
    config.edgeUserDataDir,
    'C:\\Users\\tester\\AppData\\Local\\HumanEdgeProfile'
  );
});

test('browser and MCP arguments use visible loopback mode', () => {
  const config = validateConfig(createDefaults(env.LOCALAPPDATA));
  const selection = {
    kind: 'edge',
    executablePath: 'C:\\Edge\\msedge.exe',
    processName: 'msedge.exe',
    userDataDir: 'C:\\HumanEdgeProfile'
  };
  assert.deepEqual(buildBrowserArgs(config, selection), [
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=9222',
    '--user-data-dir=C:\\HumanEdgeProfile',
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank'
  ]);
  assert.deepEqual(buildMcpArgs(config), [
    '-y',
    'chrome-devtools-mcp@1.8.0',
    '--browser-url=http://127.0.0.1:9222'
  ]);
  assert.throws(
    () => validateConfig({ ...config, extraBrowserArgs: ['--headless'] }),
    /forbidden browser argument/
  );
});

test('only the last session claims an owned browser for cleanup', async t => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'human-browser-'));
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }));
  const live = new Set([101, 102]);
  const common = {
    stateDir,
    parentPid: 10,
    isProcessAlive: pid => live.has(pid) || pid === 10,
    sleep: async () => {},
    now: () => 1_000_000
  };
  const first = createSessionRegistry({
    ...common,
    pid: 101,
    randomId: () => 'first'
  });
  const second = createSessionRegistry({
    ...common,
    pid: 102,
    randomId: () => 'second'
  });

  await first.registerSession();
  await second.registerSession();
  const selection = {
    kind: 'chrome',
    executablePath: 'C:\\Chrome\\chrome.exe',
    processName: 'chrome.exe',
    userDataDir: 'C:\\HumanChromeProfile'
  };
  const launch = await first.claimBrowserLaunch(selection);
  assert.equal(launch.status, 'claimed');
  await first.completeBrowserLaunch(launch.token, {
    ...selection,
    pid: 301,
    debuggingPort: 9222,
    launchedByWrapper: true,
    processCreatedAt: 'created-301'
  });

  const firstExit = await first.unregisterSession();
  assert.equal(firstExit.isLastSession, false);
  assert.equal(firstExit.browser, null);

  const lastExit = await second.unregisterSession();
  assert.equal(lastExit.isLastSession, true);
  assert.equal(lastExit.browser.pid, 301);
  assert.ok(lastExit.cleanupToken);
});

test('explicit close claim atomically closes a shared owned browser for any authorized session', async t => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'human-browser-close-plan-'));
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }));
  const live = new Set([101, 102, 10]);
  const common = {
    stateDir,
    parentPid: 10,
    isProcessAlive: pid => live.has(pid),
    sleep: async () => {},
    now: () => 1_000_000
  };
  const first = createSessionRegistry({
    ...common,
    pid: 101,
    randomId: () => 'first'
  });
  const second = createSessionRegistry({
    ...common,
    pid: 102,
    randomId: () => 'second'
  });
  await first.registerSession();
  await second.registerSession();

  const record = {
    kind: 'chrome',
    executablePath: 'C:\\Chrome\\chrome.exe',
    processName: 'chrome.exe',
    userDataDir: 'C:\\HumanChromeProfile',
    pid: 301,
    debuggingPort: 9222,
    launchedByWrapper: true,
    processCreatedAt: 'created-301'
  };
  const launch = await first.claimBrowserLaunch(record);
  await first.completeBrowserLaunch(launch.token, record);

  const plans = await Promise.all([
    first.claimBrowserClose('close-after-requested'),
    second.claimBrowserClose('close-after-requested')
  ]);
  const sharedPlan = plans.find(plan => plan.closeNow);
  const competingPlan = plans.find(plan => !plan.closeNow);

  assert.ok(sharedPlan);
  assert.equal(sharedPlan.allowed, true);
  assert.equal(sharedPlan.reason, 'CLOSE_ALLOWED');
  assert.equal(sharedPlan.sharedByOtherSessions, true);
  assert.ok(sharedPlan.cleanupToken);
  assert.deepEqual(sharedPlan.browser, {
    phase: 'ready',
    claimToken: null,
    claimOwnerSessionId: null,
    claimAt: null,
    ...record,
    updatedAt: 1_000_000
  });
  assert.ok(competingPlan);
  assert.equal(competingPlan.closeNow, false);
  assert.equal(competingPlan.reason, 'BROWSER_NOT_READY');
  assert.equal(competingPlan.browser, null);
  assert.equal(competingPlan.cleanupToken, null);
  assert.equal(competingPlan.sharedByOtherSessions, true);

  const winner = sharedPlan === plans[0]
    ? { registry: first, pid: 101 }
    : { registry: second, pid: 102 };
  const claimed = await first.getSnapshot();
  assert.equal(claimed.browser.phase, 'closing');
  assert.equal(claimed.browser.cleanupToken, sharedPlan.cleanupToken);
  assert.equal(claimed.browser.closeOwnerSessionId, winner.registry.sessionId);
  assert.equal(claimed.browser.closeOwnerPid, winner.pid);

  await first.completeBrowserCleanup(sharedPlan.cleanupToken);
  assert.equal((await first.getSnapshot()).browser, null);
});

test('explicit close never claims an external browser', async t => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'human-browser-external-close-'));
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }));
  const registry = createSessionRegistry({
    stateDir,
    pid: 101,
    parentPid: 10,
    isProcessAlive: pid => pid === 101 || pid === 10,
    randomId: () => 'external-close',
    sleep: async () => {},
    now: () => 1_000_000
  });
  await registry.registerSession();

  const record = {
    kind: 'chrome',
    executablePath: 'C:\\Chrome\\chrome.exe',
    processName: 'chrome.exe',
    userDataDir: 'C:\\HumanChromeProfile',
    pid: 301,
    debuggingPort: 9222,
    processCreatedAt: 'created-301'
  };
  await registry.recordExternalBrowser(record);

  const plan = await registry.claimBrowserClose('close-after-requested');
  assert.equal(plan.allowed, false);
  assert.equal(plan.closeNow, false);
  assert.equal(plan.reason, 'BROWSER_NOT_OWNED_BY_CURRENT_SESSION');
  assert.equal(plan.browser, null);
  assert.equal(plan.cleanupToken, null);

  const snapshot = await registry.getSnapshot();
  assert.equal(snapshot.browser.phase, 'ready');
  assert.equal(snapshot.browser.launchedByWrapper, false);
});

test('browser cleanup abort only clears the matching close claim', async t => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'human-browser-close-abort-'));
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }));
  const registry = createSessionRegistry({
    stateDir,
    pid: 101,
    parentPid: 10,
    isProcessAlive: pid => pid === 101 || pid === 10,
    randomId: () => 'claim-token',
    sleep: async () => {},
    now: () => 1_000_000
  });
  await registry.registerSession();
  const record = {
    kind: 'chrome',
    executablePath: 'C:\\Chrome\\chrome.exe',
    processName: 'chrome.exe',
    userDataDir: 'C:\\HumanChromeProfile',
    pid: 301,
    debuggingPort: 9222,
    launchedByWrapper: true,
    processCreatedAt: 'created-301'
  };
  const launch = await registry.claimBrowserLaunch(record);
  await registry.completeBrowserLaunch(launch.token, record);
  const plan = await registry.claimBrowserClose('close-after-task');

  const wrong = await registry.abortBrowserCleanup(
    'wrong-token',
    'simulated close failure'
  );
  assert.equal(wrong.result.cleared, false);
  assert.equal((await registry.getSnapshot()).browser.phase, 'closing');

  const matched = await registry.abortBrowserCleanup(
    plan.cleanupToken,
    'simulated close failure'
  );
  assert.equal(matched.result.cleared, true);
  const snapshot = await registry.getSnapshot();
  assert.equal(snapshot.browser, null);
  assert.equal(snapshot.lastBrowserError.message, 'simulated close failure');
});

test('unregister preserves an in-flight close and a dead owner is recovered after lease expiry', async t => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'human-browser-close-lease-'));
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }));
  let clock = 1_000_000;
  const live = new Set([10, 101]);
  let nextId = 0;
  const registry = createSessionRegistry({
    stateDir,
    pid: 101,
    parentPid: 10,
    isProcessAlive: pid => live.has(pid),
    randomId: () => 'id-' + (++nextId),
    sleep: async () => {},
    now: () => clock,
    cleanupClaimTimeoutMs: 1000
  });
  await registry.registerSession();
  const record = {
    kind: 'chrome',
    executablePath: 'C:\\Chrome\\chrome.exe',
    processName: 'chrome.exe',
    userDataDir: 'C:\\HumanChromeProfile',
    pid: 301,
    debuggingPort: 9222,
    launchedByWrapper: true,
    processCreatedAt: 'created-301'
  };
  const launch = await registry.claimBrowserLaunch(record);
  await registry.completeBrowserLaunch(launch.token, record);
  const plan = await registry.claimBrowserClose('close-after-task');

  const exit = await registry.unregisterSession();
  assert.equal(exit.browser, null);
  assert.equal(exit.cleanupPending, true);
  let snapshot = await registry.getSnapshot();
  assert.equal(snapshot.browser.phase, 'closing');
  assert.equal(snapshot.browser.cleanupToken, plan.cleanupToken);

  live.delete(101);
  clock += 1001;
  snapshot = await registry.getSnapshot();
  assert.equal(snapshot.browser, null);
  assert.match(snapshot.lastBrowserError.message, /stale browser cleanup claim/i);
});

test('launch claim timeout must exceed browser startup timeout', () => {
  const config = createDefaults(env.LOCALAPPDATA);
  assert.throws(
    () => validateConfig({
      ...config,
      browserStartupTimeoutMs: 30000,
      launchClaimTimeoutMs: 20000
    }),
    /launchClaimTimeoutMs must exceed browserStartupTimeoutMs/
  );
});

test('registry default launch claim remains valid through the default browser startup window', async t => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'human-browser-'));
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }));
  let clock = 1_000;

  const first = createSessionRegistry({
    stateDir,
    pid: 201,
    parentPid: 20,
    now: () => clock,
    isProcessAlive: () => true,
    randomId: () => 'first',
    sleep: async () => {}
  });
  const second = createSessionRegistry({
    stateDir,
    pid: 202,
    parentPid: 20,
    now: () => clock,
    isProcessAlive: () => true,
    randomId: () => 'second',
    sleep: async () => {}
  });

  const selection = {
    kind: 'chrome',
    executablePath: 'C:\\Chrome\\chrome.exe',
    processName: 'chrome.exe',
    userDataDir: 'C:\\HumanChromeProfile'
  };
  const claimed = await first.claimBrowserLaunch(selection);
  assert.equal(claimed.status, 'claimed');

  clock += 30_000;
  const observed = await second.claimBrowserLaunch(selection);
  assert.equal(observed.status, 'waiting');
});

test('browser startup timeout cleans up the process launched by this wrapper', async () => {
  let clock = 0;
  const terminated = [];
  const failures = [];
  const selection = {
    kind: 'chrome',
    executablePath: 'C:\\Chrome\\chrome.exe',
    processName: 'chrome.exe',
    userDataDir: 'C:\\HumanChromeProfile'
  };
  const registry = {
    getSnapshot: async () => ({ sessions: [], browser: null }),
    claimBrowserLaunch: async () => ({ status: 'claimed', token: 'launch-1' }),
    completeBrowserLaunch: async () => {
      throw new Error('launch must not complete after timeout');
    },
    failBrowserLaunch: async (token, message) => {
      failures.push({ token, message });
    },
    recordExternalBrowser: async record => record
  };
  const adapter = {
    queryListener: async () => [],
    queryBrowserProcesses: async () => [],
    resolveBrowser: () => selection,
    buildBrowserArgs: () => [],
    launchBrowser: async () => ({ pid: 301 }),
    terminateProcessTree: async pid => {
      terminated.push(pid);
    }
  };
  const runtime = createBrowserRuntime({
    config: {
      ...createDefaults(env.LOCALAPPDATA),
      browserStartupTimeoutMs: 500
    },
    registry,
    adapter,
    now: () => clock,
    sleep: async ms => {
      clock += ms;
    }
  });

  await assert.rejects(runtime.ensureBrowser(), /BROWSER_STARTUP_TIMEOUT/);
  assert.deepEqual(terminated, [301]);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].token, 'launch-1');
  assert.match(failures[0].message, /BROWSER_STARTUP_TIMEOUT/);
});

test('browser runtime clears a stale ready record before launching a replacement', async () => {
  let registryBrowser = {
    phase: 'ready',
    pid: 301,
    processCreatedAt: 'created-301',
    launchedByWrapper: true
  };
  let ready = false;
  let launched = false;
  let clock = 0;
  const selection = {
    kind: 'chrome',
    executablePath: 'C:\\Chrome\\chrome.exe',
    processName: 'chrome.exe',
    userDataDir: 'C:\\HumanChromeProfile'
  };
  const readyProcess = {
    pid: 402,
    parentPid: 1,
    name: 'chrome.exe',
    executablePath: selection.executablePath,
    commandLine: '--remote-debugging-port=9222 --user-data-dir=' + selection.userDataDir,
    createdAt: 'created-402'
  };
  const registry = {
    getSnapshot: async () => ({ sessions: [], browser: registryBrowser }),
    clearBrowserRecord: async expected => {
      assert.equal(expected.pid, 301);
      registryBrowser = null;
      return { result: { cleared: true } };
    },
    claimBrowserLaunch: async () => registryBrowser
      ? { status: 'ready', browser: registryBrowser }
      : { status: 'claimed', token: 'replacement-launch' },
    completeBrowserLaunch: async (_token, record) => {
      registryBrowser = { phase: 'ready', ...record };
    },
    failBrowserLaunch: async () => {},
    recordExternalBrowser: async record => record
  };
  const adapter = {
    queryListener: async () => ready
      ? [{ address: '127.0.0.1', pid: 402 }]
      : [],
    queryBrowserProcesses: async () => ready ? [readyProcess] : [],
    resolveBrowser: () => selection,
    buildBrowserArgs: () => [],
    ensureProfileWritable: async () => {},
    launchBrowser: async () => {
      launched = true;
      ready = true;
      return { pid: 402, getStderrTail: () => '' };
    },
    terminateProcessTree: async () => {}
  };
  const runtime = createBrowserRuntime({
    config: {
      ...createDefaults(env.LOCALAPPDATA),
      chromeUserDataDir: selection.userDataDir,
      browserStartupTimeoutMs: 5000
    },
    registry,
    adapter,
    httpGetJson: async () => ({
      Browser: 'Chrome/152',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222'
    }),
    now: () => clock,
    sleep: async ms => { clock += ms; }
  });

  const record = await runtime.ensureBrowser();
  assert.equal(launched, true);
  assert.equal(record.pid, 402);
});

test('browser runtime waits for an atomic close claim before probing or launching', async () => {
  let closing = true;
  let clock = 0;
  let probedWhileClosing = false;
  const selection = {
    kind: 'chrome',
    executablePath: 'C:\\Chrome\\chrome.exe',
    processName: 'chrome.exe',
    userDataDir: 'C:\\HumanChromeProfile'
  };
  const expected = {
    phase: 'ready',
    ...selection,
    pid: 402,
    debuggingPort: 9222,
    launchedByWrapper: true,
    processCreatedAt: 'created-402'
  };
  const runtime = createBrowserRuntime({
    config: {
      ...createDefaults(env.LOCALAPPDATA),
      chromeUserDataDir: selection.userDataDir,
      browserStartupTimeoutMs: 500
    },
    registry: {
      getSnapshot: async () => ({
        sessions: [],
        browser: closing ? { phase: 'closing' } : expected
      })
    },
    adapter: {
      queryListener: async () => {
        if (closing) {
          probedWhileClosing = true;
          return [];
        }
        return [{ address: '127.0.0.1', pid: 402 }];
      },
      queryBrowserProcesses: async () => [{
        pid: 402,
        parentPid: 1,
        name: 'chrome.exe',
        executablePath: selection.executablePath,
        commandLine: '--remote-debugging-port=9222 --user-data-dir=' + selection.userDataDir,
        createdAt: 'created-402'
      }],
      resolveBrowser: () => selection
    },
    httpGetJson: async () => ({
      Browser: 'Chrome/152',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222'
    }),
    now: () => clock,
    sleep: async ms => {
      clock += ms;
      closing = false;
    }
  });

  assert.deepEqual(await runtime.ensureBrowser(), expected);
  assert.equal(probedWhileClosing, false);
});

test('launch claim records the configured debugging port', async t => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'human-browser-port-'));
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }));
  const registry = createSessionRegistry({
    stateDir,
    pid: 101,
    parentPid: 10,
    isProcessAlive: pid => pid === 101 || pid === 10,
    randomId: () => 'port-test',
    now: () => 1_000_000,
    sleep: async () => {}
  });
  await registry.registerSession();
  await registry.claimBrowserLaunch({
    kind: 'chrome',
    executablePath: 'C:\\Chrome\\chrome.exe',
    processName: 'chrome.exe',
    userDataDir: 'C:\\HumanChromeProfile',
    debuggingPort: 9333
  });

  const snapshot = await registry.getSnapshot();
  assert.equal(snapshot.browser.debuggingPort, 9333);
});

test('owned browser cleanup accepts unavailable command line with strong fingerprint', async () => {
  const terminated = [];
  let listenerChecks = 0;
  const record = {
    kind: 'chrome',
    executablePath: 'C:\\Chrome\\chrome.exe',
    processName: 'chrome.exe',
    userDataDir: 'C:\\HumanChromeProfile',
    pid: 301,
    debuggingPort: 9222,
    launchedByWrapper: true,
    processCreatedAt: 'created-301'
  };
  const runtime = createBrowserRuntime({
    config: {
      ...createDefaults(env.LOCALAPPDATA),
      browserStartupTimeoutMs: 500
    },
    registry: {},
    adapter: {
      queryBrowserProcesses: async () => [{
        pid: 301,
        parentPid: 1,
        name: 'chrome.exe',
        executablePath: 'C:\\Chrome\\chrome.exe',
        commandLine: '',
        createdAt: 'created-301'
      }],
      queryListener: async () => {
        listenerChecks += 1;
        return listenerChecks === 1
          ? [{ address: '127.0.0.1', pid: 301 }]
          : [];
      },
      terminateProcessTree: async pid => {
        terminated.push(pid);
      }
    }
  });

  await runtime.closeOwnedBrowser(record);
  assert.deepEqual(terminated, [301]);
});

test('browser launcher exposes a bounded stderr tail for startup diagnosis', async () => {
  let spawnOptions = null;
  const child = new EventEmitter();
  child.pid = 301;
  child.stderr = new PassThrough();
  child.stderr.unref = () => {};
  child.unref = () => {};
  const adapter = createWindowsBrowserAdapter({
    spawn: (_command, _args, options) => {
      spawnOptions = options;
      queueMicrotask(() => child.emit('spawn'));
      return child;
    }
  });

  const launched = await adapter.launchBrowser(
    { executablePath: 'C:\\Chrome\\chrome.exe' },
    ['about:blank']
  );
  child.stderr.write('profile lock denied\n');
  assert.deepEqual(spawnOptions.stdio, ['ignore', 'ignore', 'pipe']);
  assert.match(launched.getStderrTail(), /profile lock denied/);
});

test('browser startup timeout includes the captured browser stderr tail', async () => {
  let clock = 0;
  const failures = [];
  const selection = {
    kind: 'chrome',
    executablePath: 'C:\\Chrome\\chrome.exe',
    processName: 'chrome.exe',
    userDataDir: 'C:\\HumanChromeProfile'
  };
  const runtime = createBrowserRuntime({
    config: {
      ...createDefaults(env.LOCALAPPDATA),
      browserStartupTimeoutMs: 500
    },
    registry: {
      getSnapshot: async () => ({ sessions: [], browser: null }),
      claimBrowserLaunch: async () => ({ status: 'claimed', token: 'launch-2' }),
      completeBrowserLaunch: async () => {},
      failBrowserLaunch: async (_token, message) => failures.push(message),
      recordExternalBrowser: async record => record
    },
    adapter: {
      queryListener: async () => [],
      queryBrowserProcesses: async () => [],
      resolveBrowser: () => selection,
      buildBrowserArgs: () => [],
      launchBrowser: async () => ({
        pid: 302,
        getStderrTail: () => 'SingletonLock access denied'
      }),
      terminateProcessTree: async () => {}
    },
    now: () => clock,
    sleep: async ms => {
      clock += ms;
    }
  });

  await assert.rejects(
    runtime.ensureBrowser(),
    /SingletonLock access denied/
  );
  assert.match(failures[0], /SingletonLock access denied/);
});

test('browser process query falls back when CIM command line access is denied', async () => {
  let calls = 0;
  const adapter = createWindowsBrowserAdapter({
    execFile: (_command, _args, _options, callback) => {
      calls += 1;
      if (calls === 1) {
        callback(new Error('Access denied'), '', 'Access denied');
        return;
      }
      callback(null, JSON.stringify({
        ProcessId: 301,
        ParentProcessId: 0,
        Name: 'chrome.exe',
        ExecutablePath: 'C:\\Chrome\\chrome.exe',
        CommandLine: null,
        CreationDate: 'created-301'
      }), '');
    }
  });

  const processes = await adapter.queryBrowserProcesses(['chrome.exe']);
  assert.equal(calls, 2);
  assert.deepEqual(processes, [{
    pid: 301,
    parentPid: 0,
    name: 'chrome.exe',
    executablePath: 'C:\\Chrome\\chrome.exe',
    commandLine: '',
    createdAt: 'created-301'
  }]);
});

test('profile writability check reports an explicit browser error', async () => {
  const adapter = createWindowsBrowserAdapter({
    fsPromises: {
      mkdir: async () => {
        const error = new Error('Access denied');
        error.code = 'EACCES';
        throw error;
      },
      writeFile: async () => {},
      unlink: async () => {}
    }
  });

  await assert.rejects(
    adapter.ensureProfileWritable({
      userDataDir: 'C:\\Users\\tester\\AppData\\Local\\HumanChromeProfile'
    }),
    /BROWSER_PROFILE_NOT_WRITABLE.*Access denied/
  );
});

test('browser runtime checks profile writability before launch', async () => {
  let launched = false;
  let clock = 0;
  const selection = {
    kind: 'chrome',
    executablePath: 'C:\\Chrome\\chrome.exe',
    processName: 'chrome.exe',
    userDataDir: 'C:\\HumanChromeProfile'
  };
  const runtime = createBrowserRuntime({
    config: createDefaults(env.LOCALAPPDATA),
    registry: {
      getSnapshot: async () => ({ sessions: [], browser: null }),
      claimBrowserLaunch: async () => ({ status: 'claimed', token: 'launch-3' }),
      failBrowserLaunch: async () => {},
      recordExternalBrowser: async record => record
    },
    adapter: {
      queryListener: async () => [],
      queryBrowserProcesses: async () => [],
      resolveBrowser: () => selection,
      buildBrowserArgs: () => [],
      ensureProfileWritable: async () => {
        throw new Error('BROWSER_PROFILE_NOT_WRITABLE: Access denied');
      },
      launchBrowser: async () => {
        launched = true;
        return { pid: 303 };
      },
      terminateProcessTree: async () => {}
    },
    now: () => clock,
    sleep: async ms => {
      clock += ms;
    }
  });

  await assert.rejects(
    runtime.ensureBrowser(),
    /BROWSER_PROFILE_NOT_WRITABLE/
  );
  assert.equal(launched, false);
});

test('session registry persists shared state to a .jsonl file', async t => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'human-browser-jsonl-'));
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }));
  const registry = createSessionRegistry({
    stateDir,
    pid: 101,
    parentPid: 10,
    isProcessAlive: pid => pid === 101 || pid === 10,
    randomId: () => 'first',
    now: () => 1_000_000,
    sleep: async () => {}
  });
  const statePath = path.join(stateDir, 'runtime-state.jsonl');
  await registry.registerSession();
  const raw = await fs.readFile(statePath, 'utf8');
  const parsed = JSON.parse(raw.trim());
  assert.equal(parsed.version, 1);
  assert.ok(Array.isArray(parsed.sessions));
  assert.equal(parsed.sessions[0].pid, 101);
});

test('session registry degrades to in-memory state when the file is unreadable', async t => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'human-browser-degrade-'));
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }));
  const statePath = path.join(stateDir, 'runtime-state.jsonl');
  // Simulate a corrupted state file: the file exists but is not JSON.
  await fs.writeFile(statePath, Buffer.from([0x41, 0x42, 0x00, 0xff]), 'binary');
  const logs = [];
  const registry = createSessionRegistry({
    stateDir,
    pid: 101,
    parentPid: 10,
    isProcessAlive: pid => pid === 101 || pid === 10,
    randomId: () => 'first',
    now: () => 1_000_000,
    sleep: async () => {},
    log: message => logs.push(message)
  });
  const { record } = await registry.registerSession();
  assert.equal(record.pid, 101);
  const claim = await registry.claimBrowserLaunch({
    kind: 'chrome',
    executablePath: 'C:\\Chrome\\chrome.exe',
    processName: 'chrome.exe',
    userDataDir: 'C:\\HumanChromeProfile'
  });
  // Degraded mode reports the claim as already satisfied (no blocking).
  assert.equal(claim.status, 'ready');
  assert.equal(claim.degraded, true);
  const snapshot = await registry.getSnapshot();
  assert.ok(Array.isArray(snapshot.sessions));
  assert.ok(logs.some(line => /in-memory fallback/i.test(line)));
});

test('session registry falls back to memory when the state file is unwritable', async t => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'human-browser-readonly-'));
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }));
  const registry = createSessionRegistry({
    stateDir,
    pid: 101,
    parentPid: 10,
    isProcessAlive: pid => pid === 101 || pid === 10,
    randomId: () => 'first',
    now: () => 1_000_000,
    sleep: async () => {},
    // Force write failure by pointing the state path at a directory.
    statePath: stateDir
  });
  // registerSession must not throw even though the write fails.
  const { record } = await registry.registerSession();
  assert.equal(record.pid, 101);
});

test('degraded browser launch proceeds without persisted claim bookkeeping', async () => {
  // Realistic degraded case: the state file is unavailable (no other
  // wrappers) and the dedicated browser is NOT yet listening, so the runtime
  // must still launch on the default parameters instead of blocking.
  let launched = false;
  let ready = false;
  let clock = 0;
  const profile = 'C:\\Users\\tester\\AppData\\Local\\HumanChromeProfile';
  const selection = {
    kind: 'chrome',
    executablePath: 'C:\\Chrome\\chrome.exe',
    processName: 'chrome.exe',
    userDataDir: profile
  };
  const readyProcess = {
    pid: 401,
    parentPid: 1,
    name: 'chrome.exe',
    executablePath: 'C:\\Chrome\\chrome.exe',
    commandLine: '--remote-debugging-port=9222 --user-data-dir=' + profile,
    createdAt: 'created-401'
  };
  const registry = {
    getSnapshot: async () => ({ sessions: [], browser: null }),
    claimBrowserLaunch: async () => ({ status: 'ready', browser: null, degraded: true })
  };
  const adapter = {
    // Probes report "not ready" until launchBrowser flips readiness.
    queryListener: async () => (ready ? [{ address: '127.0.0.1', pid: 401 }] : []),
    queryBrowserProcesses: async () => (ready ? [readyProcess] : []),
    resolveBrowser: () => selection,
    buildBrowserArgs: () => [],
    ensureProfileWritable: async () => {},
    launchBrowser: async () => {
      launched = true;
      ready = true;
      return { pid: 401 };
    },
    terminateProcessTree: async () => {}
  };
  const runtime = createBrowserRuntime({
    config: {
      ...createDefaults(env.LOCALAPPDATA),
      browserStartupTimeoutMs: 5000
    },
    registry,
    adapter,
    httpGetJson: async () => ({
      Browser: 'Chrome/152',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222'
    }),
    now: () => clock,
    sleep: async ms => { clock += ms; }
  });

  const record = await runtime.ensureBrowser();
  assert.equal(launched, true);
  assert.equal(record.pid, 401);
  assert.equal(record.launchedByWrapper, true);
});
