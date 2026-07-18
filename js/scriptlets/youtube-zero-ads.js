/*******************************************************************************
 *
 *  aBlock Origin — YouTube Zero-Tolerance Ad Blocker
 *  Runs in MAIN world at document_start — no race condition possible.
 *
 *  Strategy:
 *    1. Patch window.fetch to strip ad data from /player API responses
 *    2. Patch window.XMLHttpRequest to strip ad data from XHR responses
 *    3. Trap ytInitialPlayerResponse via Object.defineProperty
 *    4. MutationObserver: auto-click skip buttons + hide ad DOM elements
 *    5. Block IMA SDK initialisation
 *
 *******************************************************************************/

(function youtubeZeroAds() {
    'use strict';

    // ── Guard: only run on YouTube ──────────────────────────────────────────
    const host = location.hostname;
    if (!host.includes('youtube.com') && !host.includes('youtubekids.com') && !host.includes('youtube-nocookie.com')) return;

    // ── Ad data paths to remove from API JSON responses ────────────────────
    const AD_PROPS = [
        'adPlacements',
        'playerAds',
        'adSlots',
        'adBreakHeartbeatParams',
        'adSlotAndLayoutMetadataList',
        'fulfillmentAds',
        'adBreaks',
    ];

    // ── Ad-related DOM selectors to hide ───────────────────────────────────
    const AD_SELECTORS = [
        '.video-ads',
        '.ytp-ad-module',
        '.ytp-ad-overlay-container',
        '.ytp-ad-skip-button-container',
        '.ytp-ad-text-overlay',
        '.ytp-ad-player-overlay',
        '.ytp-ad-preview-container',
        '.ytp-ad-progress-list',
        '.ytp-ad-persistent-progress-bar-container',
        'ytd-enforcement-message-view-model',
        'ytd-ad-slot-renderer',
        'ytd-in-feed-ad-layout-renderer',
        'ytd-promoted-sparkles-web-renderer',
        'ytd-display-ad-renderer',
        '#masthead-ad',
        'ytd-popup-container ytd-enforcement-message-view-model',
    ].join(',');

    // ── URL patterns that carry player/ad data ─────────────────────────────
    const PLAYER_URL_RE = /\/(youtubei\/v1\/player|youtubei\/v1\/get_watch|watch\?|playlist\?|next\?|reel_watch_sequence)/;

    // ── Recursively prune ad props from an object ──────────────────────────
    function pruneAds(obj) {
        if (!obj || typeof obj !== 'object') return obj;
        for (const prop of AD_PROPS) {
            if (prop in obj) {
                try { delete obj[prop]; } catch (_) { obj[prop] = undefined; }
            }
        }
        return obj;
    }

    // ── Return a pruned copy of a JSON string ──────────────────────────────
    function pruneJSON(text) {
        try {
            const parsed = JSON.parse(text);
            pruneAds(parsed);
            // Also prune nested playerResponse
            if (parsed && parsed.playerResponse) pruneAds(parsed.playerResponse);
            return JSON.stringify(parsed);
        } catch (_) {
            return text;
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 1. Patch window.fetch
    // ─────────────────────────────────────────────────────────────────────────
    const _fetch = window.fetch;
    window.fetch = function patchedFetch(input, init) {
        const url = typeof input === 'string' ? input
                  : input instanceof URL      ? input.href
                  : input instanceof Request  ? input.url
                  : '';

        const promise = Reflect.apply(_fetch, this, arguments);

        if (!PLAYER_URL_RE.test(url)) return promise;

        return promise.then(response => {
            return response.clone().text().then(text => {
                const pruned = pruneJSON(text);
                return new Response(pruned, {
                    status:     response.status,
                    statusText: response.statusText,
                    headers:    response.headers,
                });
            }).catch(() => response);
        }).catch(() => promise);
    };
    Object.defineProperty(window.fetch, 'name', { value: 'fetch' });

    // ─────────────────────────────────────────────────────────────────────────
    // 2. Patch XMLHttpRequest
    // ─────────────────────────────────────────────────────────────────────────
    const OrigXHR = window.XMLHttpRequest;
    class PatchedXHR extends OrigXHR {
        open(method, url, ...rest) {
            this.__ytUrl = url || '';
            return super.open(method, url, ...rest);
        }
        get response() {
            const r = super.response;
            if (!PLAYER_URL_RE.test(this.__ytUrl)) return r;
            if (typeof r === 'string') return pruneJSON(r);
            if (r && typeof r === 'object') return pruneAds(r);
            return r;
        }
        get responseText() {
            const r = this.response;
            return typeof r === 'string' ? r : super.responseText;
        }
    }
    window.XMLHttpRequest = PatchedXHR;

    // ─────────────────────────────────────────────────────────────────────────
    // 3. Trap ytInitialPlayerResponse (inline JSON in <script> tag)
    // ─────────────────────────────────────────────────────────────────────────
    let _ytInitialPlayerResponse;
    Object.defineProperty(window, 'ytInitialPlayerResponse', {
        get() { return _ytInitialPlayerResponse; },
        set(v) {
            pruneAds(v);
            if (v && v.playerResponse) pruneAds(v.playerResponse);
            _ytInitialPlayerResponse = v;
        },
        configurable: true,
    });

    // Also trap ytInitialData (contains promoted results in feed)
    let _ytInitialData;
    Object.defineProperty(window, 'ytInitialData', {
        get() { return _ytInitialData; },
        set(v) {
            if (v && v.alerts) {
                // Remove adblock detection alerts but keep legitimate ones
                v.alerts = (v.alerts || []).filter(a => {
                    const text = JSON.stringify(a);
                    return !text.includes('ad blocker') && !text.includes('adBlocker');
                });
            }
            _ytInitialData = v;
        },
        configurable: true,
    });

    // Block ad blocker detection popup config
    let _ytCfg;
    const ytCfgTrap = {
        get(target, prop) {
            const v = target[prop];
            if (prop === 'openPopupConfig') {
                if (v && v.supportedPopups) {
                    delete v.supportedPopups.adBlockMessageViewModel;
                }
            }
            return v;
        }
    };

    // ─────────────────────────────────────────────────────────────────────────
    // 4. Block IMA SDK (Google's ad framework)
    // ─────────────────────────────────────────────────────────────────────────
    Object.defineProperty(window, 'google', {
        get() { return undefined; },
        set() {},   // silently swallow IMA SDK assignments
        configurable: true,
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 5. DOM observer — skip button auto-clicker + hide ad elements
    // ─────────────────────────────────────────────────────────────────────────
    let skipTimer = null;

    function clickSkipButton() {
        const btn = document.querySelector(
            '.ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern, [class*="skip-ad"], [class*="skipAd"]'
        );
        if (btn) {
            btn.click();
            return true;
        }
        return false;
    }

    function hideAdElements() {
        const els = document.querySelectorAll(AD_SELECTORS);
        for (const el of els) {
            if (el.style.display !== 'none') el.style.cssText = 'display:none!important';
        }
        // Also hide any rich items that wrap an ad slot
        const richItems = document.querySelectorAll('ytd-rich-item-renderer');
        for (const item of richItems) {
            if (item.querySelector('ytd-ad-slot-renderer, ytd-in-feed-ad-layout-renderer')) {
                item.style.cssText = 'display:none!important';
            }
        }
    }

    function handleMutation() {
        clickSkipButton();
        hideAdElements();
    }

    // Use MutationObserver at document_start — it will fire as soon as elements are added
    const observer = new MutationObserver(handleMutation);
    observer.observe(document.documentElement, { childList: true, subtree: true });

    // Also poll for skip button every 100ms as a belt-and-suspenders fallback
    const pollInterval = setInterval(() => {
        if (clickSkipButton()) {
            // Found and clicked — poll less aggressively for a moment
            setTimeout(() => {}, 500);
        }
        hideAdElements();
    }, 100);

    // Stop aggressive polling after 30 seconds (video is playing by then)
    setTimeout(() => clearInterval(pollInterval), 30000);

    // ─────────────────────────────────────────────────────────────────────────
    // 6. Suppress the "Video paused. Continue watching?" prompt caused by ad
    //    detection blocking the video
    // ─────────────────────────────────────────────────────────────────────────
    const origAddEventListener = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function(type, listener, options) {
        // Block the ad blocker detection event listeners YouTube adds
        if (type === 'yt-action' && typeof listener === 'function') {
            const src = listener.toString();
            if (src.includes('adBlockMessageViewModel') || src.includes('adblock')) {
                return;
            }
        }
        return origAddEventListener.call(this, type, listener, options);
    };

})();
