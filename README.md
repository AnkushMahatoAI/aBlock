# aBlock Origin

> **A Manifest V3 compatible fork of uBlock Origin — fully functional on modern Chrome.**

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](https://www.gnu.org/licenses/gpl-3.0)
[![Manifest Version](https://img.shields.io/badge/Manifest-V3-green.svg)](https://developer.chrome.com/docs/extensions/mv3/intro/)
[![Based On](https://img.shields.io/badge/Based%20on-uBlock%20Origin-red.svg)](https://github.com/gorhill/uBlock)

---

## What is aBlock Origin?

**aBlock Origin** is a fork of [uBlock Origin](https://github.com/gorhill/uBlock) that has been patched to work with Chrome's **Manifest Version 3 (MV3)** service worker architecture. The upstream uBlock Origin codebase targets MV2 (background page model), which Chrome is deprecating. This fork bridges that gap.

This project was created for learning, research, and personal use. It is **not affiliated with, endorsed by, or associated with** the original uBlock Origin project or Raymond Hill.

---

## What Was Changed From uBlock Origin

All changes are MV3 compatibility fixes — **zero functionality was intentionally removed**. Every change has a comment in the source code explaining why it was made.

| File | Change | Reason |
|------|--------|--------|
| `manifest.json` | Removed `webRequestBlocking` permission | Not allowed in MV3 (Chrome restriction) |
| `js/vapi.js` | Guard `instanceof Element` with `typeof` check | `Element` is undefined in SW context |
| `js/vapi-common.js` | Guard `requestAnimationFrame` / `requestIdleCallback` | Not available in service workers |
| `js/vapi-common.js` | Guard `document` access | `document` is undefined in SW context |
| `js/vapi-background.js` | Replace `window.addEventListener` → `self.addEventListener` | `window` is undefined in SW context |
| `js/vapi-background.js` | Replace `window.navigator.platform` → `navigator.platform` | Same reason |
| `js/vapi-background.js` | Remove `['blocking']` from webRequest listeners | MV3 doesn't allow `webRequestBlocking` permission |
| `js/i18n.js` | Guard `instanceof Element` and `document.title` | Both crash in SW context |
| `js/redirect-engine.js` | Replace dynamic `import()` with static import | Dynamic `import()` is disallowed in SW by HTML spec |

> **Does removing `webRequestBlocking` reduce blocking power?**
> No — Chrome **never** grants `webRequestBlocking` to non-force-installed MV3 extensions. The actual blocking in MV3 is done by `declarativeNetRequest`, which remains fully intact. The upstream uBlock Origin MV3 port faces the same restriction.

---

## How to Install (Unpacked Extension)

1. **Clone this repository**
   ```bash
   git clone https://github.com/AnkushMahatoAI/aBlock.git
   ```

2. **Open Chrome** and navigate to `chrome://extensions`

3. **Enable Developer Mode** (toggle in the top-right corner)

4. Click **"Load unpacked"** and select the cloned folder

5. The **aBlock Origin** icon will appear in your Chrome toolbar

---

## Features

Everything uBlock Origin offers on Manifest V2, now running on MV3:

- 🚫 **Ad blocking** — blocks ads across the web
- 🛡️ **Tracker blocking** — stops trackers from following you
- 🍪 **Cookie banner removal** — cosmetic filtering removes GDPR popups
- 📊 **Per-site rules** — granular control over what's blocked
- 📋 **Filter list support** — compatible with EasyList, uBlock filters, etc.
- 🔧 **Advanced dashboard** — full settings, filter management, logger
- ⚡ **Low CPU & memory** — inherits uBlock Origin's efficiency

---

## Browser Compatibility

| Browser | Status |
|---------|--------|
| Chrome 107+ | ✅ Works (MV3) |
| Chromium-based (Edge, Brave, etc.) | ✅ Should work |
| Firefox | ❌ Not targeted (use official uBlock Origin) |

---

## Legal & License

### License

This project is distributed under the **[GNU General Public License v3.0](LICENSE)**.
You may use, modify, and redistribute it under the same terms.

### Attribution

This project is a fork of **uBlock Origin**, created by Raymond Hill and contributors.

- Original project: https://github.com/gorhill/uBlock
- Original author: Raymond Hill (gorhill)
- Original license: GPL v3

All original copyright notices in source files have been preserved as required by GPL v3.

### Trademark Notice

- **"uBlock Origin"** is associated with Raymond Hill. This project does not claim to be uBlock Origin.
- **"aBlock Origin"** is the name of this independent fork.
- This project is not affiliated with, endorsed by, or sponsored by Raymond Hill or the uBlock Origin project.

### What GPL v3 Means for You

| You can… | You must… |
|----------|----------|
| ✅ Use this freely | 📋 Keep the GPL v3 license |
| ✅ Modify the source | 📋 Preserve original copyright notices |
| ✅ Distribute your changes | 📋 Share your changes under GPL v3 |
| ✅ Use commercially | 📋 Make source available |

---

## Contributing

Pull requests are welcome! If you find additional MV3 compatibility issues, please open an issue.

When contributing:
- Keep the GPL v3 license on all new files
- Add a comment explaining why any MV3-specific change was necessary
- Do not remove original copyright headers from existing files

---

## Disclaimer

This software is provided "as is", without warranty of any kind. The maintainers are not responsible for any issues arising from use of this extension.

---

*Built on top of the excellent work by Raymond Hill and the uBlock Origin community.*
