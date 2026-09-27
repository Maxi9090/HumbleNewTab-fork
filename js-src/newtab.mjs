import {BookmarkCache} from './bookmark-cache.mjs';
import {themes} from './themes.mjs';
import {applyFavicon, refreshOpenTabsFavicons} from './favicons-ui.mjs';
import {getConfig, setConfig, config, applyTheme, notifyConfigChange, addConfigChangeListener} from './config-engine.mjs';

const TAB_OPEN_MODE = Object.freeze({
	FOREGROUND: 1,
	BACKGROUND: 2,
});

// Prefix match so a listed page with a path or query is still covered; no other about: page crashes
const CRASH_URL = /^(?:about:(?:certificate|keyboard|logins|newtab|pdf|protections|studies|translations)|file:)/;

// Tell the background a page is booting so it keeps its work off this boot, and off the close that preceded it
browser.runtime.sendMessage({type: 'newtab-booting'}).catch(() => {});

// Defer rendering while the page is hidden or busy
let uiBusy = false;
let pendingBookmarkRender = false;
let bookmarkRenderFailureHash = null;
let bookmarkRenderRecoveryUsed = false;
let detailsMenuActive = false;
let detailsPersistentElement = null;

function clearDetailsHighlight() {
	if (!detailsPersistentElement) return;
	detailsPersistentElement.classList.remove('details-active', 'column-details-active', 'menu-active', 'column-menu-active');
	detailsPersistentElement = null;
}

function setDetailsHighlight(element) {
	if (!detailsMenuActive || !element) return;
	if (detailsPersistentElement !== element) {
		clearDetailsHighlight();
		detailsPersistentElement = element;
	}
	element.classList.add(element.classList.contains('column') ? 'column-details-active' : 'details-active');
}

function setDetailsMenuActive(value) {
	const active = !!value;
	if (active === detailsMenuActive) return;
	clearDetailsHighlight();
	detailsMenuActive = active;
	if (!active) return;
	const stale = document.querySelectorAll('#main a.menu-active, #main .column-menu-active');
	for (let i = 0, len = stale.length; i < len; i++) stale[i].classList.remove('menu-active', 'column-menu-active');
}

function setMenuActive(a) {
	a.classList.add('menu-active');
	// The native menu consumes its own dismissal, so the highlight clears on the first Escape or pointer event the page sees
	const remove = () => {
		a.classList.remove('menu-active');
		document.removeEventListener('mousedown', remove, true);
		document.removeEventListener('click', remove, true);
		document.removeEventListener('keydown', removeOnEscape, true);
		document.removeEventListener('keyup', removeOnEscape, true);
		window.removeEventListener('blur', remove);
	};
	const removeOnEscape = (e) => {
		if (e.key === 'Escape') remove();
	};
	document.addEventListener('mousedown', remove, {capture: true, passive: true});
	document.addEventListener('click', remove, {capture: true, passive: true});
	document.addEventListener('keydown', removeOnEscape, {capture: true, passive: true});
	document.addEventListener('keyup', removeOnEscape, {capture: true, passive: true});
	// A taskbar or other-window click leaves the page without a document event at all
	window.addEventListener('blur', remove);
}

function restoreMenuActive(target, href) {
	if (!href) return;
	const link = [...target.querySelectorAll('a[href]')].find((a) => a.getAttribute('href') === href);
	if (link) setMenuActive(link);
}

let loadGeneration = 0;

let deferredFolderLinks = [];

async function applyBookmarkUpdate() {
	// Compare the stored hash: rebuilding the mirror first made a changed update rebuild it twice
	const storedHash = await BookmarkCache.getStored('meta:hash');
	const newHash = storedHash?.value ?? '';
	if (newHash === lastRenderedHash) return;
	if (document.hidden || uiBusy) {
		pendingBookmarkRender = true;
		return;
	}
	if (bookmarkRenderFailureHash !== newHash) {
		bookmarkRenderFailureHash = newHash;
		bookmarkRenderRecoveryUsed = false;
	}
	let loaded = false;
	try {
		loaded = await loadColumns(true);
	} catch (error) {
		console.error('[BookmarkCache] Bookmark render failed:', error);
	}
	if (!loaded && !bookmarkRenderRecoveryUsed) {
		bookmarkRenderRecoveryUsed = true;
		console.warn('[BookmarkCache] Retrying bookmark render once:', newHash);
		try {
			loaded = await loadColumns(true);
		} catch (error) {
			console.error('[BookmarkCache] Bookmark render recovery failed:', error);
		}
	}
	if (loaded) {
		lastRenderedHash = newHash;
		bookmarkRenderFailureHash = null;
		bookmarkRenderRecoveryUsed = false;
	} else {
		console.error('[BookmarkCache] Bookmark render continues to fail:', newHash);
	}
}

async function drainPendingBookmarkRender() {
	if (!pendingBookmarkRender || uiBusy || document.hidden) return;
	pendingBookmarkRender = false;
	await applyBookmarkUpdate();
}

// Use a setter because imported ESM bindings are read-only
function setUiBusy(value) {
	uiBusy = value;
}

function readSpecialFolderCache(id, limit) {
	try {
		const parsed = JSON.parse(localStorage.getItem(`cache.${id}`));
		// A record written with a higher limit serves smaller ones. Below it falls to the live path
		if (!parsed || !Array.isArray(parsed.data) || parsed.limit < limit) return null;
		return parsed.data.slice(0, limit);
	} catch {
		return null;
	}
}

function writeSpecialFolderCache(id, limit, data) {
	BookmarkCache.safeSetItem(`cache.${id}`, JSON.stringify({limit, data}));
}

const SpecialFolders = {
	defs: {
		top: {title: 'Most visited', configKey: 'number_top', max: 50},
		recent: {title: 'Recent bookmarks', configKey: 'number_recent', max: 50},
		closed: {title: 'Recently closed tabs', configKey: 'number_closed', max: 25},
		windows: {title: 'Recently closed windows', configKey: 'number_windows', max: 25},
	},

	all: ['top', 'recent', 'closed', 'windows'],

	isSpecial(id) {
		return this.all.includes(id);
	},

	async fetchChildrenOfSpecialFolder(id) {
		const def = this.defs[id];
		const raw = Number(getConfig(def.configKey));
		const limit = raw > 0 ? Math.min(raw, def.max) : 15;

		if (id === 'closed' || id === 'windows') return this._fetchClosedSessions(id, limit);
		if (id === 'top') return this._fetchTopSites(limit);

		const cached = readSpecialFolderCache(id, limit);
		return cached ?? [];
	},

	// Fetch topSites in the page because the background cannot cache it
	async _fetchTopSites(limit) {
		if (!browser.topSites?.get) return [];
		try {
			const sites = await browser.topSites.get();
			const data = sites
				.filter((s) => s.url)
				.map((s) => ({title: s.title || s.url, url: s.url}))
				.slice(0, limit);
			writeSpecialFolderCache('top', limit, data);
			return data;
		} catch (error) {
			console.warn('[SpecialFolders] topSites fetch failed:', error);
			return [];
		}
	},

	// Use the background cache, falling back to a live query only while no record exists
	async _fetchClosedSessions(kind, limit) {
		const cached = readSpecialFolderCache(kind, limit);
		if (cached) return this._hydrateClosed(cached);
		try {
			const sessions = await browser.sessions.getRecentlyClosed({maxResults: Math.min(limit, 25)});
			const list = [];
			for (let i = 0, len = sessions.length; i < len; i++) {
				const raw = sessions[i];
				// Each folder owns one half of Firefox's recently closed list
				if (kind === 'windows' ? !raw.window : !raw.tab) continue;
				list.push(BookmarkCache.shapeClosedSession(raw));
			}
			writeSpecialFolderCache(kind, limit, list);
			return this._hydrateClosed(list);
		} catch (error) {
			console.warn('[SpecialFolders] sessions fetch failed:', error);
			// The background may have written the record while this fetch was in flight
			const fallback = readSpecialFolderCache(kind, limit);
			return fallback ? this._hydrateClosed(fallback) : [];
		}
	},

	_hydrateClosed(data) {
		const len = data.length;
		const result = new Array(len);
		for (let i = 0; i < len; i++) {
			const item = data[i];
			result[i] = {
				...item,
				// Windows have no URL to resolve; the class drives the window.svg mask
				className: item.isWindow ? 'window' : '',
				action: () => {
					void (async () => {
						try {
							// The background rewrites cache.closed on the restore and then broadcasts, which repaints the folder
							await browser.sessions.restore(item.sessionId);
						} catch (error) {
							console.warn('[SpecialFolders] closed session restore failed:', error);
						}
					})();
					return false;
				},
			};
		}
		return result;
	},
};

