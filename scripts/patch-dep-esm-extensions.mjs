#!/usr/bin/env node
// Workaround for upstream packaging bugs in the @session.js/* dependency
// packages, whose published dist files do not import cleanly under Node's
// strict ESM resolver (Bun tolerates all three):
//
//  1. Extensionless relative specifiers (e.g. `from "./compiled"`) —
//     Node throws ERR_MODULE_NOT_FOUND; rewrite to add `.js`.
//  2. Bare subpaths of packages without an "exports" map
//     (`from "protobufjs/minimal"`) — same; rewrite to the explicit file.
//  3. Named imports from the CJS `lodash` bundle (`import { isNil } from
//     "lodash"`) — Node's cjs-module-lexer cannot statically detect
//     lodash's exports on the runner's Node 22; rewrite to a default
//     import plus destructuring.
//  4. Namespace imports of CJS packages (`import * as $protobuf from
//     "protobufjs/minimal"`) — Node's namespace for a CJS module exposes
//     only `default` plus statically-detectable names, and protobufjs's
//     minimal entry is a dynamic re-export, so `.Reader`/`.roots`/...
//     come back undefined at runtime. Rewrite to a default import
//     (module.exports itself — the form Bun rewrites these to).
//
// Idempotent; no-op for specifiers/imports already in the safe form
// (Bun sometimes rewrites these at install time — results converge either
// way). Patches node_modules only — the real fix belongs upstream in the
// @session.js/* packages. Used by the node-22 CI lane's import check.

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
const LODASH_NAMED = /import\s*\{([^}]+)\}\s*from\s*(["'])lodash\2\s*;?/g;
// Must run before BARE (which would add `.js` and break this match).
const STAR_AS_CJS = /import\s*\*\s*as\s+([\w$]+)\s*from\s*(["'])(protobufjs(?:\/minimal)?)\2\s*;?/g;
let patchedFiles = 0;
let patchedSpecifiers = 0;
for (const file of walk(root)) {
	const src = readFileSync(file, "utf8");
	let out = src.replace(STAR_AS_CJS, (_match, name, quote, pkg) => {
		patchedSpecifiers++;
		const target = pkg === "protobufjs" ? "protobufjs" : "protobufjs/minimal.js";
		return `import ${name} from ${quote}${target}${quote};`;
	});
	out = out.replace(SPECIFIER, (match, kw, quote, spec) => {
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
	// Named CJS imports of lodash: default-import once per file, then
	// destructure (`as` aliases become `:` renames in the pattern).
	let lodashDefaultAdded = false;
	out = out.replace(LODASH_NAMED, (_match, names, quote) => {
		patchedSpecifiers++;
		const pattern = names.trim().replace(/\s+as\s+/g, ": ");
		const destructure = `const { ${pattern} } = __lodash_default;`;
		if (!lodashDefaultAdded) {
			lodashDefaultAdded = true;
			return `import __lodash_default from ${quote}lodash${quote};\n${destructure}`;
		}
		return destructure;
	});
	if (out !== src) {
		writeFileSync(file, out);
		patchedFiles++;
	}
}
console.log(
	`patch-dep-esm-extensions: ${patchedSpecifiers} specifier(s) in ${patchedFiles} file(s) under node_modules/@session.js`,
);
