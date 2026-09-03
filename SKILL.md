---
name: mcp-human-browser
description: Use when Chrome DevTools MCP must access or operate a site through an ordinary visible browser with persistent state, JavaScript, login state, browser-integrity verification, or anti-bot checks; also when 127.0.0.1:9222 is unavailable, navigator.webdriver is true, or Chrome DevTools connections need lifecycle recovery.
---

# MCP Human Browser

## Overview

Use the chrome_devtools MCP through the bundled lazy runtime. MCP tools can be discovered without opening a browser. The first browser tool call starts or reuses a visible dedicated Chrome; Microsoft Edge is a best-effort fallback.

## Action and authorization boundary

The user's requested outcome defines the authorized scope. Do not ask for another confirmation when the next browser operation is a necessary part of that outcome and the required data is already available.

- If the user supplied a username and password for a requested login, enter them and submit directly.
- If the requested flow needs a supplied one-time code, form value, destination, text, or choice, use it directly.
- Ask the user only when progress requires something the AI cannot independently supply or complete: a missing secret or current code, biometric or passkey approval, personal-consent control, recognition challenge, ambiguous consequential choice, or manual browser takeover.
- Limit the request to the blocked step. After the user completes or supplies it, refresh page evidence and resume without re-confirming the whole task.
- Do not extend the task merely because the browser is available. A request to inspect an account does not authorize a purchase, post, deletion, subscription, or unrelated account change.
- Never persist conversation authorization in `runtime-state.jsonl`, browser Profiles, or config files. Do not echo or log credentials unnecessarily.

## Startup and connection failure diagnosis

If the first browser call, especially `list_pages` or `new_page`, reports that it cannot connect to Chrome, or cannot fetch `http://127.0.0.1:9222/json/version`, treat that as a local runtime startup problem before trying more page navigation.

- Check whether `127.0.0.1:9222` is listening and whether the owner is the dedicated `chrome.exe` or `msedge.exe` process for the configured Profile.
- Check `%LOCALAPPDATA%\HumanBrowser\` for current runtime state, stale `runtime-state.jsonl.*.tmp` files, stale `runtime-state.json` from earlier versions, and the recorded browser PID.
- If the recorded browser PID is dead or no dedicated browser CDP listener exists, the runtime must be able to launch a browser. The wrapper persists state to `runtime-state.jsonl` and degrades to in-memory state if the file is unreadable or unwritable, so a broken state file never blocks startup. On start it also sweeps out orphaned `start-mcp.js` processes (parent already exited).
- If the host sandbox is workspace-only or denies access to `%LOCALAPPDATA%\HumanBrowser`, the browser executable, the dedicated browser Profile, or loopback `127.0.0.1:9222`, tell the user the MCP cannot start or recover the browser under the current sandbox.
- After confirming the likely sandbox restriction, proactively ask the user to raise permission if the host supports an approval/permission prompt. Do not merely report the failure and wait silently.
- If the host cannot auto-escalate, clearly tell the user to check and set the agent permission to full access / never-ask / unrestricted, or to allow the specific local paths and loopback `127.0.0.1:9222` port.
- Full access is the safest diagnostic baseline when sandbox rules make it impossible to distinguish a real browser failure from a sandbox denial.

## Workflow

1. Call chrome_devtools list_pages. The lazy runtime starts or reuses the browser on this first tools/call.
2. Evaluate the selected page:

   ~~~javascript
   () => ({
     webdriver: navigator.webdriver,
     userAgent: navigator.userAgent,
     url: location.href
   })
   ~~~

3. Continue only when webdriver is exactly false. Otherwise diagnose the listener, attachment, and dedicated Profile with references/windows-9222.md.
4. Navigate and take a fresh snapshot before interaction. Use current page identifiers only.
5. For Cloudflare, Turnstile, reCAPTCHA, hCaptcha, login verification, MFA, or another visible verification flow, read references/browser-verification.md. Never exceed three automated verification attempts for one challenge episode.
6. After a browser or MCP-child recovery, call list_pages, select the current page, take a new snapshot, and recheck webdriver before resuming.
7. Verify the requested result from the destination page, authenticated state, server response, download, or resulting account state. A green widget or generated token is only supporting evidence.
8. Close the dedicated browser window only when the current task semantics authorize it; authorization may be in the original instruction or a later user request, so do not ask for redundant confirmation. Use the `close_browser_window` local tool with:
   - `intent: "close-after-requested"` when the user later asks to close the browser window after it was already opened;
   - `intent: "close-after-task"` when the original instruction explicitly says to close the browser after the task completes (e.g. “打开 xxx，执行 xxx 后关闭浏览器”);
   - an optional short `reason` describing the authorization. Do not include credentials.

   The tool closes only a wrapper-owned browser whose process fingerprint still matches. An explicit user close intent applies to the shared dedicated window, so any registered agent session may atomically claim and close it even when other sessions are registered. Other sessions reconnect or relaunch on their next browser tool call. External Chrome or Edge instances remain protected.

## Runtime references

- Setup, browser selection, listener and process diagnosis: references/windows-9222.md
- Verification attempt accounting and manual handoff: references/browser-verification.md
- Multi-session state, recovery, and final cleanup: references/runtime-lifecycle.md

## Quick reference

| Observed state | Action |
|---|---|
| First browser operation | Call list_pages; lazy runtime starts or reuses the browser |
| Supplied credentials satisfy a requested login | Enter and submit without another confirmation |
| Required value is missing | Ask only for that value |
| AI-only completion is impossible | Ask the user to handle the blocked step, then resume |
| Verification is unresolved after attempt 1 or 2 | Refresh evidence and make at most the next bounded attempt |
| Verification is unresolved after attempt 3 | Stop all automated attempts and wait for manual completion |
| `127.0.0.1:9222` unavailable, stale runtime state, or sandbox blocks AppData/Profile access | Check sandbox execution permission; the wrapper now degrades gracefully (in-memory state) and launches on defaults. If it still cannot start, ask the user to raise permission to full access / never-ask, or allow `%LOCALAPPDATA%\HumanBrowser`, the Profile dir, and loopback `127.0.0.1:9222` |
| State file missing / unreadable / unwritable | State lives in `runtime-state.jsonl`. Stale `runtime-state.json` from earlier versions is ignored; you may delete it and any orphaned `start-mcp.js` processes manually |
| webdriver is true | Diagnose the attachment and dedicated Profile |
| Page or MCP connection recovered | Refresh list_pages, snapshot, and webdriver |
| Requested external action completed | Verify the destination or server-side result |
| User explicitly authorized closing the browser window | Call `close_browser_window` with the matching `intent`; any registered agent may close the shared wrapper-owned window |