const special = SpecialFolders.all;

let cacheLoadError = null;

async function getRootFolderIds() {
	const folder = await BookmarkCache.getFolder('0');
	return folder?.children?.filter((c) => c.isFolder).map((c) => c.id) ?? [];
}

function forEachColumnEntry(fn) {
	for (let x = 0; ; x++) {
		let foundInRow = false;
		for (let y = 0; ; y++) {
			const id = localStorage.getItem(`column.${x}.${y}`);
			if (id) {
				foundInRow = true;
				if (fn(x, y, id) === false) return;
			} else {
				break;
			}
		}
		if (!foundInRow) break;
	}
}

// Return null when the folder no longer exists
async function getChildren_internal(id) {
	if (SpecialFolders.isSpecial(id)) {
		return SpecialFolders.fetchChildrenOfSpecialFolder(id);
	}

	let children;
	try {
		const folder = await BookmarkCache.getFolder(id);
		children = folder ? folder.children : null;
	} catch (e) {
		console.error(`[BookmarkCache] Error loading folder ${id}:`, e);
		cacheLoadError = e;
		children = [];
	}

	if (children) {
		for (let i = 0, len = children.length; i < len; i++) {
			if (children[i].isFolder) children[i].children = true;
		}
	}
	return children;
}

function render(node, target, readyTasks = null) {
	const li = document.createElement('li');
	const a = document.createElement('a');
	const {url, children, id} = node;

	if (url) {
		a.href = url;
		a.tabIndex = -1;
	} else {
		a.tabIndex = 0;
	}

	a.textContent = node.title ?? url ?? '';

	setClass(a, node);
	if (url) {
		applyFavicon(url, a);
	}

	const newtab = url ? getConfig('newtab') : 0;

	if (url) {
		// Keep hover visible while native context menu is open, also for action anchors (Recently closed)
		a.oncontextmenu = (e) => {
			setDetailsHighlight(a);
			if (CRASH_URL.test(url)) {
				showToast('Warning', 'Choosing "Open Link in New Tab" in the context menu for this URL can crash Firefox');
				// The toast is every click, the menu block is once per anchor per page load
				if (!privilegedMenuBlocked.has(a)) {
					privilegedMenuBlocked.add(a);
					e.preventDefault();
					return false;
				}
			}
			setMenuActive(a);
		};
	}

	if (node.action) {
		a.onclick = node.action;
	} else if (url) {
		if (newtab === TAB_OPEN_MODE.FOREGROUND) {
			a.target = '_blank';
		} else if (newtab === TAB_OPEN_MODE.BACKGROUND) {
			a.onclick = () => {
				openLink(node);
				return false;
			};
		}
		// Use clipboard fallback for privileged and foreign extension URLs
		if (BookmarkCache.isPrivilegedScheme(url) || BookmarkCache.isForeignExtensionUrl(url)) {
			a.onclick = () => {
				openLink(node);
				return false;
			};
			a.onauxclick = (e) => {
				if (e.button === 1) {
					openLink(node);
					return false;
				}
			};
		}
	} else if (!children) {
		a.style.pointerEvents = 'none';
	}

	li.append(a);

	if (children) {
		li.dataset.nodeId = id;
		if (!getConfig('lock')) a.draggable = true;

		const shouldBeOpen = getConfig('remember_open') && localStorage.getItem(`open.${id}`);
		if (shouldBeOpen) {
			setClass(a, node, true);
			a.open = true;
			if (Array.isArray(children)) {
				const childList = renderAll(children, li, false, false);
				readyTasks?.push(childList._renderReady);
			} else if (SpecialFolders.isSpecial(id)) {
				a.dataset.deferred = 'true';
				deferredFolderLinks.push(a);
				const cached = readSpecialFolderCache(id, getConfig(SpecialFolders.defs[id].configKey));
				if (cached) {
					const painted = id === 'closed' ? SpecialFolders._hydrateClosed(cached) : cached;
					a._cachedPainted = painted;
					const childList = renderAll(painted, li, false, false);
					readyTasks?.push(childList._renderReady);
				}
			} else {
				const task = (async () => {
					const folderChildren = await getChildren_internal(id);
					if (a.open && !a.nextSibling) {
						const childList = renderAll(folderChildren || [], li, false, false);
						await childList._renderReady;
					}
				})();
				readyTasks?.push(task);
			}
		}
		addFolderHandlers(node, a);
	}

	target.append(li);
	return li;
}

function renderAll(nodes, target, toplevel, precollapse) {
	const fragment = document.createDocumentFragment();
	const ul = document.createElement('ul');
	const readyTasks = [];

	for (let i = 0, len = nodes.length; i < len; i++) {
		const node = nodes[i];
		// Avoid duplicate layout entries inside their parent
		if (toplevel || !coords[node.id]) render(node, ul, readyTasks);
	}
	if (!ul.firstChild) render({id: 'empty', title: '< Empty >'}, ul, readyTasks);
	ul._renderReady = Promise.all(readyTasks);
	if (toplevel) {
		fragment.append(ul);
	} else {
		// Pre-collapse animated folders to prevent a one-frame flash
		const wrap = document.createElement('div');
		if (precollapse) {
			wrap.style.gridTemplateRows = '0fr';
			wrap.style.opacity = '0';
			wrap.style.overflow = 'hidden';
		}
		wrap.append(ul);
		fragment.append(wrap);
	}
	target.append(fragment);
	if (toplevel) updateTooltips();
	return ul;
}

async function renderColumn(index, target) {
	const ids = columns[index];
	if (ids.length === 1 && !getConfig('show_root')) {
		// Hide the root when one folder is shown and show_root is disabled
		const result = await getChildren({id: ids[0]});
		renderAll(result, target, false, false);
		addColumnHandlers(index, target);
	} else if (ids.length > 0) {
		const nodes = await Promise.all(ids.map(getSubTree));
		renderAll(nodes.flat(), target, true);
		addColumnHandlers(index, target);
	}
}

