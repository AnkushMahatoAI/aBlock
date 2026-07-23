/*******************************************************************************
 *
 *  aBlock Origin — YouTube Zero-Tolerance Ad Blocker  v5
 *  Runs in MAIN world at document_start — no race condition possible.
 *
 *  Strategy (layered — each layer catches what the previous missed):
 *
 *  Layer 1: API response pruning  ← PRIMARY DEFENSE — stops ads before they load
 *    - Patch window.fetch → strip adPlacements/playerAds/adSlots from /player
 *    - Patch window.XMLHttpRequest → same for XHR
 *    - Trap ytInitialPlayerResponse → prune before YouTube's player reads it
 *
 *  Layer 2: Player API skip  ← catches anything that slips through Layer 1
 *    - Call player.skipAd() — YouTube's own internal skip method
 *    - Click the skip button if visible
 *    - NO video.playbackRate or video.currentTime manipulation (that broke things)
 *
 *  Layer 3: DOM cleanup  ← belt-and-suspenders
 *    - MutationObserver + interval → auto-click skip buttons, hide ad elements
 *    - YouTube SPA navigation events → re-apply on each page change
 *
 *******************************************************************************/

(function youtubeZeroAds() {
    'use strict';

    // ── Guard: only run on YouTube ──────────────────────────────────────────
    const host = location.hostname;
    if (!host.includes('youtube.com') && !host.includes('youtubekids.com') &&
        !host.includes('youtube-nocookie.com')) return;

    // ── Ad data properties to prune from API JSON responses ────────────────
    const AD_PROPS = [
        'adPlacements',
        'playerAds',
        'adSlots',
        'adBreakHeartbeatParams',
        'adSlotAndLayoutMetadataList',
        'fulfillmentAds',
        'adBreaks',
        'adBreakLengthSeconds',
        'auxiliaryUi',
        'companionAdSlots',
        'adComments',
        'adMessages',
        'adNotices',
        'adBreakServiceResponse',
        'paidContentOverlay',
    ];

    // ── URL patterns whose responses carry ad placement data ───────────────
    const PLAYER_URL_RE = /\/(youtubei\/v1\/player|youtubei\/v1\/get_watch|watch[\?#]|playlist[\?#]|next[\?#]|reel_watch_sequence|browse[\?#])/;

    // ── Deep-prune ad props from an object ─────────────────────────────────
    function pruneAds(obj) {
        if (!obj || typeof obj !== 'object') return obj;
        for (const prop of AD_PROPS) {
            if (prop in obj) {
                try { delete obj[prop]; } catch (_) { obj[prop] = undefined; }
            }
        }
        // Prune nested playerResponse (used in some embed / next responses)
        if (obj.playerResponse) pruneAds(obj.playerResponse);
        // Prune nested contents arrays (browse response)
        if (Array.isArray(obj.contents)) obj.contents = obj.contents.filter(
            item => !item || (!item.adSlotRenderer && !item.adPlacementRenderer)
        );
        return obj;
    }

    // ── Parse, prune, and re-serialize a JSON string ───────────────────────
    function pruneJSON(text) {
        try {
            return JSON.stringify(pruneAds(JSON.parse(text)));
        } catch (_) {
            return text;
        }
    }

    // ==========================================================================
    // LAYER 1A — Patch window.fetch
    // ==========================================================================
    const _fetch = window.fetch;
    window.fetch = function patchedFetch(input, init) {
        const url = typeof input === 'string'   ? input
                  : input instanceof URL        ? input.href
                  : input instanceof Request    ? input.url
                  : '';

        const promise = Reflect.apply(_fetch, this, arguments);
        if (!PLAYER_URL_RE.test(url)) return promise;

        return promise.then(response => {
            return response.clone().text()
                .then(text => new Response(pruneJSON(text), {
                    status:     response.status,
                    statusText: response.statusText,
                    headers:    response.headers,
                }))
                .catch(() => response);
        }).catch(() => promise);
    };

    // ==========================================================================
    // LAYER 1B — Patch XMLHttpRequest
    // ==========================================================================
    const _XHROpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
        this.__ytUrl = typeof url === 'string' ? url : '';
        return Reflect.apply(_XHROpen, this, [method, url, ...rest]);
    };

    const _XHRResponseGetter     = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, 'response').get;
    const _XHRResponseTextGetter = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, 'responseText').get;

    Object.defineProperty(XMLHttpRequest.prototype, 'response', {
        get() {
            const r = Reflect.apply(_XHRResponseGetter, this, []);
            if (!PLAYER_URL_RE.test(this.__ytUrl)) return r;
            if (typeof r === 'string') return pruneJSON(r);
            if (r && typeof r === 'object') return pruneAds(r);
            return r;
        },
        configurable: true,
    });

    Object.defineProperty(XMLHttpRequest.prototype, 'responseText', {
        get() {
            try {
                const r = Reflect.apply(_XHRResponseTextGetter, this, []);
                if (!PLAYER_URL_RE.test(this.__ytUrl)) return r;
                return pruneJSON(r);
            } catch (_) {
                return Reflect.apply(_XHRResponseTextGetter, this, []);
            }
        },
        configurable: true,
    });

    // ==========================================================================
    // LAYER 1C — Trap ytInitialPlayerResponse (inline <script> JSON on page)
    // ==========================================================================
    let _ytpr;
    Object.defineProperty(window, 'ytInitialPlayerResponse', {
        get() { return _ytpr; },
        set(v) { _ytpr = pruneAds(v); },
        configurable: true,
    });

    // ==========================================================================
    // LAYER 2 — Player API skip
    //
    // Uses YouTube's own internal skipAd() method and the skip button.
    // NEVER touches video.playbackRate or video.currentTime — those affect
    // the main video and caused fast-forwarding of real content.
    // ==========================================================================

    function isAdPlaying() {
        // .ad-showing is the ONLY class YouTube adds exclusively during ads.
        // All other ad-related classes are present in the DOM even during
        // normal playback (just hidden via CSS), so ONLY check this one.
        const player = document.querySelector('.html5-video-player');
        return player ? player.classList.contains('ad-showing') : false;
    }

    function clickSkipButton() {
        const btn = document.querySelector([
            '.ytp-skip-ad-button',
            '.ytp-ad-skip-button',
            '.ytp-ad-skip-button-modern',
            '.ytp-ad-skip-button-slot button',
            '[class*="skip-ad-button"]',
            'button[class*="SkipAdButton"]',
        ].join(','));
        if (btn) { btn.click(); return true; }
        return false;
    }

    function skipViaPlayerAPI() {
        // YouTube exposes skipAd() on the #movie_player element
        const player = document.querySelector('#movie_player');
        if (!player) return false;
        if (typeof player.skipAd === 'function') {
            try { player.skipAd(); return true; } catch (_) {}
        }
        // Some versions expose it under the internal player API
        if (typeof player.getInternalApiInterface === 'function') {
            try {
                const iface = player.getInternalApiInterface();
                if (iface && typeof iface.skipAd === 'function') {
                    iface.skipAd();
                    return true;
                }
            } catch (_) {}
        }
        return false;
    }

    // Main entry point: try every method to dismiss the ad, never touch video speed
    function dismissAd() {
        if (!isAdPlaying()) return;
        // 1. Skip button (skippable ads)
        if (clickSkipButton()) return;
        // 2. YouTube's own skipAd() API
        if (skipViaPlayerAPI()) return;
        // 3. Last resort: click skip button again in case it appeared after skipAd()
        setTimeout(() => {
            if (isAdPlaying()) clickSkipButton();
        }, 300);
    }

    // ==========================================================================
    // LAYER 3A — DOM cleanup: hide all ad-related elements
    // ==========================================================================
    const AD_SELECTORS = [
        '.video-ads',
        '.ytp-ad-module',
        '.ytp-ad-overlay-container',
        '.ytp-ad-skip-button-container',
        '.ytp-ad-text-overlay',
        '.ytp-ad-player-overlay',
        '.ytp-ad-player-overlay-instream-info',
        '.ytp-ad-preview-container',
        '.ytp-ad-progress-list',
        '.ytp-ad-persistent-progress-bar-container',
        '.ytp-ad-image-overlay',
        '.ytp-ad-feedback-dialog-container',
        'ytd-enforcement-message-view-model',
        'ytd-ad-slot-renderer',
        'ytd-in-feed-ad-layout-renderer',
        'ytd-promoted-sparkles-web-renderer',
        'ytd-display-ad-renderer',
        'ytd-banner-promo-renderer',
        'ytd-statement-banner-renderer',
        'ytd-primetime-promo-renderer',
        '#masthead-ad',
        '#player-ads',
    ].join(',');

    function hideAdElements() {
        document.querySelectorAll(AD_SELECTORS).forEach(el => {
            if (el.style.display !== 'none') el.style.cssText = 'display:none!important';
        });
        // Hide rich-item wrappers containing ad slots
        document.querySelectorAll('ytd-rich-item-renderer').forEach(item => {
            if (item.querySelector('ytd-ad-slot-renderer, ytd-in-feed-ad-layout-renderer')) {
                item.style.cssText = 'display:none!important';
            }
        });
    }

    // ==========================================================================
    // LAYER 3B — MutationObserver: react to every DOM change
    // ==========================================================================
    function onMutation() {
        dismissAd();
        hideAdElements();
    }

    const observer = new MutationObserver(onMutation);
    observer.observe(document.documentElement, { childList: true, subtree: true });

    // ==========================================================================
    // LAYER 3C — Polling interval
    //
    // MutationObserver fires for DOM changes but YouTube sometimes starts ads
    // inside the existing video element with no new DOM nodes added.
    // ==========================================================================
    let _pollInterval = setInterval(() => {
        if (isAdPlaying()) dismissAd();
        hideAdElements();
    }, 200);

    // Slow down after 60s — page is fully loaded by then
    setTimeout(() => {
        clearInterval(_pollInterval);
        _pollInterval = setInterval(() => {
            if (isAdPlaying()) dismissAd();
            hideAdElements();
        }, 500);
    }, 60000);

    // ==========================================================================
    // LAYER 3D — YouTube SPA navigation events
    //
    // YouTube is a Single Page Application. Navigation fires custom events
    // instead of a full page reload.
    // ==========================================================================
    function onYouTubeNavigation() {
        setTimeout(() => dismissAd(), 300);
        setTimeout(() => dismissAd(), 800);
        setTimeout(() => dismissAd(), 1500);
        setTimeout(() => hideAdElements(), 500);
    }

    document.addEventListener('yt-navigate-finish', onYouTubeNavigation);
    document.addEventListener('yt-page-data-updated', onYouTubeNavigation);

    // ==========================================================================
    // LAYER 1D — Block anti-adblock popup config
    // ==========================================================================
    try {
        const _ytcfgSet = window.ytcfg && window.ytcfg.set;
        if (_ytcfgSet) {
            window.ytcfg.set = function(key, value) {
                if (key === 'openPopupConfig' && value && value.supportedPopups) {
                    delete value.supportedPopups.adBlockMessageViewModel;
                }
                return Reflect.apply(_ytcfgSet, this, arguments);
            };
        }
    } catch (_) {}

})();
