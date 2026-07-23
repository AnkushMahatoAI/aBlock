/*******************************************************************************
 *
 *  aBlock Origin — YouTube Zero-Tolerance Ad Blocker  v4
 *  Runs in MAIN world at document_start — no race condition possible.
 *
 *  Strategy (layered — each layer catches what the previous missed):
 *
 *  Layer 1: API response pruning
 *    - Patch window.fetch → strip adPlacements/playerAds/adSlots from /player
 *    - Patch window.XMLHttpRequest → same for XHR
 *    - Trap ytInitialPlayerResponse → prune before YouTube's player reads it
 *
 *  Layer 2: Video-level ad skip (catches anything that slips through Layer 1)
 *    - Patch HTMLMediaElement.play() → detect ad-showing state on play start
 *    - Fast-forward video.currentTime to video.duration when ad is playing
 *    - Handle both skippable and non-skippable ads
 *
 *  Layer 3: DOM cleanup (belt-and-suspenders)
 *    - MutationObserver + interval → auto-click skip buttons, hide ad elements
 *    - YouTube SPA navigation events → re-apply skip on each page change
 *
 *  What was REMOVED from v3 (they caused forced reloads / page breakage):
 *    ✗ window.google = undefined  (broke auth, caused YouTube to reload)
 *    ✗ EventTarget.prototype.addEventListener override (broke SPA navigation)
 *    ✗ ytInitialData.alerts filter (could break legitimate error messages)
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
        'auxiliaryUi',            // used in newer YouTube for ad overlays
    ];

    // ── URL patterns whose responses carry ad placement data ───────────────
    const PLAYER_URL_RE = /\/(youtubei\/v1\/player|youtubei\/v1\/get_watch|watch[\?#]|playlist[\?#]|next[\?#]|reel_watch_sequence|browse[\?#])/;

    // ── Prune ad props in-place from an object ─────────────────────────────
    function pruneAds(obj) {
        if (!obj || typeof obj !== 'object') return obj;
        for (const prop of AD_PROPS) {
            if (prop in obj) {
                try { delete obj[prop]; } catch (_) { obj[prop] = undefined; }
            }
        }
        // Also prune nested playerResponse (used in some embed / next responses)
        if (obj.playerResponse) pruneAds(obj.playerResponse);
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

    const _XHRResponseGetter = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, 'response').get;
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
    // LAYER 2 — Core ad-skip logic: skip button first, fast-forward fallback
    //
    // IMPORTANT: isAdPlaying() MUST use only .html5-video-player.ad-showing.
    // Other ad elements (.ytp-ad-module, .ytp-ad-bar) are ALWAYS present in
    // the DOM even during normal playback (just CSS-hidden), so querying them
    // would incorrectly return true and fast-forward the main video.
    // .html5-video-player.ad-showing is the ONLY class YouTube adds exclusively
    // when an actual ad is playing.
    // ==========================================================================
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
        ].join(','));
        if (btn) { btn.click(); return true; }
        return false;
    }

    // Track which video elements we've already hooked to avoid duplicate listeners.
    // A generation counter lets us "reset" the set on SPA navigation without
    // needing WeakSet.clear() (which doesn't exist).
    let _hookGen = 0;
    const _hookedVideos = new WeakMap(); // video element -> generation it was hooked in

    function speedThroughAd(video) {
        if (!video) return false;
        // If already hooked in the CURRENT generation, don't double-hook
        if (_hookedVideos.get(video) === _hookGen) return false;
        _hookedVideos.set(video, _hookGen);
        const hookedGen = _hookGen; // capture gen at hook time
        try {
            // Save the user's real settings before touching them
            const realRate   = video.playbackRate || 1;
            const realMuted  = video.muted;
            const realVolume = video.volume;

            // Mute + speed up — ad plays at 16×, silently.
            // YouTube's own ad-end logic fires cleanly (no stuck/loading state).
            video.muted        = true;
            video.playbackRate = 16;

            // Restore as soon as the ad is over
            function onTimeUpdate() {
                if (isAdPlaying()) return;  // still in ad
                video.playbackRate = realRate;
                video.muted        = realMuted;
                video.volume       = realVolume;
                video.removeEventListener('timeupdate', onTimeUpdate);
                // Un-mark so a future ad on the same element can be hooked again
                if (_hookedVideos.get(video) === hookedGen) _hookedVideos.delete(video);
            }
            video.addEventListener('timeupdate', onTimeUpdate, { passive: true });

            // Emergency fallback: if still in ad after 2 s, seek to near-end
            // (duration-0.5 avoids the EOF-buffer hang that exact duration caused)
            setTimeout(() => {
                if (!isAdPlaying()) return;
                const dur = video.duration;
                if (dur && isFinite(dur) && dur > 0.6) {
                    video.currentTime = dur - 0.5;
                }
            }, 2000);

            return true;
        } catch (_) {
            _hookedVideos.delete(video);
            return false;
        }
    }

    function skipOrFastForwardAd(video) {
        if (!isAdPlaying()) return;
        if (clickSkipButton()) return;   // skippable ad — click skip button
        // Non-skippable ad — mute + 16× speed through it
        speedThroughAd(video || document.querySelector('.html5-video-player video, video'));
    }

    // ==========================================================================
    // LAYER 3A — MutationObserver: react to every DOM change
    // ==========================================================================
    function hideAdElements() {
        // Hide known ad DOM nodes
        document.querySelectorAll([
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
            '#masthead-ad',
        ].join(',')).forEach(el => {
            if (el.style.display !== 'none') el.style.cssText = 'display:none!important';
        });

        // Hide rich-item wrappers that contain ad slots
        document.querySelectorAll('ytd-rich-item-renderer').forEach(item => {
            if (item.querySelector('ytd-ad-slot-renderer, ytd-in-feed-ad-layout-renderer')) {
                item.style.cssText = 'display:none!important';
            }
        });
    }

    function onMutation() {
        skipOrFastForwardAd(null);
        hideAdElements();
    }

    const observer = new MutationObserver(onMutation);
    observer.observe(document.documentElement, { childList: true, subtree: true });

    // ==========================================================================
    // LAYER 3B — Aggressive polling interval
    //
    // MutationObserver fires for DOM changes but YouTube sometimes plays ads
    // entirely in the existing video element with no new DOM nodes.
    // Polling catches these video-only ads.
    // ==========================================================================
    let _pollInterval = setInterval(() => {
        if (isAdPlaying()) {
            // Ad is playing — be very aggressive
            if (!clickSkipButton()) {
                speedThroughAd(document.querySelector('.html5-video-player video, video'));
            }
        }
        hideAdElements();
    }, 200);   // Check every 200ms — fast enough to skip, not enough to lag the page

    // Slow down polling after 60s (initial load phase is over)
    setTimeout(() => {
        clearInterval(_pollInterval);
        _pollInterval = setInterval(() => {
            if (isAdPlaying()) {
                if (!clickSkipButton()) {
                    speedThroughAd(document.querySelector('.html5-video-player video, video'));
                }
            }
        }, 500);
    }, 60000);

    // ==========================================================================
    // LAYER 3C — YouTube SPA navigation events
    //
    // YouTube is a Single Page Application. When the user navigates between
    // videos, a full page reload does NOT happen — YouTube fires custom events
    // instead. We listen for these to re-apply skip logic after each navigation.
    // ==========================================================================
    function onYouTubeNavigation() {
        // Increment generation counter — this effectively resets the "hooked" set
        // so the new video element on the next page gets the ad-skip hook
        _hookGen++;
        // New video is loading — apply skip logic after a short delay
        // to let YouTube set up the new player
        setTimeout(() => skipOrFastForwardAd(null), 300);
        setTimeout(() => skipOrFastForwardAd(null), 800);
        setTimeout(() => skipOrFastForwardAd(null), 1500);
    }

    // yt-navigate-finish fires when YouTube SPA navigation completes
    document.addEventListener('yt-navigate-finish', onYouTubeNavigation);
    // yt-page-data-updated fires when the page data (including player config) is updated
    document.addEventListener('yt-page-data-updated', onYouTubeNavigation);

    // Also intercept yt.config_ updates to remove ad-related popup config
    // (this is the anti-adblock detection wall config — safe to remove)
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