let mainElement = null;

function getMainElement() {
	return (mainElement ??= document.getElementById('main'));
}

async function renderColumns() {
	const target = getMainElement();
	deferredFolderLinks = [];
	target.replaceChildren();

	const columnCount = columns.length;
	// Set the shared column count with one style write
	target.style.setProperty('--columns', String(columnCount));

	const columnElements = new Array(columnCount);
	const fragment = document.createDocumentFragment();
	for (let i = 0; i < columnCount; i++) {
		const column = document.createElement('div');
		column.className = 'column';
		if (!getConfig('lock')) column.draggable = true;
		fragment.append(column);
		columnElements[i] = column;
	}
	target.append(fragment);

	wireMainDragDelegation();

	await Promise.all(columnElements.map((el, i) => renderColumn(i, el)));

	dropWire?.();
}

// Expand deferred special folders after the first paint
async function expandDeferredFolders() {
	const links = deferredFolderLinks;
	deferredFolderLinks = [];
	if (links.length === 0) return;

	await Promise.all(
		links.map(async (a) => {
			const li = a.parentNode;
			const nodeId = li?.dataset?.nodeId;
			if (!nodeId || !a.open) return;
			delete a.dataset.deferred;
			const children = await getChildren({id: nodeId, children: true});
			if (!a.open) return;
			// Record what the DOM shows so a refresh of the same list can skip a rebuild
			const signature = JSON.stringify(children);
			a._specialPainted = signature;
			const wrap = a.nextSibling;
			if (!wrap) {
				renderAll(children, li, false, false);
				return;
			}
			// Repaint cached content only when the fetched list differs
			if (signature !== JSON.stringify(a._cachedPainted)) {
				wrap.firstChild.replaceChildren();
				renderAll(children, wrap.firstChild, false, false);
			}
		}),
	);
}

function addFolderHandlers(node, a) {
	a._toggle = () => toggle(node, a);
	a.onclick = () => {
		toggle(node, a);
		return false;
	};

	a.oncontextmenu = (e) => {
		setDetailsHighlight(a);
		a.classList.add('menu-active');
		// Build menu items at click time so the lazy drag handlers are available
		const items = [
			{
				label: 'Open all links in folder',
				action: () => {
					if (confirm('Open every link in this folder?')) openLinks(node);
				},
			},
		];
		if (!getConfig('lock')) {
			const folderHooks = {addColumn, addRow, removeRow, getColumns: () => columns, getCoords: () => coords, getRootSet: () => rootSet};
			const lockItems = lockFolderMenuItems?.(node, folderHooks);
			if (lockItems) for (let i = 0, n = lockItems.length; i < n; i++) items.push(lockItems[i]);
		}
		renderMenu(items, e.pageX, e.pageY, () => a.classList.remove('menu-active'));
		return false;
	};
}

function addColumnHandlers(index, ul) {
	const ids = columns[index];

	// Build menu items at click time so the lazy drag handlers are available
	ul.oncontextmenu = (e) => {
		if (e.target.tagName === 'A' || e.target.parentNode.tagName === 'A') return true;
		const items = [];
		const lockItems = lockMenuItems?.(index, ids);
		if (lockItems) for (let i = 0, n = lockItems.length; i < n; i++) items.push(lockItems[i]);
		if (items.length === 0) return true;
		const column = ul.closest('.column');
		if (column) setDetailsHighlight(column);
		renderMenu(items, e.pageX, e.pageY, () => {
			if (column) column.classList.remove('column-menu-active');
		});
		if (column) column.classList.add('column-menu-active');
		return false;
	};
}

let currentMenu = null; // renderMenu keeps only one menu open

function renderMenu(items, x, y, onClose) {
	if (currentMenu) closeMenu(currentMenu);
	const ul = document.createElement('ul');
	ul.className = 'menu';

	const fragment = document.createDocumentFragment();
	const len = items.length;
	const lastIndex = len - 1;
	for (let i = 0; i < len; i++) {
		const item = items[i];
		if (!item) {
			if (i > 0 && i < lastIndex) {
				const li = document.createElement('li');
				li.append(document.createElement('hr'));
				fragment.append(li);
			}
			continue;
		}
		const li = document.createElement('li');
		const a = document.createElement('a');
		a.textContent = item.label;
		a.tabIndex = 0;
		a.onclick = () => {
			closeMenu(ul);
			item.action();
			return false;
		};
		li.append(a);
		fragment.append(li);
	}
	ul.append(fragment);

	document.body.append(ul);
	ul.style.left = `${Math.max(Math.min(x, window.innerWidth + window.scrollX - ul.clientWidth), 0)}px`;
	ul.style.top = `${Math.max(Math.min(y, window.innerHeight + window.scrollY - ul.clientHeight), 0)}px`;
	ul.style.transitionDuration = `${getConfig('fade') / 4}s`;
	ul.onmousedown = (e) => {
		e.stopPropagation();
		return true;
	};

	currentMenu = ul;
	ul._onClose = onClose;
	// A painted frame of the closed state first, so the entrance transition has a starting point
	requestAnimationFrame(() => {
		if (currentMenu === ul) ul.classList.add('open');
	});
	return ul;
}

function closeMenu(ul) {
	if (currentMenu === ul) currentMenu = null;
	if (ul._onClose) {
		const onClose = ul._onClose;
		ul._onClose = null;
		onClose();
	}
	ul.classList.remove('open');
	// Keep the element through the leave transition, then drop it
	setTimeout(() => ul.remove(), getConfig('fade') * 1000);
}

// Native menus dismiss on the next interaction, so one permanent listener set replaces per-menu document handlers
const dismissMenu = () => {
	if (currentMenu) closeMenu(currentMenu);
};
document.addEventListener(
	'mousedown',
	(e) => {
		if (currentMenu && !currentMenu.contains(e.target)) dismissMenu();
	},
	{capture: true},
);
document.addEventListener('contextmenu', dismissMenu, {capture: true});
document.addEventListener(
	'keydown',
	(e) => {
		if (e.key === 'Escape') dismissMenu();
	},
	{capture: true},
);
document.addEventListener('wheel', dismissMenu, {capture: true, passive: true});
window.addEventListener('scroll', dismissMenu, {passive: true});
window.addEventListener('blur', dismissMenu);

// Drag handlers remain optional until drag-drop.mjs loads
let dropWire = null;
let lockMenuItems = null;
let lockFolderMenuItems = null;
let disableDragDrop = null;
let handleDragStart = null;
let handleDragEnd = null;
let mainDragWired = false;

function wireMainDragDelegation() {
	if (mainDragWired) return;
	const main = getMainElement();
	main.addEventListener('dragstart', (e) => {
		handleDragStart?.(e);
	});
	main.addEventListener('dragend', () => {
		handleDragEnd?.();
	});
	mainDragWired = true;
}

function wireDragDrop() {
	if (getConfig('lock')) return;
	import('./drag-drop.mjs')
		.then((m) => {
			const slots = m.register({
				addColumn,
				addRow,
				removeRow,
				getMainElement,
				drainPendingBookmarkRender,
				setUiBusy,
				getColumns: () => columns,
				getCoords: () => coords,
				getRootSet: () => rootSet,
			});
			({dropWire, lockMenuItems, lockFolderMenuItems, disableDragDrop, handleDragStart, handleDragEnd} = slots);
			dropWire?.();
		})
		.catch((e) => console.warn('[DragDrop] import failed:', e));
}

