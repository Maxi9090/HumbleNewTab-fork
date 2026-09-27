import {BookmarkCache} from './bookmark-cache.mjs';
import {getConfig} from './config-engine.mjs';

// Receive mutable core hooks because imported bindings are read-only
let hooks = null;

let dragIds, dragKind, dragParentId;
let colElsCache = null;
let overlayPool = new Map();

const SEG_FALLOFF = 200,
	RECT_FALLOFF = 150,
	RECT_INSET = 6;
const OUTER_SEG_FALLOFF = 290;
const DROP_COMMIT_STRENGTH = 0.6;
const DROP_MIN_OPACITY = 0.2;
const DROP_PHASE12_SCALE = 0.6;

// Measure strength with cubic easing over inverse cursor distance
function segStrength(px, py, x1, y1, x2, y2) {
	const dx = x2 - x1,
		dy = y2 - y1;
	const lenSq = dx * dx + dy * dy;
	let t = lenSq > 0 ? ((px - x1) * dx + (py - y1) * dy) / lenSq : 0;
	t = t < 0 ? 0 : t > 1 ? 1 : t;
	const fx = x1 + t * dx,
		fy = y1 + t * dy;
	const d = Math.hypot(px - fx, py - fy);
	const tt = d >= SEG_FALLOFF ? 0 : 1 - d / SEG_FALLOFF;
	return tt * tt * tt;
}
function outerSegStrength(px, py, xCoord, segTop, segBot) {
	// Clamp the outer edge so it cannot highlight outside the layout
	const fy = py < segTop ? segTop : py > segBot ? segBot : py;
	const d = Math.hypot(px - xCoord, py - fy);
	const tt = d >= OUTER_SEG_FALLOFF ? 0 : 1 - d / OUTER_SEG_FALLOFF;
	return tt * tt * tt;
}
function rectStrength(px, py, l, t, r, b) {
	const dx = Math.max(0, l - px, px - r),
		dy = Math.max(0, t - py, py - b);
	const d = Math.hypot(dx, dy);
	const tt = d >= RECT_FALLOFF ? 0 : 1 - d / RECT_FALLOFF;
	return tt * tt * tt;
}

function isAncestorOf(cache, descendantParentId, candidateId) {
	let c = descendantParentId;
	for (let d = 0; d < 16 && c; d++) {
		if (c === candidateId) return true;
		c = cache.get(`folder:${c}`)?.parentId ?? null;
	}
	return false;
}

function insetRect(r) {
	const inset = Math.min(RECT_INSET, r.width / 2, r.height / 2);
	return {
		left: r.left + inset,
		top: r.top + inset,
		right: r.right - inset,
		bottom: r.bottom - inset,
		width: Math.max(0, r.width - inset * 2),
		height: Math.max(0, r.height - inset * 2),
	};
}

function adjustColumnIndex(srcX, x) {
	return srcX === -1 || x <= srcX ? x : x - 1;
}

function pickActive(cs) {
	let best = null;
	for (let i = 0, n = cs.length; i < n; i++) {
		const c = cs[i];
		if (c.noOp || c.strength < DROP_COMMIT_STRENGTH) continue;
		if (!best || c.strength > best.strength) best = c;
	}
	return best;
}

function keyOf(c) {
	if (c.noOp) return null;
	if (c.intent === 'column') return `c:${c.x}`;
	if (c.intent === 'row-insert') return `r:${c.colIdx}:${c.y}`;
	if (c.intent === 'merge') return `m:${c.colIdx}:${c.ancestorId}`;
	return null;
}

function findColumnIndex(ids) {
	return hooks.getColumns().findIndex((col) => col.length === ids.length && col.every((v, i) => v === ids[i]));
}

