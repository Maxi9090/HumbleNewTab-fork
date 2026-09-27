import {themes} from './themes.mjs';
import {BookmarkCache} from './bookmark-cache.mjs';

// Theme-dependent values use null placeholders
const config = {
	theme: null,
	newtab: 0,
	lock: 0,
	remember_open: 1,
	auto_close: 0,
	show_root: 1,
	hide_options: 0,
	hide_scrollbar: 0,
	remember_scroll: 0,

	show_top: 0,
	show_recent: 1,
	show_closed: 0,
	show_windows: 0,
	number_closed: 15,
	number_top: 15,
	number_recent: 15,
	number_windows: 15,

	font_color: null,
	font: 'sans-serif',
	font_size: 1.25,
	font_weight: 400,
	font_outline: 0,

	background_color: null,
	background_image_file: '',
	background_size: 'auto',
	background_align: 'left top',
	background_repeat: 'repeat',
	background_zoom: 100,
	background_scroll: 0,
	background_scroll_speed: 1,

	spacing: 1.95,
	v_margin: 5,
	width: 80,
	h_pos: 50,

	highlight_color: null,
	highlight_font_color: null,
	shadow_color: null,
	shadow_blur: 4,
	highlight_round: 0.7,
	fade: 0.04,
	slide: 0.1,
	dynamic_height_animation: 1,

	css: '',
};

// The active theme is loaded from themes.mjs
let theme = {};

// Cache values to avoid repeated localStorage reads during rendering
const configCache = new Map();

function getConfig(key) {
	// Use one get instead of separate has and get lookups
	const cached = configCache.get(key);
	if (cached !== undefined) return cached;

	let result;
	if (key === 'theme') {
		// Prefer an explicit theme, otherwise follow the browser preference
		result = themes._.resolve();
	} else {
		const value = localStorage.getItem(`options.${key}`);
		if (value != null) {
			// Convert dynamic show_* keys to numbers
			const isShowKey = key.startsWith('show_');
			const isNumber = typeof config[key] === 'number' || (isShowKey && !(key in config));
			result = isNumber ? Number(value) : value;
		} else {
			// Resolve null placeholders from the active theme
			result = key in theme && theme[key] != null ? theme[key] : config[key];
		}
	}
	configCache.set(key, result);
	return result;
}

// Keep storage and style updates here. Listeners handle other side effects
function setConfig(key, value) {
	configCache.delete(key);

	const storageKey = `options.${key}`;
	if (value != null) {
		BookmarkCache.safeSetItem(storageKey, typeof config[key] === 'number' ? Number(value) : value);
	} else {
		BookmarkCache.safeRemoveItem(storageKey);
		value = key === 'theme' ? themes._.resolve() : key in theme && theme[key] != null ? theme[key] : config[key];
	}

	if (key === 'theme') applyTheme(value);
	else regenerateStylesheet();
	notifyConfigChange(key, value);
	return value;
}