let tooltipTimeout = null;

function scheduleTooltipPass() {
	tooltipTimeout = requestIdleCallback(doUpdateTooltips, {timeout: 500});
}

function doUpdateTooltips() {
	tooltipTimeout = null;
	// Wait for animations to finish before reading link layout
	if (uiBusy) {
		scheduleTooltipPass();
		return;
	}
	const links = document.querySelectorAll('#main li a');
	for (let i = 0, len = links.length; i < len; i++) {
		const el = links[i];
		if (el.clientWidth + 1 < el.scrollWidth) {
			if (!el.title) el.title = el.textContent;
		} else if (el.title === el.textContent) {
			el.title = '';
		}
	}
}

// Update truncated-link tooltips during idle time
function updateTooltips() {
	if (tooltipTimeout) cancelIdleCallback(tooltipTimeout);
	scheduleTooltipPass();
}

async function getChildren(node) {
	if (Array.isArray(node.children)) return node.children;

	const children = await getChildren_internal(node.id);
	if (!children && coords[node.id]) {
		removeRow(coords[node.id].x, coords[node.id].y);
	}
	return children || [];
}

async function getSubTree(id) {
	const def = SpecialFolders.defs[id];
	if (def) return [{id, title: def.title, children: true}];

	const folder = await BookmarkCache.getFolder(id);
	if (folder) return [{id: folder.id, title: folder.title, children: true}];
	if (coords[id]) removeRow(coords[id].x, coords[id].y);
	return [];
}

function setClass(target, node, isopen) {
	let className = node.className || '';
	if (node.children) className = className ? `${className} folder` : 'folder';
	if (isopen) className = className ? `${className} open` : 'open';
	if (SpecialFolders.isSpecial(node.id) || node.id === 'empty') {
		className = className ? `${className} ${node.id}` : node.id;
	}
	if (className) target.className = className;
}

async function toggle(node, a) {
	const isopen = a.open;
	setClass(a, node, !isopen);
	a.open = !isopen;

	const openKey = `open.${node.id}`;
	const autoClose = getConfig('auto_close');
	if (isopen) {
		BookmarkCache.safeRemoveItem(openKey);
		if (a.nextSibling) {
			if (autoClose) {
				const wrapper = a.nextSibling.tagName === 'DIV' ? a.nextSibling.firstChild : a.nextSibling;
				const wrapperChildren = wrapper.children;
				for (let i = 0, len = wrapperChildren.length; i < len; i++) {
					const child = wrapperChildren[i].firstChild;
					if (child?.open) child.onclick();
				}
			}
			animate(a, isopen);
		}
	} else {
		BookmarkCache.safeSetItem(openKey, true);
		if (autoClose) {
			const siblings = a.parentNode.parentNode.children;
			for (let i = 0, len = siblings.length; i < len; i++) {
				const sibling = siblings[i].firstChild;
				if (sibling !== a && sibling?.open) sibling.onclick();
			}
		}
		if (a.nextSibling) {
			animate(a, isopen);
		} else {
			const result = await getChildren(node);
			if (!a.nextSibling && a.open) {
				const childList = renderAll(result, a.parentNode, false, true);
				await childList._renderReady;
				if (a.nextSibling && a.open) animate(a, isopen);
			}
		}
	}
}

// Constant speed mode reads the slide time as the time for a folder of this height
const SLIDE_REF_HEIGHT = 300;

function slideDuration(wrap) {
	const slide = getConfig('slide') * 1000;
	// Dynamic height animation: the same time for every folder, so the pace follows the expansion
	if (getConfig('dynamic_height_animation')) return slide;
	// scrollHeight, not clientHeight: a collapsed row track gives the list zero height
	const height = wrap.firstChild.scrollHeight;
	const clamped = Math.min(Math.max(height, SLIDE_REF_HEIGHT / 4), SLIDE_REF_HEIGHT * 4);
	return (slide * clamped) / SLIDE_REF_HEIGHT;
}

function animate(a, isopen) {
	let wrap = a.nextSibling;
	const wrapStyle = wrap.style;
	const duration = slideDuration(wrap);
	uiBusy = true;
	wrapStyle.overflow = 'hidden';
	if (a.animationHandle) {
		clearTimeout(a.animationHandle);
		a.animationHandle = null;
	} else {
		wrapStyle.gridTemplateRows = isopen ? '1fr' : '0fr';
		wrapStyle.opacity = isopen ? '1' : '0';
	}
	// Use two frames so the initial styles are painted first
	requestAnimationFrame(() => {
		requestAnimationFrame(() => {
			if (wrap) {
				wrap.className = 'wrap';
				wrapStyle.transitionDuration = `${duration}ms`;
				wrapStyle.gridTemplateRows = isopen ? '0fr' : '1fr';
				wrapStyle.opacity = isopen ? '0' : '1';
				wrapStyle.pointerEvents = isopen ? 'none' : '';
			}
		});
	});

	// The CSS transition runs for the computed time, so the cleanup waits the same time
	a.animationHandle = setTimeout(() => {
		a.animationHandle = null;
		if (isopen) {
			wrap.remove();
		} else {
			wrap.className = '';
			wrap.removeAttribute('style');
			updateTooltips();
		}
		wrap = null;
		uiBusy = false;
		drainPendingBookmarkRender();
	}, duration);
}

async function openLinks(node) {
	const result = await getChildren(node);
	for (let i = 0, len = result.length; i < len; i++) {
		openLink(result[i]);
	}
}

let toastHideTimer = null;
let privilegedMenuBlocked = new WeakSet(); // One native-menu block per crash-URL anchor per page load

// Test-only reset: replaces the page reload that clears the block state in Firefox
function resetPrivilegedMenuBlockForTest() {
	privilegedMenuBlocked = new WeakSet();
}

function showToast(title, detail) {
	const toast = document.getElementById('toast');
	if (!toast) return;
	toast.replaceChildren();
	const titleEl = document.createElement('div');
	titleEl.className = 'toast-title';
	titleEl.textContent = title;
	toast.append(titleEl);
	if (detail) {
		const detailEl = document.createElement('div');
		detailEl.className = 'toast-detail';
		detailEl.textContent = detail;
		toast.append(detailEl);
	}
	const wasVisible = toast.classList.contains('show');
	if (wasVisible) toast.style.transition = 'none';
	toast.classList.remove('show');
	if (wasVisible) {
		// Commit the hidden state before restarting the entrance transition
		void toast.offsetWidth;
		toast.style.removeProperty('transition');
		void toast.offsetWidth;
	}
	toast.classList.add('show');
	clearTimeout(toastHideTimer);
	toastHideTimer = setTimeout(() => toast.classList.remove('show'), 5000);
}

function copyUrlAndNotify(url, reason) {
	const pasteHint = 'Paste into the address bar (Ctrl+L, Ctrl+V) to open it.';
	const detail = reason ? `${reason}\n${pasteHint}` : pasteHint;
	if (!navigator.clipboard?.writeText) {
		showToast('Copy failed', `Clipboard is unavailable. URL: ${url}`);
		return;
	}
	navigator.clipboard.writeText(url).then(
		() => showToast('Copied', detail),
		() => showToast('Copy failed', `Clipboard write failed. URL: ${url}`),
	);
}

