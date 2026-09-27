import {BookmarkCache} from './bookmark-cache.mjs';
import {theme, addConfigChangeListener} from './config-engine.mjs';

// Map origins to favicon URLs and skip opaque origins
let openTabsByOrigin = null;
// Map path overrides for tabs that differ from the origin default
let openTabsByOriginPath = null;

let openTabsFaviconMapPromise = null;

// Ask the background first: it builds the maps in this process and reuses them across page boots, while listing tabs here costs a parent round trip
async function resolveOpenTabsFaviconMaps() {
	try {
		const maps = await browser.runtime.sendMessage({type: 'favicons-request'});
		if (maps?.byOrigin) return maps;
	} catch {}
	try {
		const tabs = await browser.tabs.query({});
		return BookmarkCache.buildOpenTabsFaviconMaps(tabs, (url) => BookmarkCache.getUrlParts(url));
	} catch (e) {
		console.warn('[Favicon] Failed to query open tabs:', e);
		return {byOrigin: new Map(), byOriginPath: new Map()};
	}
}

function getOpenTabsFaviconMap() {
	if (openTabsFaviconMapPromise) return openTabsFaviconMapPromise;
	openTabsFaviconMapPromise = (async () => {
		const {byOrigin, byOriginPath} = await resolveOpenTabsFaviconMaps();
		openTabsByOrigin = byOrigin;
		openTabsByOriginPath = byOriginPath;
		return byOrigin;
	})();
	return openTabsFaviconMapPromise;
}

// Both accessors read the shared URL memo, so lookups never parse locally
function getOrigin(pageUrl) {
	return BookmarkCache.getUrlParts(pageUrl).origin;
}

function getFaviconKey(urlStr) {
	return BookmarkCache.getUrlParts(urlStr).key;
}

// Prefer a path override before the origin default
function getOpenTabsFaviconFor(pageUrl) {
	if (!openTabsByOrigin) return null;
	const key = getFaviconKey(pageUrl);
	if (key && openTabsByOriginPath?.has(key)) return openTabsByOriginPath.get(key);
	const origin = getOrigin(pageUrl);
	if (!origin) return null;
	return openTabsByOrigin.get(origin) || null;
}

// Share capture logic through BookmarkCache

// Keep a capture in the session mirror so a later render paints it without a second capture. The background prefetch owns persistence
function rememberFaviconView(viewKey, capture, provider) {
	BookmarkCache._faviconCache?.set(viewKey, {dataUrl: capture.dataUrl, provider: provider ?? null, srcId: capture.srcId, lumaClass: capture.lumaClass ?? null});
}

// Paint the raw URL immediately, then replace it with the captured data URL
function paintFromFavIconUrl(a, faviconUrl, cacheKey, viewKey, afterPaint) {
	setFaviconBackground(a, faviconUrl);
	// Treat tainted skin SVGs as black for contrast checks
	if (BookmarkCache.isAssumedBlackFavicon(faviconUrl)) applyFaviconLuma(a, 'black');
	a.dataset.faviconSrc = faviconUrl;
	const loader = new Image();
	loader.onload = async () => {
		try {
			const capture = await BookmarkCache.captureFaviconResult(faviconUrl, loader);
			setFaviconBackground(a, capture.dataUrl);
			applyFaviconLuma(a, capture.lumaClass);
			rememberFaviconView(viewKey, capture);
			afterPaint?.(capture.dataUrl, capture.lumaClass);
		} catch {
			// Keep the raw URL when canvas access is blocked by taint
			const id = await BookmarkCache.digestString(faviconUrl);
			rememberFaviconView(viewKey, {dataUrl: faviconUrl, srcId: id, lumaClass: null});
		}
	};
	loader.onerror = async () => {
		setFaviconError(a);
		// Keep an acceptable favicon when loading fails
		const cached = BookmarkCache._faviconCache?.get(cacheKey);
		if (!cached || cached.provider) {
			rememberFaviconView(cacheKey, {dataUrl: null, provider: 'error', srcId: await BookmarkCache.digestString(faviconUrl)}, 'error');
		}
	};
	loader.src = faviconUrl;
}

// Paint trusted cached views: privileged URLs paint only on privileged keys
function paintTrustedSync(a, cached, privilegedKey) {
	if (!cached) return false;
	if (cached.dataUrl && BookmarkCache.isPrivilegedScheme(cached.dataUrl)) {
		if (!privilegedKey) {
			setFaviconError(a);
			return true;
		}
		setFaviconBackground(a, cached.dataUrl);
		// Skin SVGs need an assumed luma because tainted captures have no pixels
		applyFaviconLuma(a, BookmarkCache.isAssumedBlackFavicon(cached.dataUrl) ? 'black' : cached.lumaClass);
	} else {
		setFaviconBackground(a, cached.dataUrl);
		applyFaviconLuma(a, cached.lumaClass);
	}
	a.dataset.faviconSrc = cached.srcId;
	return true;
}

