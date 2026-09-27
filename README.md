<h2><img align='center' src='https://raw.githubusercontent.com/Maxi9090/HumbleNewTab-fork/main/icons/logo.svg' style='height:35px;'> HumbleNewTab-fork</h2>

A Firefox-only fork of [Humble New Tab Page](https://github.com/ibillingsley/HumbleNewTabPage) focused on instant loading, local-only favicons, and quality of life improvements. Same layout, fully offline, completely rewritten internals.

Requires Firefox 140 or later.

## How it differs

- **Speed.** The original was built for Chrome, where extension API calls are cheap. On Firefox, those same calls cross a process boundary, so every new tab waited on a long chain of API round-trips with a sustained CPU spike while the page assembled itself from scratch. This fork adds a background page and moves that work there, so the page renders from data that is already available:
  - reads the full bookmark tree once, keeps it up to date in the background, and renders from a stored copy, so opening a new tab does no bookmark API call at all and is effectively instant (the original read the tree on every load, and called the bookmarks API again the first time you opened a folder).
  - does no capture or fetch for the icons it already has stored, so a new tab renders them immediately (the original pointed every row at a provider URL, so icons came from the network on every load).
  - caches "Most visited", "Recent bookmarks", "Recently closed tabs", and "Recently closed windows", so they appear instantly (the original called the matching browser API each time those folders rendered).
  - builds bookmark rows in one batch, with no image element per row (the original created an element per row icon).
  - compiles every setting into a single stylesheet (the original created one style element per setting).
  - skips work that would change nothing: it writes only when the stored content changed, and re-renders only when the bookmark tree changed.
  - loads the options panel and the drag and drop code only when used.
  - has many more smaller performance improvements that together add up.
- **Favicons.** The original sets each favicon domain to its `.ico` path, or fetches favicons from third-party providers (DuckDuckGo, Ecosia, Google, Icon Horse, Yandex). All of these options are unreliable, and the providers send your bookmarked domains to those services. This fork never contacts the internet for favicons. Instead it:
  - reads favicons only from your open tabs.
  - captures favicons fully in the background. Opening a bookmarked site in any way is enough to get its favicon, and the extension's new tab page does not need to be open.
  - stores favicons locally so they survive restarts and are already there on the next new tab.
  - uses different icons per path on the same origin (Google Docs and Sheets, Google Maps and Search, for example), each resolving to the correct one.
  - automatically inverts pure white favicons in light theme and pitch black favicons in dark theme, no more invisible favicons.
  - unfortunately can't get bookmark favicons the way Chrome extensions can, so this favicon workaround is the best we can do.
- **Real-time preview:**
  - Changes made in the bookmarks (Library) appear in an already open new tab page without reloading, and "Recent bookmarks" refreshes the same way.
  - There is no polling or scheduled sync. The listeners fire only on actual changes.
  - Every setting applies as you change it: sliders while you drag them, colors, checkboxes, number inputs, and text fields as you edit them.
  - The theme can follow your browser's light or dark preference in real-time.
  - "Recently closed tabs" and "Recently closed windows" update as you close tabs or windows, as you restore an entry from them, and as you remove entries in Firefox View.
- **Improved drag and drop UX:**
  - Made harder to move unintentionally thanks to small drop zones and spatial thresholds.
  - All areas you can actually move to are dimly visible.
  - Moving close enough to a line shows it at full opacity and allows dropping.
  - Releasing in dead space does nothing.
  - Drag a strayed subfolder back into its parent folder and it re-nests.
- **Refined UI:**
  - Adaptive by default, following your browser preference until you pick a theme.
  - All elements, including the options panel, context menu, and form controls, theme consistently in Light and Dark modes.
  - Options panel restructured and polished: reorganized sidebar buttons, hover effects on every element, nicer color swatches, and more.
  - Replaced the PNG icons with SVG icons that inherit the active theme's text color, stay sharp at any DPI/zoom level, are smaller in file size, and load faster.
  - Improved readability for the generated CSS and the JSON settings export.
- **Reworked sliders:**
  - Every slider has a synced number input for typing exact values.
  - Every slider's value is the exact CSS value and unit (`em`, `%`, `s`, `px`) instead of an abstract position.
  - Every slider spans the full panel width.
  - Font size and font weight became sliders.
- **Privileged URL handling.** Firefox blocks extension navigation to `about:`, `chrome://`, `resource://`, and `file:///` URLs. Clicking such a bookmark copies the URL to the clipboard with a toast, instead of doing nothing.
- **Removed:**
  - The 12 named color themes.
  - Background image URL input.
  - Third-party favicon providers and their selector UI.
  - Browser homepage override from first install.
  - The "Scale with window size" option (bad UX).
  - Chrome-only manifest keys and APIs the upstream Chrome build ("Apps" folder, "Other devices" folder, `fontSettings`, `favicon`, `optional_host_permissions` for `file:///*`) and TBP-Fork (`service_worker`, `alarms`) carried.

### Smaller changes

- "Most visited" (`topSites`) and both "Recently closed" folders (`sessions`) are now optional permissions.
- New tab entries in "Recently closed tabs" are pruned, so closing new tabs does not pollute the list.
- "Open all links in folder" appears only when right-clicking the folder itself, and asks for confirmation before opening.
- Import overrides settings instead of appending them.
- Refined some of the default settings.
- Added "Hide scrollbar" and "Remember scroll position" options.
- Added "Restore closed windows", so closed windows get their own folder instead of mixing into "Recently closed tabs".
- Added zoom and image scrolling for the background image.
- Icons in the layout now scales when adjusting font size.
- Added a text outline option for better visibility with certain background images/colors.
- Folder animation no longer overlaps.
- Added "Dynamic height animation", which switches the folder animation to a constant speed when off.
- The highlight effect stays active while the "Details" menu is open, so you can adjust it and see the changes.
- Failed and privileged-URL favicons get their own placeholder icons.
- Added a "Navigate to latest new tab" shortcut (in `about:addons` → ⚙️ → Manage Extension Shortcuts) that goes to the most recently used new tab page if one is open, otherwise opens a fresh one.
- Fixed new tab missing its favicon.
- Improved keyboard navigation.
- Added error pages for storage full and bookmarks/cache errors.
- Many additional backend improvements: legacy and dead code removal, internal refactoring, and modernization throughout the codebase.

## Install

The extension in this repository runs directly from source (`js-src/*.mjs` and `newtab.css`), no build step is required to load or test it.

Load as a temporary add-on via `about:debugging#/runtime/this-firefox` by selecting `manifest.json`, or run `web-ext run --source-dir .` ([web-ext](https://extensionworkshop.com/documentation/develop/getting-started-with-web-ext/)).

Advice: Add `:root {--tabpanel-background-color: YOUR_COLOR_HERE !important;}` in your `userChrome.css` with your background color to fix flicker caused by `about:blank` having a different color.

## Distribution

`build.mjs` bundles and minifies.

Prerequisites: [Node.js](https://nodejs.org/).

```text
npm install
npm run build-for-amo
```

Output:

```text
js-dist
├── background.bundle.mjs
├── drag-drop.bundle.mjs
├── newtab.bundle.mjs
├── settings-ui.bundle.mjs
└── shared-bundle.mjs
newtab.min.css
```

To use the built files:

`newtab.html`:

```html
	<link rel='stylesheet' href='newtab.min.css'>
	<link rel='modulepreload' href='js-dist/shared-bundle.mjs'>
	<script type='module' src='js-dist/newtab.bundle.mjs'></script>
```

`manifest.json`:

```json
	"background": {
		"scripts": ["js-dist/background.bundle.mjs"],
		"type": "module"
	},
```

## License explained simply

Private use is unrestricted. You can use, change, and share GPL-3.0 code freely, but if you distribute a copy or a modified version, you must license it under GPL-3.0 and provide the source code.