// Copy privileged URLs because Firefox blocks extension navigation to them
async function openLink(node) {
	const {url} = node;
	if (!url) return;

	if (BookmarkCache.isPrivilegedScheme(url) || BookmarkCache.isForeignExtensionUrl(url)) {
		copyUrlAndNotify(url, 'Firefox blocks extensions from opening this URL directly.');
		return;
	}

	browser.tabs.create({url, active: false}).catch(() => copyUrlAndNotify(url));
}

let columns; // Store layout entry IDs as columns[x][y]
let root; // Store root folder IDs in this array
let rootSet; // Use this set for constant-time root lookups
let coords; // Store each layout entry position as coords[id] = {x, y}

// Place special folders before bookmark folders and drop empty columns
function buildDefaultLayout() {
	const specialColumn = [];
	for (let i = 0, len = special.length; i < len; i++) if (getConfig(`show_${special[i]}`)) specialColumn.push(special[i]);
	const bookmarkColumn = [];
	for (let i = 0, len = root.length; i < len; i++) {
		const id = root[i];
		if (!SpecialFolders.isSpecial(id) && getConfig(`show_${id}`)) bookmarkColumn.push(id);
	}
	return [specialColumn, bookmarkColumn].filter((c) => c.length > 0);
}

function verifyColumns() {
	if (columns.length === 0) {
		for (const col of buildDefaultLayout()) columns.push(col);
	}

	// Strip only explicitly disabled root folders. Drag-added layout entries carry no show_* key and must persist
	for (let x = 0, xLen = columns.length; x < xLen; x++) {
		const col = columns[x];
		columns[x] = col.filter((id) => getConfig(`show_${id}`) !== 0);
	}

	const existing = new Set(columns.flat());
	const missing = root.filter((id) => !existing.has(id));

	for (let i = 0, len = missing.length; i < len; i++) {
		const id = missing[i];
		if (getConfig(`show_${id}`)) {
			columns.at(-1).push(id);
		}
	}

	coords = {};
	for (let x = columns.length - 1; x >= 0; x--) {
		if (columns[x].length === 0) {
			columns.splice(x, 1);
		} else {
			const col = columns[x];
			for (let y = 0, len = col.length; y < len; y++) {
				coords[col[y]] = {x, y};
			}
		}
	}
}

function isQuotaError(error) {
	return error?.name === 'QuotaExceededError' || error?.code === 22;
}

function storageIsFull() {
	const probeKey = '__hntp_storage_probe__';
	try {
		// One write per probe: the value alternates so the write is never a no-op
		localStorage.setItem(probeKey, localStorage.getItem(probeKey) === '1' ? '2' : '1');
	} catch (error) {
		return isQuotaError(error);
	}
	return false;
}

async function clearLocalStorageAndReload(reload = () => window.location.reload()) {
	if (!window.confirm('Clear all HumbleNewTab-fork data (settings, cached bookmarks, favicons, and background image)?')) return false;
	try {
		localStorage.clear();
	} catch (error) {
		console.error('[Storage] Could not clear localStorage:', error);
		return false;
	}
	try {
		await browser.runtime.sendMessage({type: 'storage-cleared'});
	} catch {}
	reload();
	return true;
}

function showStorageFullError(error, status) {
	getMainElement().replaceChildren();
	const errorDiv = document.createElement('div');
	errorDiv.className = 'cache-error storage-full-error';
	errorDiv.innerHTML = `
	<h1>Storage is full</h1>
	<p>HumbleNewTab-fork cannot save more data because this extension has reached its localStorage limit.</p>
	<p>If this keeps happening, report it to the developer: <a class="storage-recovery-link" href="https://github.com/Maxi9090/HumbleNewTab-fork/issues" target="_blank" rel="noopener">https://github.com/Maxi9090/HumbleNewTab-fork/issues</a></p>
	<p>Export your settings before clearing storage.</p>
	`;
	const clearButton = document.createElement('button');
	clearButton.type = 'button';
	clearButton.id = 'clear-localstorage-button';
	clearButton.textContent = 'Clear extension storage';
	clearButton.onclick = () => clearLocalStorageAndReload();
	errorDiv.append(clearButton);
	document.body.append(errorDiv);
	if (error || status) console.error('[Storage] localStorage is full:', {error: error ?? null, status: status ?? null});
}

function showCacheError(error) {
	getMainElement().replaceChildren();

	const errorDiv = document.createElement('div');
	errorDiv.className = 'cache-error';
	errorDiv.innerHTML = `
	<h1>Could not load bookmarks</h1>
	<p>The bookmark cache is not available. This usually means:</p>
	<ul>
		<li>The extension was just installed (wait a moment and refresh)</li>
		<li>Bookmarks could not be read on this load</li>
		<li>There was an error reading bookmarks</li>
	</ul>
	<p>Check the console for more details.</p>
	`;
	document.body.append(errorDiv);

	console.error('[BookmarkCache] Cache unavailable:', error);
	console.error('[BookmarkCache] Open about:debugging, find this extension, and click Inspect to see its logs');
}

async function renderLoadedColumns(generation) {
	if (generation !== loadGeneration) return;
	columns = [];
	forEachColumnEntry((x, y, id) => {
		if (!columns[x]) columns[x] = [];
		columns[x][y] = id;
	});

	if (!root) {
		const rootIds = await getRootFolderIds();
		for (let i = 0, len = rootIds.length; i < len; i++) {
			const id = rootIds[i];
			if (config[`show_${id}`] === undefined) config[`show_${id}`] = 1;
		}
		root = [...special, ...rootIds];
		rootSet = new Set(root);
	}
	verifyColumns();
	await renderColumns();
	requestAnimationFrame(() => expandDeferredFolders());
}

async function loadColumns(forceReload = false) {
	const generation = ++loadGeneration;
	if (storageIsFull()) {
		showStorageFullError();
		return false;
	}
	if (forceReload) {
		root = null;
		cacheLoadError = null;
	}

	BookmarkCache.loadFavicons().catch(() => {});
	try {
		await BookmarkCache.loadAllData(forceReload);
	} catch (e) {
		console.error('[BookmarkCache] loadAllData failed:', e);
		if (isQuotaError(e) || storageIsFull()) showStorageFullError(e);
		else showCacheError(e);
		return false;
	}

	// Check cache validity through the in-memory mirror
	const status = await BookmarkCache.getCacheStatus();
	// A tree record that did not expand leaves no folder records, and rendering that would remove every folder row from the saved layout
	const treeUsable = BookmarkCache.treeUsable();
	if (!status.valid || !treeUsable) {
		console.error('[BookmarkCache] Cache not valid:', status, {treeUsable});
		if (storageIsFull()) showStorageFullError(cacheLoadError || new Error('Cache storage is full'), status);
		else showCacheError(cacheLoadError || new Error(treeUsable ? 'Cache not initialized' : 'Cache tree did not expand'));
		return false;
	}

	await renderLoadedColumns(generation);
	return true;
}

