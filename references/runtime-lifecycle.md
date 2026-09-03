# Runtime Lifecycle

## Process tree

~~~text
Codex session
└── start-mcp.js
    └── chrome-devtools-mcp
        └── CDP connection to a shared visible Chrome or Edge
~~~

start-mcp.js starts with Codex. The browser starts only when tools/call arrives.

## State transitions

~~~text
MCP_READY_NO_BROWSER
  → FIRST_TOOL_CALL
  → PROFILE_WRITABILITY_CHECK
  → BROWSER_STARTING
  → BROWSER_READY
  → TOOL_PROXYING
    ├─→ EXPLICIT_AUTHORIZED_CLOSE
    │   → BROWSER_CLOSING
    │   → CLOSE_WRAPPER_OWNED_BROWSER
    └─→ LAST_SESSION_EXIT
        → VERIFY_WRAPPER_OWNERSHIP
        → CLOSE_WRAPPER_OWNED_BROWSER
~~~

Multiple wrappers register independent session IDs in `runtime-state.jsonl`. A short-held `runtime-state.guard` serializes state changes. Browser startup and shutdown occur only after a claim is recorded and the Guard is released.

The state file is JSON Lines (a single-line JSON document). If the file is missing, unreadable, or unwritable, the registry degrades to in-memory state; browser launch then proceeds on the default parameters and the MCP child reaches the browser via the live loopback CDP endpoint, so startup is never blocked by a broken state file.

The default browser startup timeout is 30 seconds. The launch-claim timeout is 40 seconds and must remain greater than the startup timeout so another session cannot steal an active launch claim prematurely.

## Browser record

The ready record contains:

- kind: chrome or edge;
- executablePath and processName;
- dedicated userDataDir;
- PID and process CreationDate;
- actual debugging port;
- launchedByWrapper ownership;
- update timestamp.

## Multi-session cleanup

- The first session claims browser startup; other sessions wait for the ready record.
- During normal session shutdown, the browser remains while at least one registered wrapper session is alive. An explicit authorized close may end the shared window earlier.
- Startup failure or timeout terminates the newly launched process tree before the error is returned.
- The final session receives a cleanup claim only for launchedByWrapper=true.
- An agent may also request an explicit close via the `close_browser_window` local tool when the current task semantics authorize it. The intent belongs to that tool call and is not persisted. Because all registered agents share the same dedicated window, any registered session with an explicit close intent may close it. Under the state Guard, the registry verifies wrapper ownership, copies the full browser fingerprint, and atomically moves the browser to `closing`; a competing close receives `BROWSER_NOT_READY`. Other sessions wait for the claim to complete and reconnect or relaunch on their next browser tool call.
- Wrapper shutdown waits for an in-flight local close before unregistering its session, and unregistering never erases an active `closing` claim. A failed close is token-aborted. If the close owner crashes, the registry clears the claim only after its lease expires and the recorded owner PID is confirmed dead.
- Cleanup re-queries PID, process name, executable path, CreationDate, and the exact loopback listener owner before terminating anything.
- When command-line access is available, the dedicated Profile and debugging-port flags must also match.
- If command-line access is unavailable, cleanup is permitted only when every stronger fingerprint and listener-owner check matches.
- External Chrome or Edge instances remain running.

## Startup orphan cleanup

Before registering its session, `start-mcp.js` sweeps out orphaned wrapper
processes: any `start-mcp.js` whose parent process has already exited. Live
wrappers (including other agents') are never touched. The sweep is
best-effort — a CIM/PowerShell failure is logged and swallowed, so it can
never block startup. It is skipped in the unit tests (`cleanStaleWrappers:
false`).

## MCP-child recovery

- A child exit rejects pending forwarded calls with JSON-RPC error -32071.
- One shared recovery operation prevents concurrent calls from spawning competing replacement children.
- Recovery allows at most two replacement-child attempts.
- Each replacement must answer the cached initialize request successfully within 10 seconds; an initialize error also rejects that replacement.
- The cached notifications/initialized message is replayed only after successful initialize.
- Browser preparation errors use -32070.
- Exhausted MCP recovery uses -32072.
- Calls remain blocked behind the shared recovery promise until a replacement is ready or recovery is exhausted.

After any recovery, call list_pages, acquire a fresh snapshot, and re-evaluate navigator.webdriver before interacting.

## Verification counters survive recovery

A browser or MCP-child restart does not create a new allowance for the same website challenge. Preserve the challenge's automated-attempt count and stop after three unresolved attempts as defined in browser-verification.md.

## Authorization boundary

Authorization belongs to the current user request and conversation, not the runtime. Existing required data may be used without a repeated confirmation. `runtime-state.jsonl` and browser Profiles contain no authorization flag. A new task or conversation establishes its own scope.
