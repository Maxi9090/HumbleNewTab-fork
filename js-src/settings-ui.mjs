import {BookmarkCache} from './bookmark-cache.mjs';
import {themes} from './themes.mjs';
import {config, theme, configCache, getConfig, setConfig, styleSchema, applyTheme, addConfigChangeListener} from './config-engine.mjs';

// Receive mutable core hooks because imported ESM bindings are read-only
let coreHooks = null;
const DETAILS_TAB_INDEX = 5;
let activeNavIndex = 0;

// Preview slider changes without writing storage or rebuilding the full stylesheet
let previewStyleElement = null;
let pendingSliderKey = null;
let pendingSliderValue = null;
let pendingSliderRaf = null;

function flushSliderPreview() {
	pendingSliderRaf = null;
	if (pendingSliderKey == null) return;
	if (pendingSliderKey === 'background_scroll_speed') {
		if (getConfig('background_scroll')) document.body.style.backgroundPositionY = `${-(window.scrollY * pendingSliderValue)}px`;
		return;
	}
	let css = styleSchema[pendingSliderKey]?.(pendingSliderValue);
	if (pendingSliderKey === 'width') css += styleSchema.h_pos(getConfig('h_pos'), pendingSliderValue);
	if (!css) return;
	if (!previewStyleElement) {
		previewStyleElement = document.createElement('style');
		document.head.append(previewStyleElement);
	}
	previewStyleElement.textContent = css;
}

function cancelPendingSliderPreview() {
	if (pendingSliderRaf != null) {
		cancelAnimationFrame(pendingSliderRaf);
		pendingSliderRaf = null;
	}
	if (pendingSliderKey != null) {
		pendingSliderKey = null;
		pendingSliderValue = null;
		if (previewStyleElement) previewStyleElement.textContent = '';
	}
}

// Show the reset control when the key is explicitly set
function refreshResetArrow(input, key, value) {
	if (!input?.reset) return;
	const v = value ?? getConfig(key);
	const hasOverride = localStorage.getItem(`options.${key}`) != null;
	input.reset.style.visibility = hasOverride ? null : 'hidden';
	if (input.swatch) input.swatch.value = v;
}

// Map settings to permissions requested by their checkboxes
const PERMISSION_FOR_KEY = {
	show_top: 'topSites',
	show_closed: 'sessions',
	show_windows: 'sessions',
};

// One prompt per permission: a second enabling click while the prompt is open reuses the in-flight request
const pendingPermissionRequests = new Map();
function requestPermission(perm) {
	let request = pendingPermissionRequests.get(perm);
	if (!request) {
		request = browser.permissions.request({permissions: [perm]}).catch(() => false);
		pendingPermissionRequests.set(perm, request);
		request.finally(() => {
			if (pendingPermissionRequests.get(perm) === request) pendingPermissionRequests.delete(perm);
		});
	}
	return request;
}

// Zoom scales the Size fit, read from the image's own size, which only the options panel can decode
function captureBackgroundSize(dataUrl) {
	if (!dataUrl || (localStorage.getItem('background_image_width') && localStorage.getItem('background_image_height'))) return;
	const img = new Image();
	img.onload = () => {
		if (!img.naturalWidth || !img.naturalHeight) return;
		BookmarkCache.safeSetItem('background_image_width', String(img.naturalWidth));
		BookmarkCache.safeSetItem('background_image_height', String(img.naturalHeight));
		// The stylesheet was built before the size existed
		applyTheme(getConfig('theme'));
	};
	img.src = dataUrl;
}

function showConfig(key) {
	const input = document.getElementById(`options_${key}`);
	if (!input) return;
	if (input.type === 'file') {
		const filename = localStorage.getItem('background_image_filename');
		const status = input.parentElement.querySelector('.file-status');
		if (status) status.textContent = filename ? `Image saved: ${filename}` : '';
		input.style.display = filename ? 'none' : '';
		captureBackgroundSize(getConfig('background_image_file'));
		return;
	}
	const value = getConfig(key);
	input[input.type === 'checkbox' ? 'checked' : 'value'] = value;
	if (input.number) input.number.value = value;
	if (input.valueLabel) syncRangeValue(input);
}

// Name the nearest level of a ticked slider, so a value between ticks still reads
function syncRangeValue(input) {
	if (!input.valueLabel) return;
	const options = input.list?.options ?? [];
	const value = Number(input.value);
	let name = '';
	let closest = Infinity;
	for (let i = 0, len = options.length; i < len; i++) {
		const distance = Math.abs(Number(options[i].value) - value);
		if (distance < closest) {
			closest = distance;
			name = options[i].textContent;
		}
	}
	input.valueLabel.textContent = name;
}

