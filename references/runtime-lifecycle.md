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
  → LAST_SESSION_EXIT
  → VERIFY_WRAPPER_OWNERSHIP
  → CLOSE_WRAPPER_OWNED_BROWSER
~~~

Multiple wrappers register independent session IDs in runtime-state.json. A short-held runtime-state.guard serializes state changes. Browser startup and shutdown occur only after a claim is recorded and the Guard is released.

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
- The browser remains while at least one registered wrapper session is alive.
- Startup failure or timeout terminates the newly launched process tree before the error is returned.
- The final session receives a cleanup claim only for launchedByWrapper=true.
- Cleanup re-queries PID, process name, executable path, CreationDate, and the exact loopback listener owner before terminating anything.
- When command-line access is available, the dedicated Profile and debugging-port flags must also match.
- If command-line access is unavailable, cleanup is permitted only when every stronger fingerprint and listener-owner check matches.
- External Chrome or Edge instances remain running.

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

Authorization belongs to the current user request and conversation, not the runtime. Existing required data may be used without a repeated confirmation. runtime-state.json and browser Profiles contain no authorization flag. A new task or conversation establishes its own scope.
