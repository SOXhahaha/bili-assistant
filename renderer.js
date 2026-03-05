document.addEventListener('DOMContentLoaded', () => {
    const HOME_URL = 'https://www.bilibili.com';
    const LOGIN_URL = 'https://passport.bilibili.com/login';
    const ACCOUNT_HOME_URL = 'https://account.bilibili.com/account/home';
    const AUTHOR_UID = '22424343';
    const DAILY_WATCH_TARGET_SECONDS = 62;
    const DAILY_WATCH_MAX_WAIT_MS = 220000;
    const STEP_DEFAULT_TIMEOUT_MS = 240000;
    const STEP_WATCH_TIMEOUT_MS = DAILY_WATCH_MAX_WAIT_MS + 60000;
    const API_MIN_INTERVAL_MS = 2000;  // API 调用最小间隔，防触发风控
    const WEBVIEW_PARTITION = 'persist:bili-assistant';
    const WEBVIEW_PRELOAD_URL = new URL('webview-preload.js', window.location.href).toString();
    const WEBVIEW_USER_AGENT =
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

    const startBtn = document.getElementById('startBtn');
    const loginBtn = document.getElementById('loginBtn');
    const refreshBtn = document.getElementById('refreshBtn');
    const newTabBtn = document.getElementById('newTabBtn');

    const followAuthor = document.getElementById('followAuthor');
    const dailyTaskEnabled = document.getElementById('dailyTaskEnabled');
    const vipSignEnabled = document.getElementById('vipSignEnabled');
    const coinTarget = document.getElementById('coinTarget');
    const coinTargetVal = document.getElementById('coinTargetVal');
    const currentCoin = document.getElementById('currentCoin');

    const addressText = document.getElementById('addressText');
    const userStatus = document.getElementById('userStatus');
    const tabBar = document.getElementById('tabBar');
    const webviewContainer = document.getElementById('webviewContainer');

    const taskList = document.querySelector('.task-list');
    const progressPanel = document.getElementById('progressPanel');
    const progressBarFill = document.getElementById('progressBarFill');
    const progressSteps = document.getElementById('progressSteps');

    if (!startBtn || !tabBar || !webviewContainer || !progressPanel || !progressBarFill || !progressSteps) {
        console.error('Missing required UI elements, automation bootstrap aborted.');
        return;
    }

    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    let runState = 'idle';
    let stopRequested = false;
    let tabCounter = 1;
    let activeTabId = 'tab-1';
    let automationTabId = '';
    let loginSyncTimer = null;

    const CONFIG_STORAGE_KEY = 'bili-assistant-config-v1';
    const DEFAULT_CONFIG = {
        followAuthor: true,
        dailyTaskEnabled: true,
        vipSignEnabled: true,
        coinTarget: 5
    };

    let desiredConfig = { ...DEFAULT_CONFIG };
    const userEligibility = {
        loggedIn: false,
        isVip: null,
        isAnnualVip: null
    };

    function clampInt(value, min, max) {
        const parsed = Number.parseInt(value, 10);
        if (Number.isNaN(parsed)) return min;
        return Math.min(max, Math.max(min, parsed));
    }

    function sanitizeConfig(config = {}) {
        return {
            followAuthor: Boolean(config.followAuthor),
            dailyTaskEnabled: Boolean(config.dailyTaskEnabled),
            vipSignEnabled: Boolean(config.vipSignEnabled),
            coinTarget: clampInt(config.coinTarget, 0, 5)
        };
    }

    function applyVipEligibilityToUI() {
        if (!vipSignEnabled) return;

        const desiredVipSign = Boolean(desiredConfig.vipSignEnabled);

        if (!userEligibility.loggedIn) {
            vipSignEnabled.disabled = false;
            vipSignEnabled.checked = desiredVipSign;
            return;
        }

        if (userEligibility.isVip === false) {
            vipSignEnabled.checked = false;
            vipSignEnabled.disabled = true;
            return;
        }

        vipSignEnabled.disabled = false;
        vipSignEnabled.checked = desiredVipSign;
    }

    function applyConfigToUI(config) {
        desiredConfig = sanitizeConfig({
            ...DEFAULT_CONFIG,
            ...config
        });

        if (followAuthor) followAuthor.checked = desiredConfig.followAuthor;
        if (dailyTaskEnabled) dailyTaskEnabled.checked = desiredConfig.dailyTaskEnabled;

        const safeCoinTarget = desiredConfig.coinTarget;
        if (coinTarget) coinTarget.value = String(safeCoinTarget);
        if (coinTargetVal) coinTargetVal.innerText = String(safeCoinTarget);

        applyVipEligibilityToUI();
    }

    function loadPersistedConfig() {
        try {
            const raw = window.localStorage.getItem(CONFIG_STORAGE_KEY);
            if (!raw) {
                applyConfigToUI(DEFAULT_CONFIG);
                return;
            }

            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object') {
                applyConfigToUI(DEFAULT_CONFIG);
                return;
            }

            applyConfigToUI(parsed);
        } catch (error) {
            console.warn('Failed to load persisted config:', error);
            applyConfigToUI(DEFAULT_CONFIG);
        }
    }

    function persistCurrentConfig() {
        try {
            desiredConfig = sanitizeConfig(desiredConfig);
            window.localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(desiredConfig));
        } catch (error) {
            console.warn('Failed to persist config:', error);
        }
    }

    function normalizeUrl(rawUrl) {
        if (!rawUrl || typeof rawUrl !== 'string') return HOME_URL;

        const trimmed = rawUrl.trim();
        if (!trimmed) return HOME_URL;

        if (/^https?:\/\//i.test(trimmed) || /^file:\/\//i.test(trimmed)) {
            return trimmed;
        }

        try {
            return new URL(trimmed, HOME_URL).toString();
        } catch {
            return `https://${trimmed}`;
        }
    }

    function isUsablePopupUrl(rawUrl) {
        if (!rawUrl || typeof rawUrl !== 'string') return false;

        const trimmed = rawUrl.trim();
        if (!trimmed) return false;

        const lowered = trimmed.toLowerCase();
        if (lowered === 'about:blank') return false;
        if (lowered.startsWith('javascript:')) return false;

        return true;
    }

    function getTabButtons() {
        return Array.from(tabBar.querySelectorAll('.tab-item'));
    }

    function getWebviews() {
        return Array.from(webviewContainer.querySelectorAll('.bili-webview'));
    }

    function getTabButtonById(tabId) {
        return tabBar.querySelector(`.tab-item[data-tab-id="${tabId}"]`);
    }

    function getWebviewByTabId(tabId) {
        return webviewContainer.querySelector(`.bili-webview[data-tab-id="${tabId}"]`);
    }

    function getActiveWebview() {
        return getWebviewByTabId(activeTabId);
    }

    function getExecutionWebview() {
        const runTabId = automationTabId || activeTabId;
        return getWebviewByTabId(runTabId);
    }

    function updateAddressBar() {
        if (!addressText) return;

        const webview = getActiveWebview();
        if (!webview) {
            addressText.innerText = HOME_URL;
            return;
        }

        try {
            const url = webview.getURL() || webview.getAttribute('src') || HOME_URL;
            addressText.innerText = url;
        } catch {
            addressText.innerText = webview.getAttribute('src') || HOME_URL;
        }
    }

    function setUserStatus(loggedIn, name) {
        if (!userStatus) return;

        userStatus.classList.toggle('online', loggedIn);
        userStatus.classList.toggle('offline', !loggedIn);
        userStatus.querySelector('span').innerText = loggedIn ? (name || '已登录') : '未登录';

        if (loginBtn) {
            loginBtn.innerHTML = loggedIn
                ? '<i class="fas fa-sign-out-alt"></i> 退出登录'
                : '<i class="fas fa-sign-in-alt"></i> 去登录';
        }
    }

    function setTabTitle(tabId, title) {
        const tab = getTabButtonById(tabId);
        if (!tab) return;

        const titleNode = tab.querySelector('.tab-title');
        if (!titleNode) return;

        const safeTitle = (title || '').trim();
        titleNode.innerText = safeTitle ? safeTitle.slice(0, 18) : '新标签页';
    }

    function updateStartButtonAvailability() {
        if (runState !== 'idle') return;
        const followChecked = Boolean(followAuthor && followAuthor.checked);
        const canStart = followChecked && Boolean(userEligibility.loggedIn);
        startBtn.disabled = !canStart;
    }

    function setRunState(nextState) {
        runState = nextState;

        if (runState === 'idle') {
            startBtn.classList.remove('running');
            startBtn.innerHTML = '<i class="fas fa-play"></i> 一键开始自动化';
            updateStartButtonAvailability();
            return;
        }

        if (runState === 'running') {
            startBtn.classList.add('running');
            startBtn.disabled = false;
            startBtn.innerHTML = '<i class="fas fa-stop"></i> 停止运行';
            return;
        }

        if (runState === 'done') {
            startBtn.classList.remove('running');
            startBtn.disabled = false;
            startBtn.innerHTML = '<i class="fas fa-undo"></i> 返回配置';
            return;
        }

        if (runState === 'paused') {
            startBtn.classList.remove('running');
            startBtn.disabled = false;
            startBtn.innerHTML = '<i class="fas fa-pause"></i> 任务已暂停，返回配置';
        }
    }

    function togglePanels(showConfig) {
        taskList.style.display = showConfig ? 'block' : 'none';
        progressPanel.style.display = showConfig ? 'none' : 'flex';
    }

    function updateProgressBar(processed, total) {
        const percent = total === 0 ? 0 : Math.floor((processed / total) * 100);
        progressBarFill.style.width = `${percent}%`;
    }

    function renderProgressSteps(steps) {
        progressSteps.innerHTML = '';

        steps.forEach((step, index) => {
            const item = document.createElement('div');
            item.className = 'step-item';
            item.id = `step_${index}`;

            item.innerHTML = `
                <div class="step-icon"><i class="fas fa-clock"></i></div>
                <div class="step-info">
                    <span class="step-name">${step.name}</span>
                    <span class="step-status" id="status_${index}">等待执行...</span>
                </div>
            `;

            progressSteps.appendChild(item);
        });
    }

    function setStepState(index, state, statusText) {
        const item = document.getElementById(`step_${index}`);
        const statusEl = document.getElementById(`status_${index}`);
        if (!item || !statusEl) return;

        const icon = item.querySelector('.step-icon i');
        item.className = 'step-item';

        if (state === 'active') {
            item.classList.add('active');
            icon.className = 'fas fa-spinner fa-spin';
            statusEl.innerText = statusText || '执行中...';
            return;
        }

        if (state === 'completed') {
            item.classList.add('completed');
            icon.className = 'fas fa-check';
            statusEl.innerText = statusText || '已完成';
            return;
        }

        if (state === 'skipped') {
            item.classList.add('skipped');
            icon.className = 'fas fa-forward';
            statusEl.innerText = statusText || '已跳过';
            return;
        }

        if (state === 'failed') {
            item.classList.add('failed');
            icon.className = 'fas fa-times';
            statusEl.innerText = statusText || '执行失败';
            return;
        }

        if (state === 'paused') {
            item.classList.add('failed');
            icon.className = 'fas fa-pause';
            statusEl.innerText = statusText || '已暂停';
            return;
        }

        icon.className = 'fas fa-clock';
        statusEl.innerText = statusText || '等待执行...';
    }

    function switchToTab(tabId) {
        const tab = getTabButtonById(tabId);
        const webview = getWebviewByTabId(tabId);
        if (!tab || !webview) return;

        activeTabId = tabId;

        getTabButtons().forEach((node) => node.classList.remove('active'));
        getWebviews().forEach((node) => node.classList.remove('active'));

        tab.classList.add('active');
        webview.classList.add('active');
        updateAddressBar();

        if (runState !== 'running') {
            refreshUserStatus(webview);
        }
    }

    function attachWebviewEvents(webview, tabId) {
        const retryLoadedUrls = new Set();

        const updateIfActive = () => {
            if (activeTabId === tabId) {
                updateAddressBar();
            }
        };

        const openUrlInTab = (url, activate = true) => {
            createTab(url, { activate });
        };

        webview.addEventListener('did-start-loading', updateIfActive);
        webview.addEventListener('did-stop-loading', () => {
            updateIfActive();
            if (activeTabId === tabId && runState !== 'running') {
                refreshUserStatus(webview);
            }
        });
        webview.addEventListener('did-navigate', updateIfActive);
        webview.addEventListener('did-navigate-in-page', updateIfActive);
        webview.addEventListener('did-redirect-navigation', updateIfActive);
        webview.addEventListener('did-fail-load', (event) => {
            if (!event || !event.isMainFrame) return;

            const errorCode = Number(event.errorCode);
            if (errorCode === -3) return;

            const failedUrl = (event.validatedURL || '').trim();
            if (!failedUrl) return;

            // Account experience page can occasionally fail on first load in embedded sessions.
            const shouldRetryAccountRecord =
                /account\.bilibili\.com\/account\/record/i.test(failedUrl) &&
                !retryLoadedUrls.has(failedUrl);

            if (!shouldRetryAccountRecord) return;

            retryLoadedUrls.add(failedUrl);
            setTimeout(() => {
                try {
                    webview.loadURL(failedUrl);
                } catch {
                    // ignore retry errors
                }
            }, 280);
        });

        webview.addEventListener('page-title-updated', (event) => {
            setTabTitle(tabId, event.title || '新标签页');
        });

        webview.addEventListener('ipc-message', (event) => {
            if (event.channel !== 'open-new-tab') return;

            const payload = event.args && event.args[0] ? event.args[0] : {};
            const url = payload && payload.url ? payload.url : '';
            if (url) {
                openUrlInTab(url, true);
            }
        });

        webview.addEventListener('new-window', (event) => {
            event.preventDefault();
            if (event.url && isUsablePopupUrl(event.url)) {
                openUrlInTab(event.url, true);
            }
        });

        webview.addEventListener('did-create-window', (event) => {
            if (event && event.window && typeof event.window.close === 'function') {
                event.window.close();
            }

            if (event && event.url && isUsablePopupUrl(event.url)) {
                openUrlInTab(event.url, true);
            }
        });
    }

    function createTab(url, options = {}) {
        const activate = options.activate !== false;
        const nextUrl = normalizeUrl(url || HOME_URL);

        tabCounter += 1;
        const tabId = `tab-${tabCounter}`;

        const tab = document.createElement('button');
        tab.className = 'tab-item';
        tab.type = 'button';
        tab.setAttribute('data-tab-id', tabId);
        tab.innerHTML = `
            <i class="fab fa-bilibili"></i>
            <span class="tab-title">新标签页</span>
            <span class="tab-close" data-close-tab>×</span>
        `;

        tabBar.insertBefore(tab, newTabBtn || null);

        const webview = document.createElement('webview');
        webview.className = 'bili-webview';
        webview.setAttribute('data-tab-id', tabId);
        webview.setAttribute('partition', WEBVIEW_PARTITION);
        webview.setAttribute('preload', WEBVIEW_PRELOAD_URL);
        webview.setAttribute('useragent', WEBVIEW_USER_AGENT);
        webview.setAttribute('src', nextUrl);
        webviewContainer.appendChild(webview);

        attachWebviewEvents(webview, tabId);

        if (activate) {
            switchToTab(tabId);
        }

        return tabId;
    }

    function closeTab(tabId) {
        if (!tabId) return;

        if (runState === 'running' && automationTabId === tabId) {
            return;
        }

        const tabs = getTabButtons();
        if (tabs.length <= 1) {
            const onlyWebview = getWebviewByTabId(tabId);
            if (onlyWebview) {
                onlyWebview.loadURL(HOME_URL);
            }
            return;
        }

        const tabIndex = tabs.findIndex((node) => node.getAttribute('data-tab-id') === tabId);
        const isActive = activeTabId === tabId;

        const tab = getTabButtonById(tabId);
        const webview = getWebviewByTabId(tabId);

        if (tab) tab.remove();
        if (webview) webview.remove();

        if (automationTabId === tabId) {
            automationTabId = '';
        }

        if (isActive) {
            const remainedTabs = getTabButtons();
            const next = remainedTabs[tabIndex] || remainedTabs[tabIndex - 1] || remainedTabs[0];
            if (next) {
                switchToTab(next.getAttribute('data-tab-id'));
            }
        }
    }

    async function executeInWebview(code, webview = getExecutionWebview()) {
        if (!webview) {
            return { status: 'failed', message: '无可用浏览器标签' };
        }

        if (typeof code !== 'string' || !code.trim()) {
            return { status: 'failed', message: '注入脚本为空' };
        }

        const safeExec = async () => {
            if (typeof webview.isDestroyed === 'function' && webview.isDestroyed()) {
                return { status: 'failed', message: '浏览器标签已销毁' };
            }

            // Wait until webview is not loading to avoid context-destroy races
            for (let wait = 0; wait < 15; wait += 1) {
                try {
                    if (!webview.isLoading()) break;
                } catch {
                    break;
                }
                await new Promise(r => setTimeout(r, 300));
            }

            const wrappedCode = `
                (async () => {
                    try {
                        const __runner = async () => ${code};
                        return await __runner();
                    } catch (error) {
                        const message = error && error.message ? String(error.message) : '脚本执行异常';
                        return { status: 'failed', message };
                    }
                })()
            `;

            return await webview.executeJavaScript(wrappedCode, true);
        };

        // Retry once on guest-context-destroyed errors
        for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
                return await safeExec();
            } catch (error) {
                const message = error && error.message ? String(error.message) : 'WebView 注入失败';
                const guestInterrupted = /script failed to execute|guest_view_manager_call|object has been destroyed/i.test(message);
                if (guestInterrupted && attempt === 0) {
                    // Wait for page to settle, then retry
                    await new Promise(r => setTimeout(r, 1500));
                    continue;
                }
                return {
                    status: 'failed',
                    code: guestInterrupted ? 'guest_script_interrupted' : 'webview_exec_failed',
                    message
                };
            }
        }

        return { status: 'failed', message: 'executeInWebview 异常退出' };
    }

    async function waitForWebviewLoad(webview = getExecutionWebview(), timeoutMs = 25000) {
        if (!webview) {
            throw new Error('无可用浏览器标签');
        }

        return new Promise((resolve, reject) => {
            let timer = null;

            const cleanup = () => {
                webview.removeEventListener('did-stop-loading', onLoaded);
                webview.removeEventListener('did-fail-load', onFailed);
                if (timer) clearTimeout(timer);
            };

            const onLoaded = () => {
                cleanup();
                resolve();
            };

            const onFailed = (event) => {
                if (event && Number(event.errorCode) === -3) {
                    return;
                }
                cleanup();
                reject(new Error((event && event.errorDescription) || '页面加载失败'));
            };

            timer = setTimeout(() => {
                cleanup();
                reject(new Error('页面加载超时'));
            }, timeoutMs);

            webview.addEventListener('did-stop-loading', onLoaded, { once: true });
            webview.addEventListener('did-fail-load', onFailed);
        });
    }

    async function sleepWithStop(ms) {
        const step = 150;
        const loops = Math.ceil(ms / step);

        for (let i = 0; i < loops; i += 1) {
            if (stopRequested) throw new Error('任务已手动停止');
            await delay(step);
        }
    }

    function isLikelyStuckMessage(message) {
        const text = String(message || '').toLowerCase();
        return /超时|timeout|timed out|无响应|卡住/.test(text);
    }

    async function runStepWithTimeout(step) {
        const timeoutMs = Number(step && step.timeoutMs) > 0 ? Number(step.timeoutMs) : STEP_DEFAULT_TIMEOUT_MS;
        let timer = null;

        const timeoutResult = new Promise((resolve) => {
            timer = window.setTimeout(() => {
                // Request cooperative stop in long polling loops inside step implementations.
                stopRequested = true;
                resolve({
                    status: 'paused',
                    message: `步骤执行超时（${Math.floor(timeoutMs / 1000)}秒），已自动暂停`
                });
            }, timeoutMs);
        });

        try {
            return await Promise.race([step.run(), timeoutResult]);
        } finally {
            if (timer) {
                clearTimeout(timer);
            }
        }
    }

    async function navigateTo(url, webview = getExecutionWebview()) {
        if (!webview) throw new Error('无可用浏览器标签');

        webview.loadURL(normalizeUrl(url));
        await waitForWebviewLoad(webview);

        if (webview === getActiveWebview()) {
            updateAddressBar();
        }

        await sleepWithStop(500);
    }

    async function detectLoginStatus(webview = getExecutionWebview()) {
        const result = await executeInWebview(`(async () => {
            const parseCookieMap = () => {
                const cookieText = document.cookie || '';
                const map = {};

                const safeDecode = (value) => {
                    try {
                        return decodeURIComponent(value);
                    } catch {
                        return value;
                    }
                };

                cookieText.split(';').forEach((pair) => {
                    const [rawKey, ...rest] = pair.split('=');
                    const key = (rawKey || '').trim();
                    if (!key) return;
                    map[key] = safeDecode((rest.join('=') || '').trim());
                });

                return map;
            };

            const cookieMap = parseCookieMap();
            const uidByCookie = cookieMap.DedeUserID || '';

            let apiLogin = false;
            let apiUserName = '';
            let apiUid = '';
            let apiCoin = null;
            let apiVipKnown = false;
            let apiIsVip = null;
            let apiIsAnnualVip = null;

            try {
                const resp = await fetch('https://api.bilibili.com/x/web-interface/nav', {
                    credentials: 'include',
                    cache: 'no-store'
                });
                const json = await resp.json();
                if (json && Number(json.code) === 0 && json.data) {
                    apiLogin = Boolean(json.data.isLogin);
                    apiUserName = (json.data.uname || '').trim();
                    apiUid = json.data.mid ? String(json.data.mid) : '';

                    if (Object.prototype.hasOwnProperty.call(json.data, 'money')) {
                        const moneyNum = Number(json.data.money);
                        apiCoin = Number.isNaN(moneyNum) ? null : moneyNum;
                    }

                    const vipStatusRaw = json.data.vipStatus;
                    const vipTypeRaw = json.data.vipType;
                    const hasVipField =
                        Object.prototype.hasOwnProperty.call(json.data, 'vipStatus') ||
                        Object.prototype.hasOwnProperty.call(json.data, 'vipType') ||
                        Object.prototype.hasOwnProperty.call(json.data, 'vip_label') ||
                        Object.prototype.hasOwnProperty.call(json.data, 'isAnnual');

                    if (hasVipField) {
                        apiVipKnown = true;
                        const vipStatusNum = Number(vipStatusRaw);
                        const vipTypeNum = Number(vipTypeRaw || 0);

                        apiIsVip = Boolean(vipStatusNum === 1 || vipStatusRaw === true);

                        const vipLabelText =
                            json.data.vip_label && typeof json.data.vip_label.text === 'string'
                                ? json.data.vip_label.text
                                : '';

                        const annualByType = vipTypeNum === 2;
                        const annualByFlag = Boolean(json.data.isAnnual);
                        const annualByLabel = /年度|year/i.test(vipLabelText || '');
                        apiIsAnnualVip = Boolean(apiIsVip && (annualByType || annualByFlag || annualByLabel));
                    }
                }
            } catch {
                // ignore API failures and fallback to cookie/DOM detection
            }

            const loginSelectors = [
                '.header-login-entry',
                '.go-login-btn',
                'a[href*="passport.bilibili.com/login"]',
                'button[class*="login"]'
            ];
            const hasLoginEntry = loginSelectors.some((selector) => document.querySelector(selector));

            const avatarSelectors = [
                '.header-avatar-wrap img',
                '.bili-avatar img',
                '.header-entry-mini img',
                'img[class*="avatar"]'
            ];

            const avatar = avatarSelectors
                .map((selector) => document.querySelector(selector))
                .find((node) => Boolean(node));

            const domUserName = avatar && avatar.alt ? avatar.alt.trim() : '';
            const cookieLogin = Boolean(uidByCookie) || Boolean(cookieMap.SESSDATA);
            const domLogin = Boolean(avatar) && !hasLoginEntry;

            return {
                loggedIn: apiLogin || cookieLogin || domLogin,
                userName: apiUserName || domUserName,
                uid: apiUid || uidByCookie,
                coin: apiCoin,
                vipKnown: apiVipKnown,
                isVip: apiVipKnown ? apiIsVip : null,
                isAnnualVip: apiVipKnown ? apiIsAnnualVip : null
            };
        })()`, webview);

        if (!result || result.status === 'failed') {
            return { loggedIn: false, userName: '', message: '登录状态检测失败' };
        }

        return {
            loggedIn: Boolean(result.loggedIn),
            userName: result.userName || '',
            uid: result.uid || '',
            coin: result.coin == null ? null : result.coin,
            vipKnown: Boolean(result.vipKnown),
            isVip: typeof result.isVip === 'boolean' ? result.isVip : null,
            isAnnualVip: typeof result.isAnnualVip === 'boolean' ? result.isAnnualVip : null
        };
    }

    async function refreshUserStatus(webview = getActiveWebview()) {
        if (!webview) {
            setUserStatus(false, '未登录');
            userEligibility.loggedIn = false;
            userEligibility.isVip = null;
            userEligibility.isAnnualVip = null;
            applyVipEligibilityToUI();
            if (currentCoin) currentCoin.innerText = '--';
            updateStartButtonAvailability();
            return;
        }

        const login = await detectLoginStatus(webview);
        if (login.loggedIn) {
            const name = login.userName || (login.uid ? `UID:${login.uid}` : '已登录');
            setUserStatus(true, name);
        } else {
            setUserStatus(false, '未登录');
        }

        userEligibility.loggedIn = Boolean(login.loggedIn);
        userEligibility.isVip = login.vipKnown ? login.isVip : null;
        userEligibility.isAnnualVip = login.vipKnown ? login.isAnnualVip : null;
        applyVipEligibilityToUI();
        updateStartButtonAvailability();

        if (!login.loggedIn) {
            if (currentCoin) currentCoin.innerText = '--';
            return;
        }

        if (login.coin !== null && login.coin !== undefined && currentCoin) {
            currentCoin.innerText = String(login.coin);
        }
    }

    async function ensureLoggedInBeforeStart() {
        const webview = getActiveWebview();
        if (!webview) {
            setUserStatus(false, '未登录');
            userEligibility.loggedIn = false;
            updateStartButtonAvailability();
            return false;
        }

        const login = await detectLoginStatus(webview);
        if (!login.loggedIn) {
            setUserStatus(false, '未登录');
            userEligibility.loggedIn = false;
            userEligibility.isVip = null;
            userEligibility.isAnnualVip = null;
            applyVipEligibilityToUI();
            if (currentCoin) currentCoin.innerText = '--';
            updateStartButtonAvailability();
            return false;
        }

        const name = login.userName || (login.uid ? `UID:${login.uid}` : '已登录');
        setUserStatus(true, name);
        userEligibility.loggedIn = true;
        userEligibility.isVip = login.vipKnown ? login.isVip : null;
        userEligibility.isAnnualVip = login.vipKnown ? login.isAnnualVip : null;
        applyVipEligibilityToUI();

        if (login.coin !== null && login.coin !== undefined && currentCoin) {
            currentCoin.innerText = String(login.coin);
        }

        updateStartButtonAvailability();
        return true;
    }

    async function fetchCoinBalance(webview = getExecutionWebview()) {
        const coinResult = await executeInWebview(`(async () => {
            try {
                const resp = await fetch('https://api.bilibili.com/x/web-interface/nav', {
                    credentials: 'include', cache: 'no-store'
                });
                const json = await resp.json();
                if (json && json.code === 0 && json.data && json.data.money !== undefined) {
                    return String(json.data.money);
                }
                return null;
            } catch { return null; }
        })()`, webview);

        if (coinResult && typeof coinResult === 'string' && currentCoin) {
            currentCoin.innerText = coinResult;
        }

        return coinResult;
    }

    async function runCheckLoginStep() {
        const webview = getExecutionWebview();
        const login = await detectLoginStatus(webview);

        if (!login.loggedIn) {
            setUserStatus(false, '未登录');
            return {
                status: 'failed',
                message: '未检测到登录，请先点击右上角“去登录”'
            };
        }

        setUserStatus(true, login.userName || '已登录');
        return {
            status: 'completed',
            message: `登录有效 ${login.userName ? `(${login.userName})` : ''}`
        };
    }

    async function runEnsureFollowAuthorStep() {
        const webview = getExecutionWebview();

        const ensureResult = await executeInWebview(`(async () => {
            const targetUid = '${AUTHOR_UID}';

            const parseCookieMap = () => {
                const cookieText = document.cookie || '';
                const map = {};

                const safeDecode = (value) => {
                    try {
                        return decodeURIComponent(value);
                    } catch {
                        return value;
                    }
                };

                cookieText.split(';').forEach((pair) => {
                    const [rawKey, ...rest] = pair.split('=');
                    const key = (rawKey || '').trim();
                    if (!key) return;
                    map[key] = safeDecode((rest.join('=') || '').trim());
                });

                return map;
            };

            const toNumber = (value) => {
                const num = Number(value);
                return Number.isFinite(num) ? num : NaN;
            };

            const parseRelationFollowed = (payload) => {
                const data = payload && payload.data ? payload.data : {};

                if (typeof data.is_followed === 'boolean') return data.is_followed;
                if (typeof data.following === 'boolean') return data.following;

                const sources = [
                    data,
                    data.relation,
                    data.be_relation
                ];

                for (const source of sources) {
                    if (!source || typeof source !== 'object') continue;

                    const attrNum = toNumber(source.attribute);
                    if (!Number.isNaN(attrNum)) {
                        // Relationship attribute bit 2 indicates current user follows target.
                        return (attrNum & 2) === 2;
                    }
                }

                return null;
            };

            const queryRelation = async () => {
                const endpoints = [
                    'https://api.bilibili.com/x/relation?fid=' + encodeURIComponent(targetUid),
                    'https://api.bilibili.com/x/space/acc/relation?mid=' + encodeURIComponent(targetUid)
                ];

                let lastCode = null;
                let lastMessage = '';

                for (const endpoint of endpoints) {
                    try {
                        const resp = await fetch(endpoint, {
                            method: 'GET',
                            credentials: 'include',
                            cache: 'no-store'
                        });

                        const json = await resp.json();
                        if (!json || typeof json !== 'object') {
                            continue;
                        }

                        lastCode = Number(json.code);
                        lastMessage = json.message || '';

                        if (lastCode !== 0) {
                            continue;
                        }

                        const followed = parseRelationFollowed(json);
                        if (typeof followed === 'boolean') {
                            return { ok: true, followed };
                        }
                    } catch {
                        // Try next endpoint.
                    }
                }

                return {
                    ok: false,
                    message: lastCode === -101 ? '登录状态失效，请重新登录' : (lastMessage || '关注关系查询失败')
                };
            };

            const relation = await queryRelation();
            if (!relation.ok) {
                return { status: 'failed', message: relation.message };
            }

            if (relation.followed) {
                return { status: 'completed', message: '已关注 UID' + targetUid + '（API）' };
            }

            const cookieMap = parseCookieMap();
            const csrf = cookieMap.bili_jct || '';
            if (!csrf) {
                return { status: 'failed', message: '未获取到 bili_jct，无法调用关注API' };
            }

            try {
                const body = new URLSearchParams();
                body.set('fid', targetUid);
                body.set('act', '1');
                body.set('re_src', '11');
                body.set('csrf', csrf);
                body.set('csrf_token', csrf);

                const followResp = await fetch('https://api.bilibili.com/x/relation/modify', {
                    method: 'POST',
                    credentials: 'include',
                    headers: {
                        'content-type': 'application/x-www-form-urlencoded; charset=UTF-8'
                    },
                    body: body.toString()
                });

                const followJson = await followResp.json();
                const followCode = followJson && typeof followJson.code !== 'undefined' ? Number(followJson.code) : NaN;

                if (!Number.isNaN(followCode) && followCode !== 0) {
                    // 22001-like codes can indicate already followed; verify via relation API.
                    const verify = await queryRelation();
                    if (verify.ok && verify.followed) {
                        return { status: 'completed', message: '已关注 UID' + targetUid + '（API校验）' };
                    }

                    // 不能关注自己时直接视为完成
                    if (followJson && /不能关注自己/.test(followJson.message || '')) {
                        return { status: 'completed', message: '当前账号即为作者，无需关注' };
                    }

                    return {
                        status: 'failed',
                        message: (followJson && followJson.message) ? ('关注API失败: ' + followJson.message) : '关注API调用失败'
                    };
                }
            } catch {
                return { status: 'failed', message: '关注API请求异常' };
            }

            const verifyRelation = await queryRelation();
            if (verifyRelation.ok && verifyRelation.followed) {
                return { status: 'completed', message: '已自动关注 UID' + targetUid + '（API）' };
            }

            return { status: 'failed', message: '关注后校验未通过' };
        })()`, webview);

        if (!ensureResult || ensureResult.status === 'failed') {
            return {
                status: 'failed',
                message: ensureResult && ensureResult.message ? ensureResult.message : '关注状态检查失败'
            };
        }

        return ensureResult;
    }

    // ── 纯 API 实现的辅助函数 ──

    let lastApiCallTime = 0;

    async function apiThrottle() {
        const now = Date.now();
        const elapsed = now - lastApiCallTime;
        if (elapsed < API_MIN_INTERVAL_MS) {
            await sleepWithStop(API_MIN_INTERVAL_MS - elapsed + Math.floor(Math.random() * 1500));
        }
        lastApiCallTime = Date.now();
    }

    async function biliApiCall(webview, method, url, bodyParams) {
        await apiThrottle();
        if (stopRequested) throw new Error('任务已手动停止');

        const safeMethod = JSON.stringify(method);
        const safeUrl = JSON.stringify(url);
        const safeBody = bodyParams ? JSON.stringify(bodyParams) : 'null';

        const result = await executeInWebview(`(async () => {
            try {
                const method = ${safeMethod};
                const url = ${safeUrl};
                const bodyParams = ${safeBody};

                const opts = { method, credentials: 'include', cache: 'no-store' };
                if (method === 'POST' && bodyParams) {
                    opts.headers = { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' };
                    const form = new URLSearchParams();
                    for (const [k, v] of Object.entries(bodyParams)) {
                        form.set(k, String(v));
                    }
                    opts.body = form.toString();
                }

                const resp = await fetch(url, opts);
                return await resp.json();
            } catch (e) {
                return { code: -999, message: e && e.message ? e.message : 'fetch 异常' };
            }
        })()`, webview);

        if (!result || result.status === 'failed') {
            return { code: -998, message: result && result.message ? result.message : 'executeInWebview 失败' };
        }

        return result;
    }

    async function getCsrfToken(webview) {
        const csrf = await executeInWebview(`(() => {
            try {
                const m = (document.cookie || '').match(/bili_jct=([^;]+)/);
                return m ? m[1].trim() : '';
            } catch { return ''; }
        })()`, webview);
        return (typeof csrf === 'string') ? csrf : '';
    }

    async function getRandomPopularVideos(webview, count = 5) {
        const pn = Math.floor(Math.random() * 5) + 1;
        const json = await biliApiCall(webview, 'GET',
            `https://api.bilibili.com/x/web-interface/popular?ps=20&pn=${pn}`);

        if (!json || json.code !== 0 || !json.data || !json.data.list) return [];

        const list = json.data.list.filter(v => v && v.bvid && v.duration > 30);
        // 洗牌后取前 count 个
        for (let i = list.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [list[i], list[j]] = [list[j], list[i]];
        }
        return list.slice(0, count).map(v => ({
            bvid: v.bvid,
            aid: v.aid || v.id || 0,
            title: (v.title || '').slice(0, 26),
            duration: v.duration || 0
        }));
    }

    // ── 每日观看：真实播放视频 ──

    async function runDailyWatchStep() {
        const webview = getExecutionWebview();

        // 通过 API 获取一个随机热门视频
        const videos = await getRandomPopularVideos(webview, 1);
        if (!videos.length) return { status: 'failed', message: '未能获取热门视频列表' };

        const video = videos[0];
        const videoUrl = `https://www.bilibili.com/video/${video.bvid}`;

        // 导航到视频页面
        await navigateTo(videoUrl, webview);

        // 等待视频实际播放指定时长
        const targetSeconds = DAILY_WATCH_TARGET_SECONDS;
        const maxWaitMs = DAILY_WATCH_MAX_WAIT_MS;
        const startTime = Date.now();
        let reloaded = false;

        while (Date.now() - startTime < maxWaitMs) {
            if (stopRequested) throw new Error('任务已手动停止');

            const currentTime = await executeInWebview(`(() => {
                try {
                    const videoEl = document.querySelector('video');
                    if (videoEl && !videoEl.paused && videoEl.currentTime > 0) {
                        return videoEl.currentTime;
                    }
                    if (videoEl && videoEl.paused) videoEl.play().catch(() => {});
                    return videoEl ? videoEl.currentTime : -1;
                } catch { return -1; }
            })()`, webview);

            if (typeof currentTime === 'number' && currentTime >= targetSeconds) {
                return {
                    status: 'completed',
                    message: `已观看 ${Math.floor(currentTime)} 秒 (${video.title})`
                };
            }

            // 加载 10 秒后仍未播放，刷新页面重试一次
            if (!reloaded && Date.now() - startTime > 10000 && (typeof currentTime !== 'number' || currentTime <= 0)) {
                reloaded = true;
                webview.reload();
                await waitForWebviewLoad(webview);
                await sleepWithStop(2000);
                continue;
            }

            await sleepWithStop(5000);
        }

        return {
            status: 'completed',
            message: `观看超时 (${video.title})`
        };
    }

    // ── 每日分享：API 上报 ──

    async function runDailyShareStep() {
        const webview = getExecutionWebview();
        const csrf = await getCsrfToken(webview);
        if (!csrf) return { status: 'failed', message: '未获取到 csrf token' };

        const videos = await getRandomPopularVideos(webview, 1);
        if (!videos.length) return { status: 'failed', message: '未能获取热门视频' };

        const video = videos[0];
        const json = await biliApiCall(webview, 'POST',
            'https://api.bilibili.com/x/web-interface/share/add', {
                bvid: video.bvid,
                aid: video.aid,
                csrf: csrf,
                csrf_token: csrf
            });

        if (!json) return { status: 'failed', message: '分享 API 请求失败' };
        if (json.code === 0) return { status: 'completed', message: `已分享 (${video.title})` };
        if (json.code === 71000) return { status: 'completed', message: '今日已分享过' };

        return { status: 'failed', message: `分享失败: ${json.message || json.code}` };
    }

    // ── 每日投币：API 投币 ──

    async function runDailyCoinStep(config) {
        const webview = getExecutionWebview();
        const csrf = await getCsrfToken(webview);
        if (!csrf) return { status: 'failed', message: '未获取到 csrf token' };

        if (config.coinTarget <= 0) {
            return { status: 'skipped', message: '目标投币数为 0，已跳过' };
        }

        // 先查今日已投币数
        await apiThrottle();
        const todayExp = await biliApiCall(webview, 'GET',
            'https://api.bilibili.com/x/web-interface/coin/today/exp');
        const alreadyCoined = (todayExp && todayExp.code === 0 && typeof todayExp.data === 'number')
            ? Math.floor(todayExp.data / 10) : 0;

        const remaining = Math.max(0, config.coinTarget - alreadyCoined);
        if (remaining <= 0) {
            return { status: 'completed', message: `今日已投 ${alreadyCoined} 枚硬币，无需再投` };
        }

        let successCount = 0;
        const videos = await getRandomPopularVideos(webview, remaining + 2);

        for (let i = 0; i < videos.length && successCount < remaining; i++) {
            if (stopRequested) throw new Error('任务已手动停止');

            const v = videos[i];
            const coinCount = Math.min(remaining - successCount, Math.floor(Math.random() * 2) + 1);

            const json = await biliApiCall(webview, 'POST',
                'https://api.bilibili.com/x/web-interface/coin/add', {
                    bvid: v.bvid,
                    aid: v.aid,
                    multiply: coinCount,
                    select_like: 1,
                    csrf: csrf,
                    csrf_token: csrf
                });

            if (json && json.code === 0) {
                successCount += coinCount;
                // 更新步骤进度显示
                const nameEl = Array.from(document.querySelectorAll('.step-name')).find(el => el.textContent.includes('投币'));
                const statusEl = nameEl && nameEl.parentElement && nameEl.parentElement.querySelector('.step-status');
                if (statusEl) statusEl.innerText = `执行中... 已投 ${alreadyCoined + successCount}/${config.coinTarget} 枚`;
            }
            // code 34005 = 超过投币上限, -104 = 硬币不足
            if (json && (json.code === 34005 || json.code === -104)) break;

            // 投币间隔随机 5-8 秒
            if (i < videos.length - 1 && successCount < remaining) {
                await sleepWithStop(5000 + Math.floor(Math.random() * 3000));
            }
        }

        await fetchCoinBalance(webview);

        if (successCount === 0 && alreadyCoined === 0) {
            return { status: 'skipped', message: '投币失败（可能硬币不足）' };
        }

        return {
            status: 'completed',
            message: `投币完成: 本次 ${successCount} 枚，今日累计 ${alreadyCoined + successCount} 枚`
        };
    }

    // ── 大会员签到（领取每日经验）：API ──

    async function runVipSignStep() {
        const webview = getExecutionWebview();
        const csrf = await getCsrfToken(webview);
        if (!csrf) return { status: 'failed', message: '未获取到 csrf token' };

        const json = await biliApiCall(webview, 'POST',
            'https://api.bilibili.com/x/vip/experience/add', {
                csrf: csrf
            });

        if (!json) return { status: 'failed', message: '大会员签到请求失败' };
        if (json.code === 0) return { status: 'completed', message: '大会员签到成功' };
        if (json.code === 69198) return { status: 'completed', message: '今日已签到' };
        if (json.code === -101) return { status: 'skipped', message: '账号未登录' };
        if (json.code === 6034007) return { status: 'skipped', message: '请求频繁，请稍后再试' };

        return { status: 'skipped', message: `签到跳过: ${json.message || json.code}` };
    }

    function readConfig() {
        const targetValue = coinTarget ? coinTarget.value : '0';
        const safeCoinTarget = clampInt(targetValue, 0, 5);

        return {
            followAuthor: Boolean(followAuthor && followAuthor.checked),
            dailyTaskEnabled: Boolean(dailyTaskEnabled && dailyTaskEnabled.checked),
            vipSignEnabled: Boolean(vipSignEnabled && vipSignEnabled.checked),
            coinTarget: safeCoinTarget
        };
    }

    function buildSteps(config) {
        const steps = [
            {
                id: 'ensure_follow_author',
                name: `关注检查: UID${AUTHOR_UID}`,
                run: runEnsureFollowAuthorStep
            }
        ];

        if (config.dailyTaskEnabled) {
            steps.push(
                {
                    id: 'daily_watch',
                    name: '每日任务: 观看视频',
                    run: runDailyWatchStep,
                    timeoutMs: STEP_WATCH_TIMEOUT_MS  // 心跳上报需要真实等待
                },
                { id: 'daily_share', name: '每日任务: 分享视频', run: runDailyShareStep },
                {
                    id: 'daily_coin',
                    name: `每日任务: 智能投币 (${config.coinTarget}/5)`,
                    run: () => runDailyCoinStep(config)
                }
            );
        }

        if (config.vipSignEnabled) {
            steps.push({ id: 'vip_sign', name: '大会员任务: 每日签到', run: runVipSignStep });
        }

        return steps;
    }

    async function runAutomation() {
        const config = readConfig();
        const steps = buildSteps(config);
        if (steps.length === 0) return;

        stopRequested = false;
        automationTabId = activeTabId;

        setRunState('running');
        togglePanels(false);
        renderProgressSteps(steps);
        updateProgressBar(0, steps.length);

        let processed = 0;
        let failed = false;
        let paused = false;

        for (let i = 0; i < steps.length; i += 1) {
            const step = steps[i];

            if (stopRequested) {
                setStepState(i, 'skipped', '已手动停止');
                processed += 1;
                updateProgressBar(processed, steps.length);
                continue;
            }

            setStepState(i, 'active', '执行中...');

            try {
                const result = await runStepWithTimeout(step);

                if (result && result.status === 'paused') {
                    paused = true;
                    setStepState(i, 'paused', result.message || '检测到任务卡住，已暂停');
                    processed += 1;
                    updateProgressBar(processed, steps.length);
                    break;
                }

                if (result && result.status === 'failed') {
                    setStepState(i, 'failed', result.message || '执行失败');
                    failed = true;
                    processed += 1;
                    updateProgressBar(processed, steps.length);
                    break;
                }

                if (result && result.status === 'skipped') {
                    setStepState(i, 'skipped', result.message || '已跳过');
                } else {
                    setStepState(i, 'completed', result && result.message ? result.message : '已完成');
                }
            } catch (error) {
                if (stopRequested) {
                    setStepState(i, 'skipped', '已手动停止');
                } else {
                    const message = error && error.message ? error.message : '执行异常';
                    if (isLikelyStuckMessage(message)) {
                        paused = true;
                        stopRequested = true;
                        setStepState(i, 'paused', `检测到任务卡住，已暂停: ${message}`);
                    } else {
                        failed = true;
                        setStepState(i, 'failed', message);
                    }
                }
            }

            processed += 1;
            updateProgressBar(processed, steps.length);

            if (failed || paused) break;
        }

        automationTabId = '';

        if (paused) {
            setRunState('paused');
            return;
        }

        if (stopRequested) {
            togglePanels(true);
            setRunState('idle');
            return;
        }

        setRunState('done');

        // 任务完成后刷新页面
        const webview = getActiveWebview();
        if (webview) {
            webview.loadURL(ACCOUNT_HOME_URL);
        }
    }

    function bindTabEvents() {
        tabBar.addEventListener('click', (event) => {
            const closeBtnNode = event.target.closest('[data-close-tab]');
            const tabNode = event.target.closest('.tab-item');

            if (closeBtnNode && tabNode) {
                event.preventDefault();
                event.stopPropagation();
                closeTab(tabNode.getAttribute('data-tab-id'));
                return;
            }

            if (tabNode) {
                switchToTab(tabNode.getAttribute('data-tab-id'));
            }
        });

        if (newTabBtn) {
            newTabBtn.addEventListener('click', () => {
                createTab(HOME_URL, { activate: true });
            });
        }
    }

    function bindBasicEvents() {
        // 提示信息区域的超链接点击 → 在 webview 中打开
        document.querySelectorAll('.notice-link[data-external]').forEach((link) => {
            link.addEventListener('click', (e) => {
                e.preventDefault();
                const url = link.getAttribute('href');
                if (url) {
                    const active = getActiveWebview();
                    if (active) active.loadURL(url);
                }
            });
        });

        if (refreshBtn) {
            refreshBtn.addEventListener('click', () => {
                const active = getActiveWebview();
                if (active) active.reload();
            });
        }

        if (loginBtn) {
            loginBtn.addEventListener('click', async () => {
                if (runState === 'running') return;
                const active = getActiveWebview();
                if (!active) return;

                if (userEligibility.loggedIn) {
                    // 退出登录：通过主进程清除 cookies
                    if (window.electronAPI && window.electronAPI.logout) {
                        await window.electronAPI.logout();
                    }
                    active.loadURL(HOME_URL);
                    setTimeout(() => refreshUserStatus(active), 1500);
                } else {
                    active.loadURL(LOGIN_URL);
                    setTimeout(() => refreshUserStatus(active), 1200);
                }
            });
        }

        if (coinTarget && coinTargetVal) {
            coinTarget.addEventListener('input', (event) => {
                const value = clampInt(event.target.value, 0, 5);
                coinTargetVal.innerText = String(value);
                desiredConfig.coinTarget = value;
                persistCurrentConfig();
            });
        }

        if (followAuthor) {
            followAuthor.addEventListener('change', () => {
                updateStartButtonAvailability();
                desiredConfig.followAuthor = Boolean(followAuthor.checked);
                persistCurrentConfig();
            });
        }

        [dailyTaskEnabled, vipSignEnabled].forEach((node) => {
            if (!node) return;
            node.addEventListener('change', () => {
                if (node === dailyTaskEnabled) desiredConfig.dailyTaskEnabled = Boolean(dailyTaskEnabled.checked);
                if (node === vipSignEnabled) desiredConfig.vipSignEnabled = Boolean(vipSignEnabled.checked);
                persistCurrentConfig();
            });
        });

        startBtn.addEventListener('click', async () => {
            if (runState === 'running') {
                stopRequested = true;
                startBtn.disabled = true;
                startBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 正在停止...';
                return;
            }

            if (runState === 'done' || runState === 'paused') {
                stopRequested = false;
                togglePanels(true);
                setRunState('idle');
                return;
            }

            if (!followAuthor || !followAuthor.checked) {
                startBtn.disabled = true;
                return;
            }

            const loggedIn = await ensureLoggedInBeforeStart();
            if (!loggedIn) {
                startBtn.innerHTML = '<i class="fas fa-sign-in-alt"></i> 请先登录后再开始';
                window.setTimeout(() => {
                    if (runState === 'idle') {
                        startBtn.innerHTML = '<i class="fas fa-play"></i> 一键开始自动化';
                        updateStartButtonAvailability();
                    }
                }, 1600);
                return;
            }

            await runAutomation();
        });

        const closeBtn = document.querySelector('.close-btn');
        if (closeBtn) {
            closeBtn.addEventListener('click', () => {
                window.electronAPI.quitApp();
            });
        }

        if (!loginSyncTimer) {
            loginSyncTimer = window.setInterval(() => {
                if (runState === 'running') return;
                refreshUserStatus();
            }, 4000);
        }

        window.addEventListener('beforeunload', () => {
            if (loginSyncTimer) {
                clearInterval(loginSyncTimer);
                loginSyncTimer = null;
            }
        });
    }

    function bootstrapInitialTab() {
        const initialTab = getTabButtonById('tab-1');
        const initialWebview = document.getElementById('biliWebview');
        if (!initialTab || !initialWebview) {
            createTab(HOME_URL, { activate: true });
            return;
        }

        initialWebview.setAttribute('data-tab-id', 'tab-1');
        initialWebview.setAttribute('partition', WEBVIEW_PARTITION);
        initialWebview.setAttribute('preload', WEBVIEW_PRELOAD_URL);
        initialWebview.setAttribute('useragent', WEBVIEW_USER_AGENT);
        attachWebviewEvents(initialWebview, 'tab-1');
        switchToTab('tab-1');
    }

    loadPersistedConfig();
    bindTabEvents();
    bindBasicEvents();
    bootstrapInitialTab();
    refreshUserStatus();

    togglePanels(true);
    setRunState('idle');
    persistCurrentConfig();
    updateAddressBar();
});