// Skip persistence when the layout matches the default
function matchesDefaultLayout() {
	if (!root) return false;
	const defaultCols = buildDefaultLayout();
	if (defaultCols.length !== columns.length) return false;
	for (let x = 0, xLen = defaultCols.length; x < xLen; x++) {
		const d = defaultCols[x];
		if (d.length !== columns[x].length) return false;
		for (let y = 0, yLen = d.length; y < yLen; y++) {
			if (d[y] !== columns[x][y]) return false;
		}
	}
	return true;
}

function saveColumns() {
	forEachColumnEntry((x, y) => BookmarkCache.safeRemoveItem(`column.${x}.${y}`));
	verifyColumns();
	if (!matchesDefaultLayout()) {
		for (let x = 0, xLen = columns.length; x < xLen; x++) {
			const col = columns[x];
			for (let y = 0, yLen = col.length; y < yLen; y++) {
				BookmarkCache.safeSetItem(`column.${x}.${y}`, col[y]);
			}
		}
	}
	loadColumns();
}

function removeIdsFromColumns(ids, xpos, ypos) {
	const idSet = new Set(ids);
	for (let x = 0; x < columns.length; x++) {
		for (let y = columns[x].length - 1; y >= 0; y--) {
			if (idSet.has(columns[x][y])) {
				columns[x].splice(y, 1);
				if (xpos !== undefined && x === xpos && ypos > y) ypos--;
			}
		}
		if (columns[x].length === 0) {
			columns.splice(x, 1);
			if (xpos !== undefined && xpos > x) xpos--;
			x--;
		}
	}
	return {xpos, ypos};
}

function addColumn(ids, index) {
	removeIdsFromColumns(ids);
	const insertAt = Math.min(index ?? columns.length, columns.length);
	columns.splice(insertAt, 0, [...ids]);
	saveColumns();
}

function addRow(id, xpos, ypos) {
	ypos = ypos ?? columns[xpos].length;
	const adjusted = removeIdsFromColumns([id], xpos, ypos);
	const insertAt = Math.min(adjusted.ypos, columns[adjusted.xpos].length);
	columns[adjusted.xpos].splice(insertAt, 0, id);
	saveColumns();
}

function removeRow(xpos, ypos) {
	columns[xpos].splice(ypos, 1);
	saveColumns();
}

// Re-render one special folder's contents in place from its live fetch path
function refreshSpecialList(id) {
	const targets = [];
	const activeHrefs = [];
	const anchors = [];
	const folders = document.getElementsByClassName(id);

	for (let i = 0, len = folders.length; i < len; i++) {
		const a = folders[i];
		if (a.nextSibling) {
			const active = a.nextSibling.querySelector('a.menu-active[href]');
			activeHrefs.push(active?.getAttribute('href') ?? null);
			targets.push(a.parentNode);
			anchors.push(a);
		}
	}

	if (folders.length === 0 && coords?.[id]) {
		const target = document.getElementsByClassName('column')[coords[id].x];
		target.firstChild.remove();
		targets.push(target);
		activeHrefs.push(null);
		anchors.push(null);
	}

	// The broadcast handler chains .catch on this return
	return getChildren({id}).then((result) => {
		const signature = JSON.stringify(result);
		for (let i = 0, len = targets.length; i < len; i++) {
			const a = anchors[i];
			// Rebuilding an unchanged list churns the DOM and other extensions' MutationObservers for nothing
			if (a && a._specialPainted === signature) continue;
			if (a?.nextSibling) a.nextSibling.remove();
			if (a) a._specialPainted = signature;
			renderAll(result, targets[i], false, false);
			restoreMenuActive(targets[i], activeHrefs[i]);
		}
	});
}

// Force a resync that owns cache.recent, then repaint open recent folders
function requestRecentResync() {
	browser.runtime
		.sendMessage({type: 'recent-limit-changed'})
		.then(() => refreshSpecialList('recent'))
		.catch(() => {});
}

function requestClosedResync(id = 'closed') {
	browser.runtime
		.sendMessage({type: 'closed-limit-changed'})
		.then(() => refreshSpecialList(id))
		.catch(() => {});
}

function refreshTopCache() {
	if (getConfig('show_top')) refreshSpecialList('top').catch(() => {});
}

// Delay scroll saves until restoration finishes
let scrollSaveRaf = null;
let scrollRestoreRaf = null;
let scrollArmed = false;
let scrollListenerOn = false;
function saveScroll() {
	if (!scrollArmed || scrollSaveRaf) return;
	scrollSaveRaf = requestAnimationFrame(() => {
		scrollSaveRaf = null;
		BookmarkCache.safeSetItem('scroll.position', String(window.scrollY));
	});
}
// Retry while deferred content changes the document height
function restoreScroll(target, attempts) {
	window.scrollTo(0, target);
	if (Math.abs(window.scrollY - target) < 2 || ++attempts > 120) {
		scrollRestoreRaf = null;
		scrollArmed = true;
		return;
	}
	scrollRestoreRaf = requestAnimationFrame(() => restoreScroll(target, attempts));
}
function setScrollMemory(on) {
	if (on === scrollListenerOn) return;
	scrollListenerOn = on;
	if (on) {
		window.addEventListener('scroll', saveScroll, {passive: true});
	} else {
		window.removeEventListener('scroll', saveScroll);
		if (scrollRestoreRaf) {
			cancelAnimationFrame(scrollRestoreRaf);
			scrollRestoreRaf = null;
		}
		BookmarkCache.safeRemoveItem('scroll.position');
		scrollArmed = true;
	}
}
function restoreScrollPosition() {
	scrollArmed = true;
	if (!getConfig('remember_scroll')) return;
	const target = Number(localStorage.getItem('scroll.position'));
	if (target > 0) {
		scrollArmed = false;
		restoreScroll(target, 0);
	}
}

let bgScrollRaf = null;
let bgScrollListenerOn = false;

function updateBgScrollPosition() {
	bgScrollRaf = null;
	if (!getConfig('background_scroll')) return;
	const speed = getConfig('background_scroll_speed');
	document.body.style.backgroundPositionY = `${-(window.scrollY * speed)}px`;
}

function scheduleBgScrollUpdate() {
	if (bgScrollRaf) return;
	bgScrollRaf = requestAnimationFrame(updateBgScrollPosition);
}

function setBackgroundScroll(on) {
	if (on === bgScrollListenerOn) return;
	bgScrollListenerOn = on;
	if (on) {
		window.addEventListener('scroll', scheduleBgScrollUpdate, {passive: true});
		updateBgScrollPosition();
	} else {
		window.removeEventListener('scroll', scheduleBgScrollUpdate);
		if (bgScrollRaf) {
			cancelAnimationFrame(bgScrollRaf);
			bgScrollRaf = null;
		}
		document.body.style.backgroundPositionY = '';
	}
}

function loadSettings() {
	document.documentElement.classList.toggle('no-scrollbar', !!Number(getConfig('hide_scrollbar')));
	// Manual always: with the option off a reload must start at 0, never at the browser's restored offset
	history.scrollRestoration = 'manual';
	setScrollMemory(!!Number(getConfig('remember_scroll')));
	setBackgroundScroll(!!getConfig('background_scroll'));
	applyTheme(getConfig('theme'));
}

