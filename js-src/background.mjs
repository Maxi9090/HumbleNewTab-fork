import {BookmarkCache} from './bookmark-cache.mjs';

// Event-driven bookmark sync for Firefox's event page

let syncInProgress = false;
let sessionsSyncTimeout = null;
let sessionsSyncInFlight = false;
let sessionsDirty = false;
let lastFullSyncAt = 0;
const SESSIONS_DEBOUNCE_MS = 200;
// Bookmark events drive the sync, so this window only has to cover a dead event page. A short window re-reads the whole tree on almost every open
const NEW_TAB_REFRESH_AGE_MS = 30_000;

// Keep background work off a page boot and its aftermath. Never gate the closed-tab sync
const PAGE_SETTLE_GRACE_MS = 1_200;
const PAGE_BOOT_MAX_MS = 3_000;
const TAB_CLOSE_QUIET_MS = 1_000;
let pagesBooting = 0;
let bootDeadline = 0;
let quietUntil = 0;
let holdTimer = null;
let holdTimerAt = 0;
let heldSyncCheck = false;
let heldPrefetch = false;
let heldPrefetchRecovery = false;

function holdBoundary() {
	return pagesBooting > 0 ? Math.max(quietUntil, bootDeadline) : quietUntil;
}

function isHeld() {
	return Date.now() < holdBoundary();
}

function armHoldRelease() {
	const boundary = holdBoundary();
	if (holdTimer) {
		// Re-arm only when the boundary moved earlier, so a page reporting ready shortens its own boot deadline
		if (holdTimerAt <= boundary) return;
		clearTimeout(holdTimer);
		holdTimer = null;
	}
	const remaining = boundary - Date.now();
	if (remaining <= 0) return;
	holdTimerAt = boundary;
	holdTimer = setTimeout(releaseHeldWork, remaining);
}

function releaseHeldWork() {
	holdTimer = null;
	holdTimerAt = 0;
	// A page that died before its ready signal must not hold the background forever
	if (pagesBooting > 0 && Date.now() >= bootDeadline) pagesBooting = 0;
	if (isHeld()) {
		armHoldRelease();
		return;
	}
	const syncCheck = heldSyncCheck;
	const prefetch = heldPrefetch;
	const recovery = heldPrefetchRecovery;
	heldSyncCheck = false;
	heldPrefetch = false;
	heldPrefetchRecovery = false;
	if (syncCheck) performBookmarkSync('newtab-ready');
	if (prefetch) schedulePrefetch(recovery);
}

// Cancel work still waiting on a debounce so it runs after the page settles instead of during the boot
function holdPendingWork() {
	if (prefetchTimer) {
		clearTimeout(prefetchTimer);
		prefetchTimer = null;
		heldPrefetch = true;
	}
	armHoldRelease();
}

// Cache only a granted sessions permission so later grants and revocations are detected
let sessionsPermissionCache = null;
async function hasSessionsPermission() {
	if (sessionsPermissionCache === true) return true;
	const has = await browser.permissions.contains({permissions: ['sessions']});
	if (has) sessionsPermissionCache = true;
	return has;
}

// Use a short delay normally and a longer delay for large bursts
const BOOKMARK_DEBOUNCE_MS = 500;
const BOOKMARK_BULK_DEBOUNCE_MS = 5_000;
const BULK_CHANGE_THRESHOLD = 20;
let bookmarkSyncTimer = null;
let pendingChangeCount = 0;
let bookmarkSyncDirty = false;

async function notifyPages(type, payload) {
	try {
		await browser.runtime.sendMessage({type, ...payload});
	} catch {
		// Ignore the error when no new-tab page is open
	}
}

async function performBookmarkSync(reason, options = {}) {
	if (syncInProgress) {
		bookmarkSyncDirty = true;
		return;
	}

	// Skip a fresh cache unless the sync is forced
	if (!options.force && reason === 'newtab-ready' && Date.now() - lastFullSyncAt < NEW_TAB_REFRESH_AGE_MS) {
		return;
	}

	syncInProgress = true;
	const previousSync = (await BookmarkCache.getCacheStatus()).lastSync;
	try {
		await BookmarkCache.fullSync();
		lastFullSyncAt = Date.now();
		const currentSync = (await BookmarkCache.getCacheStatus()).lastSync;
		// Notify pages only when lastSync advances
		if (currentSync !== previousSync) {
			await notifyPages('bookmarks-updated');
		}
		// Prefetch favicons for newly added URLs
		schedulePrefetch();
	} catch (error) {
		console.error('[BookmarkCache] Sync failed:', error);
	} finally {
		syncInProgress = false;
		if (bookmarkSyncDirty) {
			bookmarkSyncDirty = false;
			performBookmarkSync('bookmark-event');
		}
	}
}

