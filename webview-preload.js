let ipcRenderer = null;
try {
    ({ ipcRenderer } = require('electron'));
} catch {
    ipcRenderer = null;
}

(() => {
    const toAbsoluteUrl = (rawUrl) => {
        if (!rawUrl || typeof rawUrl !== 'string') return '';

        const trimmed = rawUrl.trim();
        if (!trimmed || trimmed.startsWith('javascript:')) return '';

        try {
            return new URL(trimmed, window.location.href).toString();
        } catch {
            return '';
        }
    };

    const openInHostOrFallback = (rawUrl, allowSameTabFallback = true) => {
        const nextUrl = toAbsoluteUrl(rawUrl);
        if (!nextUrl) {
            return false;
        }

        if (ipcRenderer && typeof ipcRenderer.sendToHost === 'function') {
            ipcRenderer.sendToHost('open-new-tab', { url: nextUrl });
            return true;
        }

        if (allowSameTabFallback) {
            // If host IPC is unavailable, avoid silent popup drops by navigating current tab.
            window.location.assign(nextUrl);
            return true;
        }

        return false;
    };

    const createWindowProxy = () => {
        let isClosed = false;

        const forward = (rawUrl) => openInHostOrFallback(rawUrl, true);

        const locationProxy = {
            assign: (url) => {
                forward(url);
            },
            replace: (url) => {
                forward(url);
            },
            reload: () => {
                window.location.reload();
            },
            toString: () => window.location.href
        };

        Object.defineProperty(locationProxy, 'href', {
            get() {
                return window.location.href;
            },
            set(value) {
                forward(value);
            }
        });

        const proxy = {
            close: () => {
                isClosed = true;
            },
            focus: () => {},
            blur: () => {},
            postMessage: () => {},
            opener: null,
            get closed() {
                return isClosed;
            }
        };

        Object.defineProperty(proxy, 'location', {
            get() {
                return locationProxy;
            },
            set(value) {
                forward(value);
            }
        });

        return proxy;
    };

    const patchWindowOpen = () => {
        if (window.__biliAssistantWindowOpenPatched__) return;
        window.__biliAssistantWindowOpenPatched__ = true;

        const rawOpen = window.open;
        window.open = function patchedOpen(url, target, features) {
            const urlText = typeof url === 'string' ? url.trim() : '';

            if (openInHostOrFallback(urlText, true)) {
                return createWindowProxy();
            }

            const targetMode = (target || '').toLowerCase();
            const likelyBlankPopup = !urlText || urlText === 'about:blank' || targetMode === '_blank';
            if (likelyBlankPopup) {
                // Many pages call window.open('', '_blank') then assign location later.
                return createWindowProxy();
            }

            return rawOpen ? rawOpen.call(window, url, target, features) : null;
        };
    };

    const normalizeNewTabElements = () => {
        document.querySelectorAll('a[target="_blank"]').forEach((anchor) => {
            anchor.setAttribute('rel', 'noopener noreferrer');
        });

        document.querySelectorAll('form[target="_blank"]').forEach((form) => {
            form.setAttribute('rel', 'noopener noreferrer');
        });
    };

    const bindAnchorNewTabHijack = () => {
        if (window.__biliAssistantAnchorHijackBound__) return;
        window.__biliAssistantAnchorHijackBound__ = true;

        const handler = (event) => {
            const target = event.target;
            if (!target || !target.closest) return;

            const anchor = target.closest('a[href]');
            if (!anchor) return;

            const href = anchor.getAttribute('href') || anchor.href || '';
            const targetMode = (anchor.getAttribute('target') || '').toLowerCase();
            const openInTab =
                targetMode === '_blank' ||
                event.ctrlKey ||
                event.metaKey ||
                event.shiftKey ||
                event.button === 1;

            if (!openInTab) return;

            if (openInHostOrFallback(href, true)) {
                event.preventDefault();
                event.stopPropagation();
            }
        };

        document.addEventListener('click', handler, true);
        document.addEventListener('auxclick', handler, true);
    };

    const bindFormTargetBlankHijack = () => {
        if (window.__biliAssistantFormHijackBound__) return;
        window.__biliAssistantFormHijackBound__ = true;

        document.addEventListener('submit', (event) => {
            const form = event.target;
            if (!form || !form.getAttribute) return;

            const targetMode = (form.getAttribute('target') || '').toLowerCase();
            if (targetMode !== '_blank') return;

            const action = form.getAttribute('action') || window.location.href;
            if (openInHostOrFallback(action, true)) {
                event.preventDefault();
                event.stopPropagation();
            }
        }, true);
    };

    const bindMutationObserver = () => {
        if (window.__biliAssistantMutationObserverBound__) return;
        window.__biliAssistantMutationObserverBound__ = true;

        const observer = new MutationObserver(() => {
            normalizeNewTabElements();
        });

        observer.observe(document.documentElement, {
            childList: true,
            subtree: true
        });
    };

    window.addEventListener('DOMContentLoaded', () => {
        patchWindowOpen();
        normalizeNewTabElements();
        bindAnchorNewTabHijack();
        bindFormTargetBlankHijack();
        bindMutationObserver();
    });
})();
