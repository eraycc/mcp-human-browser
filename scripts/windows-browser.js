const fs = require('node:fs');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');

function compactUnique(values) {
  return [...new Set(values
    .filter(Boolean)
    .map(value => path.win32.normalize(String(value))))];
}

function resolveBrowser(config, adapters = {}) {
  const env = adapters.env || process.env;
  const existsSync = adapters.existsSync || fs.existsSync;
  if (!env.LOCALAPPDATA) {
    throw new Error('LOCALAPPDATA is required to resolve browser profiles');
  }
  const chromeCandidates = compactUnique([
    config.chromePath,
    env.ProgramFiles &&
      path.win32.join(env.ProgramFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    env['ProgramFiles(x86)'] &&
      path.win32.join(env['ProgramFiles(x86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.win32.join(env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe')
  ]);
  const edgeCandidates = compactUnique([
    config.edgePath,
    env.ProgramFiles &&
      path.win32.join(env.ProgramFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    env['ProgramFiles(x86)'] &&
      path.win32.join(env['ProgramFiles(x86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.win32.join(env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
  ]);

  const chromePath = chromeCandidates.find(existsSync);
  if (chromePath) {
    return {
      kind: 'chrome',
      executablePath: chromePath,
      processName: 'chrome.exe',
      userDataDir: config.chromeUserDataDir
    };
  }
  const edgePath = edgeCandidates.find(existsSync);
  if (edgePath) {
    return {
      kind: 'edge',
      executablePath: edgePath,
      processName: 'msedge.exe',
      userDataDir: config.edgeUserDataDir
    };
  }
  throw new Error(
    'BROWSER_NOT_FOUND: Chrome and Edge were not detected. Checked: ' +
    [...chromeCandidates, ...edgeCandidates].join('; ')
  );
}

function buildBrowserArgs(config, selection) {
  return [
    '--remote-debugging-address=' + config.debuggingAddress,
    '--remote-debugging-port=' + config.debuggingPort,
    '--user-data-dir=' + selection.userDataDir,
    '--no-first-run',
    '--no-default-browser-check',
    ...config.extraBrowserArgs,
    'about:blank'
  ];
}

function normalizeArray(value) {
  if (value === null || value === undefined || value === '') return [];
  return Array.isArray(value) ? value : [value];
}

function quotePowerShellLiteral(value) {
  return "'" + String(value).replaceAll("'", "''") + "'";
}

function runPowerShellJson(script, options = {}) {
  const exec = options.execFile || execFile;
  return new Promise((resolve, reject) => {
    exec(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error('PowerShell query failed: ' + (stderr || error.message).trim()));
          return;
        }
        const text = stdout.trim();
        if (!text) {
          resolve(null);
          return;
        }
        try {
          resolve(JSON.parse(text));
        } catch (parseError) {
          reject(new Error('PowerShell returned invalid JSON: ' + parseError.message));
        }
      }
    );
  });
}

function createWindowsBrowserAdapter(options = {}) {
  const exec = options.execFile || execFile;
  const spawnProcess = options.spawn || spawn;
  const env = options.env || process.env;
  const existsSync = options.existsSync || fs.existsSync;
  const fsPromises = options.fsPromises || fs.promises;

  async function queryListener(port) {
    if (!Number.isInteger(port)) throw new Error('Port must be an integer');
    const script =
      '$v=Get-NetTCPConnection -State Listen -LocalPort ' + port +
      ' -ErrorAction SilentlyContinue | Select-Object LocalAddress,OwningProcess;' +
      '$v | ConvertTo-Json -Compress';
    return normalizeArray(await runPowerShellJson(script, { execFile: exec }))
      .map(item => ({
        address: item.LocalAddress,
        pid: Number(item.OwningProcess)
      }));
  }

  async function queryBrowserProcesses(processNames = ['chrome.exe', 'msedge.exe']) {
    const names = processNames.map(quotePowerShellLiteral).join(',');
    const cimScript =
      '$n=@(' + names + ');' +
      'Get-CimInstance -Namespace root/cimv2 -ClassName Win32_Process | ' +
      'Where-Object { $n -contains $_.Name } | ' +
      'Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine,CreationDate | ' +
      'ConvertTo-Json -Compress';
    let result;
    try {
      result = await runPowerShellJson(cimScript, { execFile: exec });
    } catch (cimError) {
      const fallbackScript =
        '$n=@(' + names + ');' +
        "Get-Process | Where-Object { $n -contains ($_.ProcessName + '.exe') } | " +
        'ForEach-Object {' +
        '$p=$_;' +
        '[pscustomobject]@{' +
        "ProcessId=$p.Id;ParentProcessId=0;Name=($p.ProcessName + '.exe');" +
        "ExecutablePath=$(try{$p.Path}catch{''});CommandLine=$null;" +
        "CreationDate=$(try{$p.StartTime.ToUniversalTime().ToString('o')}catch{''})" +
        '}} | ConvertTo-Json -Compress';
      try {
        result = await runPowerShellJson(fallbackScript, { execFile: exec });
      } catch (fallbackError) {
        throw new Error(
          cimError.message + '; Get-Process fallback failed: ' +
          fallbackError.message
        );
      }
    }
    return normalizeArray(result).map(item => ({
      pid: Number(item.ProcessId),
      parentPid: Number(item.ParentProcessId),
      name: item.Name,
      executablePath: item.ExecutablePath || '',
      commandLine: item.CommandLine || '',
      createdAt: item.CreationDate || ''
    }));
  }

  async function ensureProfileWritable(selection) {
    const directory = selection.userDataDir;
    const probe = path.win32.join(
      directory,
      '.mcp-human-browser-write-' + process.pid + '-' + Date.now() + '.tmp'
    );
    try {
      await fsPromises.mkdir(directory, { recursive: true });
      await fsPromises.writeFile(probe, '', { flag: 'wx' });
      await fsPromises.unlink(probe);
    } catch (error) {
      await fsPromises.unlink(probe).catch(() => {});
      throw new Error(
        'BROWSER_PROFILE_NOT_WRITABLE: ' + directory + '; ' + error.message
      );
    }
  }

  async function launchBrowser(selection, args) {
    const child = spawnProcess(selection.executablePath, args, {
      detached: false,
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: false
    });
    let stderrTail = '';
    if (child.stderr) {
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', chunk => {
        stderrTail = (stderrTail + chunk).slice(-8192);
      });
      if (typeof child.stderr.unref === 'function') child.stderr.unref();
    }
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    child.unref();
    return {
      pid: child.pid,
      getStderrTail: () => stderrTail.trim()
    };
  }

  async function terminateProcessTree(pid) {
    if (!Number.isInteger(pid) || pid <= 0) throw new Error('Invalid browser PID');
    await new Promise((resolve, reject) => {
      exec(
        'taskkill.exe',
        ['/PID', String(pid), '/T', '/F'],
        { windowsHide: true },
        (error, stdout, stderr) => {
          if (error) {
            reject(new Error('Browser cleanup failed: ' + (stderr || stdout || error.message).trim()));
            return;
          }
          resolve();
        }
      );
    });
  }

  return {
    resolveBrowser: config => resolveBrowser(config, { env, existsSync }),
    buildBrowserArgs,
    queryListener,
    queryBrowserProcesses,
    ensureProfileWritable,
    launchBrowser,
    terminateProcessTree
  };
}

module.exports = {
  compactUnique,
  resolveBrowser,
  buildBrowserArgs,
  normalizeArray,
  runPowerShellJson,
  createWindowsBrowserAdapter
};