let lastSessionsSignature = null;

// The page paints these records directly, so the background owns them. Skip a record while its folder is disabled
function writeClosedRecord(id, data) {
	const show = localStorage.getItem(`options.show_${id}`);
	if (show == null || Number(show) === 0) return;
	const raw = Number(localStorage.getItem(`options.number_${id}`));
	const limit = raw > 0 ? Math.min(raw, 25) : 15;
	BookmarkCache.safeSetItem(`cache.${id}`, JSON.stringify({limit, data: data.slice(0, limit)}));
}

async function syncClosedTabs(force = false) {
	if (!(await hasSessionsPermission())) return;
	try {
		const sessions = await browser.sessions.getRecentlyClosed({maxResults: 25});
		const closed = [];
		const windows = [];
		const forgets = [];
		for (let i = 0, len = sessions.length; i < len; i++) {
			const raw = sessions[i];
			// Each record owns one half of Firefox's recently closed list
			if (raw.window) {
				windows.push(BookmarkCache.shapeClosedSession(raw));
				continue;
			}
			const session = BookmarkCache.shapeClosedSession(raw);
			if (BookmarkCache.isBlankNewTab(raw.tab)) {
				// Forget standalone new-tab sessions. Firefox cannot forget tabs from closed-window sessions
				if (raw.tab.windowId != null && raw.tab.sessionId) {
					forgets.push(browser.sessions.forgetClosedTab(raw.tab.windowId, raw.tab.sessionId).catch(() => {}));
				}
				continue;
			}
			closed.push(session);
		}
		if (forgets.length) await Promise.all(forgets);
		// Skip the write and broadcast when neither list changed
		const signature = JSON.stringify({closed, windows});
		if (force || signature !== lastSessionsSignature) {
			lastSessionsSignature = signature;
			writeClosedRecord('closed', closed);
			writeClosedRecord('windows', windows);
			await notifyPages('sessions-updated');
		}
	} catch (error) {
		sessionsPermissionCache = null;
		console.error('[Sessions] Failed to sync closed tabs:', error);
	}
}

// Keep a trailing sync because Firefox may register a closed tab after the first query
function scheduleSessionsSync() {
	if (sessionsSyncTimeout || sessionsSyncInFlight) {
		sessionsDirty = true;
		return;
	}
	sessionsSyncTimeout = setTimeout(() => {
		sessionsSyncTimeout = null;
		sessionsSyncInFlight = true;
		syncClosedTabs().finally(() => {
			sessionsSyncInFlight = false;
			if (sessionsDirty) {
				sessionsDirty = false;
				scheduleSessionsSync();
			}
		});
	}, SESSIONS_DEBOUNCE_MS);
}

// Coalesce bookmark events until editing stops
function onBookmarkChange() {
	pendingChangeCount++;
	if (bookmarkSyncTimer) clearTimeout(bookmarkSyncTimer);
	const delay = pendingChangeCount > BULK_CHANGE_THRESHOLD ? BOOKMARK_BULK_DEBOUNCE_MS : BOOKMARK_DEBOUNCE_MS;
	bookmarkSyncTimer = setTimeout(() => {
		bookmarkSyncTimer = null;
		pendingChangeCount = 0;
		performBookmarkSync('bookmark-event');
	}, delay);
}

browser.bookmarks.onCreated.addListener(onBookmarkChange);
browser.bookmarks.onRemoved.addListener(onBookmarkChange);
browser.bookmarks.onChanged.addListener(onBookmarkChange);
browser.bookmarks.onMoved.addListener(onBookmarkChange);

browser.runtime.onInstalled.addListener((details) => {
	performBookmarkSync(`extension-${details.reason}`, {force: true});
	scheduleSessionsSync();
});

browser.runtime.onStartup.addListener(() => {
	lastFullSyncAt = 0;
	performBookmarkSync('startup', {force: true});
	scheduleSessionsSync();
});

async function focusLastNewTab() {
	const tabs = await browser.tabs.query({});
	const newTabPrefix = browser.runtime.getURL('newtab.html');
	const newTabs = tabs.filter((t) => t.url && (t.url === 'about:newtab' || t.url.startsWith(newTabPrefix)));
	if (newTabs.length === 0) {
		browser.tabs.create({});
		return;
	}
	newTabs.sort((a, b) => b.lastAccessed - a.lastAccessed);
	const tab = newTabs[0];
	await browser.tabs.update(tab.id, {active: true});
	await browser.windows.update(tab.windowId, {focused: true});
}