function initConfig(key) {
	const input = document.getElementById(`options_${key}`);
	if (!input) return;

	if (input.type === 'color') {
		input.type = 'text';
		input.className = 'color';
		input.maxLength = 9;
		const swatch = document.createElement('input');
		swatch.type = 'color';
		swatch.value = input.value;
		swatch.oninput = (e) => {
			input.value = swatch.value;
			return input.onchange(e);
		};
		input.swatch = swatch;
		input.parentNode.appendChild(swatch);
	}

	// Add a number input that stays synced with the range slider
	if (input.type === 'range') {
		const label = input.parentNode;
		label.classList.add('range-label');
		const number = document.createElement('input');
		number.type = 'number';
		number.inputMode = 'decimal';
		number.step = input.step;
		number.min = input.min;
		number.max = input.max;
		number.className = 'range-number';
		number.value = input.value;
		number.onchange = () => {
			input.value = number.value;
			input.onchange();
		};
		input.oninput = () => {
			number.value = input.value;
			syncRangeValue(input);
			// Coalesce slider previews into one overlay style update per frame
			pendingSliderKey = key;
			pendingSliderValue = input.value;
			pendingSliderRaf ??= requestAnimationFrame(flushSliderPreview);
		};
		input.number = number;
		label.insertBefore(number, input);
		if (input.list) {
			const valueLabel = document.createElement('span');
			valueLabel.className = 'range-value';
			label.append(valueLabel);
			input.valueLabel = valueLabel;
		}
	}

	input.onchange = async (e) => {
		// Commit the preview before setConfig replaces the overlay stylesheet
		cancelPendingSliderPreview();
		if (input.type === 'file') {
			const file = e?.target?.files?.[0];
			if (!file) return;
			if (file.size > 2097152) {
				input.value = '';
				alert('Image must be less than 2 MB');
				return false;
			}
			const reader = new FileReader();
			reader.onload = (f) => {
				if (f.target.result) {
					setConfig(key, f.target.result);
					BookmarkCache.safeSetItem('background_image_filename', file.name);
					BookmarkCache.safeRemoveItem('background_image_width');
					BookmarkCache.safeRemoveItem('background_image_height');
					captureBackgroundSize(f.target.result);
					showConfig(key);
				}
			};
			reader.readAsDataURL(file);
			return;
		}
		const value = input.type === 'checkbox' ? Number(input.checked) : input.value;
		const perm = PERMISSION_FOR_KEY[key];
		if (perm && value && !(await requestPermission(perm))) {
			input.checked = false;
			return;
		}
		setConfig(key, value);
	};

	const reset = document.createElement('a');
	reset.className = 'revert';
	reset.title = 'Reset to default';
	reset.tabIndex = 0;
	reset.onclick = () => {
		setConfig(key, null);
		if (input.type === 'file') {
			input.value = '';
			BookmarkCache.safeRemoveItem('background_image_filename');
			BookmarkCache.safeRemoveItem('background_image_width');
			BookmarkCache.safeRemoveItem('background_image_height');
		}
		showConfig(key);
		return false;
	};

	input.reset = reset;
	// Keep the reset control beside the label for fieldset grid alignment
	input.parentNode.insertAdjacentElement('afterend', reset);
	showConfig(key);
	refreshResetArrow(input, key);
}

let settingsInitialized = false;

function refreshBgScrollDisabled() {
	const on = !!getConfig('background_scroll');
	const speed = document.getElementById('options_background_scroll_speed');
	if (speed) {
		speed.disabled = !on;
		if (speed.number) speed.number.disabled = !on;
	}
}

// List counts grey out while their folder is off, the scroll-speed treatment
const LIST_COUNT_KEYS = [
	['show_top', 'number_top'],
	['show_recent', 'number_recent'],
	['show_closed', 'number_closed'],
	['show_windows', 'number_windows'],
];

function refreshListCountDisabled() {
	for (const [showKey, countKey] of LIST_COUNT_KEYS) {
		const input = document.getElementById(`options_${countKey}`);
		if (input) input.disabled = !getConfig(showKey);
	}
}

function initializeThemeOptions() {
	const themeSelect = document.getElementById('options_theme');
	if (!themeSelect || themeSelect.childNodes.length !== 0) return;
	const themeNames = Object.keys(themes).filter((k) => themes[k].chrome);
	const currentTheme = getConfig('theme');
	for (let i = 0, len = themeNames.length; i < len; i++) {
		const name = themeNames[i];
		const option = document.createElement('option');
		option.textContent = name;
		option.selected = name === currentTheme;
		themeSelect.append(option);
	}
}

