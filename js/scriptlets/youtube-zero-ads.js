/*******************************************************************************
 *
 *  aBlock Origin — YouTube Zero-Tolerance Ad Blocker  v6
 *  Runs in MAIN world at document_start — no race condition possible.
 *
 *  Layers (each catches what the previous missed):
 *
 *  Layer 1 — API pruning (PRIMARY — stops ads before the player sees them)
 *    1A  Patch window.fetch  → strip all ad fields from /player, /next, /browse …
 *    1B  Patch XHR           → same
 *    1C  Trap ytInitialPlayerResponse  → prune inline JSON before player reads it
 *    1D  Trap ytInitialData            → prune ad items from home/watch page data
 *    1E  Patch ytcfg.set    → block anti-adblock popup config key
 *
 *  Layer 2 — Player API skip (catches slip-throughs)
 *    - player.skipAd()  (YouTube's own internal method)
 *    - click skip button
 *    - mute video immediately on ad-showing so user never hears an ad
 *
 *  Layer 3 — DOM cleanup + aggressive polling
 *    - MutationObserver fires on every DOM change
 *    - 100 ms polling while ad is active, 500 ms otherwise
 *    - Rapid-fire dismiss on EVERY navigation event (start + finish + data)
 *
 *******************************************************************************/

(function youtubeZeroAds() {
    'use strict';

    // ── Guard: only run on YouTube domains ──────────────────────────────────
    const host = location.hostname;
    if (!host.includes('youtube.com') && !host.includes('youtubekids.com') &&
        !host.includes('youtube-nocookie.com')) return;

    // =========================================================================
    // SHARED: ad property names to delete from every API JSON object
    // =========================================================================
    const AD_PROPS = [
        'adPlacements', 'playerAds', 'adSlots', 'adBreaks',
        'adBreakHeartbeatParams', 'adBreakLengthSeconds',
        'adSlotAndLayoutMetadataList', 'fulfillmentAds',
        'auxiliaryUi', 'companionAdSlots',
        'adComments', 'adMessages', 'adNotices',
        'adBreakServiceResponse', 'paidContentOverlay',
        'showCompanionAds', 'adPreroll', 'adMidroll', 'adPostroll',
        'interstitialAdRenderer', 'linearAdSequenceRenderer',
        'adLayoutLoggingData', 'adRendererLoggingData',
    ];

    // Matches every YouTube internal API URL that may carry ad scheduling data
    const AD_URL_RE = /\/(youtubei\/v1\/(player|next|browse|guide|search|reel_watch_sequence|get_watch)|watch|embed\/|shorts\/)/;

    // ── Recursively prune ad props from a parsed JSON object ─────────────────
    function pruneAds(obj, depth) {
        if (!obj || typeof obj !== 'object') return obj;
        if ((depth || 0) > 6) return obj;   // safety — don't recurse forever
        for (const prop of AD_PROPS) {
            if (prop in obj) {
                try { delete obj[prop]; } catch (_) { obj[prop] = undefined; }
            }
        }
        // Recurse into well-known nesting points
        if (obj.playerResponse)    pruneAds(obj.playerResponse, (depth || 0) + 1);
        if (obj.streamingData)     {} // leave streaming data alone
        if (obj.contents && Array.isArray(obj.contents)) {
            obj.contents = obj.contents.filter(
                item => !item || !(item.adSlotRenderer || item.adPlacementRenderer ||
                                   item.promotedVideoRenderer || item.searchPyvRenderer)
            );
        }
        if (obj.items && Array.isArray(obj.items)) {
            obj.items = obj.items.filter(
                item => !item || !(item.adSlotRenderer || item.adPlacementRenderer)
            );
        }
        return obj;
    }

    function pruneJSON(text) {
        if (!text || text[0] !== '{') return text;
        try { return JSON.stringify(pruneAds(JSON.parse(text))); }
        catch (_) { return text; }
    }

    // =========================================================================
    // LAYER 1A — Patch window.fetch
    // =========================================================================
    const _fetch = window.fetch;
    window.fetch = function patchedFetch(input, init) {
        const url = typeof input === 'string'  ? input
                  : input instanceof URL       ? input.href
                  : input instanceof Request   ? input.url : '';

        const promise = Reflect.apply(_fetch, this, arguments);
        if (!AD_URL_RE.test(url)) return promise;

        return promise.then(resp => {
            return resp.clone().text()
                .then(text => new Response(pruneJSON(text), {
                    status: resp.status, statusText: resp.statusText,
                    headers: resp.headers,
                }))
                .catch(() => resp);
        }).catch(() => promise);
    };

    // =========================================================================
    // LAYER 1B — Patch XMLHttpRequest
    // =========================================================================
    const _XHROpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
        this.__ytUrl = typeof url === 'string' ? url : '';
        return Reflect.apply(_XHROpen, this, [method, url, ...rest]);
    };

    const _respGet = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, 'response').get;
    const _textGet = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, 'responseText').get;

    Object.defineProperty(XMLHttpRequest.prototype, 'response', {
        get() {
            const r = Reflect.apply(_respGet, this, []);
            if (!AD_URL_RE.test(this.__ytUrl)) return r;
            if (typeof r === 'string') return pruneJSON(r);
            if (r && typeof r === 'object') return pruneAds(r);
            return r;
        },
        configurable: true,
    });

    Object.defineProperty(XMLHttpRequest.prototype, 'responseText', {
        get() {
            try {
                const r = Reflect.apply(_textGet, this, []);
                if (!AD_URL_RE.test(this.__ytUrl)) return r;
                return pruneJSON(r);
            } catch (_) { return Reflect.apply(_textGet, this, []); }
        },
        configurable: true,
    });

    // =========================================================================
    // LAYER 1C — Trap ytInitialPlayerResponse (set by inline <script> on page)
    // =========================================================================
    let _ytpr;
    Object.defineProperty(window, 'ytInitialPlayerResponse', {
        get() { return _ytpr; },
        set(v) { _ytpr = pruneAds(v); },
        configurable: true,
    });

    // =========================================================================
    // LAYER 1D — Trap ytInitialData (home + watch page feed data)
    // =========================================================================
    let _ytid;
    Object.defineProperty(window, 'ytInitialData', {
        get() { return _ytid; },
        set(v) { _ytid = pruneAds(v); },
        configurable: true,
    });

    // =========================================================================
    // LAYER 1E — Patch ytcfg.set → remove anti-adblock popup config
    // =========================================================================
    function patchYtcfg() {
        try {
            const cfg = window.ytcfg;
            if (!cfg || !cfg.set || cfg.__aBlockPatched) return;
            const _orig = cfg.set.bind(cfg);
            cfg.set = function(key, value) {
                // Remove the "you're using an ad blocker" popup trigger
                if (key === 'openPopupConfig' && value && value.supportedPopups) {
                    delete value.supportedPopups.adBlockMessageViewModel;
                }
                // Remove ad-related config keys passed as an object
                if (key && typeof key === 'object') {
                    for (const prop of AD_PROPS) delete key[prop];
                }
                return _orig(key, value);
            };
            cfg.__aBlockPatched = true;
        } catch (_) {}
    }
    patchYtcfg();
    // Also try after DOM is ready in case ytcfg loads late
    document.addEventListener('DOMContentLoaded', patchYtcfg, { once: true });

    // =========================================================================
    // LAYER 2 — Player API skip
    //
    // NEVER sets video.playbackRate or video.currentTime — that caused the
    // main video to be fast-forwarded.  Only uses YouTube's own APIs.
    // =========================================================================

    function isAdPlaying() {
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
            '.ytp-ad-skip-button-container button',
        ].join(','));
        if (btn) { btn.click(); return true; }
        return false;
    }

    function skipViaPlayerAPI() {
        const player = document.querySelector('#movie_player');
        if (!player) return false;
        // Primary: direct skipAd()
        if (typeof player.skipAd === 'function') {
            try { player.skipAd(); return true; } catch (_) {}
        }
        // Alternate: internal API interface
        if (typeof player.getInternalApiInterface === 'function') {
            try {
                const api = player.getInternalApiInterface();
                if (api && typeof api.skipAd === 'function') {
                    api.skipAd(); return true;
                }
            } catch (_) {}
        }
        return false;
    }

    // Mute video the instant an ad starts so user never hears it
    let _mutedForAd = false;
    let _realVolume = null;
    let _realMuted  = null;

    function muteForAd() {
        if (_mutedForAd) return;
        const video = document.querySelector('.html5-video-player video');
        if (!video) return;
        _realVolume = video.volume;
        _realMuted  = video.muted;
        video.muted = true;
        _mutedForAd = true;
    }

    function unmuteAfterAd() {
        if (!_mutedForAd) return;
        const video = document.querySelector('.html5-video-player video');
        if (!video) return;
        if (_realMuted  !== null) video.muted  = _realMuted;
        if (_realVolume !== null) video.volume = _realVolume;
        _mutedForAd = false;
        _realVolume = null;
        _realMuted  = null;
    }

    function dismissAd() {
        if (!isAdPlaying()) {
            // Ad just ended — restore volume
            if (_mutedForAd) unmuteAfterAd();
            return;
        }
        // Mute immediately so user doesn't hear even a fraction of the ad
        muteForAd();
        // Try to skip it
        if (clickSkipButton()) return;
        skipViaPlayerAPI();
        // Try skip button again shortly (skip button may appear after skipAd())
        setTimeout(() => { if (isAdPlaying()) clickSkipButton(); }, 300);
        setTimeout(() => { if (isAdPlaying()) { clickSkipButton(); skipViaPlayerAPI(); } }, 700);
    }

    // =========================================================================
    // LAYER 3A — DOM: hide every ad element
    // =========================================================================
    const AD_SELECTORS = [
        '.video-ads', '.ytp-ad-module',
        '.ytp-ad-overlay-container', '.ytp-ad-skip-button-container',
        '.ytp-ad-text-overlay', '.ytp-ad-player-overlay',
        '.ytp-ad-player-overlay-instream-info', '.ytp-ad-preview-container',
        '.ytp-ad-progress-list', '.ytp-ad-persistent-progress-bar-container',
        '.ytp-ad-image-overlay', '.ytp-ad-feedback-dialog-container',
        '.ytp-ad-action-interstitial', '.ytp-ad-action-interstitial-background',
        'ytd-enforcement-message-view-model',
        'ytd-ad-slot-renderer', 'ytd-in-feed-ad-layout-renderer',
        'ytd-promoted-sparkles-web-renderer', 'ytd-display-ad-renderer',
        'ytd-banner-promo-renderer', 'ytd-statement-banner-renderer',
        'ytd-primetime-promo-renderer', 'ytd-compact-promoted-video-renderer',
        'ytd-promoted-video-renderer', 'ytd-search-pyv-renderer',
        '#masthead-ad', '#player-ads',
        'tp-yt-paper-dialog.ytd-enforcement-message-view-model',
    ].join(',');

    function hideAdElements() {
        document.querySelectorAll(AD_SELECTORS).forEach(el => {
            if (el.style.display !== 'none') el.style.cssText = 'display:none!important';
        });
        document.querySelectorAll('ytd-rich-item-renderer, ytd-shelf-renderer').forEach(item => {
            if (item.querySelector(
                'ytd-ad-slot-renderer,ytd-in-feed-ad-layout-renderer,' +
                'ytd-promoted-video-renderer,ytd-search-pyv-renderer'
            )) item.style.cssText = 'display:none!important';
        });
    }

    // =========================================================================
    // LAYER 3B — MutationObserver
    // =========================================================================
    const _observer = new MutationObserver(() => { dismissAd(); hideAdElements(); });
    _observer.observe(document.documentElement, { childList: true, subtree: true });

    // =========================================================================
    // LAYER 3C — Adaptive polling
    //
    // Runs every 100 ms while an ad is active (very aggressive), drops to
    // 500 ms once the page is settled.  This catches ads that play inside the
    // existing video element without any DOM mutation.
    // =========================================================================
    let _fastPoll = null;
    let _slowPoll = null;

    function startFastPoll() {
        if (_fastPoll) return;
        _fastPoll = setInterval(() => {
            dismissAd();
            hideAdElements();
            if (!isAdPlaying()) {
                clearInterval(_fastPoll);
                _fastPoll = null;
            }
        }, 100);
    }

    _slowPoll = setInterval(() => {
        hideAdElements();
        if (isAdPlaying()) {
            dismissAd();
            startFastPoll();   // kick into high gear while ad is active
        }
    }, 500);

    // =========================================================================
    // LAYER 3D — Navigation events
    //
    // YouTube SPA: yt-navigate-start fires BEFORE the new page data loads,
    // giving us the earliest possible hook.
    // =========================================================================
    function onNavigation() {
        // Rapid-fire dismiss attempts covering the full load window (0–3 s)
        for (const delay of [0, 100, 250, 500, 800, 1200, 2000, 3000]) {
            setTimeout(() => { dismissAd(); hideAdElements(); }, delay);
        }
        startFastPoll();
    }

    document.addEventListener('yt-navigate-start',        onNavigation);
    document.addEventListener('yt-navigate-finish',       onNavigation);
    document.addEventListener('yt-page-data-updated',     onNavigation);
    document.addEventListener('yt-player-updated',        onNavigation);

})();