browser.commands.onCommand.addListener((command) => {
	if (command === 'focus-newtab') focusLastNewTab();
});

browser.runtime.onMessage.addListener((message) => {
	if (message?.type === 'newtab-booting') {
		// A page is loading: keep its boot window clear of background work
		pagesBooting++;
		bootDeadline = Date.now() + PAGE_BOOT_MAX_MS;
		holdPendingWork();
		return false;
	}
	if (message?.type === 'newtab-ready') {
		// First render done: release only after the page settles
		if (pagesBooting > 0) pagesBooting--;
		quietUntil = Math.max(quietUntil, Date.now() + PAGE_SETTLE_GRACE_MS);
		// Recover if the event page ended during the debounce
		if (Date.now() - lastFullSyncAt > NEW_TAB_REFRESH_AGE_MS) {
			heldSyncCheck = true;
			armHoldRelease();
		}
		// Recover favicon prefetch after event-page termination
		schedulePrefetch(true);
		return false;
	}
	if (message?.type === 'favicons-request') {
		// A page boot asks here instead of listing every tab through the parent process
		return faviconMapsForPages();
	}
	if (message?.type === 'storage-cleared') {
		return performBookmarkSync('storage-cleared', {force: true});
	}
	if (message?.type === 'recent-limit-changed') {
		// Re-sync when number_recent changes or the folder is re-enabled. The reply lets the page repaint after the write
		return performBookmarkSync('recent-limit-changed', {force: true});
	}
	if (message?.type === 'closed-limit-changed') {
		return syncClosedTabs(true);
	}
	return false;
});

// Prefetch favicons in the background using the page's map rules
const PREFETCH_DEBOUNCE_MS = 500;
const PREFETCH_RECOVERY_AGE_MS = 5_000;
let prefetchTimer = null;
let prefetchInFlight = false; // Ignore events while a prefetch is running
let prefetchDirty = false;
let lastPrefetchAt = 0;

function schedulePrefetch(recovery = false) {
	if (isHeld()) {
		heldPrefetch = true;
		heldPrefetchRecovery = heldPrefetchRecovery || recovery;
		armHoldRelease();
		return;
	}
	if (prefetchInFlight) {
		// Events landing mid-run would otherwise be dropped until the next unrelated trigger
		prefetchDirty = true;
		return;
	}
	if (prefetchTimer) return;
	if (recovery && lastPrefetchAt && Date.now() - lastPrefetchAt < PREFETCH_RECOVERY_AGE_MS) return;
	prefetchTimer = setTimeout(() => {
		prefetchTimer = null;
		prefetchInFlight = true;
		lastPrefetchAt = Date.now();
		prefetchFavicons()
			.catch((e) => console.warn('[Favicon] Background prefetch failed:', e))
			.finally(() => {
				prefetchInFlight = false;
				if (prefetchDirty) {
					prefetchDirty = false;
					schedulePrefetch();
				}
			});
	}, PREFETCH_DEBOUNCE_MS);
}

function resetPrefetchForTest() {
	if (prefetchTimer) clearTimeout(prefetchTimer);
	prefetchTimer = null;
	prefetchInFlight = false;
	prefetchDirty = false;
	lastPrefetchAt = 0;
}

function getPrefetchStateForTest() {
	return {timerActive: prefetchTimer !== null, inFlight: prefetchInFlight, lastPrefetchAt, dirty: prefetchDirty};
}

function setPrefetchLastAtForTest(value) {
	lastPrefetchAt = value;
}

// Reuse the shared URL parser while keeping a background test binding
const getUrlParts = (urlStr) => BookmarkCache.getUrlParts(urlStr);

// Persist tainted URLs so favicons survive restart. Pixel luma is unavailable
async function captureFavicon(favIconUrl) {
	return new Promise((resolve) => {
		const img = new Image();
		img.onload = async () => {
			try {
				resolve(await BookmarkCache.captureFaviconResult(favIconUrl, img));
			} catch {
				// Persist the raw URL when canvas access is blocked by taint. The row digest keys on the URL string
				const id = await BookmarkCache.digestString(favIconUrl);
				resolve({dataUrl: favIconUrl, hash: id, srcId: id, lumaClass: null});
			}
		};
		img.onerror = () => resolve(null);
		img.src = favIconUrl;
	});
}

// Wrap the shared builder with background tabs.query error handling
async function buildOpenTabsFaviconMaps() {
	try {
		const tabs = await browser.tabs.query({});
		return BookmarkCache.buildOpenTabsFaviconMaps(tabs, getUrlParts);
	} catch (e) {
		console.warn('[Favicon] tabs.query failed:', e);
		return {byOrigin: new Map(), byOriginPath: new Map()};
	}
}

