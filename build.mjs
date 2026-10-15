import * as esbuild from 'esbuild';
import {transform} from 'lightningcss';
import {mkdir, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';

// Build outputs are regenerated only before distribution

const here = import.meta.dirname;
const srcDir = path.join(here, 'js-src');
const distDir = path.join(here, 'js-dist');

// Wrapper files must point at the bundled outputs before packaging. Already-bundled is a no-op, a file matching neither form throws
const switchPairs = [
	{
		file: 'newtab.html',
		source: `	<link rel='stylesheet' href='newtab.css'>
	<link rel='modulepreload' href='js-src/bookmark-cache.mjs'>
	<link rel='modulepreload' href='js-src/themes.mjs'>
	<link rel='modulepreload' href='js-src/favicons-ui.mjs'>
	<link rel='modulepreload' href='js-src/config-engine.mjs'>
	<script type='module' src='js-src/newtab.mjs'></script>`,
		bundled: `	<link rel='stylesheet' href='newtab.min.css'>
	<link rel='modulepreload' href='js-dist/shared-bundle.mjs'>
	<script type='module' src='js-dist/newtab.bundle.mjs'></script>`,
	},
	{
		file: 'manifest.json',
		source: '"scripts": ["js-src/background.mjs"]',
		bundled: '"scripts": ["js-dist/background.bundle.mjs"]',
	},
];

const distOutputs = [
	'newtab.bundle.mjs',
	'settings-ui.bundle.mjs',
	'drag-drop.bundle.mjs',
	'settings-undo.bundle.mjs',
	'background.bundle.mjs',
	'shared-bundle.mjs', //
];
await mkdir(distDir, {recursive: true});
for (const f of distOutputs) await rm(path.join(distDir, f), {force: true});
for (const f of await readdir(distDir)) {
	if (/^chunk-[A-Z0-9]+\.mjs$/.test(f) || /^shared\d+\.mjs$/.test(f)) await rm(path.join(distDir, f), {force: true});
}
await rm(path.join(here, 'newtab.min.css'), {force: true});

// Share hot modules so the page and lazy chunks use one BookmarkCache and config-engine instance.
// The shared chunks stay external in the rebuild passes below so those singletons cannot split.
const result = await esbuild.build({
	entryPoints: [path.join(srcDir, 'newtab.mjs')],
	bundle: true,
	splitting: true,
	format: 'esm',
	platform: 'browser',
	target: 'firefox121',
	absWorkingDir: here,
	outdir: distDir,
	entryNames: '[name].bundle',
	chunkNames: 'chunk-[hash]',
	outExtension: {'.js': '.mjs'},
	sourcemap: false,
	minify: true,
	legalComments: 'none',
	logLevel: 'info',
	metafile: true,
	write: false,
});

// Rename chunks to stable source-based names and leave the entry name unchanged.
// Names come from chunk inputs, never output order: the hot-modules chunk must keep the shared-bundle.mjs name.
const renameMap = new Map();
let sharedIndex = 0;
for (const [outPath, out] of Object.entries(result.metafile.outputs)) {
	if (!outPath.endsWith('.mjs') || path.basename(outPath) === 'newtab.bundle.mjs') continue;
	const inputs = Object.keys(out.inputs || {});
	const ends = (re) => inputs.some((i) => i.split(path.sep).join('/').match(re));
	let newName;
	if (ends(/js-src\/settings-ui\.mjs$/)) newName = 'settings-ui.bundle.mjs';
	else if (ends(/js-src\/drag-drop\.mjs$/)) newName = 'drag-drop.bundle.mjs';
	else if (ends(/js-src\/bookmark-cache\.mjs$/)) newName = 'shared-bundle.mjs';
	else if (ends(/js-src\/settings-undo\.mjs$/)) newName = 'settings-undo.bundle.mjs';
	else newName = `shared${++sharedIndex}.mjs`;
	renameMap.set(path.basename(outPath), newName);
}

const lazyNames = ['settings-ui.bundle.mjs', 'drag-drop.bundle.mjs'];
const sharedExternals = [];
for (const name of new Set(renameMap.values())) {
	if (!lazyNames.includes(name)) sharedExternals.push(`./${name}`);
}
const lazyExternals = lazyNames.map((name) => `./${name}`);

for (const out of result.outputFiles) {
	let text = out.text;
	let outPath = out.path;
	const base = path.basename(outPath);
	for (const [oldB, newB] of renameMap) {
		text = text.split(`"./${oldB}"`).join(`"./${newB}"`);
	}
	const finalBase = renameMap.get(base);
	if (finalBase) outPath = path.join(path.dirname(outPath), finalBase);
	// The entry has no importers, so remove its unused export block
	if (base === 'newtab.bundle.mjs') {
		text = text.replace(/\bexport\s*\{[^}]*\}\s*;?\s*$/, '');
	}
	await writeFile(outPath, text.trimEnd());
}

