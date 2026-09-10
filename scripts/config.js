const fs = require('node:fs');
const path = require('node:path');

const FORBIDDEN_BROWSER_ARGUMENTS = [
  /^--headless(?:=|$)/i,
  /^--enable-automation(?:=|$)/i,
  /^--remote-debugging-pipe(?:=|$)/i,
  /AutomationControlled/i,
  /stealth/i,
  /fingerprint/i
];

function createDefaults(localAppData = process.env.LOCALAPPDATA) {
  if (!localAppData) {
    throw new Error('LOCALAPPDATA is required');
  }
  return {
    browserPreference: ['chrome', 'edge'],
    chromePath: null,
    edgePath: null,
    chromeUserDataDir: path.win32.join(localAppData, 'HumanChromeProfile'),
    edgeUserDataDir: path.win32.join(localAppData, 'HumanEdgeProfile'),
    debuggingAddress: '127.0.0.1',
    debuggingPort: 9222,
    headless: false,
    browserStartupTimeoutMs: 30000,
    mcpPackage: 'chrome-devtools-mcp@1.9.0',
    mcpArgs: [],
    extraBrowserArgs: [],
    guardTimeoutMs: 5000,
    launchClaimTimeoutMs: 40000,
    heartbeatIntervalMs: 2000,
    heartbeatTimeoutMs: 10000
  };
}

function expandWindowsEnvironmentVariables(value, environment) {
  if (typeof value !== 'string') {
    return value;
  }
  const values = new Map(
    Object.entries(environment).map(([name, item]) => [name.toUpperCase(), item])
  );
  return value.replace(/%([^%]+)%/g, (token, name) => {
    const replacement = values.get(name.toUpperCase());
    return replacement === undefined ? token : replacement;
  });
}

function validateConfig(input) {
  const config = {
    ...input,
    browserPreference: [...(input.browserPreference || [])],
    mcpArgs: [...(input.mcpArgs || [])],
    extraBrowserArgs: [...(input.extraBrowserArgs || [])]
  };
  if (JSON.stringify(config.browserPreference) !== JSON.stringify(['chrome', 'edge'])) {
    throw new Error('browserPreference must be ["chrome", "edge"]');
  }
  if (config.debuggingAddress !== '127.0.0.1') {
    throw new Error('debuggingAddress must use the 127.0.0.1 loopback address');
  }
  if (!Number.isInteger(config.debuggingPort) ||
      config.debuggingPort < 1024 ||
      config.debuggingPort > 65535) {
    throw new Error('debuggingPort must be an integer from 1024 through 65535');
  }
  if (config.headless !== false) {
    throw new Error('headless must remain false');
  }
  if (!Number.isInteger(config.browserStartupTimeoutMs) ||
      config.browserStartupTimeoutMs < 1000) {
    throw new Error('browserStartupTimeoutMs must be at least 1000');
  }
  if (!Number.isInteger(config.launchClaimTimeoutMs) ||
      config.launchClaimTimeoutMs <= config.browserStartupTimeoutMs) {
    throw new Error('launchClaimTimeoutMs must exceed browserStartupTimeoutMs');
  }
  for (const argument of config.extraBrowserArgs) {
    if (typeof argument !== 'string' ||
        FORBIDDEN_BROWSER_ARGUMENTS.some(pattern => pattern.test(argument))) {
      throw new Error('forbidden browser argument: ' + argument);
    }
  }
  if (config.mcpArgs.some(argument => String(argument).startsWith('--browser-url'))) {
    throw new Error('mcpArgs must not contain --browser-url; the wrapper supplies it');
  }
  return Object.freeze(config);
}

function loadConfig(options = {}) {
  const localAppData = options.localAppData || process.env.LOCALAPPDATA;
  const defaults = createDefaults(localAppData);
  const configPath = options.configPath ||
    path.win32.join(localAppData, 'HumanBrowser', 'config.json');
  const existsSync = options.existsSync || fs.existsSync;
  const readFileSync = options.readFileSync || fs.readFileSync;
  const overrides = existsSync(configPath)
    ? JSON.parse(readFileSync(configPath, 'utf8'))
    : {};
  const config = { ...defaults, ...overrides };
  const environment = { ...process.env, LOCALAPPDATA: localAppData };
  for (const key of [
    'chromePath',
    'edgePath',
    'chromeUserDataDir',
    'edgeUserDataDir'
  ]) {
    config[key] = expandWindowsEnvironmentVariables(config[key], environment);
  }
  return validateConfig(config);
}

function buildMcpArgs(config) {
  return [
    '-y',
    config.mcpPackage,
    '--browser-url=http://' + config.debuggingAddress + ':' + config.debuggingPort,
    ...config.mcpArgs
  ];
}

module.exports = {
  FORBIDDEN_BROWSER_ARGUMENTS,
  createDefaults,
  validateConfig,
  loadConfig,
  buildMcpArgs
};