// Serve page requests from one build: listing every tab costs a parent round trip, and each page asks on boot
let cachedFaviconMaps = null;
async function faviconMapsForPages(refresh = false) {
	if (refresh || !cachedFaviconMaps) cachedFaviconMaps = await buildOpenTabsFaviconMaps();
	return cachedFaviconMaps;
}

// Compare source tokens, never stored source strings
async function classifyKeysForFavicon(keys, keyOrigins, byOrigin, byOriginPath, faviconCache, genericDataUrl) {
	const byFavIconUrl = new Map();
	const privilegedErrors = [];
	const staleDuplicates = [];
	const srcTokens = new Map();
	const srcIdFor = async (favIconUrl) => {
		let id = srcTokens.get(favIconUrl);
		if (!id) {
			id = await BookmarkCache.digestString(favIconUrl);
			srcTokens.set(favIconUrl, id);
		}
		return id;
	};
	for (const key of keys) {
		const origin = keyOrigins.get(key);
		const pathFav = byOriginPath.get(key);
		const favIconUrl = pathFav || byOrigin.get(origin);
		if (!favIconUrl) continue;
		const srcId = await srcIdFor(favIconUrl);
		const cached = faviconCache.get(key);
		// A privileged data URL is valid only under a privileged key
		const poisoned = cached && cached.dataUrl && BookmarkCache.isPrivilegedScheme(cached.dataUrl) && !BookmarkCache.isPrivilegedScheme(origin);
		// Path keys without their own override evaluate and write under the origin key
		const storeKey = pathFav || key === origin ? key : origin;
		const stored = storeKey === key ? cached : faviconCache.get(origin);
		const storedPoisoned = stored && stored.dataUrl && BookmarkCache.isPrivilegedScheme(stored.dataUrl) && !BookmarkCache.isPrivilegedScheme(origin);
		if (storeKey !== key) {
			// Reclaim duplicate, poisoned, and unacceptable path entries. A differing acceptable per-path capture stays as last-known display
			if (cached && (poisoned || cached.provider || cached.dataUrl === genericDataUrl || (stored && !stored.provider && stored.dataUrl === cached.dataUrl))) {
				staleDuplicates.push(key);
			}
		}
		if (BookmarkCache.isPrivilegedScheme(favIconUrl) && !BookmarkCache.isPrivilegedScheme(origin)) {
			if (stored && stored.provider === 'error' && stored.srcId === srcId) continue;
			// Do not replace an acceptable favicon with an error sentinel
			if (stored && !stored.provider) continue;
			privilegedErrors.push({key: storeKey, favIconUrl, srcId});
			continue;
		}
		// Privileged keys capture and failures become error sentinels
		if (stored && !storedPoisoned && !stored.provider && stored.dataUrl !== genericDataUrl && stored.srcId === srcId) continue;
		let group = byFavIconUrl.get(favIconUrl);
		if (!group) {
			group = [];
			byFavIconUrl.set(favIconUrl, group);
		}
		if (!group.includes(storeKey)) group.push(storeKey);
	}
	return {byFavIconUrl, privilegedErrors, staleDuplicates};
}

async function prefetchFavicons() {
	// Load the mirror because a hash-matched sync may leave it empty
	const allData = await BookmarkCache.loadAllData();

	const keys = new Set();
	const keyOrigins = new Map();
	for (const [, value] of allData) {
		const children = value?.children;
		if (!children) continue;
		for (let i = 0, len = children.length; i < len; i++) {
			const child = children[i];
			if (child.url) {
				// Folder records carry the parsed key, so the walk does not re-parse per pass
				const info = child.urlParts ?? BookmarkCache.urlPartsFor(child);
				if (info.key) {
					keys.add(info.key);
					keyOrigins.set(info.key, info.origin);
				}
			}
		}
	}
	if (keys.size === 0) return;

	const {byOrigin, byOriginPath} = await faviconMapsForPages(true);
	// Preload the mirror for synchronous per-key checks
	const faviconCache = await BookmarkCache.loadFavicons();
	const genericDataUrl = await BookmarkCache.getGenericIconDataUrl();

	const {byFavIconUrl, privilegedErrors, staleDuplicates} = await classifyKeysForFavicon(keys, keyOrigins, byOrigin, byOriginPath, faviconCache, genericDataUrl);

	// Strip row memberships before the capture batch so reclaimed quota is available to it
	if (staleDuplicates.length > 0) {
		BookmarkCache.removeFaviconSites(staleDuplicates);
	}

	let wrote = staleDuplicates.length > 0;
	if (byFavIconUrl.size > 0 || privilegedErrors.length > 0) {
		const batch = [];
		for (let i = 0, len = privilegedErrors.length; i < len; i++) {
			const e = privilegedErrors[i];
			batch.push({origin: e.key, dataUrl: null, provider: 'error', srcId: e.srcId});
		}

		// Capture each URL once and yield periodically to keep the event page responsive
		let i = 0;
		for (const [favIconUrl, keyList] of byFavIconUrl) {
			if (++i % 10 === 0) await new Promise((r) => setTimeout(r, 0));
			const result = await captureFavicon(favIconUrl);
			if (!result) {
				// Persist an error sentinel for a failed load
				const failedId = await BookmarkCache.digestString(favIconUrl);
				for (let j = 0, len = keyList.length; j < len; j++) {
					batch.push({origin: keyList[j], dataUrl: null, provider: 'error', srcId: failedId});
				}
				continue;
			}
			for (let j = 0, len = keyList.length; j < len; j++) {
				batch.push({origin: keyList[j], dataUrl: result.dataUrl, hash: result.hash, srcId: result.srcId, lumaClass: result.lumaClass});
			}
		}
		await BookmarkCache.setFaviconsMany(batch);
		wrote = true;
	}

	// Broadcast only after a write so pages avoid unnecessary favicon reloads
	if (wrote) {
		await notifyPages('favicons-updated', {byOrigin, byOriginPath});
	}
}