function initializeConfigControls() {
	const configKeys = Object.keys(config);
	for (let i = 0, len = configKeys.length; i < len; i++) {
		const input = document.getElementById(`options_${configKeys[i]}`);
		if (input && !input.reset) initConfig(configKeys[i]);
	}
	coreHooks.loadSettings();
	for (let i = 0, len = configKeys.length; i < len; i++) {
		const k = configKeys[i];
		refreshResetArrow(document.getElementById(`options_${k}`), k);
	}
	refreshBgScrollDisabled();
	refreshListCountDisabled();
}

// Inclusion list: only schema options and layout cells are exportable, so keys written by anything else never leave the page
function exportReplacer(k, v) {
	// JSON.stringify calls the replacer once with an empty key for the object itself
	if (k === '') return v;
	// Exclude the large data URL, it is restored from the image file instead
	if (k === 'options.background_image_file') return undefined;
	if (k.startsWith('options.')) {
		const key = k.slice(8);
		const inConfig = key in config;
		const inTheme = key in theme;
		return inConfig || inTheme ? v : undefined;
	}
	return importKeyAllowed(k) ? v : undefined;
}

function exportSettings() {
	const sorted = Object.fromEntries(
		Object.keys(localStorage)
			.sort()
			.map((k) => [k, localStorage.getItem(k)]),
	);
	return JSON.stringify(sorted, exportReplacer, 2);
}

const COLUMN_KEY_RE = /^column\.\d+\.\d+$/;

function importKeyAllowed(key) {
	if (key.startsWith('options.')) {
		const option = key.slice(8);
		return option in config || option.startsWith('show_');
	}
	return COLUMN_KEY_RE.test(key);
}

// Name the failing entry or the syntax problem so the user knows what to correct
function importErrorReason(error) {
	if (error instanceof SyntaxError) return 'Invalid JSON.';
	return error?.message || 'Unknown error.';
}

// Validate against the config schema's types and the live controls' own ranges and value sets
function importedValueError(key, value) {
	if (!key.startsWith('options.')) return typeof value === 'string' ? null : `Invalid value for "${key}": expected a string.`;
	const option = key.slice(8);
	if (option === 'theme') {
		const names = Object.keys(themes).filter((t) => themes[t].chrome);
		const list = names.map((t) => `"${t}"`).join(' or ');
		return names.includes(value) ? null : `Unsupported theme: "${value}" (expected ${list}).`;
	}
	const numeric = typeof config[option] === 'number' || (option.startsWith('show_') && !(option in config));
	let number;
	if (numeric) {
		number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
		if (!Number.isFinite(number)) return `Invalid value for "${key}": expected a number.`;
	}
	if (!numeric && typeof value !== 'string') return `Invalid value for "${key}": expected a string.`;
	const input = document.getElementById(`options_${option}`);
	if (!input) return null;
	if (input.tagName === 'SELECT') {
		const allowed = Array.from(input.options, (o) => `"${o.value}"`);
		return !allowed.length || allowed.includes(`"${value}"`) ? null : `Invalid value for "${key}": expected one of ${allowed.join(', ')}.`;
	}
	if (input.type === 'checkbox') return number === 0 || number === 1 ? null : `Invalid value for "${key}": expected "0" or "1".`;
	if (!numeric) return null;
	if (input.min !== '' && number < Number(input.min)) return `Invalid value for "${key}": below the minimum "${input.min}".`;
	if (input.max !== '' && number > Number(input.max)) return `Invalid value for "${key}": above the maximum "${input.max}".`;
	return null;
}

function parseImportedSettings(value) {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Settings import must be a JSON object.');
	const entries = Object.entries(value);
	for (let i = 0, len = entries.length; i < len; i++) {
		const [key, importedValue] = entries[i];
		if (!importKeyAllowed(key)) throw new Error(`Unsupported settings key: "${key}"`);
		const error = importedValueError(key, importedValue);
		if (error) throw new Error(error);
	}
	return entries;
}

