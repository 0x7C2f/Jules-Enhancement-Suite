// ==UserScript==
// @name         Jules Enhancement Suite
// @namespace    https://github.com/0x7C2f/Jules-Enhancement-Suite
// @version      3.2.0
// @description  UI enhancement and workflow automation suite for jules.google.com: expand/collapse toggle for repo groups, start all, by-category or by-confidence suggestions, smart session archiving, toolbar controls, keyboard shortcuts, and observer-backed CDK synchronization
// @author       0x7C2f
// @match        https://jules.google.com/*
// @homepageURL  https://github.com/0x7C2f/Jules-Enhancement-Suite
// @supportURL   https://github.com/0x7C2f/Jules-Enhancement-Suite/issues
// @updateURL    https://raw.githubusercontent.com/0x7C2f/Jules-Enhancement-Suite/main/jules-enhancement-suite.user.js
// @downloadURL  https://raw.githubusercontent.com/0x7C2f/Jules-Enhancement-Suite/main/jules-enhancement-suite.user.js
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    const LOG_PREFIX = '[Jules Enhancement Suite]';

    const DEFAULT_CONFIG = {
        autoArchive: true,
        autoExpandSidebar: true,
        skipActiveSession: true,
        onlyCompletedOrFailed: true,
        confirmBeforeArchive: false,
        confirmBeforeStart: true,
        actionRegex: /^archive\b/i,
        allChipRegex: /^all$/i,
        maxSuggestionStartsPerRun: 50,
        suggestionStartTimeoutMs: 6000,
        // "delete" is intentionally excluded so a destructive dialog is never auto-confirmed.
        confirmRegex: /^(archive|confirm|yes|ok)$/i,
        viewMoreRegex: /^(view|show|load)\s+(more|all)\b/i,
        timeoutMs: 3500,
        pollIntervalMs: 100,
        maxConsecutiveFailures: 5,
        maxTotalOperations: 500,
        retryAttemptsPerRow: 2
    };

    const SETTING_KEYS = [
        'autoArchive',
        'autoExpandSidebar',
        'skipActiveSession',
        'onlyCompletedOrFailed',
        'confirmBeforeArchive',
        'confirmBeforeStart'
    ];

    const SELECTORS = {
        panel: '.panel-container',
        panelToggle: '.start-panel-button',
        collapsibleWrapper: '.collapsible-wrapper',
        sourceHeader: '.source-header',
        viewMoreBtn: '.view-more-button',
        taskRow: '.task-link-container',
        taskContainer: 'a.task-container, .task-container',
        taskDescription: '.task-description',
        suggestionsList: '.suggestions-list',
        filterChips: '.suggestions-list .filter-chips',
        filterChip: '.suggestions-list .filter-chip',
        suggestionItem: '.suggestion-item',
        suggestionStart: '.start-button',
        suggestionTitle: '.suggestion-title',
        activeIndicators: [
            '.working-dots',
            '.needs-attention',
            '.awaiting-feedback',
            '[aria-busy="true"]',
            '.status-running',
            '.in-progress'
        ].join(', '),
        menuTrigger: [
            '.task-options-trigger button',
            '.task-options-trigger .cdk-menu-trigger',
            'button.task-options-button',
            'button[aria-haspopup="menu"]'
        ].join(', '),
        overlayContainer: '.cdk-overlay-container',
        overlayBackdrop: '.cdk-overlay-backdrop-showing',
        overlayMenuItems: [
            '.cdk-overlay-container swebot-menu-item',
            '.cdk-overlay-container [role="menuitem"]',
            '.cdk-overlay-container .mat-mdc-menu-item',
            '.cdk-overlay-container .cdk-menu-item',
            '.cdk-overlay-container .cdk-overlay-pane button'
        ].join(', '),
        dialogConfirmBtns: [
            '.cdk-overlay-container mat-dialog-container button',
            '.cdk-overlay-container [role="dialog"] button',
            '.cdk-overlay-container [role="alertdialog"] button'
        ].join(', '),
        toolbarContainers: '.panel-button-right-container, .buttons-container'
    };

    const state = {
        isArchiving: false,
        isExpanding: false,
        isStarting: false,
        startingLabel: null,
        // Suggestion titles already started (never restarted) or failed in this run.
        startedTitles: new Set(),
        failedTitles: new Set(),
        suggestionCategories: [],
        suggestionConfidences: [],
        abortRequested: false,
        // True after the user collapsed groups with the toggle. Suppresses all
        // automatic expansion/archiving until they expand again or run the archiver.
        groupsCollapsedByUser: false,
        archivedIds: new Set(),
        skippedIds: new Set(),
        processedNodes: new WeakSet(),
        failureCounts: new Map(),
        settings: {},
        debounceTimer: null,
        toastTimer: null,
        toastFadeTimer: null,
        archivedCount: 0,
        skippedCount: 0,
        consecutiveFailures: 0,
        uidCounter: 0,
        menuCommandIds: [],
        initialExpansionDone: false,
        lastPathname: window.location.pathname
    };

    /* ------------------------------------------------------------------ */
    /* Settings                                                            */
    /* ------------------------------------------------------------------ */

    function loadSettings() {
        for (const key of SETTING_KEYS) {
            try {
                if (typeof GM_getValue === 'function') {
                    if (key === 'autoArchive') {
                        const legacyVal = GM_getValue('autoRun', undefined);
                        const currentVal = GM_getValue('autoArchive', undefined);
                        if (currentVal === undefined && legacyVal !== undefined) {
                            GM_setValue('autoArchive', legacyVal);
                            state.settings[key] = legacyVal;
                            continue;
                        }
                    }
                    state.settings[key] = GM_getValue(key, DEFAULT_CONFIG[key]);
                } else {
                    state.settings[key] = DEFAULT_CONFIG[key];
                }
            } catch {
                state.settings[key] = DEFAULT_CONFIG[key];
            }
        }

        if (typeof GM_addValueChangeListener === 'function') {
            for (const key of SETTING_KEYS) {
                try {
                    GM_addValueChangeListener(key, (_name, _oldVal, newVal, remote) => {
                        if (remote) {
                            state.settings[key] = newVal;
                            registerMenus();
                        }
                    });
                } catch {
                    // Ignore if unsupported by userscript manager
                }
            }
        }
    }

    function getSetting(key) {
        return key in state.settings ? state.settings[key] : DEFAULT_CONFIG[key];
    }

    function setSetting(key, val) {
        state.settings[key] = val;
        try {
            if (typeof GM_setValue === 'function') {
                GM_setValue(key, val);
            }
        } catch (err) {
            console.warn(`${LOG_PREFIX} Failed to save setting:`, err);
        }
        registerMenus();
    }

    /* ------------------------------------------------------------------ */
    /* DOM utilities                                                       */
    /* ------------------------------------------------------------------ */

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    /**
     * Event-driven DOM condition waiter using MutationObserver + heartbeat fallback.
     * Supports a single root Element or an Array of root Elements.
     */
    function waitFor(predicate, timeout = DEFAULT_CONFIG.timeoutMs, roots = document.body) {
        return new Promise((resolve) => {
            if (state.abortRequested) return resolve(null);

            try {
                const immediate = predicate();
                if (immediate) return resolve(immediate);
            } catch {
                // Ignore transient Angular DOM hydration errors
            }

            let settled = false;
            let obs = null;
            let pollTimer = null;
            let timeoutTimer = null;

            const cleanup = (result) => {
                if (settled) return;
                settled = true;
                if (obs) obs.disconnect();
                if (pollTimer) clearInterval(pollTimer);
                if (timeoutTimer) clearTimeout(timeoutTimer);
                resolve(result);
            };

            const check = () => {
                if (state.abortRequested) return cleanup(null);
                try {
                    const res = predicate();
                    if (res) cleanup(res);
                } catch {
                    // Ignore transient errors
                }
            };

            const targetList = (Array.isArray(roots) ? roots : [roots]).filter(
                (r) => r && r.isConnected
            );

            if (targetList.length > 0) {
                obs = new MutationObserver(check);
                for (const root of targetList) {
                    obs.observe(root, {
                        childList: true,
                        subtree: true,
                        attributes: true,
                        characterData: false
                    });
                }
            }

            pollTimer = setInterval(check, DEFAULT_CONFIG.pollIntervalMs);
            timeoutTimer = setTimeout(() => cleanup(null), timeout);
        });
    }

    function isVisible(el) {
        if (!el || !el.isConnected) return false;
        if (typeof el.checkVisibility === 'function') {
            return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
        }
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) === 0) {
            return false;
        }
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    }

    function triggerHoverAndFocus(el) {
        if (!el || !el.isConnected) return;
        try {
            const rect = el.getBoundingClientRect();
            const opts = {
                bubbles: true,
                cancelable: true,
                clientX: rect.left + rect.width / 2,
                clientY: rect.top + rect.height / 2
            };
            el.dispatchEvent(new PointerEvent('pointerenter', opts));
            el.dispatchEvent(new PointerEvent('pointerover', opts));
            el.dispatchEvent(new MouseEvent('mouseenter', opts));
            el.dispatchEvent(new MouseEvent('mouseover', opts));
            el.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
        } catch {
            // Ignore synthetic dispatch failures
        }
    }

    function triggerClick(el) {
        if (!el || !el.isConnected) return false;
        try {
            const rect = el.getBoundingClientRect();
            const clientX = rect.left + rect.width / 2;
            const clientY = rect.top + rect.height / 2;
            const opts = { bubbles: true, cancelable: true, clientX, clientY, button: 0, buttons: 1 };

            el.dispatchEvent(new PointerEvent('pointerdown', opts));
            el.dispatchEvent(new MouseEvent('mousedown', opts));
            el.dispatchEvent(new PointerEvent('pointerup', opts));
            el.dispatchEvent(new MouseEvent('mouseup', opts));
        } catch {
            // Fallback to native .click()
        }
        el.click();
        return true;
    }

    async function clearOverlays() {
        const overlay = document.querySelector(SELECTORS.overlayContainer);
        if (!overlay || overlay.children.length === 0) return;

        const hasOpenElements = () => Boolean(
            overlay.querySelector(
                '[role="menu"], [role="dialog"], [role="alertdialog"], swebot-menu-item, .cdk-overlay-backdrop-showing'
            )
        );

        if (!hasOpenElements()) return;

        const escapeEvent = new KeyboardEvent('keydown', {
            key: 'Escape',
            code: 'Escape',
            keyCode: 27,
            which: 27,
            bubbles: true,
            cancelable: true
        });

        (document.activeElement || document.body).dispatchEvent(escapeEvent);
        document.body.dispatchEvent(escapeEvent);

        const backdrop = document.querySelector(SELECTORS.overlayBackdrop);
        if (backdrop) triggerClick(backdrop);

        await waitFor(() => !hasOpenElements(), 1000, overlay);
    }

    function normalizePath(href) {
        if (!href) return '';
        try {
            return new URL(href, window.location.origin).pathname;
        } catch {
            return href.split('?')[0].split('#')[0];
        }
    }

    /* ------------------------------------------------------------------ */
    /* Row identification and eligibility                                  */
    /* ------------------------------------------------------------------ */

    function getRowId(row) {
        if (!row || !row.isConnected) return null;

        const link = row.querySelector(SELECTORS.taskContainer);
        if (link) {
            const href = link.getAttribute('href');
            if (href) return `href::${normalizePath(href)}`;

            const dataId = row.dataset.taskId || row.dataset.sessionId || link.dataset.taskId || link.id;
            if (dataId) return `id::${dataId}`;
        }

        if (!row.dataset.jesUid) {
            const text = ((link && (link.querySelector(SELECTORS.taskDescription) || link).textContent) || '')
                .trim()
                .slice(0, 64);
            row.dataset.jesUid = `uid_${++state.uidCounter}_${text}`;
        }
        return row.dataset.jesUid;
    }

    function isEligible(row) {
        if (!row || !row.isConnected) return false;
        if (state.processedNodes.has(row)) return false;

        const id = getRowId(row);
        if (!id || state.archivedIds.has(id) || state.skippedIds.has(id)) return false;

        const taskLink = row.querySelector(SELECTORS.taskContainer);
        if (!taskLink) return false;

        if (getSetting('skipActiveSession')) {
            const hrefPath = normalizePath(taskLink.getAttribute('href'));
            const isSelected =
                taskLink.classList.contains('selected') ||
                taskLink.getAttribute('aria-current') === 'page' ||
                (hrefPath && window.location.pathname === hrefPath);
            if (isSelected) return false;
        }

        if (getSetting('onlyCompletedOrFailed')) {
            if (row.querySelector(SELECTORS.activeIndicators)) return false;
        }

        return true;
    }

    function getEligibleRows() {
        return Array.from(document.querySelectorAll(SELECTORS.taskRow)).filter(isEligible);
    }

    function findMenuTrigger(row) {
        if (!row || !row.isConnected) return null;
        const trigger = row.querySelector(SELECTORS.menuTrigger);
        return trigger && !trigger.disabled ? trigger : null;
    }

    function findOverlayAction(regex) {
        const candidates = document.querySelectorAll(SELECTORS.overlayMenuItems);
        for (const item of candidates) {
            if (!isVisible(item) || item.disabled || item.getAttribute('aria-disabled') === 'true') continue;
            const label = item.querySelector('.title, .mdc-list-item__primary-text') || item;
            const text = (label.textContent || item.getAttribute('aria-label') || '').trim();
            if (regex.test(text)) return item;
        }
        return null;
    }

    function findDialogConfirm(regex) {
        const btns = document.querySelectorAll(SELECTORS.dialogConfirmBtns);
        for (const btn of btns) {
            if (!isVisible(btn) || btn.disabled || btn.getAttribute('aria-disabled') === 'true') continue;
            const text = (btn.textContent || btn.getAttribute('aria-label') || '').trim();
            if (regex.test(text)) return btn;
        }
        return null;
    }

    /* ------------------------------------------------------------------ */
    /* Sidebar: open/close, group expand/collapse, pagination              */
    /* ------------------------------------------------------------------ */

    async function ensureSidebarOpen() {
        const panel = document.querySelector(SELECTORS.panel);
        if (panel && panel.classList.contains('closed')) {
            const toggleBtn = document.querySelector(SELECTORS.panelToggle);
            if (toggleBtn) {
                triggerClick(toggleBtn);
                await waitFor(() => !panel.classList.contains('closed'), 2000, panel);
                await sleep(150);
            }
        }
    }

    function toggleSidebarPanel() {
        const toggleBtn = document.querySelector(SELECTORS.panelToggle);
        if (toggleBtn) {
            triggerClick(toggleBtn);
        }
    }

    /** Each group is a header button followed by its collapsible wrapper. */
    function getGroups() {
        const groups = [];
        for (const wrapper of document.querySelectorAll(SELECTORS.collapsibleWrapper)) {
            const header = wrapper.previousElementSibling;
            if (header && header.classList.contains('source-header')) {
                groups.push({ wrapper, header });
            }
        }
        return groups;
    }

    function areAllGroupsExpanded() {
        const groups = getGroups();
        return groups.length > 0 && groups.every((g) => g.wrapper.classList.contains('expanded'));
    }

    /**
     * Drives every repo group to the target state. Returns how many groups changed.
     * Callers own the isExpanding flag.
     */
    async function setGroupsExpanded(target) {
        let changed = 0;
        for (const { wrapper, header } of getGroups()) {
            if (state.abortRequested) break;
            if (wrapper.classList.contains('expanded') === target) continue;
            if (!isVisible(header)) continue;
            triggerClick(header);
            const done = await waitFor(
                () => wrapper.classList.contains('expanded') === target,
                1500,
                wrapper
            );
            if (done) changed++;
        }
        return changed;
    }

    function getViewMoreButtons() {
        const panel = document.querySelector(SELECTORS.panel) || document;
        const byClass = Array.from(panel.querySelectorAll(SELECTORS.viewMoreBtn));
        const byText = Array.from(panel.querySelectorAll('button')).filter((b) =>
            DEFAULT_CONFIG.viewMoreRegex.test((b.textContent || '').trim())
        );
        return Array.from(new Set([...byClass, ...byText])).filter(isVisible);
    }

    async function paginateAllSessions() {
        const panelRoot = document.querySelector(SELECTORS.panel) || document.body;
        let paginationGuard = 0;
        let prevTaskCount = -1;

        while (!state.abortRequested && paginationGuard < 35) {
            const currentTaskCount = document.querySelectorAll(SELECTORS.taskRow).length;
            const viewMoreBtns = getViewMoreButtons();

            if (viewMoreBtns.length === 0 || currentTaskCount === prevTaskCount) break;
            prevTaskCount = currentTaskCount;

            for (const btn of viewMoreBtns) {
                if (state.abortRequested) break;
                btn.scrollIntoView({ block: 'nearest' });
                triggerClick(btn);
                await sleep(120);
            }

            await waitFor(
                () => document.querySelectorAll(SELECTORS.taskRow).length > prevTaskCount,
                1400,
                panelRoot
            );
            paginationGuard++;
        }
    }

    /** Silent expansion used by the automatic behaviour. */
    async function autoExpandGroups() {
        if (state.isExpanding || state.groupsCollapsedByUser) return;
        state.isExpanding = true;
        updateToolbarUI();
        try {
            await setGroupsExpanded(true);
        } finally {
            state.isExpanding = false;
            updateToolbarUI();
        }
    }

    async function expandAndPaginateSidebar(isManual = false) {
        if (state.isExpanding) return;
        state.isExpanding = true;
        state.groupsCollapsedByUser = false;
        updateToolbarUI();

        try {
            await ensureSidebarOpen();
            await setGroupsExpanded(true);
            await paginateAllSessions();

            state.initialExpansionDone = true;
            if (isManual && !state.abortRequested) {
                const totalLoaded = document.querySelectorAll(SELECTORS.taskRow).length;
                showToast(`Expanded sidebar (${totalLoaded} sessions loaded).`);
            }
        } finally {
            state.isExpanding = false;
            if (!state.isArchiving) state.abortRequested = false;
            updateToolbarUI();
        }
    }

    async function collapseAllGroups(isManual = true) {
        if (state.isExpanding) return;
        state.isExpanding = true;
        updateToolbarUI();

        try {
            await ensureSidebarOpen();
            const changed = await setGroupsExpanded(false);
            // Stop the automatic behaviour from immediately re-expanding what the user just closed.
            state.groupsCollapsedByUser = true;
            if (isManual && !state.abortRequested) {
                showToast(`Collapsed ${changed} repo group${changed === 1 ? '' : 's'}.`);
            }
        } finally {
            state.isExpanding = false;
            if (!state.isArchiving) state.abortRequested = false;
            updateToolbarUI();
        }
    }

    /** One entry point for the toolbar button, hotkey and menu command. */
    async function toggleGroups() {
        if (state.isArchiving || state.isExpanding || state.isStarting) return;
        if (areAllGroupsExpanded()) {
            await collapseAllGroups(true);
        } else {
            await expandAndPaginateSidebar(true);
        }
    }

    /* ------------------------------------------------------------------ */
    /* Archiving                                                           */
    /* ------------------------------------------------------------------ */

    function markRowOutcome(row, id, succeeded) {
        if (succeeded) {
            state.archivedIds.add(id);
            state.skippedIds.delete(id);
            state.processedNodes.add(row);
            state.failureCounts.delete(id);
            state.archivedCount++;
            state.consecutiveFailures = 0;
            return;
        }

        const attempts = (state.failureCounts.get(id) || 0) + 1;
        state.failureCounts.set(id, attempts);

        if (attempts >= DEFAULT_CONFIG.retryAttemptsPerRow) {
            state.skippedIds.add(id);
            state.processedNodes.add(row);
            state.skippedCount++;
            state.consecutiveFailures++;
        }
    }

    async function archiveRow(row) {
        const id = getRowId(row);
        if (!id) return false;

        try {
            await clearOverlays();
            if (!row.isConnected) return false;

            row.scrollIntoView({ block: 'nearest' });
            triggerHoverAndFocus(row);

            const trigger = await waitFor(() => findMenuTrigger(row), 800, row);
            if (!trigger) {
                markRowOutcome(row, id, false);
                return false;
            }

            triggerHoverAndFocus(trigger);
            triggerClick(trigger);

            const overlayRoot = document.querySelector(SELECTORS.overlayContainer) || document.body;
            const archiveItem = await waitFor(
                () => findOverlayAction(DEFAULT_CONFIG.actionRegex),
                1800,
                overlayRoot
            );

            if (!archiveItem) {
                await clearOverlays();
                markRowOutcome(row, id, false);
                return false;
            }

            const rowContainer = row.parentElement || document.querySelector(SELECTORS.panel) || document.body;
            triggerClick(archiveItem);

            const removed = await waitFor(
                () => {
                    if (!row.isConnected) return true;
                    const confirmBtn = findDialogConfirm(DEFAULT_CONFIG.confirmRegex);
                    if (confirmBtn && !confirmBtn.dataset.jesClicked) {
                        confirmBtn.dataset.jesClicked = 'true';
                        triggerClick(confirmBtn);
                    }
                    return !row.isConnected;
                },
                DEFAULT_CONFIG.timeoutMs,
                [overlayRoot, rowContainer]
            );

            await clearOverlays();
            markRowOutcome(row, id, Boolean(removed));
            return Boolean(removed);
        } catch (err) {
            console.error(`${LOG_PREFIX} Error archiving row:`, err);
            await clearOverlays();
            markRowOutcome(row, id, false);
            return false;
        }
    }

    async function runArchiver(isManual = false) {
        if (state.isArchiving || state.isStarting) return;
        state.isArchiving = true;
        state.abortRequested = false;
        state.archivedCount = 0;
        state.skippedCount = 0;
        state.consecutiveFailures = 0;
        state.failureCounts.clear();
        updateToolbarUI();

        try {
            await expandAndPaginateSidebar(false);

            const panelRoot = document.querySelector(SELECTORS.panel) || document.body;
            let totalEstimated = getEligibleRows().length;

            if (totalEstimated === 0) {
                if (isManual) showToast('No eligible sessions to archive.');
                return;
            }

            let step = 0;
            while (!state.abortRequested && step < DEFAULT_CONFIG.maxTotalOperations) {
                if (state.consecutiveFailures >= DEFAULT_CONFIG.maxConsecutiveFailures) {
                    showToast(`Circuit breaker tripped: ${state.consecutiveFailures} consecutive failures.`, true);
                    break;
                }

                let nextRow = getEligibleRows()[0];

                if (!nextRow) {
                    const viewMore = getViewMoreButtons()[0];
                    if (viewMore) {
                        const prevCount = document.querySelectorAll(SELECTORS.taskRow).length;
                        viewMore.scrollIntoView({ block: 'nearest' });
                        triggerClick(viewMore);
                        await waitFor(
                            () => document.querySelectorAll(SELECTORS.taskRow).length > prevCount,
                            1800,
                            panelRoot
                        );
                        nextRow = getEligibleRows()[0];
                    }
                }

                if (!nextRow) break;

                const remaining = getEligibleRows().length;
                totalEstimated = Math.max(totalEstimated, state.archivedCount + state.skippedCount + remaining);

                step++;
                updateToolbarUI(state.archivedCount + state.skippedCount + 1, totalEstimated);
                await archiveRow(nextRow);
            }

            if (state.consecutiveFailures < DEFAULT_CONFIG.maxConsecutiveFailures && (state.archivedCount > 0 || isManual)) {
                const statusPrefix = state.abortRequested ? 'Stopped. ' : '';
                showToast(
                    `${statusPrefix}Archived ${state.archivedCount} session(s)` +
                    (state.skippedCount ? `, skipped ${state.skippedCount}.` : '.')
                );
            }
        } catch (err) {
            console.error(`${LOG_PREFIX} Fatal error in runArchiver:`, err);
            showToast('Jules Enhancement Suite encountered an error. Check console.', true);
        } finally {
            await clearOverlays();
            state.isArchiving = false;
            state.abortRequested = false;
            updateToolbarUI();
        }
    }

    function toggleArchiver() {
        if (state.isArchiving) {
            state.abortRequested = true;
            updateToolbarUI();
            return;
        }
        if (state.isExpanding || state.isStarting) return;

        if (getSetting('confirmBeforeArchive')) {
            const loaded = getEligibleRows().length;
            const proceed = window.confirm(
                `Archive eligible sessions now?\n\n${loaded} currently loaded; more may load as groups expand.`
            );
            if (!proceed) return;
        }

        state.skippedIds.clear();
        state.processedNodes = new WeakSet();
        state.failureCounts.clear();
        state.initialExpansionDone = false;
        state.groupsCollapsedByUser = false;
        runArchiver(true);
    }

    function showEligibleCount() {
        const count = getEligibleRows().length;
        const total = document.querySelectorAll(SELECTORS.taskRow).length;
        showToast(`${count} of ${total} loaded sessions are eligible for archiving.`);
    }

    /* ------------------------------------------------------------------ */
    /* Proactive suggestions: start all, or by category                    */
    /* ------------------------------------------------------------------ */

    function getChipLabel(chip) {
        const clone = chip.cloneNode(true);
        clone.querySelectorAll('mat-icon').forEach((n) => n.remove());
        return (clone.textContent || '').replace(/\s+/g, ' ').trim();
    }

    function getFilterChips() {
        return Array.from(document.querySelectorAll(SELECTORS.filterChip))
            .map((el) => ({
                el,
                label: getChipLabel(el),
                active: el.getAttribute('aria-pressed') === 'true'
            }))
            .filter((c) => c.label);
    }

    function getActiveChipLabel() {
        const active = getFilterChips().find((c) => c.active);
        return active ? active.label : null;
    }

    /** Activates a filter chip. Never clicks an already active chip, since that may clear it. */
    async function selectChip(label) {
        const chip = getFilterChips().find((c) => c.label.toLowerCase() === label.toLowerCase());
        if (!chip) return false;
        if (!chip.active) {
            triggerClick(chip.el);
            await waitFor(() => chip.el.getAttribute('aria-pressed') === 'true', 1500, chip.el);
            await sleep(300);
        }
        return chip.el.getAttribute('aria-pressed') === 'true';
    }

    function getSuggestionTitle(item) {
        const titleEl = item.querySelector(SELECTORS.suggestionTitle);
        return ((titleEl || item).textContent || '').replace(/\s+/g, ' ').trim();
    }

    const CONFIDENCE_ORDER = ['high', 'medium', 'low'];

    /** Reads "high" / "medium" / "low" from the confidence-indicator class (confidence-high etc.). */
    function getSuggestionConfidence(item) {
        const el = item.querySelector('.confidence-indicator');
        if (!el) return null;
        const match = /\bconfidence-(?!indicator\b)([a-z]+)/i.exec(el.className || '');
        return match ? match[1].toLowerCase() : null;
    }

    function getStartableSuggestions(confidence = null) {
        return Array.from(document.querySelectorAll(SELECTORS.suggestionItem)).filter((item) => {
            if (!isVisible(item)) return false;
            const btn = item.querySelector(SELECTORS.suggestionStart);
            if (!btn || btn.disabled || btn.getAttribute('aria-disabled') === 'true') return false;
            if (confidence && getSuggestionConfidence(item) !== confidence) return false;
            const title = getSuggestionTitle(item);
            return !state.startedTitles.has(title) && !state.failedTitles.has(title);
        });
    }

    /** High, medium and low always; plus any other level the page shows. */
    function getConfidenceLevels() {
        const found = new Set(CONFIDENCE_ORDER);
        for (const item of document.querySelectorAll(SELECTORS.suggestionItem)) {
            const level = getSuggestionConfidence(item);
            if (level) found.add(level);
        }
        const extras = Array.from(found).filter((l) => !CONFIDENCE_ORDER.includes(l)).sort();
        return [...CONFIDENCE_ORDER, ...extras];
    }

    const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

    /** If starting a suggestion navigates to the new session, go back to the list. */
    async function returnToSuggestions(listPath) {
        if (window.location.pathname !== listPath) history.back();
        const back = await waitFor(
            () =>
                window.location.pathname === listPath &&
                document.querySelector(SELECTORS.suggestionsList) &&
                getFilterChips().length > 0,
            6000
        );
        if (back) await sleep(400);
        return Boolean(back);
    }

    /**
     * Starts suggestions.
     *  - startSuggestions('All')                 every suggestion
     *  - startSuggestions('Testing')             one category (selects that filter chip)
     *  - startSuggestions(null, 'high')          one confidence level, within the filter
     *                                            that is currently selected
     */
    async function startSuggestions(label, confidence = null) {
        if (state.isStarting || state.isArchiving || state.isExpanding) return;
        if (!document.querySelector(SELECTORS.suggestionsList)) {
            showToast('No suggestions list found on this page.', true);
            return;
        }

        const key = confidence ? `conf:${confidence}` : label;
        state.isStarting = true;
        state.abortRequested = false;
        state.startingLabel = key;
        state.failedTitles.clear();

        const originalLabel = confidence ? null : getActiveChipLabel();
        const startPath = window.location.pathname;
        let started = 0;
        let failed = 0;
        let consecutive = 0;
        updateToolbarUI();
        updateSuggestionBarUI();

        try {
            if (!confidence) {
                const selected = await selectChip(label);
                if (!selected && !DEFAULT_CONFIG.allChipRegex.test(label)) {
                    showToast(`Could not select the "${label}" filter.`, true);
                    return;
                }
            }

            // Chip to re-select if starting a suggestion navigates away and back.
            const scopeChip = confidence ? getActiveChipLabel() : label;
            const scopeName = confidence
                ? `${capitalize(confidence)} confidence` +
                  (scopeChip && !DEFAULT_CONFIG.allChipRegex.test(scopeChip) ? ` in ${scopeChip}` : '')
                : label;

            const queued = getStartableSuggestions(confidence).length;
            if (queued === 0) {
                showToast(`No suggestions to start for "${scopeName}".`);
                return;
            }

            const total = Math.min(queued, DEFAULT_CONFIG.maxSuggestionStartsPerRun);
            if (getSetting('confirmBeforeStart')) {
                const proceed = window.confirm(
                    `Start ${total} "${scopeName}" suggestion${total === 1 ? '' : 's'}?\n\n` +
                    'Each one creates a Jules session and counts toward your usage limits.'
                );
                if (!proceed) return;
            }

            while (!state.abortRequested && started + failed < total) {
                if (consecutive >= DEFAULT_CONFIG.maxConsecutiveFailures) {
                    showToast(`Stopped after ${consecutive} consecutive failures.`, true);
                    break;
                }

                const item = getStartableSuggestions(confidence)[0];
                if (!item) break;

                const btn = item.querySelector(SELECTORS.suggestionStart);
                const title = getSuggestionTitle(item);
                const pathBefore = window.location.pathname;
                const listRoot = document.querySelector(SELECTORS.suggestionsList) || document.body;

                updateSuggestionBarUI(started + failed + 1, total);
                item.scrollIntoView({ block: 'nearest' });
                triggerHoverAndFocus(btn);
                triggerClick(btn);

                const outcome = await waitFor(
                    () => {
                        if (!item.isConnected) return 'removed';
                        if (!btn.isConnected) return 'changed';
                        if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') return 'disabled';
                        if (window.location.pathname !== pathBefore) return 'navigated';
                        return null;
                    },
                    DEFAULT_CONFIG.suggestionStartTimeoutMs,
                    listRoot
                );

                if (!outcome) {
                    state.failedTitles.add(title);
                    failed++;
                    consecutive++;
                    continue;
                }

                state.startedTitles.add(title);
                started++;
                consecutive = 0;

                if (outcome === 'navigated') {
                    const back = await returnToSuggestions(pathBefore);
                    if (!back) {
                        showToast(
                            `Started ${started}, but could not return to the suggestions list. Stopping.`,
                            true
                        );
                        return;
                    }
                    if (scopeChip) await selectChip(scopeChip);
                }
            }

            const prefix = state.abortRequested ? 'Stopped. ' : '';
            showToast(
                `${prefix}Started ${started} suggestion${started === 1 ? '' : 's'}` +
                (failed ? `, ${failed} failed.` : '.'),
                failed > 0 && started === 0
            );
        } catch (err) {
            console.error(`${LOG_PREFIX} Error starting suggestions:`, err);
            showToast('Starting suggestions failed. Check console.', true);
        } finally {
            state.isStarting = false;
            state.abortRequested = false;
            state.startingLabel = null;
            if (
                originalLabel &&
                originalLabel.toLowerCase() !== String(label).toLowerCase() &&
                window.location.pathname === startPath
            ) {
                await selectChip(originalLabel);
            }
            updateToolbarUI();
            updateSuggestionBarUI();
        }
    }

    function updateSuggestionBarUI(current = 0, total = 0) {
        const bar = document.getElementById('jes-suggest-bar');
        if (!bar) return;

        for (const btn of bar.querySelectorAll('button')) {
            const key = btn.dataset.key;
            const isRunning = state.isStarting && state.startingLabel === key;

            let nextText = btn.dataset.text;
            if (isRunning) {
                nextText = state.abortRequested
                    ? 'Stopping...'
                    : `Starting${total > 0 ? ` (${current}/${total})` : ''} - Stop`;
            }
            const nextState = isRunning ? 'running' : 'idle';
            const nextDisabled =
                (state.isStarting && !isRunning) || state.isArchiving || state.isExpanding;

            if (btn.textContent !== nextText) btn.textContent = nextText;
            if (btn.dataset.state !== nextState) btn.dataset.state = nextState;
            if (btn.disabled !== nextDisabled) btn.disabled = nextDisabled;
        }
    }

    /**
     * Adds a "Start" row under the filter chips: All, one button per category, and one
     * per confidence level. Rebuilt whenever the category or level set changes.
     */
    function injectSuggestionBar() {
        const chipsRow = document.querySelector(SELECTORS.filterChips);
        const existing = document.getElementById('jes-suggest-bar');

        if (!chipsRow || !chipsRow.parentElement) {
            if (existing) existing.remove();
            return;
        }

        const categories = getFilterChips()
            .map((c) => c.label)
            .filter((l) => !DEFAULT_CONFIG.allChipRegex.test(l));
        const levels = getConfidenceLevels();
        const signature = `${categories.join('|')}##${levels.join('|')}`;

        if (
            existing &&
            existing.isConnected &&
            existing.parentElement === chipsRow.parentElement &&
            existing.dataset.signature === signature
        ) {
            return;
        }
        if (existing) existing.remove();

        injectStyles();

        const bar = document.createElement('div');
        bar.id = 'jes-suggest-bar';
        bar.dataset.signature = signature;

        const makeCaption = (text) => {
            const span = document.createElement('span');
            span.className = 'jes-suggest-caption';
            span.textContent = text;
            return span;
        };

        const makeButton = ({ key, text, title, primary, run }) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'jes-btn';
            btn.dataset.key = key;
            btn.dataset.text = text;
            btn.dataset.state = 'idle';
            if (!primary) btn.dataset.variant = 'secondary';
            btn.title = title;
            btn.textContent = text;
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (state.isStarting) {
                    if (state.startingLabel === key) {
                        state.abortRequested = true;
                        updateSuggestionBarUI();
                    }
                    return;
                }
                run();
            });
            return btn;
        };

        bar.append(
            makeCaption('Start suggestions:'),
            makeButton({
                key: 'All',
                text: 'All',
                title: 'Jules Enhancement Suite: Start every suggestion (Alt+Shift+T | Esc to Stop)',
                primary: true,
                run: () => startSuggestions('All')
            })
        );

        for (const category of categories) {
            bar.appendChild(
                makeButton({
                    key: category,
                    text: category,
                    title: `Jules Enhancement Suite: Start every "${category}" suggestion`,
                    primary: false,
                    run: () => startSuggestions(category)
                })
            );
        }

        bar.appendChild(makeCaption('By confidence:'));
        for (const level of levels) {
            bar.appendChild(
                makeButton({
                    key: `conf:${level}`,
                    text: capitalize(level),
                    title:
                        `Jules Enhancement Suite: Start every ${level} confidence suggestion ` +
                        'within the filter that is currently selected',
                    primary: false,
                    run: () => startSuggestions(null, level)
                })
            );
        }

        chipsRow.insertAdjacentElement('afterend', bar);
        updateSuggestionBarUI();

        if (
            state.suggestionCategories.join('|') !== categories.join('|') ||
            state.suggestionConfidences.join('|') !== levels.join('|')
        ) {
            state.suggestionCategories = categories;
            state.suggestionConfidences = levels;
            registerMenus();
        }
    }

    /* ------------------------------------------------------------------ */
    /* UI: styles, toast, toolbar                                          */
    /* ------------------------------------------------------------------ */

    function injectStyles() {
        if (document.getElementById('jes-styles')) return;
        const style = document.createElement('style');
        style.id = 'jes-styles';
        style.textContent = `
            #jes-toolbar-group {
                display: inline-flex;
                align-items: center;
                gap: 6px;
                margin-right: 6px;
            }
            .jes-btn {
                background-color: var(--button-primary-background, #715cd7);
                color: var(--button-primary-foreground, #fbfbfe);
                border: 1px solid var(--button-primary-border, rgba(255, 255, 255, 0.125));
                border-radius: 6px;
                padding: 0 12px;
                height: 34px;
                cursor: pointer;
                font-family: inherit;
                font-size: 12px;
                font-weight: 500;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                white-space: nowrap;
                transition: background-color 0.15s ease, opacity 0.15s ease;
            }
            .jes-btn:hover {
                filter: brightness(1.08);
            }
            .jes-btn:focus-visible {
                outline: 2px solid var(--button-primary-background, #715cd7);
                outline-offset: 2px;
            }
            .jes-btn[data-variant="secondary"] {
                background-color: var(--surface-secondary, rgba(255, 255, 255, 0.06));
                color: var(--text-primary, #fbfbfe);
                border-color: var(--surface-border, rgba(255, 255, 255, 0.12));
                padding: 0 10px;
            }
            .jes-btn[data-state="running"] {
                background-color: var(--semantic-red, #cc3737);
                color: #ffffff;
            }
            .jes-btn:disabled {
                opacity: 0.55;
                cursor: not-allowed;
            }
            #jes-suggest-bar {
                display: flex;
                flex-wrap: wrap;
                align-items: center;
                gap: 6px;
                margin: 8px 0;
            }
            #jes-suggest-bar .jes-suggest-caption {
                font-size: 12px;
                color: var(--text-secondary, #a8a1cb);
                margin-right: 2px;
            }
            #jes-suggest-bar .jes-btn {
                height: 28px;
                padding: 0 10px;
            }
            #jes-toast {
                position: fixed;
                bottom: 24px;
                left: 50%;
                transform: translateX(-50%);
                background-color: var(--background-dark, #141316);
                color: var(--text-primary, #fbfbfe);
                border: 1px solid var(--surface-border, rgba(255, 255, 255, 0.075));
                padding: 12px 20px;
                border-radius: 8px;
                font-size: 13px;
                font-weight: 500;
                z-index: 2147483647;
                box-shadow: 0 6px 16px rgba(0, 0, 0, 0.35);
                pointer-events: none;
                opacity: 1;
                transition: opacity 0.2s ease;
            }
            #jes-toast[data-error="true"] {
                background-color: var(--semantic-red-background, #382525);
                color: var(--semantic-red, #ff6767);
            }
        `;
        (document.head || document.documentElement).appendChild(style);
    }

    function showToast(message, isError = false) {
        injectStyles();

        if (state.toastTimer) {
            clearTimeout(state.toastTimer);
            state.toastTimer = null;
        }
        if (state.toastFadeTimer) {
            clearTimeout(state.toastFadeTimer);
            state.toastFadeTimer = null;
        }

        let toast = document.getElementById('jes-toast');
        if (!toast) {
            toast = document.createElement('div');
            toast.id = 'jes-toast';
            toast.setAttribute('role', 'status');
            toast.setAttribute('aria-live', 'polite');
            document.body.appendChild(toast);
        }

        toast.textContent = message;
        toast.dataset.error = isError ? 'true' : 'false';
        toast.style.opacity = '1';

        state.toastTimer = setTimeout(() => {
            if (toast.isConnected) toast.style.opacity = '0';
            state.toastFadeTimer = setTimeout(() => {
                if (toast.isConnected && toast.style.opacity === '0') toast.remove();
            }, 250);
        }, 3500);
    }

    function updateToolbarUI(current = 0, total = 0) {
        const archiveBtn = document.getElementById('jes-archive-btn');
        const toggleBtn = document.getElementById('jes-toggle-btn');

        if (archiveBtn) {
            let nextText;
            let nextState;

            if (state.isArchiving) {
                const progress = total > 0 ? ` (${current}/${total})` : '';
                nextText = state.abortRequested ? 'Stopping...' : `Archiving${progress} - Stop`;
                nextState = 'running';
            } else {
                nextText = 'Archive Sessions';
                nextState = 'idle';
            }

            if (archiveBtn.textContent !== nextText) archiveBtn.textContent = nextText;
            if (archiveBtn.dataset.state !== nextState) archiveBtn.dataset.state = nextState;
            archiveBtn.disabled = state.isStarting;
        }

        if (toggleBtn) {
            const expanded = areAllGroupsExpanded();
            const nextToggleText = state.isExpanding
                ? 'Working...'
                : expanded ? 'Collapse All' : 'Expand All';
            const nextTitle = expanded
                ? 'Jules Enhancement Suite: Collapse All Repo Groups (Alt+Shift+E)'
                : 'Jules Enhancement Suite: Expand All Repo Groups & Load Sessions (Alt+Shift+E | Esc to Stop)';

            if (toggleBtn.textContent !== nextToggleText) toggleBtn.textContent = nextToggleText;
            if (toggleBtn.title !== nextTitle) toggleBtn.title = nextTitle;
            toggleBtn.setAttribute('aria-pressed', String(expanded));
            toggleBtn.disabled = state.isExpanding || state.isArchiving || state.isStarting;
        }

        if (!state.isStarting) updateSuggestionBarUI();
    }

    function injectToolbarUI() {
        injectStyles();

        const existingGroup = document.getElementById('jes-toolbar-group');
        if (existingGroup && existingGroup.isConnected) return;

        const container = document.querySelector(SELECTORS.toolbarContainers);
        if (!container) return;

        const group = document.createElement('div');
        group.id = 'jes-toolbar-group';

        const toggleBtn = document.createElement('button');
        toggleBtn.id = 'jes-toggle-btn';
        toggleBtn.className = 'jes-btn';
        toggleBtn.type = 'button';
        toggleBtn.dataset.variant = 'secondary';
        toggleBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            toggleGroups();
        });

        const archiveBtn = document.createElement('button');
        archiveBtn.id = 'jes-archive-btn';
        archiveBtn.className = 'jes-btn';
        archiveBtn.type = 'button';
        archiveBtn.dataset.state = 'idle';
        archiveBtn.title = 'Jules Enhancement Suite: Archive Eligible Sessions (Alt+Shift+A | Esc to Stop)';
        archiveBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            toggleArchiver();
        });

        group.append(toggleBtn, archiveBtn);
        container.prepend(group);
        updateToolbarUI();
    }

    /* ------------------------------------------------------------------ */
    /* Keyboard                                                            */
    /* ------------------------------------------------------------------ */

    function isEditableTarget(el) {
        if (!el || !el.tagName) return false;
        const tag = el.tagName.toLowerCase();
        return (
            tag === 'input' ||
            tag === 'textarea' ||
            tag === 'select' ||
            el.isContentEditable ||
            Boolean(el.closest('.monaco-editor, .xterm, .ProseMirror, .cm-editor'))
        );
    }

    window.addEventListener('keydown', (e) => {
        if (
            e.key === 'Escape' &&
            (state.isArchiving || state.isExpanding || state.isStarting) &&
            !state.abortRequested
        ) {
            state.abortRequested = true;
            updateToolbarUI();
            updateSuggestionBarUI();
            return;
        }

        if (!e.altKey || !e.shiftKey || e.ctrlKey || e.metaKey || isEditableTarget(document.activeElement)) return;

        if (e.code === 'KeyA') {
            e.preventDefault();
            toggleArchiver();
        } else if (e.code === 'KeyE') {
            e.preventDefault();
            toggleGroups();
        } else if (e.code === 'KeyS') {
            e.preventDefault();
            toggleSidebarPanel();
        } else if (e.code === 'KeyT') {
            e.preventDefault();
            startSuggestions('All');
        }
    });

    // Keep the toggle label honest when the user opens or closes a group by hand.
    document.addEventListener(
        'click',
        (e) => {
            const target = e.target;
            if (target instanceof Element && target.closest(SELECTORS.sourceHeader)) {
                setTimeout(updateToolbarUI, 300);
            }
        },
        true
    );

    /* ------------------------------------------------------------------ */
    /* Userscript menu                                                     */
    /* ------------------------------------------------------------------ */

    function registerMenus() {
        if (typeof GM_registerMenuCommand !== 'function') return;

        if (typeof GM_unregisterMenuCommand === 'function') {
            for (const cmdId of state.menuCommandIds) {
                try {
                    GM_unregisterMenuCommand(cmdId);
                } catch {
                    // Ignore
                }
            }
        }
        state.menuCommandIds = [];

        const onOff = (key) => (getSetting(key) ? 'ON' : 'OFF');
        const flip = (key, label) => () => {
            const next = !getSetting(key);
            setSetting(key, next);
            showToast(`${label}: ${next ? 'ENABLED' : 'DISABLED'}`);
        };

        state.menuCommandIds.push(
            GM_registerMenuCommand('Archive Eligible Sessions (Alt+Shift+A)', toggleArchiver),
            GM_registerMenuCommand('Expand / Collapse All Groups (Alt+Shift+E)', toggleGroups),
            GM_registerMenuCommand('Toggle Sidebar Panel (Alt+Shift+S)', toggleSidebarPanel),
            GM_registerMenuCommand('Show Eligible Session Count', showEligibleCount),
            GM_registerMenuCommand('Start All Suggestions (Alt+Shift+T)', () => startSuggestions('All')),
            ...state.suggestionCategories.map((category) =>
                GM_registerMenuCommand(`Start Suggestions: ${category}`, () => startSuggestions(category))
            ),
            ...state.suggestionConfidences.map((level) =>
                GM_registerMenuCommand(
                    `Start Suggestions: ${capitalize(level)} confidence`,
                    () => startSuggestions(null, level)
                )
            ),
            GM_registerMenuCommand(`Auto-Archive Sessions: [${onOff('autoArchive')}]`, flip('autoArchive', 'Auto-Archive')),
            GM_registerMenuCommand(`Auto-Expand Repo Groups: [${onOff('autoExpandSidebar')}]`, flip('autoExpandSidebar', 'Auto-Expand Repo Groups')),
            GM_registerMenuCommand(`Archive Only Completed/Failed: [${onOff('onlyCompletedOrFailed')}]`, flip('onlyCompletedOrFailed', 'Only Completed/Failed')),
            GM_registerMenuCommand(`Skip Active Session: [${onOff('skipActiveSession')}]`, flip('skipActiveSession', 'Skip Active Session')),
            GM_registerMenuCommand(`Confirm Before Manual Archive: [${onOff('confirmBeforeArchive')}]`, flip('confirmBeforeArchive', 'Confirm Before Manual Archive')),
            GM_registerMenuCommand(`Confirm Before Starting Suggestions: [${onOff('confirmBeforeStart')}]`, flip('confirmBeforeStart', 'Confirm Before Starting Suggestions'))
        );
    }

    /* ------------------------------------------------------------------ */
    /* Scheduling, SPA hooks, observer                                     */
    /* ------------------------------------------------------------------ */

    function hasPendingArchiveWork() {
        if (getEligibleRows().length > 0) {
            return true;
        }
        if (!state.initialExpansionDone) {
            const hasCollapsed = getGroups().some((g) => !g.wrapper.classList.contains('expanded'));
            return hasCollapsed || getViewMoreButtons().length > 0;
        }
        return false;
    }

    function scheduleCheck() {
        if (state.isArchiving || state.isStarting) return;
        if (state.debounceTimer) clearTimeout(state.debounceTimer);
        state.debounceTimer = setTimeout(async () => {
            if (state.isArchiving || state.isStarting) return;
            if (window.location.pathname !== state.lastPathname) {
                state.lastPathname = window.location.pathname;
                state.initialExpansionDone = false;
                state.skippedIds.clear();
            }

            injectToolbarUI();
            injectSuggestionBar();
            updateToolbarUI();

            // Avoid background-tab timer throttling causing false DOM wait timeouts
            if (document.hidden) return;

            // The user deliberately collapsed the groups: leave them alone.
            if (state.groupsCollapsedByUser) return;

            if (getSetting('autoArchive') && hasPendingArchiveWork()) {
                runArchiver(false);
            } else if (getSetting('autoExpandSidebar')) {
                const hasCollapsed = getGroups().some((g) => !g.wrapper.classList.contains('expanded'));
                if (hasCollapsed) {
                    await autoExpandGroups();
                }
            }
        }, 350);
    }

    function hookNavigationAndVisibility() {
        const wrapHistoryMethod = (type) => {
            const orig = history[type];
            if (typeof orig !== 'function') return;
            history[type] = function (...args) {
                const result = orig.apply(this, args);
                scheduleCheck();
                return result;
            };
        };
        wrapHistoryMethod('pushState');
        wrapHistoryMethod('replaceState');
        window.addEventListener('popstate', scheduleCheck);
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) scheduleCheck();
        });
    }

    const observer = new MutationObserver((mutations) => {
        if (state.isArchiving || state.isStarting) return;
        const isExternalMutation = mutations.some((m) => {
            const target = m.target;
            return (
                target instanceof Element &&
                target.id !== 'jes-toast' &&
                target.id !== 'jes-toolbar-group' &&
                target.id !== 'jes-suggest-bar' &&
                !target.closest('#jes-toast, #jes-toolbar-group, #jes-suggest-bar')
            );
        });
        if (isExternalMutation) scheduleCheck();
    });

    loadSettings();
    hookNavigationAndVisibility();
    registerMenus();
    injectToolbarUI();
    scheduleCheck();
    observer.observe(document.body, { childList: true, subtree: true });
})();