function collectAncestor(cs, cache, lis, px, py, draggedId, colIdx) {
	for (let i = 0, len = lis.length; i < len; i++) {
		const li = lis[i];
		const id = li.dataset?.nodeId;
		if (!id || id === draggedId || !isAncestorOf(cache, dragParentId, id)) continue;
		const r = insetRect(li.getBoundingClientRect());
		const s = rectStrength(px, py, r.left, r.top, r.right, r.bottom);
		if (s <= 0) continue;
		cs.push({intent: 'merge', target: li, colIdx, x: colIdx, ancestorId: id, strength: s, noOp: false, rect: r});
	}
}

function movable(e) {
	const cs = collectCandidates(e);
	for (let i = 0, len = cs.length; i < len; i++) if (!cs[i].noOp) return true;
	return false;
}

function collectCandidates(e) {
	if (!dragIds) return [];
	const main = hooks.getMainElement();
	if (!colElsCache) colElsCache = [...main.querySelectorAll(':scope > .column')];
	const cols = colElsCache;
	if (cols.length === 0) return [];
	const mainRect = main.getBoundingClientRect();
	// Use client coordinates because getBoundingClientRect uses the viewport
	const px = e.clientX,
		py = e.clientY;
	const coords = hooks.getCoords();
	const columns = hooks.getColumns();
	const cs = [];
	const src = dragKind === 'folder' ? coords[dragIds[0]] : null;
	const srcX = dragKind === 'column' ? findColumnIndex(dragIds) : -1;
	const segTop = mainRect.top,
		segBot = mainRect.bottom;

	for (let i = 0; i <= cols.length; i++) {
		const targetIdx = Math.min(i, cols.length - 1);
		const r = cols[targetIdx].getBoundingClientRect();
		let xCoord = i === 0 ? r.left : i === cols.length ? r.right : r.left;
		const isOuter = i === 0 || i === cols.length;
		// Clamp outer indicators so narrow layouts keep them reachable
		if (isOuter) xCoord = Math.max(2, Math.min(xCoord, document.documentElement.clientWidth - 2));
		let noOp;
		if (dragKind === 'column') noOp = srcX !== -1 && adjustColumnIndex(srcX, i) === srcX;
		else {
			const single = src && columns[src.x].length === 1;
			noOp = single && adjustColumnIndex(src.x, i) === src.x;
		}
		const strength = isOuter ? outerSegStrength(px, py, xCoord, segTop, segBot) : segStrength(px, py, xCoord, segTop, xCoord, segBot);
		cs.push({intent: 'column', x: i, side: i === 0 ? 'before' : 'after', strength, noOp, rect: {left: xCoord, top: segTop, width: 0, height: segBot - segTop}});
	}

	if (dragKind === 'folder') {
		const cache = dragParentId !== null ? BookmarkCache._allDataCache : null;
		for (let i = 0; i < cols.length; i++) {
			const ul = cols[i].querySelector(':scope > ul');
			if (!ul) continue;
			const lis = Array.prototype.filter.call(ul.children, (li) => li.tagName === 'LI');
			const isSingle = lis.length === 1;
			for (let j = 0; j < lis.length; j++) {
				const li = lis[j];
				const linkEl = li.querySelector(':scope > a');
				if (!linkEl) continue;
				const r = linkEl.getBoundingClientRect();
				const isNoOpSingle = isSingle && src && src.x === i;
				const noOpAbove = isNoOpSingle || (src && src.x === i && (src.y === j - 1 || src.y === j));
				const noOpBelow = isNoOpSingle || (src && src.x === i && (src.y === j || src.y === j + 1));
				// Measure below an open folder at the subtree bottom
				const liRect = li.getBoundingClientRect();
				const belowY = linkEl.classList.contains('open') && liRect.bottom > r.bottom ? liRect.bottom : r.bottom;
				cs.push({
					intent: 'row-insert',
					target: li,
					colIdx: i,
					x: i,
					y: j,
					side: 'before',
					strength: segStrength(px, py, r.left, r.top, r.right, r.top),
					noOp: noOpAbove,
					rect: {left: r.left, top: r.top, width: r.width, height: 0},
				});
				cs.push({
					intent: 'row-insert',
					target: li,
					colIdx: i,
					x: i,
					y: j + 1,
					side: 'after',
					strength: segStrength(px, py, r.left, belowY, r.right, belowY),
					noOp: noOpBelow,
					rect: {left: r.left, top: belowY, width: r.width, height: 0},
				});
			}
			if (cache && src) collectAncestor(cs, cache, lis, px, py, dragIds[0], i);
		}
	}
	return cs;
}

