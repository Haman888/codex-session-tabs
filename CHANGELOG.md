# Changelog

## 0.4.3 — Preview

- Show a spinning indicator in the open-sessions sidebar while a reply is running, followed by the existing orange completion dot for background replies.
- Preserve unread indicators while tabs are restored or still loading; clear them after about one second in a ready, visible tab in the focused window.
- Reapply the unread editor icon when the native editor replaces it, without repeatedly redrawing equivalent icon URIs.
- Persist pending unread state on orderly deactivation and cancel the reading timer.

## 0.4.2 — Preview

- Developer integration tests require a private temporary VS Code test profile and verify its actual storage before writing reports or changing editors. Reports and optional screenshots share a private per-run output directory with safe atomic writes.
- Malformed, null and primitive name-index records do not interrupt valid history reads.
- Retired turn events cannot finish a newer known turn or restore an acknowledged completion badge; ID-less legacy activity remains supported.
- The manual adapter rejects combined check/restore flags before changing extension files.
- Marketplace metadata has separate limits for transferred and gzip-expanded bytes.

## 0.4.1 — Preview

- English and Russian interface with an independent Language / Язык switch and a Follow VS Code default.
- Commands, menus, sidebar labels, notifications, dates and automatic empty-draft labels follow the selected language; conversation names and manual labels are preserved.
- Installation and recovery instructions are available in English and Russian.

## 0.4.0 — Development

- Public package identity, adapter filenames and internal RPC labels use neutral names; the license uses the author's GitHub login.
- Temporary verification directories are excluded by the repository's own ignore rules.
- The package has a new extension ID. State transfer from earlier local installations must be prepared separately before replacing them.

## 0.3.3 — Development

- Draft numbering starts at one after each window restart or reload, skipping labels used by open tabs, including restored editors that have not loaded yet.
- Closed drafts do not reserve numbers after restart; reopening a draft assigns another number if its automatic label has been reused. Manual names remain unchanged.

## 0.3.2 — Development

- Shared, cached history reads with one in-flight query, bounded retry backoff, explicit manual retry and retention of the last successful list.
- A read-only Python SQLite fallback for a failing system sqlite3 reader; repeated title errors are logged once per outage.
- History warnings distinguish a temporarily unavailable source from an empty history, while cached conversations remain selectable.
- Test fixtures use system temporary directories outside the repository; unsafe historical GUI runners are retired locally.

## 0.3.1 — Development

- Cold chat startup keeps CSS preload handling and native JavaScript imports, while avoiding thousands of eager JavaScript preload hints competing between webviews.
- A completed runtime report ends the disposable test process promptly; incomplete, failed or cancelled checks still prevent installation.
- Saved probe reports identify the failed phase and elapsed runtime.
- Restored inactive editors initialize on reveal; startup timeouts pause while the tab is hidden or its window is unfocused.
- New-chat readiness requires the actual renderer-ready phase, rather than just the earlier host transport handshake.
- Disposable probes keep loading resources while covered by another window, without changing the user's VS Code launch settings.

## 0.3.0 — Development

- Commands for checked local Codex installation and recovery, with approved package checksums and a separate runtime probe.
- Automatic compatibility diagnostics that remain available independently of Codex activation.
- A retained recovery package; a new candidate cannot overwrite an existing recovery baseline.
- Native New Chat actions use distinct resources instead of resuming a previously bound tab.
- New panels are queued until the previous renderer is ready; existing conversations can continue running in parallel.
- A required renderer readiness handshake before a candidate can pass its probe.
- A verified optimization of renderer preload lookups, preserving dependencies, CSS behavior and the original timeout.

## 0.2.2 — Initial preview

- Independent native Codex editor tabs and a sidebar with open sessions and history.
- Short automatic tab titles and manual renaming.
- Orange completion indicators on background tabs and sidebar entries.
- Persisted conversation bindings across window reloads.
- Correct renderer URLs for tab badge icons.

Tested on macOS arm64 with VS Code 1.145.0 and the official Codex extension
26.1021.22027. Automatic titles and completion indicators require the included
version-specific, reversible adapter.
