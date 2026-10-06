/**
 * Deploy stability: every function in the manifest builds into a zip whose
 * `index.js` loads on its own and honours the shared contract — never throw,
 * answer `{ error }` — even when Genesys hands it nothing at all.
 *
 * This builds the real bundles (minified CJS, everything inlined), so it
 * catches what the source-level tests cannot: a bundling regression.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildFunction } from "../functions/build.mjs";
import functions from "../functions/manifest.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = join(root, "tests", ".build", "functions");
const require = createRequire(import.meta.url);

test("the manifest names are unique and every entry is complete", () => {
	const names = functions.map((f) => f.name);
	assert.equal(new Set(names).size, names.length);
	for (const spec of functions) {
		for (const key of ["name", "entry", "description", "memory", "timeout"]) {
			assert.ok(spec[key], `${spec.name}: missing ${key}`);
		}
		assert.equal(typeof spec.pdf, "boolean", `${spec.name}: pdf must be true or false`);
		assert.ok(spec.timeout <= 15, `${spec.name}: Genesys caps the timeout at 15 s`);
	}
});

for (const spec of functions) {
	test(`${spec.name}: builds a self-contained zip that honours the contract`, async () => {
		const result = await buildFunction(spec, { version: "test", outDir });

		const zip = readFileSync(result.zipPath);
		assert.equal(zip.readUInt32LE(0), 0x04034b50, "zip local file header");
		assert.ok(zip.includes(Buffer.from("index.js")), "index.js at the root of the zip");

		const bundle = readFileSync(result.outFile, "utf8");
		assert.ok(bundle.startsWith(`/* ${spec.name} test */`), "stamped with name and version");

		const { handler } = require(result.outFile);
		assert.equal(typeof handler, "function", "exports handler (Genesys field: index.handler)");

		for (const [event, context] of [[undefined, undefined], [{}, {}], [{}, { clientContext: {} }]]) {
			const res = await handler(event, context);
			assert.deepEqual(Object.keys(res), ["error"]);
			assert.equal(typeof res.error, "string");
			assert.ok(res.error.length > 0);
		}
	});
}

test("a function declared pdf: false fails the build if it bundles unpdf", async () => {
	const spec = { ...functions.find((f) => f.pdf), name: "probe-text-only", pdf: false };
	await assert.rejects(() => buildFunction(spec, { version: "test", outDir }), /declared pdf: false but bundles/);
});

test("a text-only function built from src/core-text.ts stays free of unpdf", async () => {
	const spec = { name: "probe-text-only", entry: "tests/fixtures/text-only-function.mjs", pdf: false, memory: 128, timeout: 15 };
	const result = await buildFunction(spec, { version: "test", outDir });
	assert.equal(result.pdfBytes, 0);
	assert.ok(result.bundleBytes < 50 * 1024, `expected a few KB, got ${result.bundleBytes} bytes`);
});
