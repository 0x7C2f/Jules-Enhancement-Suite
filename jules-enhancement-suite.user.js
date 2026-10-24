// ==UserScript==
// @name         Jules Enhancement Suite
// @namespace    https://github.com/0x7C2f/Jules-Enhancement-Suite
// @version      2.5.0
// @description  UI enhancement and workflow automation suite for jules.google.com: automatic sidebar expansion, smart session archiving, toolbar controls, keyboard shortcuts, and observer-backed CDK synchronization
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

    const DEFAULT_CONFIG = {
        autoArchive: true,
        autoExpandSidebar: true,
        skipActiveSession: true,
        onlyCompletedOrFailed: true,
        actionRegex: /^archive\b/i,
        confirmRegex: /^(archive|confirm|yes|ok|delete)$/i,
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
        'onlyCompletedOrFailed'
    ];

    const SELECTORS = {
        panel: '.panel-container',
        panelToggle: '.start-panel-button',
        collapsibleCollapsed: '.collapsible-wrapper:not(.expanded)',
        sourceHeader: '.source-header',
        viewMoreBtn: '.view-more-button',
        taskRow: '.task-link-container',
        taskContainer: 'a.task-container, .task-container',
        taskDescription: '.task-description',
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
        abortRequested: false,
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
            console.warn('[Jules Enhancement Suite] Failed to save setting:', err);
        }
        registerMenus();
    }

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

    async function expandCollapsibleGroups() {
        if (state.isExpanding) return;
        state.isExpanding = true;
        updateToolbarUI();
        try {
            const collapsed = Array.from(document.querySelectorAll(SELECTORS.collapsibleCollapsed));
            for (const wrapper of collapsed) {
                if (state.abortRequested) break;
                const header = wrapper.previousElementSibling;
                if (header && header.classList.contains('source-header') && isVisible(header)) {
                    triggerClick(header);
                    await waitFor(() => wrapper.classList.contains('expanded'), 1500, wrapper);
                }
            }
        } finally {
            state.isExpanding = false;
            updateToolbarUI();
        }
    }

    async function expandAndPaginateSidebar(isManual = false) {
        if (state.isExpanding) return;
        await ensureSidebarOpen();
        await expandCollapsibleGroups();

        state.isExpanding = true;
        updateToolbarUI();

        try {
            const panelRoot = document.querySelector(SELECTORS.panel) || document.body;
            let paginationGuard = 0;
            let prevTaskCount = -1;

            while (!state.abortRequested && paginationGuard < 35) {
                const currentTaskCount = document.querySelectorAll(SELECTORS.taskRow).length;
                const viewMoreBtns = Array.from(document.querySelectorAll(SELECTORS.viewMoreBtn)).filter(isVisible);

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

            state.initialExpansionDone = true;
            if (isManual) {
                const totalLoaded = document.querySelectorAll(SELECTORS.taskRow).length;
                showToast(`Expanded sidebar (${totalLoaded} sessions loaded).`);
            }
        } finally {
            state.isExpanding = false;
            updateToolbarUI();
        }
    }

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
            console.error('[Jules Enhancement Suite] Error archiving row:', err);
            await clearOverlays();
            markRowOutcome(row, id, false);
            return false;
        }
    }

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
        const expandBtn = document.getElementById('jes-expand-btn');

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
        }

        if (expandBtn) {
            const nextExpandText = state.isExpanding ? 'Expanding...' : 'Expand All';
            if (expandBtn.textContent !== nextExpandText) expandBtn.textContent = nextExpandText;
            expandBtn.disabled = state.isExpanding || state.isArchiving;
        }
    }

    async function runArchiver(isManual = false) {
        if (state.isArchiving) return;
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
            const eligibleQueue = Array.from(document.querySelectorAll(SELECTORS.taskRow)).filter(isEligible);
            let totalEstimated = eligibleQueue.length;

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

                let nextRow = Array.from(document.querySelectorAll(SELECTORS.taskRow)).find(isEligible);

                if (!nextRow) {
                    const viewMore = Array.from(document.querySelectorAll(SELECTORS.viewMoreBtn)).find(isVisible);
                    if (viewMore) {
                        const prevCount = document.querySelectorAll(SELECTORS.taskRow).length;
                        viewMore.scrollIntoView({ block: 'nearest' });
                        triggerClick(viewMore);
                        await waitFor(
                            () => document.querySelectorAll(SELECTORS.taskRow).length > prevCount,
                            1800,
                            panelRoot
                        );
                        nextRow = Array.from(document.querySelectorAll(SELECTORS.taskRow)).find(isEligible);
                    }
                }

                if (!nextRow) break;

                const remaining = Array.from(document.querySelectorAll(SELECTORS.taskRow)).filter(isEligible).length;
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
            console.error('[Jules Enhancement Suite] Fatal error in runArchiver:', err);
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
        } else {
            state.skippedIds.clear();
            state.processedNodes = new WeakSet();
            state.failureCounts.clear();
            state.initialExpansionDone = false;
            runArchiver(true);
        }
    }

    function injectToolbarUI() {
        injectStyles();

        const existingGroup = document.getElementById('jes-toolbar-group');
        if (existingGroup && existingGroup.isConnected) return;

        const container = document.querySelector(SELECTORS.toolbarContainers);
        if (!container) return;

        const group = document.createElement('div');
        group.id = 'jes-toolbar-group';

        const expandBtn = document.createElement('button');
        expandBtn.id = 'jes-expand-btn';
        expandBtn.className = 'jes-btn';
        expandBtn.type = 'button';
        expandBtn.dataset.variant = 'secondary';
        expandBtn.title = 'Jules Enhancement Suite: Expand All Repo Groups & Load Sessions (Alt+Shift+E)';
        expandBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (!state.isArchiving && !state.isExpanding) {
                expandAndPaginateSidebar(true);
            }
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

        group.append(expandBtn, archiveBtn);
        container.prepend(group);
        updateToolbarUI();
    }

    function isEditableTarget(el) {
        if (!el) return false;
        const tag = el.tagName.toLowerCase();
        return (
            tag === 'input' ||
            tag === 'textarea' ||
            el.isContentEditable ||
            Boolean(el.closest('.monaco-editor, .xterm, .ProseMirror, .cm-editor'))
        );
    }

    window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && state.isArchiving && !state.abortRequested) {
            state.abortRequested = true;
            updateToolbarUI();
            return;
        }

        if (!e.altKey || !e.shiftKey || isEditableTarget(document.activeElement)) return;

        if (e.code === 'KeyA') {
            e.preventDefault();
            toggleArchiver();
        } else if (e.code === 'KeyE') {
            e.preventDefault();
            if (!state.isArchiving && !state.isExpanding) expandAndPaginateSidebar(true);
        } else if (e.code === 'KeyS') {
            e.preventDefault();
            toggleSidebarPanel();
        }
    });

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

        const autoArchiveState = getSetting('autoArchive') ? 'ON' : 'OFF';
        const autoExpandState = getSetting('autoExpandSidebar') ? 'ON' : 'OFF';
        const filterState = getSetting('onlyCompletedOrFailed') ? 'ON' : 'OFF';
        const skipActiveState = getSetting('skipActiveSession') ? 'ON' : 'OFF';

        state.menuCommandIds.push(
            GM_registerMenuCommand('Archive Eligible Sessions (Alt+Shift+A)', toggleArchiver),
            GM_registerMenuCommand('Expand & Load All Sessions (Alt+Shift+E)', () => {
                if (!state.isArchiving && !state.isExpanding) expandAndPaginateSidebar(true);
            }),
            GM_registerMenuCommand('Toggle Sidebar Panel (Alt+Shift+S)', toggleSidebarPanel),
            GM_registerMenuCommand(`Auto-Archive Sessions: [${autoArchiveState}]`, () => {
                const next = !getSetting('autoArchive');
                setSetting('autoArchive', next);
                showToast(`Auto-Archive: ${next ? 'ENABLED' : 'DISABLED'}`);
            }),
            GM_registerMenuCommand(`Auto-Expand Repo Groups: [${autoExpandState}]`, () => {
                const next = !getSetting('autoExpandSidebar');
                setSetting('autoExpandSidebar', next);
                showToast(`Auto-Expand Repo Groups: ${next ? 'ENABLED' : 'DISABLED'}`);
            }),
            GM_registerMenuCommand(`Archive Only Completed/Failed: [${filterState}]`, () => {
                const next = !getSetting('onlyCompletedOrFailed');
                setSetting('onlyCompletedOrFailed', next);
                showToast(`Only Completed/Failed: ${next ? 'ENABLED' : 'DISABLED'}`);
            }),
            GM_registerMenuCommand(`Skip Active Session: [${skipActiveState}]`, () => {
                const next = !getSetting('skipActiveSession');
                setSetting('skipActiveSession', next);
                showToast(`Skip Active Session: ${next ? 'ENABLED' : 'DISABLED'}`);
            })
        );
    }

    function hasPendingArchiveWork() {
        if (Array.from(document.querySelectorAll(SELECTORS.taskRow)).some(isEligible)) {
            return true;
        }
        if (!state.initialExpansionDone) {
            const hasCollapsed = document.querySelector(SELECTORS.collapsibleCollapsed) !== null;
            const hasViewMore = Array.from(document.querySelectorAll(SELECTORS.viewMoreBtn)).some(isVisible);
            return hasCollapsed || hasViewMore;
        }
        return false;
    }

    function scheduleCheck() {
        if (state.isArchiving) return;
        if (state.debounceTimer) clearTimeout(state.debounceTimer);
        state.debounceTimer = setTimeout(async () => {
            if (state.isArchiving) return;
            if (window.location.pathname !== state.lastPathname) {
                state.lastPathname = window.location.pathname;
                state.initialExpansionDone = false;
                state.skippedIds.clear();
            }

            injectToolbarUI();

            // Avoid background-tab timer throttling causing false DOM wait timeouts
            if (document.hidden) return;

            if (getSetting('autoArchive') && hasPendingArchiveWork()) {
                runArchiver(false);
            } else if (getSetting('autoExpandSidebar')) {
                const hasCollapsed = document.querySelector(SELECTORS.collapsibleCollapsed) !== null;
                if (hasCollapsed) {
                    await expandCollapsibleGroups();
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
        if (state.isArchiving) return;
        const isExternalMutation = mutations.some((m) => {
            const target = m.target;
            return (
                target instanceof Element &&
                target.id !== 'jes-toast' &&
                target.id !== 'jes-toolbar-group' &&
                !target.closest('#jes-toast, #jes-toolbar-group')
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
