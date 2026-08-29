# Browser Integrity and Verification

Read this reference for Cloudflare, Turnstile, reCAPTCHA, hCaptcha, checking pages, login verification, MFA, or similar visible-browser flows.

## Authorization and manual input

Proceed without a confirmation prompt when the verification or login step is necessary for the user's requested outcome and all required data is already present. Supplied username/password or one-time-code data may be entered and submitted directly.

Ask the user only for a missing value or a step the AI cannot independently complete. Typical handoff points are recognition challenges, biometric or passkey approval, device confirmation, personal-consent controls, and controls that require the user to act in the visible browser. Request only that step; after it is completed, refresh evidence and resume.

Tool availability is not blanket authorization. Do not perform purchases, posts, deletions, subscriptions, or account changes outside the user's requested outcome.

## Three-attempt limit

For each distinct verification challenge episode, allow no more than three automated attempts total.

Treat every verification state encountered while pursuing the same requested protected destination or form submission as one episode. Widget re-rendering, reset, URL-parameter changes, redirects, refreshed tokens, page refresh, and browser or MCP recovery do not create a new episode. A new episode begins only after primary destination or server evidence proves the prior challenge succeeded and a later, explicitly requested independent protected action triggers another challenge, or the user explicitly starts a new task.

One automated attempt is one evidence-driven verification cycle:

1. acquire a fresh page snapshot and current element identifiers;
2. allow normal scripts and redirects to settle;
3. perform at most one required verification interaction, or observe one passive verification cycle;
4. wait for the resulting transition;
5. inspect the destination, authenticated state, or server response.

A challenge reset, rejection, timeout, return to the same unsolved state, or failure_retry loop consumes that attempt. Browser or MCP recovery does not reset the counter for the same challenge episode. Do not refresh merely to obtain extra attempts.

After failed attempts 1 and 2, reacquire list_pages and a fresh snapshot before deciding whether another bounded attempt is warranted. After attempt 3 remains unresolved:

- stop clicking, refreshing, resubmitting, and automated retry loops;
- do not extract, inject, replay, or manipulate challenge tokens or cookies;
- do not change fingerprints, use stealth flags, or switch automation techniques to evade the limit;
- tell the user that three automated attempts were exhausted and ask them to complete the verification manually in the visible browser;
- wait for the user before continuing.

A recognition CAPTCHA or other step the AI cannot independently solve should be handed off immediately; it need not consume three futile attempts.

## Workflow

1. Confirm a fresh page evaluation reports navigator.webdriver as false.
2. Navigate to the requested URL and take a fresh snapshot.
3. Identify whether this is a new challenge episode or a continuation, and retain its current attempt count.
4. Apply the bounded attempt cycle above.
5. When manual input or takeover is required, pause at the current page without altering the challenge further.
6. After the user reports completion, call list_pages, select the current page, take a fresh snapshot, and re-evaluate webdriver.
7. Verify success from the intended destination, authenticated state, form response, or server result.

## Success evidence

Destination content, authenticated account state, a successful form/server response, or the requested downstream result is primary evidence. A checked box, green widget, token length, or disappearance of a challenge is supporting evidence only and must not be reported as final success by itself.

## Cloudflare and Turnstile

Treat Cloudflare and Turnstile as the same visible-browser verification class. Let client checks run normally, use fresh identifiers, apply the same three-attempt counter, and stop immediately after the third unresolved cycle.
