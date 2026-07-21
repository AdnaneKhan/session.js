#!/usr/bin/env node
// Workaround for an upstream packaging bug in the @session.js/* dependency
// packages: their published dist files use extensionless relative ESM
// specifiers (e.g. `from "./compiled"`), which Bun's resolver tolerates but
// Node's strict ESM resolver rejects with ERR_MODULE_NOT_FOUND. This script
// rewrites those specifiers to add the `.js` extension so the built client
// imports under plain Node (used by the node-22 CI lane's import check).
//
// No-op for specifiers that already carry an extension. Patches
// node_modules only — the real fix belongs upstream in the @session.js/*
// packages (adding extensions at build time).

import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "node_modules", "@session.js");

function* walk(dir) {
	for (const entry of readdirSync(dir)) {
		const p = join(dir, entry);
		if (statSync(p).isDirectory()) yield* walk(p);
		else if (p.endsWith(".js")) yield p;
	}
}

const SPECIFIER = /(from\s*)(["'])(\.\.?\/[^"']+)\2/g;
// Bare subpaths of packages that ship no "exports" map, so Node's ESM
// resolver cannot probe the missing extension (Bun can). protobufjs@7 has
// no exports field; its `minimal.js` entry is CJS and imports cleanly once
// named explicitly.
const BARE_SUBPATH_REWRITES = {
	"protobufjs/minimal": "protobufjs/minimal.js",
};
const BARE = /(from\s*)(["'])([a-z@][^"']*)\2/g;
let patchedFiles = 0;
let patchedSpecifiers = 0;
for (const file of walk(root)) {
	const src = readFileSync(file, "utf8");
	let out = src.replace(SPECIFIER, (match, kw, quote, spec) => {
		if (/\.(js|mjs|cjs|json)$/.test(spec)) return match;
		patchedSpecifiers++;
		return `${kw}${quote}${spec}.js${quote}`;
	});
	out = out.replace(BARE, (match, kw, quote, spec) => {
		const fixed = BARE_SUBPATH_REWRITES[spec];
		if (!fixed) return match;
		patchedSpecifiers++;
		return `${kw}${quote}${fixed}${quote}`;
	});
	if (out !== src) {
		writeFileSync(file, out);
		patchedFiles++;
	}
}
console.log(
	`patch-dep-esm-extensions: ${patchedSpecifiers} specifier(s) in ${patchedFiles} file(s) under node_modules/@session.js`,
);
