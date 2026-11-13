# Weekly account allowance — 2026-11-13

## Requested behavior

Show the account's remaining weekly allowance as a percentage. The user clarified that per-conversation token counts were not needed. The status bar therefore shows only the weekly remainder; details include used and remaining percentages, reset timestamps and other windows returned by Codex.

## Implementation and review

- Native read-only `account/rateLimits/read` requests use the existing Codex connection and provider. `account/rateLimits/updated` notifications update the same view. The adapter forwards numeric quota fields and bounded bucket identifiers; account IDs, credits, credentials and transcript content are not forwarded.
- A weekly window is identified by `windowDurationMins === 10080`, in either position. The real account returned the weekly window as **primary**, so assuming `secondary` would have failed.
- Polling is limited to once per five minutes in a focused window with a ready Codex tab. Manual refresh is limited to once per 15 seconds. Concurrent callers share one request. The request timeout is 15 seconds.
- Nullable/missing fields in rolling updates preserve previously known values. Full reads replace the snapshot. Data older than ten minutes, expired windows and failed refreshes are marked outdated; the compact indicator shows an em dash. A reset timestamp never fabricates a restored quota.
- Account changes clear the in-memory snapshot. Generation checks discard responses started before an account change. Unknown API shapes and unauthenticated accounts show unavailable data without blocking tab creation.
- Both languages, the command palette, the visibility setting, screen-reader text and the packaged runtime are covered. The usage module participates in the helper fingerprint, and future-version admission requires the usage GUI check too.

## Observed verification

- `npm test`: exit 0; **122 passed, 0 failed**. Includes sparse updates, weekly-primary ordering, invalid percentages, expiry, failed refreshes, account changes, stale in-flight responses, native request routing and metadata filtering.
- Isolated VS Code 1.146.0 with official Codex 26.1111.21308 and helper 0.8.0: **9/9 checks passed**, including two real ready native chat tabs and the account indicator. See `2026-11-13-usage-probe.json`. Allowance values in this isolated GUI check are synthetic; the profile has no account credentials and sends no model turns.
- Separate read-only request through the installed native app-server returned a real weekly-primary snapshot: 6% used, 94% remaining, duration 10080 minutes. Zero model turns were sent. This is a point-in-time observation, not a persistent expectation.
- After the user's reload, the working window's Codex log contained one successful app-server initialization and 56 reasoning-completion records from 11:08:45 onward. A full scan of that interval found zero `renderer_ready_timeout` records; the initialization/completion matches provide the positive control. The same interval contained 96 `ResizeObserver` messages from the native renderer; this change does not establish their cause or resolve them.

## Boundaries

The tested host is Intel macOS. Apple silicon and remote extension hosts were not exercised. Data depends on Codex's native account API and a ready signed-in Codex tab. A changed or unsupported future API displays unavailable usage; structural compatibility tests cannot guarantee support for arbitrary future Codex releases.

The user's already running window needs a reload to activate the newly installed helper and native bridge. Both VSIX installation commands exited 0. The extension registry identifies helper 0.8.0 and Codex 26.1111.21308, both pinned local packages. All 26 packaged helper files match the installed files (allowing only VS Code’s injected manifest metadata). `inspectInstalled` reports `ready`. The installed packages also passed all nine isolated checks; see `2026-11-13-usage-installed-probe.json`.

Installed helper fingerprint: `d5fb975c34f254116cc372a969e971691b30f6ddc611eef0fe455b2823c668a7`. Helper VSIX SHA-256: `6f549aa3642268e25223b7badf2900921743a55da44d02d9981bc16700eea780`. Patched Codex VSIX SHA-256: `5a74a70b5a2ab168f062470a1ea652e01ad288bd331fdd1c3ec4e548273a2fd8`.

## Final security and recovery verification

Focused review of the changed runtime found no verified auth, injection, secret, filesystem or network-boundary issue. Account requests use the fixed read-only method through the existing authenticated connection. Numeric field validation and the bounded bucket identifier syntax prevent arbitrary text crossing the display boundary; the native UI uses plain strings rather than trusted Markdown or HTML. Account generation guards reject stale responses. Packaging adds only the allowlisted module, includes it in the helper fingerprint, and retains the update integrity gate. Regression tests verify that account IDs and unrecognized fields are stripped.

The saved recovery package was checked by the installed helper’s `UpdateManager.recovery()` with a full SHA-256 read and exact helper fingerprint comparison. Its receipt points to the new verified package; the old 0.7.0 receipt and package remain available. The first standalone verification script omitted the constructor’s mandatory candidate verifier; it had already saved the files, then failed before verifying them. The corrected read-only check supplied a fail-closed verifier and exited successfully.
