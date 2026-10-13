// One-level undo of the last settings change, shared by the options panel and the drag layout paths
import {BookmarkCache} from './bookmark-cache.mjs';
import {config, setConfig} from './config-engine.mjs';

const UNDO_KEY = 'settings.undo';
const SETTINGS_PREFIXES = ['options.', 'column.'];
const COLUMN_PREFIX = 'column.';

// Settings whose checkboxes need an optional permission
const PERMISSION_FOR_KEY = {
	show_top: 'topSites',
	show_closed: 'sessions',
	show_windows: 'sessions',
};

let undoArrow = null;

// Raw values of every stored key matching one of the prefixes
function captureScope(prefixes) {
	const record = {};
	for (let i = 0, len = localStorage.length; i < len; i++) {
		const k = localStorage.key(i);
		if (prefixes.some((prefix) => k.startsWith(prefix))) record[k] = localStorage.getItem(k);
	}
	return record;
}

// A change on an empty config has no previous state to return to
function hasStoredSettings() {
	return Object.keys(captureScope(SETTINGS_PREFIXES)).length > 0;
}

function refreshUndoArrow() {
	if (undoArrow) undoArrow.style.visibility = localStorage.getItem(UNDO_KEY) != null ? '' : 'hidden';
}

function storeUndoRecord(record) {
	if (record) BookmarkCache.safeSetItem(UNDO_KEY, JSON.stringify(record));
	refreshUndoArrow();
}

// The background image change spans four keys: the data URL, its filename, and the decoded size
function undoKeysFor(key) {
	return key === 'background_image_file' ? ['options.background_image_file', 'background_image_filename', 'background_image_width', 'background_image_height'] : [`options.${key}`];
}

// Record the raw pre-change values of a config key's storage, skipped while the config is empty
function recordUndo(key) {
	if (!hasStoredSettings()) return;
	const keys = undoKeysFor(key);
	const record = {};
	for (let i = 0, len = keys.length; i < len; i++) {
		record[keys[i]] = localStorage.getItem(keys[i]);
	}
	storeUndoRecord(record);
}

// The stored scope plus the keys an import is about to add, each absent key recorded as null
function captureImportUndo(entries) {
	const record = captureScope(SETTINGS_PREFIXES);
	if (!Object.keys(record).length) return null;
	for (let i = 0, len = entries.length; i < len; i++) record[entries[i][0]] ??= null;
	return record;
}

// Run a layout move with the pre-change column state recorded, keys the move creates as null
function recordLayoutChange(op) {
	const record = hasStoredSettings() ? captureScope([COLUMN_PREFIX]) : null;
	op();
	if (!record) return;
	for (let i = 0, len = localStorage.length; i < len; i++) {
		const k = localStorage.key(i);
		if (k.startsWith(COLUMN_PREFIX) && !(k in record)) record[k] = null;
	}
	storeUndoRecord(record);
}

// Caller places and wires the returned revert arrow
function createUndoArrow() {
	undoArrow = document.createElement('a');
	undoArrow.className = 'revert';
	undoArrow.title = 'Revert last change';
	undoArrow.tabIndex = 0;
	refreshUndoArrow();
	return undoArrow;
}

// Request the optional permissions the named show_* settings need, false when the prompt is denied
async function requestShowPermissions(optionKeys) {
	const perms = [];
	for (let i = 0, len = optionKeys.length; i < len; i++) {
		const perm = PERMISSION_FOR_KEY[optionKeys[i]];
		if (perm && !perms.includes(perm)) perms.push(perm);
	}
	if (!perms.length) return true;
	try {
		return await browser.permissions.request({permissions: perms});
	} catch {
		return false;
	}
}

// Apply the recorded values to storage and config, false when nothing was consumed
async function revertLastChange() {
	let record = null;
	try {
		record = JSON.parse(localStorage.getItem(UNDO_KEY));
	} catch {}
	if (!record || typeof record !== 'object' || Array.isArray(record)) {
		BookmarkCache.safeRemoveItem(UNDO_KEY);
		refreshUndoArrow();
		return false;
	}
	const changes = [];
	const keys = Object.keys(record);
	for (let i = 0, len = keys.length; i < len; i++) {
		const k = keys[i];
		if (localStorage.getItem(k) !== record[k]) changes.push([k, record[k], k.startsWith('options.') ? k.slice(8) : null]);
	}
	if (!changes.length) {
		BookmarkCache.safeRemoveItem(UNDO_KEY);
		refreshUndoArrow();
		return false;
	}
	// Optional permissions for folders the undo re-enables, requested before the first await
	const showKeys = [];
	for (let i = 0, len = changes.length; i < len; i++) {
		if (changes[i][1] === '1' && PERMISSION_FOR_KEY[changes[i][2]]) showKeys.push(changes[i][2]);
	}
	const denied = showKeys.length > 0 && !(await requestShowPermissions(showKeys));
	// Config keys first: their listeners persist the in-memory layout, which the raw writes then replace
	for (let i = 0, len = changes.length; i < len; i++) {
		const change = changes[i];
		if (change[2] == null || !(change[2] in config)) continue;
		if (denied && PERMISSION_FOR_KEY[change[2]]) continue;
		setConfig(change[2], change[1]);
	}
	for (let i = 0, len = changes.length; i < len; i++) {
		const change = changes[i];
		if (change[2] != null && change[2] in config) continue;
		if (change[1] == null) BookmarkCache.safeRemoveItem(change[0]);
		else BookmarkCache.safeSetItem(change[0], change[1]);
	}
	BookmarkCache.safeRemoveItem(UNDO_KEY);
	refreshUndoArrow();
	return true;
}

export {PERMISSION_FOR_KEY, captureImportUndo, createUndoArrow, recordUndo, recordLayoutChange, refreshUndoArrow, requestShowPermissions, revertLastChange, storeUndoRecord};
