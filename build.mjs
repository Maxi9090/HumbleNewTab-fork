import * as esbuild from 'esbuild';
import {transform} from 'lightningcss';
import {mkdir, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';

// Build outputs are regenerated only before distribution

const here = import.meta.dirname;
const srcDir = path.join(here, 'js-src');
const distDir = path.join(here, 'js-dist');

const distOutputs = [
	'newtab.bundle.mjs',
	'settings-ui.bundle.mjs',
	'drag-drop.bundle.mjs',
	'background.bundle.mjs',
	'shared-bundle.mjs', //
];
await mkdir(distDir, {recursive: true});
for (const f of distOutputs) await rm(path.join(distDir, f), {force: true});
for (const f of await readdir(distDir)) {
	if (/^chunk-[A-Z0-9]+\.mjs$/.test(f)) await rm(path.join(distDir, f), {force: true});
}
await rm(path.join(here, 'newtab.min.css'), {force: true});

// Share hot modules so the page and lazy chunks use one BookmarkCache and config-engine instance.
// Keep shared-bundle.mjs external to avoid duplicating those singletons.
const result = await esbuild.build({
	entryPoints: [path.join(srcDir, 'newtab.mjs')],
	bundle: true,
	splitting: true,
	format: 'esm',
	platform: 'browser',
	target: 'firefox140',
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

// Rename chunks to stable source-based names and leave the entry name unchanged
const renameMap = new Map();
let sharedIndex = 0;
for (const [outPath, out] of Object.entries(result.metafile.outputs)) {
	if (!outPath.endsWith('.mjs') || path.basename(outPath) === 'newtab.bundle.mjs') continue;
	const inputs = Object.keys(out.inputs || {});
	const ends = (re) => inputs.some((i) => i.split(path.sep).join('/').match(re));
	let newName;
	if (ends(/js-src\/settings-ui\.mjs$/)) newName = 'settings-ui.bundle.mjs';
	else if (ends(/js-src\/drag-drop\.mjs$/)) newName = 'drag-drop.bundle.mjs';
	else newName = sharedIndex++ === 0 ? 'shared-bundle.mjs' : `shared${sharedIndex}.mjs`;
	renameMap.set(path.basename(outPath), newName);
}

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
// Rebuild with shared-bundle.mjs external to remove dead declarations.
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
		external: ['./shared-bundle.mjs'],
		format: 'esm',
		target: 'firefox140',
		outfile: fp,
		sourcemap: false,
		minify: true,
		legalComments: 'none',
		logLevel: 'silent',
	});
	await writeFile(fp, (await readFile(fp, 'utf8')).trimEnd());
}

// The entry has no importers, so its export block is already removed.
// Rebuild with local chunks external to remove dead test-only declarations without duplicating shared code.
{
	const fp = path.join(distDir, 'newtab.bundle.mjs');
	await esbuild.build({
		stdin: {contents: await readFile(fp, 'utf8'), resolveDir: distDir, loader: 'js'},
		bundle: true,
		external: ['./shared-bundle.mjs', './drag-drop.bundle.mjs', './settings-ui.bundle.mjs'],
		format: 'esm',
		target: 'firefox140',
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
	target: 'firefox140',
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
		target: 'firefox140',
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
	targets: {firefox: 140 << 16},
});
await writeFile(path.join(here, 'newtab.min.css'), code.toString().trimEnd());