// Handle core changes. settings-ui adds its listener when imported
function handleConfigChange(key, value) {
	if (key === 'lock' || key === 'newtab' || key === 'show_root') {
		loadColumns();
		if (key === 'lock') {
			if (value) {
				dropWire = lockMenuItems = lockFolderMenuItems = handleDragStart = handleDragEnd = null;
				disableDragDrop?.();
				disableDragDrop = null;
			} else {
				wireDragDrop();
			}
		}
	} else if (key.startsWith('number')) {
		// A list-count change repaints through the folder's refresh path, not a full column re-render
		if (key === 'number_recent') {
			if (getConfig('show_recent')) requestRecentResync();
		} else if (key === 'number_top') {
			refreshTopCache();
		} else if (key === 'number_closed') {
			if (getConfig('show_closed')) requestClosedResync();
		} else if (key === 'number_windows') {
			if (getConfig('show_windows')) requestClosedResync('windows');
		}
	} else if (key === 'hide_scrollbar') {
		// Firefox skips scrollbar re-evaluation on style changes, toggling body overflow forces it
		document.documentElement.classList.toggle('no-scrollbar', !!Number(value));
		const body = document.body;
		const oldOverflow = body.style.overflow;
		body.style.overflow = 'hidden';
		void body.offsetHeight;
		body.style.overflow = oldOverflow;
	} else if (key === 'remember_scroll') {
		setScrollMemory(!!Number(value));
	} else if (key.startsWith('show')) {
		const id = key.slice(5);
		const isSpecial = SpecialFolders.isSpecial(id);
		if (value) {
			if (!coords[id]) {
				if (columns.length === 0) {
					addColumn([id], 0);
				} else if (isSpecial) {
					// Special folders reinstate fresh at their default order position
					const myOrder = SpecialFolders.all.indexOf(id);
					let scx = -1;
					for (let x = 0, xLen = columns.length; x < xLen; x++) {
						const col = columns[x];
						for (let y = 0, yLen = col.length; y < yLen; y++) {
							if (SpecialFolders.isSpecial(col[y])) {
								scx = x;
								break;
							}
						}
						if (scx >= 0) break;
					}
					if (scx < 0) {
						// No special column survived the last disable, so a new one takes its default place
						addColumn([id], 0);
					} else {
						let hy = columns[scx].length;
						for (let y = 0, yLen = columns[scx].length; y < yLen; y++) {
							const other = columns[scx][y];
							if (SpecialFolders.isSpecial(other) && SpecialFolders.all.indexOf(other) > myOrder) {
								hy = y;
								break;
							}
						}
						addRow(id, scx, hy);
					}
				} else {
					const stored = localStorage.getItem(`hidden.${id}`);
					if (stored) {
						BookmarkCache.safeRemoveItem(`hidden.${id}`);
						// Restore the saved solo flag, left neighbor, and row
						const parts = stored.split(',');
						const wasSolo = parts[0] === '1';
						const leftNeighbor = parts[1] || '';
						const hy = Number(parts[2]);
						// Resolve the column from the neighbor's current position
						let hx = -1;
						if (!leftNeighbor) hx = 0;
						else if (coords[leftNeighbor]) hx = coords[leftNeighbor].x + 1;
						if (hx < 0 || !Number.isFinite(hy)) addRow(id, columns.length - 1);
						else if (wasSolo) addColumn([id], hx);
						else addRow(id, hx, hy);
					} else {
						addRow(id, columns.length - 1);
					}
				}
				// The resync fires on every enable transition, also when the imported layout already placed the folder
				if (id === 'recent') requestRecentResync();
			}
		} else if (isSpecial) {
			// Disabling a content folder removes its records. Enabling reinstates them fresh
			if (coords[id]) {
				const pos = coords[id];
				removeRow(pos.x, pos.y);
			}
			BookmarkCache.safeRemoveItem(`open.${id}`);
			BookmarkCache.safeRemoveItem(`cache.${id}`);
			BookmarkCache.safeRemoveItem(`hidden.${id}`);
		} else if (coords[id]) {
			const pos = coords[id];
			const wasSolo = columns[pos.x].length === 1;
			const leftNeighbor = pos.x > 0 && columns[pos.x - 1].length ? columns[pos.x - 1][0] : '';
			BookmarkCache.safeSetItem(`hidden.${id}`, `${wasSolo ? 1 : 0},${leftNeighbor},${pos.y}`);
			removeRow(pos.x, pos.y);
		}
	} else if (key === 'background_scroll') {
		setBackgroundScroll(!!Number(value));
	} else if (key === 'background_zoom' || key === 'background_scroll_speed') {
		if (getConfig('background_scroll')) updateBgScrollPosition();
	}
}
addConfigChangeListener(handleConfigChange);

// Import applies toggle semantics: enabled-to-enabled untouched, off-to-on reinstates fresh, on-to-off wipes records
function captureSpecialShowState() {
	return Object.fromEntries(SpecialFolders.all.map((id) => [id, !!getConfig(`show_${id}`)]));
}

function applySpecialShowDiff(before) {
	if (!before || !root) return;
	for (let i = 0; i < SpecialFolders.all.length; i++) {
		const id = SpecialFolders.all[i];
		const now = !!getConfig(`show_${id}`);
		if (now === before[id]) continue;
		notifyConfigChange(`show_${id}`, now ? 1 : 0);
		// The imported layout was already stripped at render. Persist that strip
		if (!now && !coords[id]) saveColumns();
	}
}

let lastRenderedHash = '';

function computeBookmarkHash() {
	return BookmarkCache._allDataCache?.get('meta:hash')?.value ?? '';
}

loadSettings();
loadColumns().then(async () => {
	lastRenderedHash = computeBookmarkHash();
	restoreScrollPosition();
	// Load drag-and-drop after the initial render
	requestIdleCallback(() => wireDragDrop(), {timeout: 1000});
	browser.runtime.sendMessage({type: 'newtab-ready'}).catch(() => {});
});

// Follow browser theme changes when no explicit theme is set
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
	if (themes._.hasExplicit()) return;
	const next = themes._.pickPreferred();
	applyTheme(next);
	// Notify listeners because applyTheme does not notify them
	notifyConfigChange('theme', next);
});

// Reload the mirror before comparing bookmark hashes
browser.runtime.onMessage.addListener((message) => {
	if (message?.type === 'bookmarks-updated') {
		applyBookmarkUpdate().catch(() => {});
	} else if (message?.type === 'sessions-updated') {
		// The fetch paths reread the records the background just rewrote
		refreshSpecialList('closed').catch(() => {});
		refreshSpecialList('windows').catch(() => {});
	} else if (message?.type === 'favicons-updated') {
		// Refresh visible favicons using the background's maps
		refreshOpenTabsFavicons({byOrigin: message.byOrigin, byOriginPath: message.byOriginPath}).catch(() => {});
	}
	return false;
});

// Remove folders when Firefox revokes their optional permissions
browser.permissions.onRemoved.addListener((permissions) => {
	const perms = permissions.permissions || [];
	if (perms.includes('topSites')) setConfig('show_top', 0);
	if (perms.includes('sessions')) {
		setConfig('show_closed', 0);
		setConfig('show_windows', 0);
	}
});

