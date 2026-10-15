<h2><img src='https://github.com/Maxi9090/HumbleNewTab-fork/raw/refs/heads/main/icons/logo.svg' height='30' alt=''> Humble New Tab - fork</h2>

A Firefox-only fork of [Humble New Tab Page](https://github.com/ibillingsley/HumbleNewTabPage) focused on instant loading, local-only favicons, and quality-of-life improvements. Same layout, fully offline, completely rewritten internals.

> [!NOTE]
> Requires desktop Firefox 121 or later.

## How this fork differs

- **Speed:**
  - Background page does most of the hard work, and the new tab page renders from data that is already stored.
  - Bookmark tree is cached and kept up to date in the background. Opening a new tab makes no bookmark API call.
  - Doesn't fetch or capture favicons it already stored. It only renders them from storage.
  - Caches "Most visited", "Recent bookmarks", "Recently closed tabs", and "Recently closed windows", so they appear instantly.
  - Bookmark rows are built in one batch, with no separate image element per row.
  - Every setting compiles into a single stylesheet.
  - Writes only on real content change, re-renders only when the bookmark tree changes.
  - The options panel code loads only when clicked.
  - The drag-drop code loads only after the initial render. When "Lock columns" is enabled, drag-drop is never loaded.
  - Plus many more smaller performance improvements that together add up.
- **Favicons:**
  - Never contacts the internet for favicons. Reads favicons only from your open tabs.
  - Favicon capture runs fully in the background. Opening a bookmarked site in any way is enough to get its favicon, and the extension's new tab page does not need to be open.
  - Favicons stored locally, so they survive restarts and are ready on the next new tab.
  - Uses different icons per path on the same origin (Google Docs and Sheets, Google Maps and Search), each resolving to the correct one.
  - Automatically inverts near-white favicons in light theme and near-black favicons in dark theme, no more invisible favicons.
  - Firefox can't get bookmark favicons the way Chrome extensions can. So this tab capture is the best workaround.
- **Real-time preview:**
  - Bookmark changes in the Library appear in an open new tab page without a reload, and "Recent bookmarks" refreshes the same way.
  - No polling, no scheduled sync. Listeners fire only on actual changes.
  - Sliders update in real-time while dragging.
  - The theme can follow your browser's light or dark preference.
  - "Recently closed tabs" and "Recently closed windows" update on tab or window close, on restore, and on removal in Firefox View (`about:firefoxview`).
- **Drag and drop UX:**
  - Made harder to move unintentionally, thanks to small drop zones and spatial thresholds.
  - Releasing in dead space does nothing.
  - All areas you can actually move to are dimly visible.
  - Moving close enough to a line shows it at full opacity and allows dropping.
  - Drag a strayed subfolder back into its parent folder and it re-nests.
- **Refined UI:**
  - Adaptive by default, following the browser preference until you pick a theme.
  - All elements, including the options panel, context menu, and form controls, have consistent colors for Light and Dark modes.
  - Options panel restructured and polished: reorganized sidebar buttons, hover effects on every element, nicer color swatches, and more.
  - SVG icons instead of PNG: inherit the theme's text color, stay sharp at any DPI/zoom, smaller, faster to load.
  - Improved readability for the generated CSS and the export settings text boxes.
- **Reworked sliders:**
  - Every slider has a synced number input for exact values.
  - Slider values are the exact CSS value and unit (`em`, `%`, `s`, `px`), not an abstract position.
  - Every slider spans the full panel width.
  - Font size and font weight are sliders.
- **Privileged URLs:** Firefox blocks extension navigation to `about:`, `chrome://`, `resource://`, and `file:///` URLs. Clicking such a bookmark copies the URL to the clipboard and shows a toast.
- **Removed:**
  - The 12 named color themes.
  - Background image URL input.
  - Third-party favicon providers and their selector UI.
  - Browser homepage override on first install.
  - The "Scale with window size" option (bad UX).
  - Chrome-only manifest keys and APIs the upstream Chrome build ("Apps" folder, "Other devices" folder, `fontSettings`, `favicon`, `optional_host_permissions` for `file:///*`) and TBP-Fork (`service_worker`, `alarms`) carried.

### Smaller changes

- "Most visited" (`topSites`) and both "Recently closed" folders (`sessions`) are now optional permissions.
- New tab entries in "Recently closed tabs" are pruned, so closing new tabs does not pollute the list.
- "Open all links in folder" appears only when right-clicking the folder itself, and asks for confirmation first.
- Import overrides settings instead of appending them.
- Refined some of the default settings.
- Added "Hide scrollbar" and "Remember scroll position" options.
- Split "Recently closed" into "Recently closed tabs" and "Recently closed windows".
- Added zoom and image scrolling for the background image feature.
- Icons in the layout now scale when adjusting font size.
- Added a text outline option for better visibility over certain background images or colors.
- Folder animations no longer overlap.
- Added a "Dynamic height animation" option, which switches the folder animation to a constant speed when off.
- The highlight effect stays active while the "Details" menu is open, so you can adjust it while seeing it.
- Added an undo feature (in import settings) which reverts the last change of any setting, but only one step is recorded.
- Failed and privileged-URL favicons get their own placeholder icons.
- Added a "Navigate to latest new tab" shortcut (in `about:addons` → ⚙️ → Manage Extension Shortcuts). It goes to the most recently used new tab page if one is open, otherwise opens a fresh one.
- Fixed new tab missing its favicon.
- Improved keyboard navigation.
- Error pages for storage full and bookmarks/cache errors.
- Many additional backend improvements: legacy and dead code removal, internal refactoring, and modernization throughout the codebase.

## Install

<a href='https://addons.mozilla.org/en-US/firefox/addon/humblenewtab-fork/'>
<img height='70' src='https://blog.mozilla.org/addons/files/2020/04/get-the-addon-fx-apr-2020.svg' alt="Get the add-on."></a>

---

The extension in this repository runs directly from source (`js-src/*.mjs` and `newtab.css`), no build step is required to load or test it.

Load as a temporary extension via `about:debugging#/runtime/this-firefox` by selecting `manifest.json`, or run `web-ext run --source-dir .` ([web-ext](https://extensionworkshop.com/documentation/develop/getting-started-with-web-ext/)).

> [!TIP]
> Add `:root {--tabpanel-background-color: YOUR_COLOR_HERE !important;}` in your `userChrome.css` with your background color to fix flicker caused by `about:blank` having a different color.

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
├── settings-undo.bundle.mjs
└── shared-bundle.mjs
newtab.min.css
```

To use the built files:

`newtab.html`:

```diff
 	<meta name='color-scheme' content='dark light'>
-	<link rel='stylesheet' href='newtab.css'>
-	<link rel='modulepreload' href='js-src/bookmark-cache.mjs'>
-	<link rel='modulepreload' href='js-src/themes.mjs'>
-	<link rel='modulepreload' href='js-src/favicons-ui.mjs'>
-	<link rel='modulepreload' href='js-src/config-engine.mjs'>
-	<script type='module' src='js-src/newtab.mjs'></script>
+	<link rel='stylesheet' href='newtab.min.css'>
+	<link rel='modulepreload' href='js-dist/shared-bundle.mjs'>
+	<script type='module' src='js-dist/newtab.bundle.mjs'></script>
 	<link rel='icon' href='icons/newtab.svg'>
```

`manifest.json`:

```diff
 	"background": {
-		"scripts": ["js-src/background.mjs"],
+		"scripts": ["js-dist/background.bundle.mjs"],
 		"type": "module"
```

## License explained simply

Private use is unrestricted. You can use, change, and share GPL-3.0 code freely, but if you distribute a copy or a modified version, you must license it under GPL-3.0 and provide the source code.