function renderAdvancedCss() {
	const allcss = document.getElementById('all_css');
	const configKeys = Object.keys(config);
	const merged = new Map();
	for (let j = 0, kLen = configKeys.length; j < kLen; j++) {
		const key = configKeys[j];
		if (key === 'css' || key === 'background_image_file') continue;
		const css = styleSchema[key]?.(getConfig(key));
		if (!css) continue;
		// Merge generated rules that use the same selector
		const re = /([^{]+)\{([^}]*)\}/g;
		let m;
		let matched = false;
		while ((m = re.exec(css)) !== null) {
			matched = true;
			const selector = m[1].trim();
			const props = m[2].trim();
			if (merged.has(selector)) merged.set(selector, merged.get(selector) + '; ' + props);
			else merged.set(selector, props);
		}
		if (!matched) {
			merged.set(null, (merged.get(null) || '') + css + '\n');
		}
	}
	const cssLines = [];
	for (const [selector, props] of merged) {
		if (selector === null) cssLines.push(props.trim());
		else {
			const propList = props
				.split(';')
				.map((s) => s.trim())
				.filter(Boolean);
			const propLines = propList.map((p) => `  ${p};`).join('\n');
			cssLines.push(`${selector} {\n${propLines}\n}`);
		}
	}
	allcss.value = cssLines.join('\n\n');
}

// Filter non-numeric keyboard input because desktop Firefox is permissive
const NUMERIC_INPUT_RE = /^[-+\d.eE]*$/;

function initSettings() {
	settingsInitialized = true;

	// Move the options subtree into the body only when settings first opens
	const tpl = document.getElementById('options-template');
	if (tpl) {
		document.body.appendChild(tpl.content.cloneNode(true));
		tpl.remove();
	}

	document.getElementById('options').addEventListener('beforeinput', (e) => {
		const target = e.target;
		if (target.type !== 'number') return;
		const data = e.data;
		if (data === null) return;
		if (!NUMERIC_INPUT_RE.test(data)) e.preventDefault();
	});

	// Clamp typed, pasted, and dropped values to the input maximum
	document.getElementById('options').addEventListener('input', (e) => {
		const target = e.target;
		if (target.type !== 'number' || target.max === '') return;
		const v = Number(target.value);
		// Leave intermediate values such as '1e' and '-' unchanged
		if (Number.isFinite(v) && v > Number(target.max)) target.value = target.max;
	});

	// Firefox ships wheel-to-change off by default, so a focused number input under the pointer steps here
	document.getElementById('options').addEventListener('wheel', (e) => {
		const target = e.target;
		const delta = e.deltaY;
		if (target.type !== 'number' || document.activeElement !== target || delta === 0) return;
		e.preventDefault();
		if (delta < 0) target.stepUp();
		else target.stepDown();
		// stepUp and stepDown fire neither event, and the clamp and commit handlers run on them
		target.dispatchEvent(new Event('input', {bubbles: true}));
		target.dispatchEvent(new Event('change', {bubbles: true}));
	});

	document.getElementById('options_close_button').onclick = () => {
		showOptions(false, coreHooks);
		return false;
	};

	// Wire import and export once. Navigation only refreshes the export view
	const exportsArea = document.getElementById('options_export');
	const importsArea = document.getElementById('options_import');
	importsArea.placeholder = 'Paste exported settings here.';
	importsArea.onchange = async () => {
		try {
			const imported = JSON.parse(importsArea.value);
			const entries = parseImportedSettings(imported);
			// Preserve folder state, the bookmark cache, special folder content, and the background image, which is never exported
			const specialBefore = coreHooks.captureSpecialShowState?.();
			const keep = [];
			for (let i = 0, len = localStorage.length; i < len; i++) {
				const k = localStorage.key(i);
				if (k.startsWith('open.') || k.startsWith('bm:') || k.startsWith('background_image_') || k === 'options.background_image_file' || k.startsWith('cache.'))
					keep.push([k, localStorage.getItem(k)]);
			}
			localStorage.clear();
			for (let j = 0, jLen = keep.length; j < jLen; j++) {
				const [k, v] = keep[j];
				BookmarkCache.safeSetItem(k, v);
			}
			for (let i = 0, len = entries.length; i < len; i++) {
				const [k, v] = entries[i];
				BookmarkCache.safeSetItem(k, String(v));
			}
			configCache.clear();

			// Request imported optional permissions before the first await ends the user gesture
			const permKeys = [];
			const permsToRequest = [];
			for (const key in PERMISSION_FOR_KEY) {
				const v = imported[`options.${key}`];
				if (v === '1' || v === 1) {
					permKeys.push(key);
					permsToRequest.push(PERMISSION_FOR_KEY[key]);
				}
			}
			if (permsToRequest.length) {
				let granted = false;
				try {
					granted = await browser.permissions.request({permissions: [...new Set(permsToRequest)]});
				} catch {}
				if (!granted) {
					for (let i = 0, len = permKeys.length; i < len; i++) {
						setConfig(permKeys[i], null);
					}
				}
			}

			importsArea.value = '';
			importsArea.placeholder = 'Import successful.';
			exportsArea.value = exportSettings();
			coreHooks.loadSettings();
			// Await the layout reload so the show-state diff acts on the imported layout, never the stale one
			await coreHooks.loadColumns();
			coreHooks.applySpecialShowDiff?.(specialBefore);
			const configKeys = Object.keys(config);
			for (let i = 0, len = configKeys.length; i < len; i++) {
				const k = configKeys[i];
				showConfig(k);
				refreshResetArrow(document.getElementById(`options_${k}`), k);
			}
			refreshBgScrollDisabled();
			refreshListCountDisabled();
		} catch (e) {
			importsArea.value = '';
			importsArea.placeholder = `${importErrorReason(e)}`;
		}
	};

	const options = document.getElementById('options');
	const nav = document.getElementById('options_nav');

	const sections = [...options.getElementsByClassName('section')];
	const navChildren = [...nav.children];
	const navLen = navChildren.length;
	function selectNav(i) {
		navChildren[activeNavIndex].firstChild.classList.remove('current');
		sections[activeNavIndex].classList.remove('current');
		activeNavIndex = i;
		navChildren[activeNavIndex].firstChild.classList.add('current');
		sections[activeNavIndex].classList.add('current');
		coreHooks?.setDetailsMenuActive?.(activeNavIndex === DETAILS_TAB_INDEX);
	}
	function refreshActiveTab() {
		if (activeNavIndex === navLen - 1) renderAdvancedCss();
		if (activeNavIndex === navLen - 2) exportsArea.value = exportSettings();
	}
	// Restore the last selected navigation item
	if (navLen) {
		const saved = parseInt(localStorage.getItem('open.options_nav'), 10);
		if (Number.isInteger(saved) && saved >= 0 && saved < navLen && saved !== 0) {
			selectNav(saved);
		}
		refreshActiveTab();
	}
	coreHooks?.setDetailsMenuActive?.(activeNavIndex === DETAILS_TAB_INDEX);
	for (let i = 0; i < navLen; i++) {
		const a = navChildren[i].firstChild;
		a.onclick = function () {
			selectNav(i);
			BookmarkCache.safeSetItem('open.options_nav', String(i));
			refreshActiveTab();
			return false;
		};
	}
	initializeThemeOptions();
	initializeConfigControls();
	BookmarkCache.getFolder('0').then(async (rootFolder) => {
		const placeholder = document.getElementById('options_show_bookmarks');
		const children = rootFolder?.children || [];
		for (let i = 0, len = children.length; i < len; i++) {
			const node = children[i];
			if (!node.isFolder) continue;

			const key = `show_${node.id}`;
			config[key] = 1;

			const span = document.createElement('span');
			span.textContent = node.title;

			const input = document.createElement('input');
			input.type = 'checkbox';
			input.id = `options_${key}`;

			const label = document.createElement('label');
			label.append(span, input);
			placeholder.append(label);
		}

		initializeConfigControls();
	});
}