// Let opentabs resolve before using an origin cache entry
function applyFavicon(pageUrl, a) {
	const origin = getOrigin(pageUrl);
	if (!origin) {
		// Treat keyless data and blob URLs as terminal privileged states
		setFaviconPrivileged(a);
		return;
	}
	const privilegedKey = BookmarkCache.isPrivilegedScheme(pageUrl);
	const cacheKey = getFaviconKey(pageUrl);

	// Check only the path cache synchronously
	const faviconCache = BookmarkCache._faviconCache;
	if (faviconCache) {
		const cached = faviconCache.get(cacheKey);
		if (cached?.provider === 'error') {
			// Show the error while allowing a fresh resolution
			setFaviconError(a);
		} else if (paintTrustedSync(a, cached, privilegedKey)) return;
	}

	// Let the CSS fallback show while the cache resolves
	(async () => {
		try {
			const cached = await BookmarkCache.getFavicon(cacheKey);
			if (paintHit(a, cached, privilegedKey)) return;
		} catch (e) {
			console.warn('[Favicon] Cache read failed:', e);
		}

		// Resolve a path override before the origin default
		await getOpenTabsFaviconMap();
		const faviconUrl = getOpenTabsFaviconFor(pageUrl);
		if (faviconUrl) {
			// Reject privileged favicon URLs on web keys to avoid poisoned cache entries
			if (BookmarkCache.isPrivilegedScheme(faviconUrl) && !privilegedKey) {
				setFaviconError(a);
				return;
			}
			// Record origin defaults by origin and path overrides by path
			const viewKey = faviconUrl !== openTabsByOrigin?.get(origin) ? cacheKey : origin;
			// Paint immediately instead of waiting for capture
			paintFromFavIconUrl(a, faviconUrl, cacheKey, viewKey);
			return;
		}

		// Use the origin cache when no open tab resolves the path
		if (cacheKey !== origin) {
			try {
				const originCached = await BookmarkCache.getFavicon(origin);
				if (paintHit(a, originCached, privilegedKey)) return;
			} catch {}
		}

		// Show a terminal icon when privileged or foreign pages have no favicon
		if (privilegedKey || BookmarkCache.isForeignExtensionUrl(pageUrl)) setFaviconPrivileged(a);
	})();
}

// Trust rule: only untagged views paint, so a provider tag or missing view returns false
function paintHit(a, cached, privilegedKey) {
	if (!cached || cached.provider) return false;
	return paintTrustedSync(a, cached, privilegedKey);
}

// Treat icons within this luma distance as hard to see
const LUMA_CONFLICT_THRESHOLD = 48;

// Accept only three or six digit hex colors
const HEX_COLOR_RE = /^#([0-9a-f]{6}|[0-9a-f]{3})$/i;

function hexLuma(hex) {
	const m = HEX_COLOR_RE.exec(hex);
	if (!m) return null;
	let h = m[1];
	if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
	const n = parseInt(h, 16);
	return 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255);
}

// Compare the icon extreme with the backdrop luma
function lumaConflicts(lumaClass, bgLuma) {
	if (bgLuma == null) return false;
	return Math.abs((lumaClass === 'white' ? 255 : 0) - bgLuma) < LUMA_CONFLICT_THRESHOLD;
}

function applyFaviconLuma(a, lumaClass) {
	if (!lumaClass) return;
	if (a.dataset.faviconLuma !== lumaClass) a.dataset.faviconLuma = lumaClass;
	a.classList.toggle('favicon-conflict', lumaConflicts(lumaClass, hexLuma(theme.background_color)));
}

// Recheck visible icons after the theme changes
function refreshFaviconLumaConflicts() {
	const links = document.querySelectorAll('#main a[href][data-favicon-luma]');
	const bgLuma = hexLuma(theme.background_color);
	for (let i = 0, len = links.length; i < len; i++) {
		const a = links[i];
		a.classList.toggle('favicon-conflict', lumaConflicts(a.dataset.faviconLuma, bgLuma));
	}
}

addConfigChangeListener((key) => {
	if (key === 'theme') refreshFaviconLumaConflicts();
});

// Keep real favicons unmasked. Mask only monochrome placeholders
function setFaviconState(a, cls) {
	a.classList.remove('favicon-error', 'favicon-privileged', 'favicon-unmasked', 'favicon-conflict');
	delete a.dataset.faviconLuma;
	a.classList.add(cls);
}

function setFaviconBackground(a, url) {
	a.style.setProperty('--favicon', `url('${url}')`);
	setFaviconState(a, 'favicon-unmasked');
}

function setFaviconPrivileged(a) {
	a.style.removeProperty('--favicon');
	setFaviconState(a, 'favicon-privileged');
}

function setFaviconError(a) {
	a.style.removeProperty('--favicon');
	setFaviconState(a, 'favicon-error');
}

// Refresh from the broadcast maps instead of a tabs.query per page, coalescing broadcasts during a refresh
let faviconRefreshBusy = false;
let faviconRefreshQueued = false;
let faviconRefreshDrained = null;