function styleOverlay(el, c) {
	const r = c.rect;
	let cls = 'drop-overlay';
	if (c.intent === 'column') {
		el.style.left = `${r.left - 1}px`;
		el.style.top = `${r.top}px`;
		el.style.width = '2px';
		el.style.height = `${r.height}px`;
	} else if (c.intent === 'merge') {
		cls += ' drop-overlay-merge drop-overlay-nest';
		el.style.left = `${r.left - 2}px`;
		el.style.top = `${r.top - 2}px`;
		el.style.width = `${r.width + 4}px`;
		el.style.height = `${r.height + 4}px`;
	} else {
		el.style.left = `${r.left}px`;
		el.style.top = `${r.top - 1}px`;
		el.style.width = `${r.width}px`;
		el.style.height = '2px';
	}
	el.className = cls;
}

function updateOverlays(cs) {
	const next = new Set();
	const lock = pickActive(cs);
	const lockKey = lock ? keyOf(lock) : null;
	const byKey = new Map();
	for (let i = 0, n = cs.length; i < n; i++) {
		const c = cs[i];
		const k = keyOf(c);
		if (k) {
			next.add(k);
			byKey.set(k, c);
			if (!overlayPool.has(k)) {
				const el = document.createElement('div');
				el.style.opacity = '0';
				document.body.append(el);
				overlayPool.set(k, el);
			}
		}
	}
	for (const [key, el] of overlayPool) {
		if (!next.has(key)) {
			el.style.opacity = '0';
			continue;
		}
		const c = byKey.get(key);
		styleOverlay(el, c);
		let o;
		if (key === lockKey) o = 1;
		else if (lockKey) o = DROP_MIN_OPACITY;
		else o = Math.max(DROP_MIN_OPACITY, c.strength * DROP_PHASE12_SCALE);
		el.style.opacity = String(o);
	}
}

function hideDropZone() {
	for (const el of overlayPool.values()) el.style.opacity = '0';
}

let dragSrcEl = null;

function handleDragStart(e) {
	const main = hooks.getMainElement();
	const folderLink = e.target.closest('a.folder');
	// Row drags resolve before the lock gate: locked layouts keep native link dragging
	if (!folderLink) {
		const item = e.target.closest('li');
		if (item && main.contains(item)) return;
	}
	if (getConfig('lock')) return;
	if (folderLink && main.contains(folderLink)) {
		const li = folderLink.closest('li');
		const id = li?.dataset?.nodeId;
		if (!id) return;
		dragIds = [id];
		dragKind = 'folder';
		dragParentId = BookmarkCache._allDataCache?.get(`folder:${id}`)?.parentId ?? null;
		colElsCache = null;
		if (!movable(e)) {
			dragIds = dragKind = dragParentId = null;
			return;
		}
		dragSrcEl = folderLink;
		e.dataTransfer.effectAllowed = 'move';
		folderLink.classList.add('dragstart');
		hooks.setUiBusy(true);
		return;
	}
	const column = e.target.closest('.column');
	if (!column || !main.contains(column)) return;
	const cols = [...main.querySelectorAll(':scope > .column')];
	const idx = cols.indexOf(column);
	if (idx < 0) return;
	dragIds = [...hooks.getColumns()[idx]];
	dragKind = 'column';
	colElsCache = null;
	if (!movable(e)) {
		dragIds = dragKind = dragParentId = null;
		return;
	}
	dragSrcEl = column;
	e.dataTransfer.effectAllowed = 'move';
	column.classList.add('column-menu-active');
	hooks.setUiBusy(true);
}