// Keep only the binding used from each dynamically imported chunk.
// Rebuild with every shared chunk external so no hot module is inlined twice.
const lazyChunks = [
	{file: 'settings-ui.bundle.mjs', keep: 'showOptions'},
	{file: 'drag-drop.bundle.mjs', keep: 'register'},
];
for (const {file, keep} of lazyChunks) {
	const fp = path.join(distDir, file);
	let text = await readFile(fp, 'utf8');
	const expMatch = text.match(/export\s*\{([^}]*)\}/);
	if (expMatch) {
		const entries = expMatch[1]
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean);
		const keepEntry = entries.find((e) => e.split(' as ')[1] === keep);
		if (keepEntry) text = text.replace(/export\s*\{[^}]*\}\s*;?/, `export{${keepEntry}};`);
	}
	await esbuild.build({
		stdin: {contents: text, resolveDir: distDir, loader: 'js'},
		bundle: true,
		external: sharedExternals,
		format: 'esm',
		target: 'firefox121',
		outfile: fp,
		sourcemap: false,
		minify: true,
		legalComments: 'none',
		logLevel: 'silent',
	});
	await writeFile(fp, (await readFile(fp, 'utf8')).trimEnd());
}

// The entry has no importers, so its export block is already removed.
// Rebuild with the shared chunks and the lazy bundles external to remove dead test-only declarations.
{
	const fp = path.join(distDir, 'newtab.bundle.mjs');
	await esbuild.build({
		stdin: {contents: await readFile(fp, 'utf8'), resolveDir: distDir, loader: 'js'},
		bundle: true,
		external: [...sharedExternals, ...lazyExternals],
		format: 'esm',
		target: 'firefox121',
		outfile: fp,
		sourcemap: false,
		minify: true,
		legalComments: 'none',
		logLevel: 'silent',
	});
	await writeFile(fp, (await readFile(fp, 'utf8')).trimEnd());
}

// Inline bookmark-cache.mjs because the background has its own BookmarkCache instance
const bg = await esbuild.build({
	entryPoints: [path.join(srcDir, 'background.mjs')],
	bundle: true,
	format: 'esm',
	platform: 'browser',
	target: 'firefox121',
	absWorkingDir: here,
	outdir: distDir,
	entryNames: 'background.bundle',
	outExtension: {'.js': '.mjs'},
	sourcemap: false,
	minify: true,
	legalComments: 'none',
	logLevel: 'info',
	write: false,
});
let bgText = bg.outputFiles[0].text;
bgText = bgText.replace(/\bexport\s*\{[^}]*\}\s*;?\s*$/, '');
await writeFile(path.join(distDir, 'background.bundle.mjs'), bgText.trimEnd());

// The background entry has no importers, so its export block is already removed.
// Rebuild to remove dead test-only declarations.
{
	const fp = path.join(distDir, 'background.bundle.mjs');
	await esbuild.build({
		stdin: {contents: await readFile(fp, 'utf8'), resolveDir: distDir, loader: 'js'},
		bundle: true,
		format: 'esm',
		target: 'firefox121',
		outfile: fp,
		sourcemap: false,
		minify: true,
		legalComments: 'none',
		logLevel: 'silent',
	});
	await writeFile(fp, (await readFile(fp, 'utf8')).trimEnd());
}

// Minify newtab.css with lightningcss
const css = await readFile(path.join(here, 'newtab.css'));
const {code} = transform({
	filename: 'newtab.css',
	code: css,
	minify: true,
	targets: {firefox: 121 << 16},
});
await writeFile(path.join(here, 'newtab.min.css'), code.toString().trimEnd());

// Runs last, so a failed build leaves the wrapper files in source mode
for (const {file, source, bundled} of switchPairs) {
	const fp = path.join(here, file);
	const text = await readFile(fp, 'utf8');
	if (text.includes(source)) await writeFile(fp, text.replace(source, bundled));
	else if (!text.includes(bundled)) throw new Error(`${file}: expected reference lines not found`);
}