const styleSchema = {
	font: (v) => `#main a {font-family: ${v};}`,
	font_size: (v) => `#main {font-size: ${v}em;}`,
	font_weight: (v) => `#main a {font-weight: ${v};}`,
	font_outline: (v) => (v ? `#main a {filter:\n    drop-shadow(0 0 1px var(--bg))\n    drop-shadow(0 0 1px var(--bg))\n    drop-shadow(0 0 1px var(--bg));}` : null),
	font_color: (v) => `
		#main a {color: ${v};}
		#main .column a::before {background-color: color-mix(in srgb, ${v} 80%, transparent);}
	`,
	background_color: (v) => `body {background-color: ${v};}`,
	background_image_file: (v) => (v ? `body {background-image: url(${v});}` : null),
	background_align: (v) => `body {background-position: ${v};}`,
	background_repeat: (v) => `body {background-repeat: ${v};}`,
	background_size: (v) => {
		if (getConfig('background_zoom') !== 100) return null;
		return `body {background-size: ${v}; background-attachment: fixed;}`;
	},
	background_zoom: (v) => {
		if (v === 100) return null;
		// Zoom multiplies the Size fit, so 100 lines up with every Size mode
		const zoom = v / 100;
		const base = getConfig('background_size');
		const width = Number(localStorage.getItem('background_image_width'));
		const height = Number(localStorage.getItem('background_image_height'));
		let size = base;
		if (width && height) {
			if (base === 'auto') size = `${Math.round(width * zoom)}px`;
			else if (base === 'cover' || base === 'contain') {
				const ratio = Math.round((width / height) * 10000) / 10000;
				size = `calc(${zoom} * ${base === 'cover' ? 'max' : 'min'}(100%, 100vh * ${ratio}))`;
			}
		}
		return `body {background-size: ${size}; background-attachment: fixed;}`;
	},

	highlight_font_color: (v) => `
		#main a:hover, #main a.menu-active, #main a.details-active {color: ${v};}
		#main .column a:hover:before {background-color: color-mix(in srgb, ${v} 80%, transparent);}
	`,
	highlight_color: (v) => `
		#main a:hover, #main a.menu-active, #main a.details-active {background-color: ${v};}
		.column-menu-active, .column-details-active {background-color: color-mix(in srgb, ${v} 35%, transparent);}
	`,
	shadow_color: (v) => `
		#main a:hover, #main a.menu-active, #main a.details-active {box-shadow: 0 0 ${getConfig('shadow_blur')}px ${v};}
		.column-menu-active, .column-details-active {box-shadow: 0 0 ${getConfig('shadow_blur')}px color-mix(in srgb, ${v} 35%, transparent);}
	`,
	shadow_blur: (v) => `
		#main a:hover, #main a.menu-active, #main a.details-active {box-shadow: 0 0 ${v}px ${getConfig('shadow_color')};}
		.column-menu-active, .column-details-active {box-shadow: 0 0 ${v}px color-mix(in srgb, ${getConfig('shadow_color')} 35%, transparent);}
	`,
	highlight_round: (v) => `#main a, .column-menu-active, .column-details-active, .drop-overlay-merge, #toast {border-radius: ${v}em;}`,
	fade: (v) => `#main a {transition-duration: ${v}s;}`,
	slide: (v) => `.wrap {transition-duration: ${v}s;}`,
	// Padding stays bound to the line height: one control, padding at a third of the row
	spacing: (v) => `
		#main a {
			line-height: ${v};
			padding-inline: ${round2(v / 3)}em;
		}
	`,
	width: (v) => `#main {width: ${v}%;}`,
	// Align is a position inside the free space width leaves, so its percent scales with width
	h_pos: (v, width = getConfig('width')) => `#main {left: ${round2(((v - 50) * (100 - width)) / 100)}%;}`,
	v_margin: (v) => `#main {margin-top: ${v}%;}`,
	hide_options: (v) => (v ? '#options_button {opacity: 0;}' : null),
	css: (v) => v,
};

// Trim the float noise the products carry (1.95 / 3, percentages of the free space)
function round2(value) {
	return Math.round(value * 100) / 100;
}

let styleElement = null;
let chromeCss = '';
let schemaCss = '';

function writeStyles() {
	if (!styleElement) {
		styleElement = document.createElement('style');
		document.head.append(styleElement);
	}
	styleElement.textContent = chromeCss + schemaCss;
}

function regenerateStylesheet() {
	const configKeys = Object.keys(config);
	const cssParts = [];
	for (let i = 0, len = configKeys.length; i < len; i++) {
		const key = configKeys[i];
		const value = getConfig(key);
		const css = styleSchema[key]?.(value);
		if (css) cssParts.push(css);
	}
	schemaCss = cssParts.join('\n');
	writeStyles();
}

// Rebuilding all rules keeps dependent style values in sync

function applyThemeChrome() {
	const chrome = theme.chrome;
	if (!chrome) {
		chromeCss = '';
	} else {
		chromeCss =
			':root{' +
			Object.entries(chrome)
				.map(([k, v]) => `${k}:${v};`)
				.join('') +
			'}';
	}
}

// Apply themes from settings, direct changes, and browser preference changes
function applyTheme(name) {
	theme = themes[name] ?? themes.Dark;
	configCache.clear();
	applyThemeChrome();
	regenerateStylesheet();
	const sel = document.getElementById('options_theme');
	if (sel) sel.value = name;
}

const configChangeListeners = [];
function addConfigChangeListener(fn) {
	configChangeListeners.push(fn);
}

// Notify listeners without writing storage or regenerating styles
function notifyConfigChange(key, value) {
	for (const cb of configChangeListeners) {
		try {
			cb(key, value);
		} catch (e) {
			console.warn('[config] listener threw', e);
		}
	}
}

export {config, theme, configCache, getConfig, setConfig, styleSchema, applyTheme, notifyConfigChange, addConfigChangeListener};