function showOptions(show, hooks) {
	coreHooks = hooks;
	if (show && !settingsInitialized) initSettings();
	document.getElementById('options').style.display = show ? 'block' : 'none';
	coreHooks.setUiBusy(show);
	coreHooks.setDetailsMenuActive?.(show && activeNavIndex === DETAILS_TAB_INDEX);
	if (show) {
		const configKeys = Object.keys(config);
		for (let i = 0, len = configKeys.length; i < len; i++) {
			showConfig(configKeys[i]);
		}
	} else {
		coreHooks.drainPendingBookmarkRender();
	}
}

// Refresh settings controls after configuration changes
addConfigChangeListener((key, value) => {
	showConfig(key);
	refreshResetArrow(document.getElementById(`options_${key}`), key, value);
	if (key === 'background_scroll') refreshBgScrollDisabled();
	if (key.startsWith('show_')) refreshListCountDisabled();
	if (key === 'theme') {
		const configKeys = Object.keys(config);
		for (let i = 0, len = configKeys.length; i < len; i++) {
			const k = configKeys[i];
			if (k === key) continue;
			showConfig(k);
			refreshResetArrow(document.getElementById(`options_${k}`), k);
		}
	}
});

export {
	exportReplacer,
	exportSettings,
	importErrorReason,
	parseImportedSettings,
	showOptions, //
};