// The native filter avoids waking the event page for unrelated tab updates. onCreated is redundant, and onActivated carries no favicon signal
browser.tabs.onUpdated.addListener(
	(_id, changeInfo, tab) => {
		// Ignore blank tabs because they have no bookmark favicon signal
		if (BookmarkCache.isBlankNewTab(tab)) return;
		// Only a URL or favicon change moves the maps; a status change cannot
		if ('url' in changeInfo || 'favIconUrl' in changeInfo) cachedFaviconMaps = null;
		schedulePrefetch();
	},
	{properties: ['favIconUrl', 'url', 'status']},
);
browser.tabs.onRemoved.addListener(() => {
	// Hold off the close the user just triggered: a newtab opened right after has to settle first
	quietUntil = Math.max(quietUntil, Date.now() + TAB_CLOSE_QUIET_MS);
	cachedFaviconMaps = null;
	schedulePrefetch();
	scheduleSessionsSync();
});
// Window close creates a closed-window session, tabs.onRemoved handles tab closes
browser.windows.onRemoved.addListener(() => {
	quietUntil = Math.max(quietUntil, Date.now() + TAB_CLOSE_QUIET_MS);
	scheduleSessionsSync();
});
browser.sessions?.onChanged?.addListener(() => scheduleSessionsSync());

function resetBookmarkDebounceForTest() {
	if (bookmarkSyncTimer) clearTimeout(bookmarkSyncTimer);
	bookmarkSyncTimer = null;
	pendingChangeCount = 0;
	bookmarkSyncDirty = false;
	syncInProgress = false;
}

function resetHoldForTest() {
	if (holdTimer) clearTimeout(holdTimer);
	holdTimer = null;
	holdTimerAt = 0;
	pagesBooting = 0;
	bootDeadline = 0;
	quietUntil = 0;
	heldSyncCheck = false;
	heldPrefetch = false;
	heldPrefetchRecovery = false;
}

function getHoldStateForTest() {
	return {
		held: isHeld(),
		pagesBooting,
		bootDeadline,
		quietUntil,
		heldSyncCheck,
		heldPrefetch,
		timerActive: holdTimer !== null,
	};
}

function getBookmarkDebounceStateForTest() {
	return {
		pendingChangeCount,
		timerActive: bookmarkSyncTimer !== null,
		syncInProgress,
	};
}

export {
	BOOKMARK_DEBOUNCE_MS,
	BOOKMARK_BULK_DEBOUNCE_MS,
	BULK_CHANGE_THRESHOLD,
	SESSIONS_DEBOUNCE_MS,
	PREFETCH_DEBOUNCE_MS,
	PAGE_SETTLE_GRACE_MS,
	PAGE_BOOT_MAX_MS,
	TAB_CLOSE_QUIET_MS,
	onBookmarkChange,
	schedulePrefetch,
	resetPrefetchForTest,
	getPrefetchStateForTest,
	setPrefetchLastAtForTest,
	focusLastNewTab,
	getUrlParts,
	buildOpenTabsFaviconMaps,
	classifyKeysForFavicon,
	resetBookmarkDebounceForTest,
	getBookmarkDebounceStateForTest,
	resetHoldForTest,
	getHoldStateForTest,
};
