# Jules Enhancement Suite

A UI enhancement and workflow automation userscript for [`jules.google.com`](https://jules.google.com/) featuring automatic repository group expansion, fault-tolerant session archiving, dedicated toolbar controls, keyboard shortcuts, and observer-backed Angular CDK synchronization.

[![Install Userscript](https://img.shields.io/badge/Install-jules--enhancement--suite.min.user.js-715cd7?style=flat-square)](https://raw.githubusercontent.com/0x7C2f/Jules-Enhancement-Suite/main/jules-enhancement-suite.min.user.js)
![Version](https://img.shields.io/badge/version-3.3.0-blue?style=flat-square)

---

## Features

* **Suite Toolbar Controls:** Injects a native-styled control group into the top toolbar featuring a one-click **Expand All / Collapse All** toggle (`Alt+Shift+E`) and **Archive Sessions** (`Alt+Shift+A`) buttons with live progress indicators.
* **Expand/Collapse Toggle:** One button, hotkey, and menu command that flips every repository group open or closed. The label tracks the real state, even when you open or close a group by hand. After you collapse, the script will not re-expand groups on its own until you expand again or run the archiver.
* **Start Suggestions in Bulk:** Adds a **Start suggestions** row under the suggestion filter chips with an **All** button, one button per category (for example Cleanup, Code Health, Testing), and one button per confidence level (High, Medium, Low). Categories and levels are read from the page, so new ones appear automatically.
* **Automatic Sidebar Group Expansion:** Automatically expands collapsed repository sections (`.collapsible-wrapper`) as the sidebar renders, independent of whether auto-archiving is enabled.
* **Smart Session Archiver:** Automatically paginates and archives completed or failed coding sessions while protecting active tasks and the currently viewed session.
* **Keyboard Navigation Suite:** Built-in hotkeys to toggle the sidebar panel (`Alt+Shift+S`), expand and paginate all sessions (`Alt+Shift+E`), and start/stop session archiving (`Alt+Shift+A` / `Esc`).
* **Observer-Backed CDK Synchronization:** Interacts with Angular CDK overlay menus, backdrops, and confirmation dialogs via targeted `MutationObserver` instances rather than fragile fixed delays.
* **Background-Tab & SPA Route Awareness:** Hooks `history.pushState`, `history.replaceState`, `popstate`, and `visibilitychange` to re-evaluate sessions on route transitions while preventing false timeouts in backgrounded tabs.
* **Cross-Tab Settings Sync:** Uses `GM_getValue`, `GM_setValue`, and `GM_addValueChangeListener` to keep preferences synchronized in real time across multiple open Jules tabs.
* **Circuit Breakers & Retry Budgets:** Enforces per-row retry limits (`2` attempts) and trips a circuit breaker after `5` consecutive row failures or `500` total operations.

---

## Installation

1. Install a userscript manager browser extension:
   * [Violentmonkey](https://violentmonkey.github.io/) (Recommended)
   * [Tampermonkey](https://www.tampermonkey.net/)
2. Click the raw install link below to install and enable automatic updates from the `main` branch:
   * **[Install `jules-enhancement-suite.min.user.js`](https://raw.githubusercontent.com/0x7C2f/Jules-Enhancement-Suite/main/jules-enhancement-suite.min.user.js)**

### Which file should I install?

| File | Use it for |
| :--- | :--- |
| [`jules-enhancement-suite.min.user.js`](https://raw.githubusercontent.com/0x7C2f/Jules-Enhancement-Suite/main/jules-enhancement-suite.min.user.js) | **Recommended.** Minified build for everyday use. Smaller and loads faster, with the same features and settings. Auto-updates from this file. |
| [`jules-enhancement-suite.user.js`](https://raw.githubusercontent.com/0x7C2f/Jules-Enhancement-Suite/main/jules-enhancement-suite.user.js) | Readable source. Install this one if you want to read the code, edit [`DEFAULT_CONFIG`](#configuration-tuning), or debug. Auto-updates from this file. |

The two builds are functionally identical, but install only one of them. They share the same script name and namespace, so your userscript manager treats them as the same script.

---

## Controls & Shortcuts

### Toolbar Control Group
Two buttons are injected into the top toolbar on `jules.google.com`:
* **Expand All / Collapse All:** A single toggle. When any group is collapsed it shows **Expand All**: it opens the sidebar (if closed), expands all groups, and clicks all visible `View More` pagination buttons. When every group is open it shows **Collapse All** and closes them. `Esc` aborts a run in progress.
* **Archive Sessions:** Expands all groups and archives eligible sessions. While running, the button displays live progress (`Archiving (3/18) - Stop`) in red. Click it at any time to abort cleanly after the current row completes.

### Suggestions Panel
The suggestion filter chips get a **Start suggestions** row beneath them:
* **All:** Selects the **All** filter and starts every suggestion.
* **Category buttons:** Select that category's filter chip and start only its suggestions, then restore the filter you had selected.
* **Confidence buttons:** Start only suggestions with that confidence rating, read from each suggestion's confidence indicator. They work within the filter that is currently selected, so select **Testing** and click **High** to start only high-confidence testing suggestions. They do not change your filter.
* While running, the active button shows live progress (`Starting (3/9) - Stop`). Click it or press `Esc` to stop after the current suggestion.
* Each suggestion is started once. A confirmation prompt appears first by default because every start creates a session that counts toward your usage limits. Runs are capped at `50` suggestions.
* If starting a suggestion navigates to the new session, the script goes back to the suggestions list and continues.

### Keyboard Shortcuts

| Shortcut | Context | Action |
| :--- | :--- | :--- |
| `Alt + Shift + A` | Global (outside text inputs/editors) | Start or stop the session archiver |
| `Alt + Shift + E` | Global (outside text inputs/editors) | Toggle: expand all repo groups & load all sessions, or collapse them all |
| `Alt + Shift + S` | Global (outside text inputs/editors) | Toggle the left sidebar panel open or closed |
| `Alt + Shift + T` | Global (outside text inputs/editors) | Start every suggestion (all categories) |
| `Escape` | While archiving, expanding, or starting suggestions | Immediately request an abort |

### Userscript Menu Commands
Open your userscript manager's extension popup while on `jules.google.com` to configure persistent settings:

* **Archive Eligible Sessions (`Alt+Shift+A`)**: Manually start or abort an archive pass.
* **Expand / Collapse All Groups (`Alt+Shift+E`)**: Toggle all repository groups. Expanding also paginates all sessions, without archiving.
* **Toggle Sidebar Panel (`Alt+Shift+S`)**: Open or close the left navigation drawer.
* **Show Eligible Session Count**: Report how many currently loaded sessions would be archived, without archiving anything.
* **Start All Suggestions (`Alt+Shift+T`)**: Start every suggestion.
* **Start Suggestions: `[Category]`**: One command per category currently shown on the page.
* **Start Suggestions: `[Level]` confidence**: One command per confidence level (High, Medium, Low).
* **Auto-Archive Sessions: `[ON/OFF]`**: Automatically archive eligible sessions on initial page load and SPA route changes (Default: `ON`).
* **Auto-Expand Repo Groups: `[ON/OFF]`**: Automatically expand collapsed repository sections in the sidebar even when Auto-Archive is off (Default: `ON`).
* **Archive Only Completed/Failed: `[ON/OFF]`**: Skip sessions showing running, busy, or awaiting-feedback indicators (Default: `ON`).
* **Skip Active Session: `[ON/OFF]`**: Never archive the session currently open in the main viewport (Default: `ON`).
* **Confirm Before Manual Archive: `[ON/OFF]`**: Ask for confirmation before a manual archive pass. Automatic runs are never prompted (Default: `OFF`).
* **Confirm Before Starting Suggestions: `[ON/OFF]`**: Ask for confirmation before starting suggestions in bulk (Default: `ON`).

---

## Configuration Tuning

The on/off settings above can be changed from the userscript menu in either build. To change the internal thresholds below, install the readable [`jules-enhancement-suite.user.js`](https://raw.githubusercontent.com/0x7C2f/Jules-Enhancement-Suite/main/jules-enhancement-suite.user.js) and edit the `DEFAULT_CONFIG` block at the top of the file. The minified build compresses that block into a single line, so it is impractical to edit by hand.

| Parameter | Default | Description |
| :--- | :--- | :--- |
| `autoArchive` | `true` | Run the session archiver automatically when eligible sessions are detected |
| `autoExpandSidebar` | `true` | Automatically expand collapsed repository groups on sidebar render |
| `skipActiveSession` | `true` | Exclude the currently selected session from archiving |
| `onlyCompletedOrFailed` | `true` | Exclude sessions with active/in-progress status indicators |
| `confirmBeforeArchive` | `false` | Prompt before a manual archive pass |
| `confirmBeforeStart` | `true` | Prompt before starting suggestions in bulk |
| `maxSuggestionStartsPerRun` | `50` | Hard cap on suggestions started per run |
| `suggestionStartTimeoutMs` | `6500` | Maximum wait (ms) for a suggestion to register as started |
| `timeoutMs` | `3500` | Maximum wait time (ms) for row removal or dialog confirmation |
| `pollIntervalMs` | `100` | Fallback heartbeat interval (ms) alongside `MutationObserver` |
| `retryAttemptsPerRow` | `2` | Attempts allowed per row before marking it skipped for the current route |
| `maxConsecutiveFailures` | `5` | Consecutive skipped rows before tripping the circuit breaker |
| `maxTotalOperations` | `500` | Hard cap on archive operations per execution pass |

---

## Development

`jules-enhancement-suite.user.js` is the source of truth. `jules-enhancement-suite.min.user.js` is generated from it by the [Minify userscript](.github/workflows/minify-userscript.yml) GitHub Actions workflow on every push to `main` that changes the source, so do not edit the minified file by hand. The userscript metadata block is preserved, and the update URLs in the minified header point at the minified file.

---

## License

MIT