async function refreshOpenTabsFavicons(broadcastMaps) {
	openTabsByOrigin = broadcastMaps.byOrigin;
	openTabsByOriginPath = broadcastMaps.byOriginPath;
	openTabsFaviconMapPromise = Promise.resolve(openTabsByOrigin);
	if (faviconRefreshBusy) {
		faviconRefreshQueued = true;
		return faviconRefreshDrained;
	}
	faviconRefreshBusy = true;
	faviconRefreshDrained = (async () => {
		try {
			do {
				faviconRefreshQueued = false;
				try {
					await BookmarkCache.loadFavicons(true);
				} catch {}
				await walkFaviconRefreshLinks();
			} while (faviconRefreshQueued);
		} finally {
			faviconRefreshBusy = false;
		}
	})();
	return faviconRefreshDrained;
}

// Group links by key so each favicon is repainted once
async function walkFaviconRefreshLinks() {
	const links = document.querySelectorAll('#main a[href]');
	const groups = new Map();
	for (let i = 0, len = links.length; i < len; i++) {
		const a = links[i];
		const href = a.getAttribute('href');
		if (!href) continue;
		const origin = getOrigin(href);
		if (!origin) continue;
		const cacheKey = getFaviconKey(href);
		let group = groups.get(cacheKey);
		if (!group) {
			group = {origin, anchors: []};
			groups.set(cacheKey, group);
		}
		group.anchors.push(a);
	}

	for (const [cacheKey, group] of groups) {
		// Preserve a real per-path favicon when falling back to the origin default
		const pathFav = openTabsByOriginPath?.get(cacheKey);
		if (!pathFav && cacheKey !== group.origin && group.anchors[0].classList.contains('favicon-unmasked')) continue;
		const faviconUrl = pathFav || openTabsByOrigin?.get(group.origin);
		if (!faviconUrl) continue;

		const a = group.anchors[0];
		const href = a.getAttribute('href');
		let srcId = null;
		// Compare the painted URL because the background cache may have just changed
		if (a.classList.contains('favicon-unmasked')) {
			if (a.dataset.faviconSrc === faviconUrl) continue;
			srcId = await BookmarkCache.digestString(faviconUrl);
			if (a.dataset.faviconSrc === srcId) continue;
		}

		const privilegedKey = BookmarkCache.isPrivilegedScheme(href);
		// Reject privileged favicon URLs on web keys to avoid poisoning the cache, but never replace a real favicon with the placeholder
		if (BookmarkCache.isPrivilegedScheme(faviconUrl) && !privilegedKey) {
			if (!a.classList.contains('favicon-unmasked')) setFaviconError(a);
			continue;
		}

		// Paint a stored row whose source token matches instead of capturing a source the background already persisted
		if (srcId === null) srcId = await BookmarkCache.digestString(faviconUrl);
		const pathView = BookmarkCache._faviconCache?.get(cacheKey);
		const originView = cacheKey === group.origin ? null : BookmarkCache._faviconCache?.get(group.origin);
		let view = pathView?.dataUrl && !pathView.provider && pathView.srcId === srcId ? pathView : null;
		if (!view && originView?.dataUrl && !originView.provider && originView.srcId === srcId) view = originView;
		if (view) {
			const anchors = group.anchors;
			for (let i = 0, len = anchors.length; i < len; i++) paintHit(anchors[i], view, privilegedKey);
			continue;
		}

		// Record origin defaults by origin and path overrides by path
		const viewKey = faviconUrl !== openTabsByOrigin?.get(group.origin) ? cacheKey : group.origin;
		// Paint immediately instead of waiting for capture
		paintFromFavIconUrl(a, faviconUrl, cacheKey, viewKey, (dataUrl, lumaClass) => {
			const anchors = group.anchors;
			for (let j = 1, jLen = anchors.length; j < jLen; j++) {
				setFaviconBackground(anchors[j], dataUrl);
				applyFaviconLuma(anchors[j], lumaClass);
			}
		});
	}
}

function resetOpenTabsFaviconMapForTest() {
	openTabsByOrigin = null;
	openTabsByOriginPath = null;
	openTabsFaviconMapPromise = null;
	faviconRefreshBusy = false;
	faviconRefreshQueued = false;
	faviconRefreshDrained = null;
}

function setOpenTabsFaviconMapForTest(byOrigin, byOriginPath) {
	openTabsByOrigin = byOrigin;
	openTabsByOriginPath = byOriginPath;
	openTabsFaviconMapPromise = Promise.resolve(byOrigin);
}

export {
	getOpenTabsFaviconMap,
	getOrigin,
	getFaviconKey,
	getOpenTabsFaviconFor,
	paintFromFavIconUrl,
	applyFavicon,
	paintHit,
	setFaviconBackground,
	setFaviconError,
	refreshOpenTabsFavicons,
	walkFaviconRefreshLinks,
	resetOpenTabsFaviconMapForTest,
	setOpenTabsFaviconMapForTest,
};
