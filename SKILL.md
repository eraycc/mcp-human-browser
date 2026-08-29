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
- Never persist conversation authorization in runtime-state.json, browser Profiles, or config files. Do not echo or log credentials unnecessarily.

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
| webdriver is true | Diagnose the attachment and dedicated Profile |
| Page or MCP connection recovered | Refresh list_pages, snapshot, and webdriver |
| Requested external action completed | Verify the destination or server-side result |