// Render pending changes when visible and close menus when hidden
document.addEventListener(
	'visibilitychange',
	() => {
		if (document.hidden) {
			clearDetailsHighlight();
			if (currentMenu) closeMenu(currentMenu);
			const active = document.querySelectorAll('#main a.menu-active');
			for (let i = 0, len = active.length; i < len; i++) active[i].classList.remove('menu-active');
		} else {
			drainPendingBookmarkRender();
		}
	},
	{passive: true},
);

function folderAnchorOf(el) {
	const a = el?.firstElementChild;
	return a && a.tagName === 'A' && a.classList.contains('folder') ? a : null;
}

function folderSibling(a, dir) {
	const prop = dir < 0 ? 'previousElementSibling' : 'nextElementSibling';
	let node = a.closest('li')?.[prop];
	while (node) {
		const childA = folderAnchorOf(node);
		if (childA) return childA;
		node = node[prop];
	}
	return null;
}

function getParentFolderA(a) {
	const li = a.closest('li');
	if (!li) return null;
	const ul = li.parentNode;
	if (!ul || ul.tagName !== 'UL') return null;
	let parentLi = ul.parentNode;
	if (parentLi && parentLi.tagName === 'DIV') {
		parentLi = parentLi.parentNode;
	}
	if (!parentLi || parentLi.tagName !== 'LI') return null;
	const parentA = folderAnchorOf(parentLi);
	if (parentA) return parentA;
	return null;
}

function columnFolder(a, dir) {
	const column = a.closest('.column');
	if (!column) return null;
	const step = dir < 0 ? 'previousElementSibling' : 'nextElementSibling';
	let cur = column[step];
	while (cur) {
		if (cur.classList.contains('column')) {
			const ul = cur.querySelector(':scope > ul');
			if (ul) {
				const start = dir < 0 ? ul.children.length - 1 : 0;
				const end = dir < 0 ? -1 : ul.children.length;
				for (let i = start; i !== end; i += dir < 0 ? -1 : 1) {
					const childA = folderAnchorOf(ul.children[i]);
					if (childA) return childA;
				}
			}
		}
		cur = cur[step];
	}
	return null;
}

function getLastRootFolder() {
	const main = getMainElement();
	let col = main.lastElementChild;
	while (col) {
		if (col.classList.contains('column')) {
			const ul = col.querySelector(':scope > ul');
			if (ul) {
				for (let i = ul.children.length - 1; i >= 0; i--) {
					const childA = folderAnchorOf(ul.children[i]);
					if (childA) return childA;
				}
			}
		}
		col = col.previousElementSibling;
	}
	return null;
}

function focusFirstChild(folderA) {
	let node = folderA.nextSibling;
	while (node) {
		if (node.nodeType === 1) {
			const ul = node.tagName === 'DIV' ? node.firstElementChild : node;
			if (ul && ul.tagName === 'UL') {
				const firstA = ul.firstElementChild?.firstElementChild;
				if (firstA) firstA.focus();
			}
			return;
		}
		node = node.nextSibling;
	}
}

function navigateKeyDown(e) {
	const a = e.target.closest('#main a');
	if (!a) return;
	const key = e.key;

	if (key === 'Tab') {
		const dir = e.shiftKey ? -1 : 1;
		const cands = [folderSibling(a, dir), getParentFolderA(a), columnFolder(a, dir)];
		for (let i = 0, n = cands.length; i < n; i++) {
			const el = cands[i];
			if (el) {
				e.preventDefault();
				el.focus();
				return;
			}
		}
		e.preventDefault();
		document.getElementById('options_button')?.focus();
		return;
	}

	if (key === 'ArrowDown' || key === 'ArrowUp') {
		e.preventDefault();
		const li = a.closest('li');
		if (!li) return;
		const ul = li.parentNode;
		if (!ul || ul.tagName !== 'UL') return;
		const rows = [];
		for (let i = 0, n = ul.children.length; i < n; i++) {
			if (ul.children[i].tagName === 'LI') rows.push(ul.children[i]);
		}
		const idx = rows.indexOf(li);
		if (idx < 0) return;
		const nextIdx = key === 'ArrowDown' ? (idx + 1) % rows.length : (idx - 1 + rows.length) % rows.length;
		const nextLi = rows[nextIdx];
		if (nextLi) {
			const nextA = nextLi.firstElementChild;
			if (nextA) nextA.focus();
		}
		return;
	}

	if (key === 'ArrowRight') {
		if (!a.classList.contains('folder')) return;
		e.preventDefault();
		if (a.open) {
			focusFirstChild(a);
		} else if (a._toggle) {
			a._toggle().then(() => focusFirstChild(a));
		}
		return;
	}

	if (key === 'ArrowLeft') {
		if (a.classList.contains('folder') && a.open) {
			e.preventDefault();
			if (a._toggle) a._toggle();
			return;
		}
		const parent = getParentFolderA(a);
		if (parent) {
			e.preventDefault();
			parent.focus();
		}
	}
}

document.addEventListener('keypress', (e) => {
	if (e.key === 'Enter' && e.target?.onclick && e.target.tagName === 'A') {
		e.preventDefault();
		e.target.click();
	}
});

window.onresize = updateTooltips;

const main = getMainElement();
main.addEventListener('mouseover', (e) => {
	if (!detailsMenuActive) return;
	const anchor = e.target.closest?.('#main a');
	if (anchor) setDetailsHighlight(anchor);
});
main.addEventListener('contextmenu', (e) => {
	if (!detailsMenuActive || e.defaultPrevented) return;
	const anchor = e.target.closest?.('#main a');
	if (anchor) setDetailsHighlight(anchor);
});
main.addEventListener('keydown', navigateKeyDown);

document.getElementById('options_button').addEventListener('keydown', (e) => {
	if (e.key === 'Tab' && e.shiftKey) {
		e.preventDefault();
		const last = getLastRootFolder();
		if (last) last.focus();
	}
});

// Pass core hooks by value to keep the dynamic import acyclic
const coreHooks = Object.freeze({
	loadSettings,
	loadColumns,
	drainPendingBookmarkRender,
	setUiBusy,
	setDetailsMenuActive,
	captureSpecialShowState,
	applySpecialShowDiff,
});

document.getElementById('options_button').onclick = () => {
	import('./settings-ui.mjs').then((m) => m.showOptions(true, coreHooks)).catch((e) => console.warn('[Options] panel failed to load:', e));
	return false;
};

export {
	drainPendingBookmarkRender,
	applyBookmarkUpdate,
	SpecialFolders,
	special,
	forEachColumnEntry,
	getChildren_internal,
	render,
	renderAll,
	renderColumn,
	renderMenu,
	mainElement,
	getMainElement,
	renderColumns,
	expandDeferredFolders,
	getChildren,
	getSubTree,
	toggle,
	showToast,
	resetPrivilegedMenuBlockForTest,
	openLink,
	columns,
	root,
	coords,
	verifyColumns,
	showStorageFullError,
	storageIsFull,
	clearLocalStorageAndReload,
	loadColumns,
	addColumn,
	addRow,
	removeRow,
	refreshSpecialList,
	setUiBusy,
	setDetailsMenuActive,
	loadSettings,
	lastRenderedHash,
	captureSpecialShowState,
	applySpecialShowDiff,
};

if (location.search === '?options') {
	import('./settings-ui.mjs').then((m) => m.showOptions(true, coreHooks)).catch((e) => console.warn('[Options] panel failed to load:', e));
}
