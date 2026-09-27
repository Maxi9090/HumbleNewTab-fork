/* localStorage-backed bookmark cache for folders, special folders, and favicons */

const RECENT_DEFAULT_LIMIT = 15;
const RECENT_MAX_LIMIT = 50;

// Parse once, keep the value on the record
function lazyUrlParts() {
	const info = BookmarkCache.getUrlParts(this.url);
	Object.defineProperty(this, 'urlParts', {value: info});
	return info;
}

// One shared accessor: a per-link defineProperty cost a native call and a descriptor object on every flatten
const LINK_ENTRY_PROTO = {};
Object.defineProperty(LINK_ENTRY_PROTO, 'urlParts', {configurable: true, get: lazyUrlParts});

const HTTP_SCHEME_RE = /^https?:/i;
const SVG_DATA_RE = /^data:image\/svg\+xml[;,]/i;
const SVG_URL_RE = /^https?:\/\/[^?#]*\.svg(?:[?#]|$)/i;
const FINGERPRINT_RE = /^[0-9a-f]{32}$/;

const BookmarkCache = {
	// Cache records live under this namespace so clear() never touches the extension's other keys
	KEY_PREFIX: 'bm:',

	_allDataCache: null, // Keep an in-memory mirror of non-favicon records
	_faviconCache: null, // Keep a separate mirror of favicon records (site -> request view)
	_faviconPromise: null, // Share concurrent favicon mirror reads
	_storageWarningKeys: new Set(), // Avoid repeating quota warnings for one key
	_newtabUrlPrefix: '', // Compute the extension URL lazily because tests may omit browser.runtime

	// Share these predicates between page and background contexts
	isPrivilegedScheme(url) {
		return url.startsWith('about:') || url.startsWith('chrome:') || url.startsWith('resource:') || url.startsWith('file:');
	},

	// Treat unavailable own URLs as foreign to fail closed
	_ownUrlPrefix: null,
	isForeignExtensionUrl(url) {
		if (!url.startsWith('moz-extension://')) return false;
		if (this._ownUrlPrefix === null) {
			this._ownUrlPrefix = typeof browser !== 'undefined' && browser.runtime?.getURL ? browser.runtime.getURL('') : '';
		}
		return !this._ownUrlPrefix || !url.startsWith(this._ownUrlPrefix);
	},

	// Keep this allowlist exact because broad skin package prefixes are unsafe
	_assumedBlackFavicons: new Set(['chrome://browser/skin/preferences/category-accessibility.svg']),
	isAssumedBlackFavicon(url) {
		return this._assumedBlackFavicons.has(url);
	},

	// Normalize web URLs so cache busters do not create new favicon identities
	normalizeFaviconUrl(url) {
		if (!HTTP_SCHEME_RE.test(url)) return url;
		const q = url.indexOf('?');
		const h = url.indexOf('#');
		const cut = q === -1 ? h : h === -1 ? q : Math.min(q, h);
		return cut === -1 ? url : url.slice(0, cut);
	},

	// Require a root hit or two path keys before choosing an origin default
	buildOpenTabsFaviconMaps(tabs, urlKeyFn) {
		const byOrigin = new Map();
		const byOriginPath = new Map();
		const originFavKeys = new Map(); // Group cache keys by origin and favicon URL
		const originRootHit = new Map(); // Record favicon URLs seen at an origin root
		const pathOverrides = [];
		for (let i = 0, len = tabs.length; i < len; i++) {
			const tab = tabs[i];
			if (!tab.favIconUrl) continue;
			const favUrl = this.normalizeFaviconUrl(tab.favIconUrl);
			const info = urlKeyFn(tab.url);
			if (!info || !info.origin) continue;
			const {origin, key} = info;
			let favKeys = originFavKeys.get(origin);
			if (!favKeys) {
				favKeys = new Map();
				originFavKeys.set(origin, favKeys);
			}
			let keys = favKeys.get(favUrl);
			if (!keys) {
				keys = new Set();
				favKeys.set(favUrl, keys);
			}
			keys.add(key);
			if (key === origin) originRootHit.set(origin, favUrl);
			if (key && key !== origin) pathOverrides.push({key, favUrl, origin});
		}
		for (const [origin, favKeys] of originFavKeys) {
			let bestUrl = null,
				bestKeyCount = 0;
			for (const [url, keys] of favKeys) {
				if (keys.size > bestKeyCount) {
					bestUrl = url;
					bestKeyCount = keys.size;
				}
			}
			const rootUrl = originRootHit.get(origin);
			if (rootUrl) byOrigin.set(origin, rootUrl);
			else if (bestKeyCount >= 2) byOrigin.set(origin, bestUrl);
		}
		for (const {key, favUrl, origin} of pathOverrides) {
			const defaultFav = byOrigin.get(origin);
			if (favUrl !== defaultFav && !byOriginPath.has(key)) byOriginPath.set(key, favUrl);
		}
		return {byOrigin, byOriginPath};
	},

	// Memoize URL parsing because page and background share the same key rules
	URL_PARTS_CACHE_LIMIT: 2048,
	_urlPartsCache: new Map(),
	getUrlParts(urlStr) {
		const cache = this._urlPartsCache;
		let info = cache.get(urlStr);
		if (info !== undefined) return info;
		try {
			const u = new URL(urlStr);
			// Use the full URL for privileged pages so their favicon buckets stay separate
			if (this.isPrivilegedScheme(u.protocol)) {
				info = {origin: u.href, key: u.href};
			} else if (u.protocol === 'data:' || u.protocol === 'blob:') {
				info = {origin: null, key: null};
			} else {
				const origin = u.origin;
				if (origin === 'null') info = {origin: null, key: null};
				else {
					// Use a path key only for paths deeper than one segment or ending with a slash
					const segments = u.pathname.split('/').filter(Boolean);
					const isPerPath = segments.length > 0 && (segments.length > 1 || u.pathname.endsWith('/'));
					info = {origin, key: isPerPath ? `${origin}/${segments[0]}` : origin};
				}
			}
		} catch {
			info = {origin: null, key: null};
		}
		// Freeze the memo at its limit instead of evicting:
		// an eviction marks the entry removed and fixes up live iterators, which churns the engine's ordered table for the sake of one URL parse
		if (cache.size < this.URL_PARTS_CACHE_LIMIT) cache.set(urlStr, info);
		return info;
	},

	// Stored records cannot carry the accessor, so a walk that needs URL parts installs it on first read
	urlPartsFor(child) {
		Object.defineProperty(child, 'urlParts', {configurable: true, get: lazyUrlParts});
		return child.urlParts;
	},

	// Capture image, luma class, pixel identity, and source token in one pass. The token replaces storing the source data URL anywhere in the store
	async captureFaviconResult(source, img) {
		const srcId = await this.digestString(source);
		if (this.isVectorSource(source)) {
			// Vectors stay vector: no raster, no luma conflict signal, row key equals the source token
			return {dataUrl: source, hash: srcId, srcId, lumaClass: null};
		}
		const canvas = document.createElement('canvas');
		const w = img.naturalWidth || 16;
		const h = img.naturalHeight || 16;
		// Scale down to 64 for storage. Favicons never need more, and the identity is computed before encoding
		const scale = Math.min(1, 64 / Math.max(w, h));
		const dw = Math.max(1, Math.round(w * scale));
		const dh = Math.max(1, Math.round(h * scale));
		canvas.width = dw;
		canvas.height = dh;
		const ctx = canvas.getContext('2d');
		ctx.drawImage(img, 0, 0, dw, dh);
		const pixels = ctx.getImageData(0, 0, dw, dh).data;
		const lumaClass = this.faviconClassFromPixels(pixels);
		// The digest is over the captured pixels, not the stored bytes, so the identity survives format conversion
		const hash = await this.digestToHex(pixels);
		// Lossless WebP competes with PNG, keep the smaller data URL. Ties keep WebP. The identity is pixel-based, so the winning format cannot split rows
		const webp = await this._canvasWebpDataUrl(canvas);
		const png = canvas.toDataURL('image/png');
		const image = webp && webp.length <= png.length ? webp : png;
		return {dataUrl: image, hash, srcId, lumaClass};
	},

	// Classify only near-monochrome icons to avoid false contrast conflicts
	faviconClassFromPixels(data) {
		let black = 0;
		let white = 0;
		let total = 0;
		for (let i = 0, len = data.length; i < len; i += 4) {
			if (data[i + 3] < 16) continue;
			total++;
			const max = Math.max(data[i], data[i + 1], data[i + 2]);
			const min = Math.min(data[i], data[i + 1], data[i + 2]);
			// Ignore strongly colored pixels
			if (max - min > 24) continue;
			const luma = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
			if (luma <= 24) black++;
			else if (luma >= 235) white++;
		}
		if (total === 0) return null;
		if (black / total >= 0.6 && white / total < 0.05) return 'black';
		if (white / total >= 0.6 && black / total < 0.05) return 'white';
		return null;
	},

	// Same-origin SVG cannot taint, so a raw URL fallback is unnecessary
	GENERIC_ICON_URL: 'icons/page.svg',
	_genericIconDataUrlPromise: null,
	// One placeholder image per context, so the capture is memoized and every caller reuses the first result
	getGenericIconDataUrl() {
		if (!this._genericIconDataUrlPromise) {
			this._genericIconDataUrlPromise = new Promise((resolve) => {
				const img = new Image();
				img.onload = async () => {
					try {
						resolve((await BookmarkCache.captureFaviconResult(this.GENERIC_ICON_URL, img)).dataUrl);
					} catch {
						resolve(null);
					}
				};
				img.onerror = () => resolve(null);
				img.src = this.GENERIC_ICON_URL;
			});
		}
		return this._genericIconDataUrlPromise;
	},

	// Defer browser.runtime access because tests may omit it at module load
	isBlankNewTab(tab) {
		const url = tab?.url;
		if (!url) return tab?.title === 'New Tab';
		if (url === 'about:newtab') return true;
		if (!this._newtabUrlPrefix && typeof browser !== 'undefined' && browser.runtime?.getURL) {
			this._newtabUrlPrefix = browser.runtime.getURL('newtab.html');
		}
		if (this._newtabUrlPrefix && url.startsWith(this._newtabUrlPrefix)) return true;
		return tab.title === 'New Tab';
	},

	// Row keys are 128-bit pixel digests. Error rows key by the site itself, which never hex-matches
	isFingerprint(sub) {
		return FINGERPRINT_RE.test(sub);
	},

	// 128-bit SHA-256 prefix as hex: two different favicons collide only by coincidence
	async digestToHex(bytes) {
		const buf = await crypto.subtle.digest('SHA-256', bytes);
		return new Uint8Array(buf).toHex().slice(0, 32);
	},

	// String digest: the source token standing in for a stored original data URL
	digestString(text) {
		return this.digestToHex(new TextEncoder().encode(text));
	},

	// Vector sources pass through instead of rasterizing: data: SVG carries its own bytes, and a .svg URL is expected to be a vector too
	isVectorSource(url) {
		const u = this.normalizeFaviconUrl(String(url));
		return SVG_DATA_RE.test(u) || SVG_URL_RE.test(u);
	},

	// Quality 1 encodes lossless WebP: lossy compression adds noise that can inflate sparse icons
	async _canvasWebpDataUrl(canvas) {
		try {
			const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', 1));
			// Gecko exports PNG when the requested type has no encoder. Check rather than assume
			if (!blob || blob.type !== 'image/webp') return null;
			return 'data:image/webp;base64,' + new Uint8Array(await blob.arrayBuffer()).toBase64();
		} catch {
			return null;
		}
	},

	_storageKey(recordKey) {
		return this.KEY_PREFIX + recordKey;
	},

	// mode: 'record' for non-favicon cache keys, 'favicon' for the bm:fi: rows
	_collectCacheKeys(mode) {
		const keys = [];
		const rowPrefix = this.KEY_PREFIX + 'fi:';
		for (let i = localStorage.length - 1; i >= 0; i--) {
			const storageKey = localStorage.key(i);
			const isFavicon = storageKey.startsWith(rowPrefix);
			if (mode === 'record' && isFavicon) continue;
			if (mode === 'favicon' && !isFavicon) continue;
			if (mode !== 'favicon' && !storageKey.startsWith(this.KEY_PREFIX)) continue;
			keys.push(storageKey);
		}
		return keys;
	},

	_parseRecord(storageKey) {
		try {
			return JSON.parse(localStorage.getItem(storageKey));
		} catch {
			return null;
		}
	},

	// Bypass the mirror so a wiped store is detectable
	async getStored(key) {
		return this._parseRecord(this._storageKey(key));
	},

	// Tolerate a full quota: the in-memory state still serves the session
	safeSetItem(key, value) {
		try {
			localStorage.setItem(key, value);
			this._storageWarningKeys.delete(key);
			return true;
		} catch (e) {
			const isQuota = e?.name === 'QuotaExceededError' || e?.code === 22;
			if (!isQuota || !this._storageWarningKeys.has(key)) {
				console.warn('[Storage] write failed:', key, e);
				if (isQuota) this._storageWarningKeys.add(key);
			}
			return false;
		}
	},

	safeRemoveItem(key) {
		try {
			localStorage.removeItem(key);
		} catch {}
	},

	// The tree record is stored deflate-raw compressed, native in Firefox 113 and above
	async encodeTree(nested) {
		const bytes = new TextEncoder().encode(JSON.stringify(nested));
		const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
		return new Uint8Array(await new Response(stream).arrayBuffer()).toBase64();
	},

	// Corrupt compressed data degrades to the missing-tree path
	async decodeTree(record) {
		try {
			const stream = new Blob([Uint8Array.fromBase64(record.tree)]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
			const out = await new Response(stream).arrayBuffer();
			return JSON.parse(new TextDecoder().decode(out));
		} catch (e) {
			console.warn('[BookmarkCache] tree decode failed:', e);
			return null;
		}
	},

	// The tree record expands into folder records. Every other record lands as-is
	// Callers that just built the tree pass their folderRecords so it is not decoded and flattened twice
	async _applyRecordToMirror(cache, record, folderRecords = null) {
		if (record.key === 'tree' && record.tree) {
			let records = folderRecords;
			if (!records) {
				const tree = await this.decodeTree(record);
				if (!tree) return;
				records = this.flattenTree([tree], true);
			}
			for (let f = 0; f < records.length; f++) {
				const {key, value} = records[f];
				cache.set(key, {...value, key});
			}
		} else {
			cache.set(record.key, record);
		}
	},

	// Exclude favicon records so the bookmark mirror stays small. The tree record expands into folder records
	async loadAllData(force = false) {
		if (!force && this._allDataCache) return this._allDataCache;

		const cache = new Map();
		const keys = this._collectCacheKeys('record');
		for (let i = 0; i < keys.length; i++) {
			const record = this._parseRecord(keys[i]);
			if (!record || typeof record !== 'object') continue;
			// The storage key is the record key, so the stored value never repeats it
			record.key = keys[i].slice(this.KEY_PREFIX.length);
			await this._applyRecordToMirror(cache, record);
		}
		this._allDataCache = cache;
		return cache;
	},

	async get(key) {
		if (!this._allDataCache) await this.loadAllData();
		return this._allDataCache.get(key);
	},

	async getFolder(folderId) {
		return (await this.get(`folder:${folderId}`)) || null;
	},

	async put(key, value) {
		this.safeSetItem(this._storageKey(key), JSON.stringify(value));
		// Keep favicon rows out of the bookmark mirror. The mirror carries the key, storage does not
		if (this._allDataCache && !key.startsWith('fi:')) {
			this._allDataCache.set(key, {...value, key});
		}
	},

	// Sweeps only bm: records, so cache.<id>, open.*, and non-extension keys survive
	async replaceAll(records, folderRecords = null) {
		const stale = this._collectCacheKeys('record');
		for (let i = 0; i < stale.length; i++) localStorage.removeItem(stale[i]);
		this._allDataCache = new Map();
		for (let i = 0; i < records.length; i++) {
			const {key, value} = records[i];
			this.safeSetItem(this._storageKey(key), JSON.stringify(value));
			await this._applyRecordToMirror(this._allDataCache, {...value, key}, folderRecords);
		}
	},

	async getCacheStatus() {
		try {
			const syncRecord = await this.get('meta:lastSync');
			const lastSync = syncRecord?.value ?? null;

			return {valid: lastSync !== null, lastSync};
		} catch {
			return {valid: false, lastSync: null};
		}
	},

	// A mirror without folder:0 holds no tree
	treeUsable() {
		return !!this._allDataCache?.has('folder:0');
	},

	async clear() {
		const keys = this._collectCacheKeys('all');
		for (let i = 0; i < keys.length; i++) localStorage.removeItem(keys[i]);
		this._allDataCache = new Map();
		this._faviconCache = new Map();
	},

	// No storage handle exists. Kept as a deliberate test-only API
	close() {},

	// Reset runtime state between tests
	resetForTest() {
		this._allDataCache = null;
		this._faviconCache = null;
		this._faviconPromise = null;
		this._genericIconDataUrlPromise = null;
		this._storageWarningKeys.clear();
		this._urlPartsCache.clear();
		this._newtabUrlPrefix = '';
		this._ownUrlPrefix = null;
	},

	// Derive URL parts here, lazily and off the record's own shape: every later walk reads them instead of re-parsing, and nothing persisted can carry them
	// In-place decode: links and child arrays are reused
	flattenTree(tree, inPlace = false) {
		const records = [];

		function processNode(node, parentId, id = node.id) {
			if (!node.url) {
				const nodeChildren = node.children || [];
				const childLen = nodeChildren.length;
				const children = inPlace ? nodeChildren : new Array(childLen);
				if (!inPlace) {
					for (let j = 0; j < childLen; j++) {
						const child = nodeChildren[j];
						// Links inherit the accessor, folders stay plain
						const entry = child.url ? Object.create(LINK_ENTRY_PROTO) : {};
						entry.id = child.id;
						entry.title = child.title;
						entry.url = child.url;
						if (!child.url) entry.isFolder = true;
						children[j] = entry;
					}
				}

				records.push({
					key: 'folder:' + id,
					value: {
						id: id,
						title: node.title,
						parentId: parentId,
						children: children,
					},
				});

				for (let i = 0; i < childLen; i++) {
					const child = nodeChildren[i];
					if (!child.url) {
						processNode(child, id);
						if (inPlace) nodeChildren[i] = {id: child.id, title: child.title, url: child.url, isFolder: true};
					}
				}
			}
		}

		// Normalize Firefox's root ID to '0'
		if (tree.length > 0) {
			processNode(tree[0], null, '0');
		}

		return records;
	},

	// Serialize the tree as one nested record: folder nodes carry children, leaves carry url
	nestTree(tree) {
		const convert = (node, isRoot) => {
			const id = isRoot ? '0' : node.id;
			if (node.url) return {id, title: node.title, url: node.url};
			const children = (node.children || []).map((child) => convert(child, false));
			return {id, title: node.title, children};
		};
		return tree.length > 0 ? convert(tree[0], true) : {id: '0', title: '', children: []};
	},

	// FNV-1a over a record string: validity check for the stored tree and the sync hash, base36
	treeChecksum(treeValue) {
		let h = 2166136261;
		for (let i = 0, len = treeValue.length; i < len; i++) h = Math.imul(h ^ treeValue.charCodeAt(i), 16777619);
		return (h >>> 0).toString(36);
	},

	// Verify the records a hash match was computed from, so a record edited outside this extension is rewritten instead of trusted
	async storedCacheIntact() {
		const syncRecord = await this.getStored('meta:lastSync');
		if (typeof syncRecord?.value !== 'number') return false;
		const treeRecord = await this.getStored('tree');
		return !!treeRecord?.tree && treeRecord.sum === this.treeChecksum(treeRecord.tree);
	},

	// Skip the write when the content hash is unchanged
	async fullSync() {
		const tree = await browser.bookmarks.getTree();

		const nested = this.nestTree(tree);
		const folderRecords = this.flattenTree([nested]);
		// Match the Content input: 15 by default and 50 maximum
		const raw = Number(localStorage.getItem('options.number_recent'));
		const recentLimit = raw > 0 ? Math.min(raw, RECENT_MAX_LIMIT) : RECENT_DEFAULT_LIMIT;
		const recentBookmarks = this.extractRecentBookmarks(tree, recentLimit);
		// The record is sync-owned and stays deleted while the folder is disabled. Default is enabled
		const showRecent = localStorage.getItem('options.show_recent');
		const recentEnabled = showRecent == null || Number(showRecent) !== 0;

		// Reclaim favicon rows whose bookmark no longer exists
		const liveKeys = new Set();
		for (let i = 0; i < folderRecords.length; i++) {
			const children = folderRecords[i].value?.children;
			if (!children) continue;
			for (let j = 0; j < children.length; j++) {
				const child = children[j];
				if (!child.url) continue;
				const info = child.urlParts ?? this.urlPartsFor(child);
				if (info.key) liveKeys.add(info.key);
			}
		}
		this._sweepFaviconRows((site) => liveKeys.has(site), true);

		const hash = this.computeSyncHash(folderRecords, recentBookmarks);
		const storedHashRecord = await this.getStored('meta:hash');
		// A matching hash only says the live tree is unchanged, so the stored records are verified too before the write is skipped
		if (storedHashRecord?.value === hash && (await this.storedCacheIntact())) {
			if (recentEnabled) await this.reconcileRecentCache(recentLimit, recentBookmarks);
			return folderRecords.length;
		}

		const now = Date.now();
		const treeValue = await this.encodeTree(nested);
		const allRecords = [
			{key: 'tree', value: {tree: treeValue, sum: this.treeChecksum(treeValue)}},
			{key: 'meta:lastSync', value: {value: now}},
			{key: 'meta:hash', value: {value: hash}},
		];

		await this.replaceAll(allRecords, folderRecords);
		// The page paints cache.recent directly so the sync owns that record
		if (recentEnabled) this.safeSetItem('cache.recent', JSON.stringify({limit: recentLimit, data: recentBookmarks}));
		return folderRecords.length;
	},

	// cache.recent has one writer, so a lost or limit-stale record must heal even when the hash matches
	async reconcileRecentCache(recentLimit, recentBookmarks) {
		let parsed = null;
		try {
			parsed = JSON.parse(localStorage.getItem('cache.recent'));
		} catch {}
		const stale = !parsed || parsed.limit !== recentLimit || !Array.isArray(parsed.data) || parsed.data.length !== recentBookmarks.length;
		if (stale) {
			this.safeSetItem('cache.recent', JSON.stringify({limit: recentLimit, data: recentBookmarks}));
		}
	},

	// Hash the complete sync payload so omitted fields cannot leave stale records
	computeSyncHash(folderRecords, recentBookmarks) {
		return this.treeChecksum(JSON.stringify({folderRecords, recentBookmarks}));
	},

	extractRecentBookmarks(tree, limit = RECENT_DEFAULT_LIMIT) {
		const bookmarks = [];

		function collectBookmarks(node) {
			if (node.url && node.dateAdded) {
				bookmarks.push({
					id: node.id,
					title: node.title,
					url: node.url,
					dateAdded: node.dateAdded,
				});
			}
			if (node.children) {
				for (let i = 0; i < node.children.length; i++) {
					const child = node.children[i];
					collectBookmarks(child);
				}
			}
		}

		for (let i = 0; i < tree.length; i++) {
			const node = tree[i];
			collectBookmarks(node);
		}

		bookmarks.sort((a, b) => b.dateAdded - a.dateAdded);
		return bookmarks.slice(0, limit);
	},

	// Use one record shape for cached and live closed sessions
	shapeClosedSession(session) {
		if (session.window?.tabs.length === 1) session.tab = session.window.tabs[0];
		return {
			sessionId: session.window?.sessionId ?? session.tab?.sessionId,
			title: session.tab?.title ?? (session.window ? `${session.window.tabs?.length ?? 0} Tabs` : 'Closed'),
			url: session.tab?.url ?? null,
			isWindow: !!session.window,
		};
	},

	// An untagged view decides freshness instead of a TTL. One view per site rebuilds from the rows, keeping paint and background skip checks per-site
	async loadFavicons(force = false) {
		if (!force && this._faviconCache) return this._faviconCache;
		if (this._faviconPromise) return this._faviconPromise;
		const promise = (async () => {
			const cache = new Map();
			const keys = this._collectCacheKeys('favicon');
			for (let i = 0; i < keys.length; i++) {
				const sub = keys[i].slice(this.KEY_PREFIX.length + 3);
				const record = this._parseRecord(keys[i]);
				if (!record || typeof record !== 'object') continue;
				if (!this.isFingerprint(sub) && record.provider === 'error') {
					// Per-site rows: error sentinels carry their record under the site key
					cache.set(sub, {dataUrl: null, provider: 'error', srcId: record.srcId ?? null, lumaClass: null});
					continue;
				}
				if (!record.image || !Array.isArray(record.sites)) continue;
				const srcs = record.srcs ?? null;
				for (let j = 0; j < record.sites.length; j++) {
					const site = record.sites[j];
					const srcId = ((srcs && srcs[site]) || record.srcId) ?? null;
					cache.set(site, {dataUrl: record.image, provider: record.provider ?? null, srcId, lumaClass: record.lumaClass ?? null});
				}
			}
			this._faviconCache = cache;
			return cache;
		})();
		this._faviconPromise = promise;
		try {
			return await promise;
		} finally {
			if (this._faviconPromise === promise) this._faviconPromise = null;
		}
	},

	async getFavicon(origin) {
		return (await this.loadFavicons()).get(origin) ?? null;
	},

	// One row per unique image: digest rows list sites, error rows key the site
	async setFaviconsMany(entries) {
		if (entries.length === 0) return;
		const now = Date.now();
		const rows = new Map();
		const errors = new Map();
		for (let i = 0, len = entries.length; i < len; i++) {
			const e = entries[i];
			if (e.provider === 'error') {
				errors.set(e.origin, e);
				continue;
			}
			const hash = e.hash || (await this.digestString(e.dataUrl));
			let row = rows.get(hash);
			if (!row) rows.set(hash, (row = {canonical: {image: e.dataUrl, srcId: e.srcId ?? null, lumaClass: e.lumaClass ?? null}, sites: [], sources: new Map()}));
			else if (row.canonical.lumaClass === null && e.lumaClass) row.canonical.lumaClass = e.lumaClass;
			row.sites.push(e.origin);
			row.sources.set(e.origin, e.srcId ?? null);
		}
		// Revoke every stored membership in one pass:
		// another context may have a newer row index, and revoking per row walked and parsed the whole favicon store once per written row
		const revoked = [];
		for (const row of rows.values()) {
			for (let i = 0, len = row.sites.length; i < len; i++) revoked.push(row.sites[i]);
		}
		if (revoked.length > 0) this.removeFaviconSites(revoked);

		for (const [hash, row] of rows) {
			const storageKey = this._storageKey(`fi:${hash}`);
			const stored = this._parseRecord(storageKey);
			// Dedup row sites, absorbing what the other context may have queued concurrently
			const sites = (stored?.sites ?? []).slice();
			for (const site of row.sites) if (!sites.includes(site)) sites.push(site);
			const srcId = stored?.srcId ?? row.canonical.srcId ?? null;
			const lumaClass = stored?.lumaClass ?? row.canonical.lumaClass;
			let srcs = stored?.srcs ? {...stored.srcs} : {};
			// Token-keyed rows drop srcId and carry tokens in srcs
			const tokenKeyed = srcId !== null && srcId === hash;
			for (const site of row.sites) {
				const siteSrc = row.sources.get(site);
				if (srcId !== null && siteSrc && srcs[site] !== siteSrc && (tokenKeyed || siteSrc !== srcId)) srcs[site] = siteSrc;
			}
			const record = {image: row.canonical.image, sites, lumaClass, cachedAt: stored?.cachedAt ?? now};
			if (!tokenKeyed) record.srcId = srcId;
			if (Object.keys(srcs).length > 0) record.srcs = srcs;
			// Skip the write when the stored row already carries the same content
			if (
				!stored ||
				JSON.stringify([stored.image, stored.sites, stored.srcId ?? null, stored.srcs ?? null, stored.lumaClass ?? null]) !==
					JSON.stringify([record.image, record.sites, record.srcId ?? null, record.srcs ?? null, record.lumaClass ?? null])
			) {
				this.safeSetItem(storageKey, JSON.stringify(record));
			}
			for (const [site, src] of row.sources) this._faviconCache?.set(site, {dataUrl: record.image, provider: null, srcId: src || srcs[site] || record.srcId || null, lumaClass});
		}
		if (errors.size > 0) {
			// Never overwrite an acceptable cached view with an error sentinel
			const sentinels = [];
			for (const [site, e] of errors) {
				const view = this._faviconCache?.get(site);
				if (view && !view.provider) continue;
				sentinels.push([site, e]);
			}
			if (sentinels.length > 0) {
				this.removeFaviconSites(sentinels.map(([site]) => site));
				for (let i = 0, len = sentinels.length; i < len; i++) {
					const [site, e] = sentinels[i];
					this.safeSetItem(this._storageKey(`fi:${site}`), JSON.stringify({provider: 'error', srcId: e.srcId ?? null}));
					this._faviconCache?.set(site, {dataUrl: null, provider: 'error', srcId: e.srcId ?? null, lumaClass: null});
				}
			}
		}
	},

	// Strip site memberships across rows. Deletion heals by fall-through to the origin default on read
	removeFaviconSites(sites) {
		if (sites.length === 0) return;
		const remove = new Set(sites);
		this._sweepFaviconRows((site) => !remove.has(site), false);
	},

	// One pass over the favicon rows: drop rows whose site is gone and strip dead memberships in place.
	// The sync reclaim and every revocation share it so no caller parses the store twice
	_sweepFaviconRows(isLive, dropMalformed) {
		const rowPrefix = this.KEY_PREFIX + 'fi:';
		const keys = this._collectCacheKeys('favicon');
		for (let i = 0; i < keys.length; i++) {
			const storageKey = keys[i];
			const sub = storageKey.slice(rowPrefix.length);
			const stored = this._parseRecord(storageKey);
			if (!stored || typeof stored !== 'object') {
				if (dropMalformed) localStorage.removeItem(storageKey);
				continue;
			}
			// Per-site rows carry their sentinel under the site key; a digest-keyed row without an image is dead
			if (stored.provider === 'error' && !stored.image) {
				if (this.isFingerprint(sub)) {
					if (dropMalformed) localStorage.removeItem(storageKey);
					continue;
				}
				if (isLive(sub)) continue;
				this.safeRemoveItem(storageKey);
				this._faviconCache?.delete(sub);
				continue;
			}
			if (!stored.image || !Array.isArray(stored.sites)) {
				if (dropMalformed) localStorage.removeItem(storageKey);
				continue;
			}
			const keep = stored.sites.filter(isLive);
			if (keep.length === stored.sites.length) continue;
			if (keep.length === 0) {
				this.safeRemoveItem(storageKey);
			} else {
				this.safeSetItem(storageKey, JSON.stringify({...stored, sites: keep}));
			}
			for (let j = 0, len = stored.sites.length; j < len; j++) {
				const site = stored.sites[j];
				if (!isLive(site)) this._faviconCache?.delete(site);
			}
		}
	},
};

export {BookmarkCache};
