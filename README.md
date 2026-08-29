# mcp-human-browser

A **skill + MCP hybrid** that lets an AI agent drive the `chrome_devtools` MCP
through an ordinary, visible, "human" browser on Windows.

It wraps [`chrome-devtools-mcp`](https://github.com/ChromeDevTools/chrome-devtools-mcp)
with a Node.js **lazy runtime** so that:

- MCP tools are discoverable **without** opening a browser.
- The first real browser call starts (or reuses) a visible, dedicated Chrome —
  with Microsoft Edge as a best-effort fallback.
- The browser runs **loopback-only** (`127.0.0.1:9222`), uses a **dedicated
  user profile**, reports `navigator.webdriver === false`, and never runs
  headless or with automation flags.

## Why

Standard Chrome DevTools MCP setups expose a headless/automated browser:
`navigator.webdriver` is `true`, the port may be missing, and login state is
not persisted across sessions. This project fixes that by launching a real,
visible Chrome/Edge window that behaves like the one a human would open —
persistent login state, real JavaScript, and a clean anti-bot surface.

## What it is

Two cooperating parts:

| Part | Role |
|---|---|
| **Skill** (`SKILL.md`) | Agent instructions: when and how to use the `chrome_devtools` MCP, authorization boundaries, the verification workflow, and recovery. |
| **MCP wrapper** (`scripts/`) | A Node.js STDIO MCP server (`start-mcp.js`) that lazily manages the dedicated browser and the `chrome-devtools-mcp` child process, with lifecycle, recovery, and multi-session state. |

The skill tells the agent *what* to do; the wrapper makes the browser behave
like a human's.

## How it works

```
Codex / IDE
   │  (STDIO, JSON-RPC)
   ▼
start-mcp.js  ──  mcp-proxy.js  ──►  chrome-devtools-mcp (npx child)
   │                                              │
   │  on first tools/call                          │  --browser-url=
   │  (e.g. list_pages)                            ▼
   └──► browser-runtime.js ──► dedicated visible Chrome/Edge
        session-registry.js    127.0.0.1:9222  (dedicated profile, webdriver=false)
        windows-browser.js     (launch / probe / cleanup via PowerShell + CDP)
```

- **Lazy startup** — Codex starts `start-mcp.js` and its MCP child at launch.
  The browser itself stays closed until the first browser `tools/call`
  (usually `list_pages`).
- **Ownership & safety** — The wrapper probes `127.0.0.1:9222`, verifies the
  listener is loopback-only and owned by the expected browser, checks the
  product matches (Chrome vs Edge), and confirms the dedicated profile is in
  use before reusing or launching. Forbidden arguments (`--headless`,
  `--enable-automation`, `--remote-debugging-pipe`, automation/stealth/fingerprint
  flags) are rejected.
- **Shared, multi-session browser** — A wrapper-launched browser is shared by
  all live wrapper sessions (tracked in `runtime-state.json`). Closing one
  session keeps it alive; the **final** session closes only the
  wrapper-owned process whose fingerprint still matches.
- **Recovery** — If the MCP child exits, the proxy restarts it and
  re-`initialize`s; pending calls fail with a clear `MCP_CHILD_RESTARTED`
  instruction to re-acquire `list_pages` and a fresh snapshot.

## Repository layout

```
SKILL.md                          Agent instructions and workflow
README.md                         This file
config.example.json               Reference config (see Configuration)
references/
  windows-9222.md                 Setup, browser selection, 9222/port diagnosis
  browser-verification.md         Verification attempt accounting & manual handoff
  runtime-lifecycle.md            Multi-session state, recovery, final cleanup
scripts/
  start-mcp.js                    Entry point / MCP STDIO server
  mcp-proxy.js                    JSON-RPC proxy + child restart/recovery
  browser-runtime.js              Lazy browser ensure, probe, safe cleanup
  windows-browser.js              Windows adapter (resolve/launch/probe/kill)
  session-registry.js             Shared state, launch claims, session lifecycle
  config.js                       Defaults, validation, MCP arg building
  tests/                          Unit + live smoke tests
```

## Requirements

- **Windows** (PowerShell + `Win32_Process` CIM for process management).
- **Node.js** (the wrapper) and **npx** (to launch `chrome-devtools-mcp`).
- **Google Chrome** (primary) or **Microsoft Edge** (fallback), installed in a
  standard location or specified via config.
- **`chrome-devtools-mcp`** (fetched via `npx`; pinned or latest via config).

## Installation

1. **Clone the repository.**

   ```powershell
   git clone https://github.com/eraycc/mcp-human-browser.git
   ```

2. **Register the MCP server** in your agent's MCP config. For Codex, add to
   `config.toml` (replace the path):

   ```toml
   [mcp_servers.chrome_devtools]
   command = "node"
   args = ["C:\path\to\mcp-human-browser\scripts\start-mcp.js"]
   startup_timeout_sec = 30
   tool_timeout_sec = 120
   enabled = true
   ```

   Verify with:

   ```powershell
   codex mcp get chrome_devtools --json
   ```

   > Changing `config.toml` requires restarting Codex or the IDE — an active
   > STDIO MCP process does not hot-reload.

3. **(Optional) Install the skill** for the agent's operating instructions:
   place the `SKILL.md` and `references/` under your agent's skills directory
   (e.g. `~/.agents/skills/mcp-human-browser/`).

4. **(Optional) Create a config file.** Copy `config.example.json` to
   `%LOCALAPPDATA%\HumanBrowser\config.json` and adjust as needed. See
   [Configuration](#configuration).

## Configuration

Config is loaded from `%LOCALAPPDATA%\HumanBrowser\config.json` (optional).
String values may use `%ENV_VAR%` expansion. Unsupported or unsafe values are
rejected with a clear error.

| Key | Default | Notes |
|---|---|---|
| `browserPreference` | `["chrome", "edge"]` | Fixed order; Chrome primary, Edge fallback. |
| `chromePath` / `edgePath` | `null` | Explicit executable path; overrides auto-detection. |
| `chromeUserDataDir` | `%LOCALAPPDATA%\HumanChromeProfile` | Dedicated, persistent profile. |
| `edgeUserDataDir` | `%LOCALAPPDATA%\HumanEdgeProfile` | Dedicated, persistent profile. |
| `debuggingAddress` | `127.0.0.1` | Must stay loopback. |
| `debuggingPort` | `9222` | Integer 1024–65535. |
| `headless` | `false` | Must remain `false`. |
| `browserStartupTimeoutMs` | `30000` | ≥ 1000 ms. |
| `mcpPackage` | `chrome-devtools-mcp@latest` | Pin an exact tested version for change control. |
| `mcpArgs` | `[]` | Extra MCP flags (e.g. `--no-usage-statistics`). Must not include `--browser-url`. |
| `extraBrowserArgs` | `[]` | Extra browser flags; forbidden automation/stealth flags are rejected. |
| `guardTimeoutMs` | `5000` | State-file guard acquisition window. |
| `launchClaimTimeoutMs` | `40000` | Launch-claim wait; must exceed startup timeout. |
| `heartbeatIntervalMs` | `2000` | Session heartbeat interval. |
| `heartbeatTimeoutMs` | `10000` | Session liveness cutoff. |

Runtime files live under `%LOCALAPPDATA%\HumanBrowser\`:

```
%LOCALAPPDATA%\HumanBrowser\
├── config.json            (optional)
├── runtime-state.json     (sessions + browser fingerprint)
└── runtime-state.guard    (write guard)
```

## Usage

Once registered, the agent drives the `chrome_devtools` MCP as usual. The
skill (`SKILL.md`) defines the workflow:

1. Call `list_pages` — the lazy runtime starts or reuses the browser here.
2. Evaluate the page and confirm `navigator.webdriver === false`.
3. Take a fresh snapshot before interacting; use current page identifiers only.
4. For Cloudflare / Turnstile / reCAPTCHA / hCaptcha / MFA flows, follow
   `references/browser-verification.md` (at most **3** automated attempts per
   challenge episode, then hand off to the user).
5. After any browser/MCP-child recovery, re-acquire `list_pages`, a fresh
   snapshot, and re-check `webdriver`.
6. Verify the result from the destination page / server response / account
   state — a green widget or token is only supporting evidence.

Authorization rules are defined in the skill: supplied credentials for a
requested login are entered directly; the user is asked only for genuinely
missing inputs or manual steps; and the task scope is never extended merely
because a browser is available.

## Testing

```powershell
# Unit tests
node --test scripts/tests/

# Live protocol + lifecycle smoke test (opens a real browser; nonzero exit
# unless all invariants hold)
node scripts\tests\live-smoke.js
```

The live smoke test enforces: `listenerBefore=false`,
`listenerAfterInitialize=false`, `listenerDuring=true`,
`navigator.webdriver=false`, `pageIdRequired=true`,
`unknownArgumentWarning=false`, and `listenerAfterExit=false`.

## Safety & privacy notes

- **Loopback-only** debugging port; a non-loopback listener is an error
  (`BROWSER_PORT_EXPOSED`).
- **Dedicated profiles** isolate the agent's browser state from your everyday
  browser.
- **No headless / no automation flags** — the browser is a visible, real one.
- **Conversation authorization is never persisted** to `runtime-state.json`,
  browser profiles, or config files, and credentials are not echoed or logged.

## Troubleshooting

- **`chrome_devtools` tools missing** after a config change → restart Codex/IDE.
- **`navigator.webdriver` is `true`** → diagnose the listener, attachment, and
  dedicated profile per `references/windows-9222.md`.
- **`BROWSER_PROFILE_IN_USE`** → close the dedicated browser window and retry.
- **Port 9222 unavailable / occupied by the wrong process** → see the
  read-only diagnosis commands in `references/windows-9222.md`.

## References

- [`references/windows-9222.md`](references/windows-9222.md) — setup, browser
  selection, 9222/port and process diagnosis.
- [`references/browser-verification.md`](references/browser-verification.md) —
  verification attempt accounting and manual handoff.
- [`references/runtime-lifecycle.md`](references/runtime-lifecycle.md) —
  multi-session state, recovery, and final cleanup.
