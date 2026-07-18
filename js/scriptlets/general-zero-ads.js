/*******************************************************************************
 *
 *  aBlock Origin — General Site Zero-Tolerance Ad Blocker
 *  Runs in MAIN world at document_start on ALL sites.
 *
 *  Handles:
 *    1.  Anti-adblock variable nullification (fuckAdBlock, BlockAdBlock, etc.)
 *    2.  adsbygoogle / googletag spoofing (bypass detection)
 *    3.  Bait-element dimension spoofing (prevents height-check detection)
 *    4.  Popup / pop-under blocking via window.open intercept
 *    5.  Location redirect hijacking prevention
 *    6.  Subscription / paywall nag suppression
 *    7.  Cookie consent banner auto-dismiss (decline-first)
 *    8.  Common ad-script function nullification
 *
 *******************************************************************************/

(function aBlockGeneralSites() {
    'use strict';

    // ────────────────────────────────────────────────────────────────────────
    // 1. Nullify anti-adblock detection variables
    //    These globals are checked by scripts like FuckAdBlock, BlockAdBlock, etc.
    // ────────────────────────────────────────────────────────────────────────
    const ADBLOCK_DETECT_VARS = [
        'fuckAdBlock', 'FuckAdBlock', 'BlockAdBlock', 'blockAdBlock',
        'AdBlocker', 'adBlocker', 'adblock', 'AdBlock',
        'abp', 'ABP',
        'adBlockDetected', 'adblockDetected', 'adbDetected',
        'adsBlocked', 'AdBlockEnabled', 'adblockEnabled',
        'canRunAds', 'isAdBlockActive', 'adBlockIsActive',
        'isAdblockActive', 'adblockIsEnabled', 'adBlockOn',
    ];

    for (const varName of ADBLOCK_DETECT_VARS) {
        try {
            Object.defineProperty(window, varName, {
                get() { return undefined; },
                set() {},          // silently absorb writes
                configurable: true,
            });
        } catch (_) {}
    }

    // Common object-based anti-adblock controller
    const noopController = {
        init() {},
        run() {},
        addHook() {},
        check() { return false; },
        onDetected() { return this; },
        onNotDetected() { return this; },
    };
    try {
        Object.defineProperty(window, 'AdController', {
            get() { return noopController; },
            set() {},
            configurable: true,
        });
    } catch (_) {}

    // ────────────────────────────────────────────────────────────────────────
    // 2. Spoof adsbygoogle — many anti-adblock scripts check:
    //      window.adsbygoogle && window.adsbygoogle.loaded === true
    //    By returning a loaded-looking array, we fool the detector while
    //    the actual ad network requests are blocked at the network level.
    // ────────────────────────────────────────────────────────────────────────
    try {
        let _adsbygoogle = [];
        _adsbygoogle.loaded = true;
        _adsbygoogle.push = function() {};   // swallow ad slot registrations
        Object.defineProperty(window, 'adsbygoogle', {
            get() { return _adsbygoogle; },
            set(v) {
                // Keep loaded flag even if site tries to reset it
                if (v && typeof v === 'object') {
                    v.loaded = true;
                    v.push = function() {};
                }
                _adsbygoogle = v;
            },
            configurable: true,
        });
    } catch (_) {}

    // ────────────────────────────────────────────────────────────────────────
    // 3. Spoof Google Publisher Tag (googletag / GPT)
    //    Sites check googletag.pubads().getSlots() or similar to detect
    //    whether ads were blocked. Return a minimal working fake.
    // ────────────────────────────────────────────────────────────────────────
    try {
        const fakeSlot = {
            setTargeting() { return this; },
            addService() { return this; },
            defineSizeMapping() { return this; },
            setCollapseEmptyDiv() { return this; },
            getAdUnitPath() { return ''; },
            getSlotId() { return { getDomId() { return ''; }, getId() { return ''; } }; },
        };

        const fakePubads = {
            enableSingleRequest() {},
            collapseEmptyDivs() {},
            setTargeting() { return this; },
            addEventListener() {},
            removeEventListener() {},
            refresh() {},
            enableLazyLoad() {},
            setPrivacySettings() {},
            getSlots() { return []; },
            setRequestNonPersonalizedAds() {},
            disableInitialLoad() {},
            enableAsyncRendering() {},
            setCookieOptions() {},
            setPublisherProvidedId() {},
            setCentered() {},
        };

        const cmdQueue = [];
        const fakeGoogletag = {
            cmd: new Proxy(cmdQueue, {
                get(target, prop) {
                    if (prop === 'push') {
                        return (fn) => {
                            try { if (typeof fn === 'function') fn(); }
                            catch (_) {}
                        };
                    }
                    return target[prop];
                }
            }),
            defineSlot() { return fakeSlot; },
            defineOutOfPageSlot() { return fakeSlot; },
            pubads() { return fakePubads; },
            companionAds() { return {}; },
            enableServices() {},
            display() {},
            destroySlots() { return true; },
            getVersion() { return ''; },
            openConsole() {},
            setAdIframeTitle() {},
            sizeMapping() { return { addSize() { return this; }, build() { return []; } }; },
        };

        Object.defineProperty(window, 'googletag', {
            get() { return fakeGoogletag; },
            set() {},
            configurable: true,
        });
    } catch (_) {}

    // ────────────────────────────────────────────────────────────────────────
    // 4. Bait-element dimension spoofing
    //    Anti-adblock detectors inject a <div class="adsbox"> etc. and check
    //    if its offsetHeight/clientHeight is 0 (means our CSS collapsed it).
    //    We spoof the element dimensions via getComputedStyle.
    // ────────────────────────────────────────────────────────────────────────
    const BAIT_CLASS_RE = /\b(adsbox|adsbygoogle|ad-banner|ad-container|ad-slot|ad-unit|doubleclick|pub-ads|GoogleActiveViewElement|BannerAd)\b/i;

    const _getComputedStyle = window.getComputedStyle;
    window.getComputedStyle = function(el, pseudo) {
        const style = Reflect.apply(_getComputedStyle, this, [el, pseudo]);
        if (!el || !el.className) return style;
        const cls = typeof el.className === 'string' ? el.className
                  : el.className.baseVal || '';    // SVGAnimatedString guard
        if (!BAIT_CLASS_RE.test(cls) && !BAIT_CLASS_RE.test(el.id || '')) {
            return style;
        }
        // Return a proxy that reports non-zero dimensions for bait elements
        return new Proxy(style, {
            get(target, prop) {
                if (prop === 'display')    return 'block';
                if (prop === 'visibility') return 'visible';
                if (prop === 'opacity')    return '1';
                if (prop === 'height')     return '1px';
                if (prop === 'width')      return '1px';
                if (prop === 'minHeight')  return '1px';
                if (prop === 'maxHeight')  return 'none';
                const v = Reflect.get(target, prop);
                return typeof v === 'function' ? v.bind(target) : v;
            }
        });
    };
    Object.defineProperty(window.getComputedStyle, 'name', { value: 'getComputedStyle' });

    // ────────────────────────────────────────────────────────────────────────
    // 5. Popup / pop-under blocking via window.open
    //    Block window.open calls to known ad network domains.
    //    Also detect pop-unders (cross-origin open without user gesture).
    // ────────────────────────────────────────────────────────────────────────
    const POPUP_AD_HOSTS = new Set([
        'doubleclick.net', 'googlesyndication.com', 'googleadservices.com',
        'adnxs.com', 'advertising.com', 'adroll.com',
        'criteo.com', 'criteo.net', 'taboola.com', 'outbrain.com',
        'rubiconproject.com', 'openx.net', 'amazon-adsystem.com',
        'popads.net', 'popcash.net', 'exoclick.com', 'adsterra.com',
        'propellerads.com', 'adcash.com', 'revcontent.com', 'mgid.com',
        'zedo.com', 'undertone.com', 'smartadserver.com', 'bidswitch.net',
        'spotx.tv', 'spotxchange.com', 'triplelift.com',
        'trafficjunky.net', 'juicyads.com', 'hilltopads.net',
        'clickadu.com', 'a-ads.com', 'popunder.net', 'pop.cash',
        'ero-advertising.com', 'tsyndicate.com', 'adspyglass.com',
        'traffic-media.co', 'monetizer.pro', 'cpmstar.com',
    ]);

    function isAdPopupHost(url) {
        if (!url || url === 'about:blank' || url.startsWith('javascript:')) return false;
        try {
            const hostname = new URL(url, location.href).hostname.replace(/^www\./, '');
            // Exact match or suffix match
            if (POPUP_AD_HOSTS.has(hostname)) return true;
            for (const h of POPUP_AD_HOSTS) {
                if (hostname.endsWith('.' + h)) return true;
            }
        } catch (_) {}
        return false;
    }

    // Track whether a real user gesture occurred in the last 1 second
    let _userGestureTs = 0;
    const GESTURE_EVENTS = ['click', 'keydown', 'mousedown', 'touchstart', 'touchend'];
    for (const evt of GESTURE_EVENTS) {
        document.addEventListener(evt, () => { _userGestureTs = Date.now(); }, true);
    }
    function hasRecentUserGesture() {
        return (Date.now() - _userGestureTs) < 1000;
    }

    const _windowOpen = window.open;
    window.open = function aBlockOpen(url, name, features) {
        if (isAdPopupHost(url)) return null;

        // Block pop-unders: cross-origin window.open without a real user gesture
        if (url && url !== 'about:blank' && !hasRecentUserGesture()) {
            try {
                const target = new URL(url, location.href);
                if (target.hostname !== location.hostname) {
                    // Suspicious pop-under pattern
                    return null;
                }
            } catch (_) {}
        }
        return Reflect.apply(_windowOpen, this, arguments);
    };
    Object.defineProperty(window.open, 'name', { value: 'open' });

    // ────────────────────────────────────────────────────────────────────────
    // 6. Location redirect hijack prevention
    //    Some sites change location.href to an ad URL on click or load.
    // ────────────────────────────────────────────────────────────────────────
    try {
        const locProto = Object.getPrototypeOf(window.location);
        const hrefDesc = Object.getOwnPropertyDescriptor(locProto, 'href');
        if (hrefDesc && hrefDesc.set) {
            const _hrefSet = hrefDesc.set;
            Object.defineProperty(locProto, 'href', {
                get: hrefDesc.get,
                set(url) {
                    if (isAdPopupHost(url) && !hasRecentUserGesture()) return;
                    return Reflect.apply(_hrefSet, this, [url]);
                },
                configurable: true,
            });
        }
    } catch (_) {}

    // ────────────────────────────────────────────────────────────────────────
    // 7. Suppress common ad & tracking function calls
    // ────────────────────────────────────────────────────────────────────────
    // Suppress Amazon Publisher Services
    try { Object.defineProperty(window, 'apstag', { get() { return { init() {}, fetchBids() {}, setDisplayBids() {}, targetingKeys() { return []; } }; }, configurable: true }); } catch (_) {}
    // Suppress Prebid.js
    try { Object.defineProperty(window, 'pbjs', { get() { return { que: { push: () => {} }, requestBids: () => {}, addAdUnits: () => {}, setConfig: () => {} }; }, configurable: true }); } catch (_) {}

    // ────────────────────────────────────────────────────────────────────────
    // 8. Cookie consent banner auto-dismiss (prefer "Decline" over "Accept")
    // ────────────────────────────────────────────────────────────────────────
    const DECLINE_BTNS = [
        // OneTrust
        '#onetrust-reject-all-handler',
        // TrustArc / TrueArc
        '.truste_popframe [title*="Decline" i]',
        // Cookiebot
        '#CybotCookiebotDialogBodyButtonDecline',
        // Quantcast
        '[data-testid="uc-deny-all-button"]',
        // Didomi
        '#didomi-notice-disagree-button',
        // Generic patterns (case-insensitive via attribute selectors)
        '[id*="reject-all" i]', '[class*="reject-all" i]',
        '[id*="decline-all" i]', '[class*="decline-all" i]',
        '[aria-label*="reject all" i]', '[aria-label*="decline all" i]',
        'button[class*="decline" i]', 'button[id*="decline" i]',
        'a[class*="decline" i]', 'a[id*="decline" i]',
        // Common close/dismiss buttons on cookie banners
        '.cookie-close', '.cookie-dismiss', '.cc-dismiss',
        '#cookie-close', '#CookieConsent button.close',
    ].join(',');

    const CLOSE_BTNS = [
        '.modal-close', '[aria-label="close" i]', '[title="close" i]',
        '.newsletter-close', '.popup-close', '.overlay-close',
        '[data-dismiss="modal"]',
    ].join(',');

    function dismissBanners() {
        // 1. Prefer "decline" on cookie banners
        const decline = document.querySelector(DECLINE_BTNS);
        if (decline && decline.offsetParent !== null) {
            decline.click();
            return;
        }
        // 2. Close newsletter / interstitial popups
        const close = document.querySelector(CLOSE_BTNS);
        if (close && close.offsetParent !== null) {
            close.click();
        }
    }

    // Run on DOM mutations for dynamically inserted banners
    const dismissObserver = new MutationObserver(dismissBanners);
    function startDismissObserver() {
        const root = document.body || document.documentElement;
        if (root) {
            dismissObserver.observe(root, { childList: true, subtree: true });
            dismissBanners();
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', startDismissObserver);
    } else {
        startDismissObserver();
    }
    // Stop after 15 seconds — banners are always injected early
    setTimeout(() => dismissObserver.disconnect(), 15000);

    // ────────────────────────────────────────────────────────────────────────
    // 9. Paywall / subscribe-nag scroll unlock
    //    Many news sites lock body overflow when showing a paywall.
    // ────────────────────────────────────────────────────────────────────────
    function unlockScroll() {
        const paywallSelectors = [
            '.paywall', '.paywall-overlay', '#paywall', '.modal-backdrop',
            '[class*="paywall"]', '[id*="paywall"]',
            '[class*="subscribeWall"]', '[class*="subscribe-wall"]',
        ];
        const anyPaywall = paywallSelectors.some(s => document.querySelector(s));
        if (anyPaywall) {
            document.documentElement.style.overflow = '';
            document.body.style.overflow = '';
            document.documentElement.style.setProperty('overflow', 'auto', 'important');
            document.body.style.setProperty('overflow', 'auto', 'important');
        }
    }

    const scrollObserver = new MutationObserver(unlockScroll);
    function startScrollObserver() {
        const root = document.body || document.documentElement;
        if (root) scrollObserver.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', startScrollObserver);
    } else {
        startScrollObserver();
    }
    setTimeout(() => scrollObserver.disconnect(), 20000);

})();
