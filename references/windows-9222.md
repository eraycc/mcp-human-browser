# Windows Lazy Browser Runtime

Read this reference when chrome_devtools configuration, 127.0.0.1:9222, browser ownership, dedicated Profile state, or navigator.webdriver is uncertain.

## Expected Codex MCP entry

~~~toml
[mcp_servers.chrome_devtools]
command = "node"
args = [
  "C:\\path\\to\\mcp-human-browser\\scripts\\start-mcp.js"
]
startup_timeout_sec = 30
tool_timeout_sec = 120
enabled = true
~~~

Check it with:

~~~powershell
codex mcp get chrome_devtools --json
~~~

Changing config.toml requires a Codex or IDE restart because an active STDIO MCP process does not hot-reload.

For a live protocol and lifecycle smoke test:

~~~powershell
node C:\path\to\mcp-human-browser\scripts\tests\live-smoke.js
~~~

The smoke test exits nonzero unless all required invariants hold: listenerBefore=false, listenerAfterInitialize=false, listenerDuring=true, navigator.webdriver=false, pageIdRequired=true, unknownArgumentWarning=false, and listenerAfterExit=false.

## Lazy startup

Codex startup launches start-mcp.js and its chrome-devtools-mcp child. Chrome and Edge remain closed until the first tools/call, normally list_pages.

The wrapper resolves browsers in this order:

1. configured chromePath;
2. Chrome under Program Files, Program Files (x86), then LocalAppData;
3. configured edgePath;
4. Microsoft Edge under Program Files, Program Files (x86), then LocalAppData.

Chrome is the primary supported target. Edge uses the Chromium CDP path as a best-effort fallback and should be covered by the live smoke test after upstream MCP upgrades.

Chrome uses %LOCALAPPDATA%\HumanChromeProfile. Edge uses %LOCALAPPDATA%\HumanEdgeProfile. Before launch, the runtime creates the selected directory and performs an exclusive write/delete probe. Failure returns BROWSER_PROFILE_NOT_WRITABLE with the exact Profile path.

Both browsers receive:

~~~text
--remote-debugging-address=127.0.0.1
--remote-debugging-port=9222
--user-data-dir=<dedicated profile>
--no-first-run
--no-default-browser-check
about:blank
~~~

The MCP child receives --browser-url=http://127.0.0.1:9222. Current chrome-devtools-mcp releases require pageId routing by default, so the obsolete explicit --page-id-routing argument is omitted. Do not add --no-page-id-routing.

The default package is chrome-devtools-mcp@1.8.0. To upgrade, pin a newer exact version in config.json and run the unit and live smoke suites before switching over. For stricter privacy, supported MCP flags such as --no-usage-statistics and --no-performance-crux can be added to mcpArgs.

## Runtime files

~~~text
%LOCALAPPDATA%\HumanBrowser\
├── config.json
├── runtime-state.jsonl
└── runtime-state.guard
~~~

config.json is optional. See config.example.json for supported values. `runtime-state.jsonl` (a single-line JSON document) records active wrapper sessions and the selected browser fingerprint. Legacy `runtime-state.json` files (if any exist from earlier versions) are ignored and may be deleted. If `runtime-state.jsonl` is missing, unreadable, or unwritable, the wrapper degrades to in-memory state and still launches the browser on default parameters, so startup is never blocked by a broken state file.

On startup the wrapper also sweeps out orphaned `start-mcp.js` processes (parent already exited); live wrappers are never touched.

## Read-only diagnosis

~~~powershell
Get-NetTCPConnection -LocalPort 9222 -State Listen -ErrorAction SilentlyContinue |
  Select-Object LocalAddress, LocalPort, OwningProcess

Get-CimInstance -Namespace root/cimv2 -ClassName Win32_Process |
  Where-Object {
    $_.Name -in @('chrome.exe', 'msedge.exe') -and
    ($_.CommandLine -like '*HumanChromeProfile*' -or
     $_.CommandLine -like '*HumanEdgeProfile*')
  } |
  Select-Object ProcessId, ParentProcessId, Name, ExecutablePath, CommandLine, CreationDate

Invoke-RestMethod -Uri 'http://127.0.0.1:9222/json/version' -TimeoutSec 3 |
  Select-Object Browser, 'Protocol-Version', webSocketDebuggerUrl
~~~

If CIM access is denied, the runtime falls back to Get-Process for PID, name, path, and start time. Missing command-line data is treated conservatively: external-browser reuse remains fail-closed, while wrapper-owned final cleanup still requires the exact recorded PID, name, executable path, CreationDate, and loopback listener owner.

Expected conditions:

- listener address is 127.0.0.1 or ::1;
- the exact listener owner is chrome.exe or msedge.exe;
- Browser product matches the owner;
- when readable, the command line contains the configured port and matching dedicated Profile;
- a fresh page evaluation reports navigator.webdriver as false.

## State handling and diagnostics

- A valid dedicated browser already on the configured loopback port is reused as external and retained when Codex exits.
- A browser launched by the wrapper is shared by all live wrapper sessions.
- Closing one Codex session retains the browser while another session is registered.
- The final session closes only a wrapper-owned process whose recorded fingerprint and exact listener ownership still match.
- The wrapper also exposes `close_browser_window`, a local tool for browser-window closure authorized by the current task semantics. Its call-scoped intent is not persisted. Because the dedicated window is shared, any registered agent with explicit user close intent may atomically claim its full wrapper-owned browser fingerprint and close it; competing callers receive `BROWSER_NOT_READY`, and other sessions reconnect or relaunch on their next browser tool call.
- A dedicated Profile open without the configured CDP listener is reported as BROWSER_PROFILE_IN_USE; close that dedicated window and call the browser tool again.
- Startup failure or timeout terminates the new process tree and reports a bounded tail of browser stderr when available.
- If chrome_devtools tools are missing after changing config.toml, restart Codex or the IDE first. Raw CDP checks are diagnostic only and do not replace the MCP protocol.
- After browser or MCP-child recovery, reacquire list_pages, a fresh snapshot, and webdriver before continuing.
