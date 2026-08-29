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
    'chrome-devtools-mcp@latest',
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