function handleDragEnd() {
	if (!dragSrcEl) return;
	dragSrcEl.classList.remove('dragstart', 'column-menu-active');
	dragSrcEl = null;
	dragIds = dragKind = dragParentId = null;
	colElsCache = null;
	hideDropZone();
	hooks.setUiBusy(false);
	hooks.drainPendingBookmarkRender();
}

function enableDragDrop() {
	if (getConfig('lock')) {
		disableDragDrop();
		return;
	}
	document.ondragover = (e) => {
		if (!dragIds) return;
		e.preventDefault();
		const cs = collectCandidates(e);
		updateOverlays(cs);
		e.dataTransfer.dropEffect = pickActive(cs) ? 'move' : 'none';
	};
	document.ondragleave = (e) => {
		if (e.relatedTarget === null) hideDropZone();
	};
	document.ondrop = (e) => {
		if (!dragIds) return;
		e.preventDefault();
		e.stopPropagation();
		const a = pickActive(collectCandidates(e));
		if (!a) {
			hideDropZone();
			return false;
		}
		if (dragKind === 'column' || a.intent === 'column') hooks.addColumn(dragIds, a.x);
		else if (a.intent === 'merge') {
			const source = hooks.getCoords()[dragIds[0]];
			if (source) hooks.removeRow(source.x, source.y);
		} else hooks.addRow(dragIds[0], a.x, a.y);
		hideDropZone();
	};
}

function lockMenuItems(index, ids) {
	if (getConfig('lock') || hooks.getColumns().length <= 1) return [];
	const items = [null];
	if (index > 0) items.push({label: 'Move column left', action: () => hooks.addColumn(ids, index - 1)});
	if (index < hooks.getColumns().length - 1) items.push({label: 'Move column right', action: () => hooks.addColumn(ids, index + 1)});
	if (ids.length === 1) {
		if (index > 0) items.push({label: 'Move folder left', action: () => hooks.addRow(ids[0], index - 1)});
		if (index < hooks.getColumns().length - 1) items.push({label: 'Move folder right', action: () => hooks.addRow(ids[0], index + 1)});
	}
	return items;
}

function lockFolderMenuItems(node, folderHooks) {
	if (getConfig('lock')) return [];
	const items = [null];
	items.push({label: 'Create new column', action: () => folderHooks.addColumn([node.id])});
	const pos = folderHooks.getCoords()[node.id];
	const columns = folderHooks.getColumns();
	if (pos && columns[pos.x]) {
		if (pos.y > 0) items.push({label: 'Move folder up', action: () => folderHooks.addRow(node.id, pos.x, pos.y - 1)});
		if (pos.y < columns[pos.x].length - 1) items.push({label: 'Move folder down', action: () => folderHooks.addRow(node.id, pos.x, pos.y + 2)});
		if (pos.x > 0) items.push({label: 'Move folder left', action: () => folderHooks.addRow(node.id, pos.x - 1)});
		if (pos.x < columns.length - 1) items.push({label: 'Move folder right', action: () => folderHooks.addRow(node.id, pos.x + 1)});
		if (!folderHooks.getRootSet()?.has(node.id)) items.push({label: 'Remove folder', action: () => folderHooks.removeRow(pos.x, pos.y)});
	}
	return items;
}

// Remove drop handlers when locking at runtime
function disableDragDrop() {
	document.ondragover = document.ondragleave = document.ondrop = null;
}

function register(hooksPayload) {
	hooks = hooksPayload;
	return {dropWire: enableDragDrop, lockMenuItems, lockFolderMenuItems, disableDragDrop, handleDragStart, handleDragEnd};
}

export {
	SEG_FALLOFF,
	OUTER_SEG_FALLOFF,
	DROP_COMMIT_STRENGTH,
	segStrength,
	outerSegStrength,
	collectCandidates,
	adjustColumnIndex,
	findColumnIndex,
	pickActive,
	keyOf,
	register, //
};
