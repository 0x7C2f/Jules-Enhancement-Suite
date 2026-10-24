# Jules Enhancement Suite

A UI enhancement and workflow automation userscript for [`jules.google.com`](https://jules.google.com/) featuring automatic repository group expansion, fault-tolerant session archiving, dedicated toolbar controls, keyboard shortcuts, and observer-backed Angular CDK synchronization.

[![Install Userscript](https://img.shields.io/badge/Install-jules--enhancement--suite.user.js-715cd7?style=flat-square)](https://raw.githubusercontent.com/0x7C2f/Jules-Enhancement-Suite/main/jules-enhancement-suite.user.js)
![Version](https://img.shields.io/badge/version-2.5.0-blue?style=flat-square)

---

## Features

* **Suite Toolbar Controls:** Injects a native-styled control group into the top toolbar featuring one-click **Expand All** (`Alt+Shift+E`) and **Archive Sessions** (`Alt+Shift+A`) buttons with live progress indicators.
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
   * **[Install `jules-enhancement-suite.user.js`](https://raw.githubusercontent.com/0x7C2f/Jules-Enhancement-Suite/main/jules-enhancement-suite.user.js)**

---

## Controls & Shortcuts

### Toolbar Control Group
Two buttons are injected into the top toolbar on `jules.google.com`:
* **Expand All:** Opens the sidebar (if closed), expands all collapsed repository groups, and clicks all visible `View More` pagination buttons.
* **Archive Sessions:** Expands all groups and archives eligible sessions. While running, the button displays live progress (`Archiving (3/18) - Stop`) in red. Click it at any time to abort cleanly after the current row completes.

### Keyboard Shortcuts

| Shortcut | Context | Action |
| :--- | :--- | :--- |
| `Alt + Shift + A` | Global (outside text inputs/editors) | Start or stop the session archiver |
| `Alt + Shift + E` | Global (outside text inputs/editors) | Expand all repo groups & load all paginated sessions |
| `Alt + Shift + S` | Global (outside text inputs/editors) | Toggle the left sidebar panel open or closed |
| `Escape` | While archiver is running | Immediately request an abort |

### Userscript Menu Commands
Open your userscript manager's extension popup while on `jules.google.com` to configure persistent settings:

* **Archive Eligible Sessions (`Alt+Shift+A`)**: Manually start or abort an archive pass.
* **Expand & Load All Sessions (`Alt+Shift+E`)**: Open all repository groups and paginate all sessions without archiving.
* **Toggle Sidebar Panel (`Alt+Shift+S`)**: Open or close the left navigation drawer.
* **Auto-Archive Sessions: `[ON/OFF]`**: Automatically archive eligible sessions on initial page load and SPA route changes (Default: `ON`).
* **Auto-Expand Repo Groups: `[ON/OFF]`**: Automatically expand collapsed repository sections in the sidebar even when Auto-Archive is off (Default: `ON`).
* **Archive Only Completed/Failed: `[ON/OFF]`**: Skip sessions showing running, busy, or awaiting-feedback indicators (Default: `ON`).
* **Skip Active Session: `[ON/OFF]`**: Never archive the session currently open in the main viewport (Default: `ON`).

---

## Configuration Tuning

Internal thresholds can be customized in the `DEFAULT_CONFIG` block at the top of `jules-enhancement-suite.user.js`:

| Parameter | Default | Description |
| :--- | :--- | :--- |
| `autoArchive` | `true` | Run the session archiver automatically when eligible sessions are detected |
| `autoExpandSidebar` | `true` | Automatically expand collapsed repository groups on sidebar render |
| `skipActiveSession` | `true` | Exclude the currently selected session from archiving |
| `onlyCompletedOrFailed` | `true` | Exclude sessions with active/in-progress status indicators |
| `timeoutMs` | `3500` | Maximum wait time (ms) for row removal or dialog confirmation |
| `pollIntervalMs` | `100` | Fallback heartbeat interval (ms) alongside `MutationObserver` |
| `retryAttemptsPerRow` | `2` | Attempts allowed per row before marking it skipped for the current route |
| `maxConsecutiveFailures` | `5` | Consecutive skipped rows before tripping the circuit breaker |
| `maxTotalOperations` | `500` | Hard cap on archive operations per execution pass |

---

## License

MIT
