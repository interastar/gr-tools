import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = join(root, "tests", ".build");

/**
 * Bundles a source entry to ESM so `node --test` can import it. Dependencies
 * are left external — they resolve from node_modules and don't need bundling
 * for a test run.
 */
export async function bundleForTest(entry, name) {
	mkdirSync(outDir, { recursive: true });
	const outfile = join(outDir, name);
	await build({
		entryPoints: [join(root, entry)],
		bundle: true,
		platform: "node",
		target: "node22",
		format: "esm",
		outfile,
		resolveExtensions: [".ts", ".js", ".mjs", ".json"],
		packages: "external",
		define: { __CODE_VERSION__: JSON.stringify("test"), __FUNCTION_NAME__: JSON.stringify("test") },
		logLevel: "silent",
	});
	return import(`file://${outfile.replace(/\\/g, "/")}`);
}

export const samplesDir = join(root, "samples");
