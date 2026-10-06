/**
 * Builds the Genesys Cloud Function bundles declared in `functions/manifest.mjs`.
 *
 * Each function is bundled into a single CommonJS file — no `node_modules` in
 * the zip — and stamped with its name and a code version, so a bundle sitting in
 * the Genesys UI can be traced back to a commit.
 *
 * Usage:
 *   pnpm build:function                              # every function, version from package.json + git
 *   pnpm build:function --only gr-extract-pdf        # a single function
 *   pnpm build:function --version 1.4.0              # explicit version
 *
 * Output, per function: functions/dist/<name>/index.js and
 * functions/dist/<name>-<version>.zip (handler `index.handler`).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { deflateRawSync } from "node:zlib";
import { build } from "esbuild";
import functions, { RUNTIME } from "./manifest.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
export const defaultOutDir = join(root, "functions", "dist");

/* ------------------------------------------------------------------ version */

function git(...args) {
	try {
		return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch {
		return "";
	}
}

/**
 * `<pkg version>+<short sha>[-dirty]`, e.g. `1.0.0+a201d8f` — the base version
 * is bumped by hand in package.json, the suffix pins the exact source. A `-dirty`
 * suffix means the bundle contains uncommitted changes and should not be
 * published to Genesys as a released version.
 */
export function resolveVersion() {
	const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
	const sha = git("rev-parse", "--short", "HEAD");
	if (!sha) return pkg.version;
	const dirty = git("status", "--porcelain") ? "-dirty" : "";
	return `${pkg.version}+${sha}${dirty}`;
}

/* ----------------------------------------------------------------------- zip */

const CRC_TABLE = (() => {
	const table = new Int32Array(256);
	for (let i = 0; i < 256; i++) {
		let c = i;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[i] = c;
	}
	return table;
})();

function crc32(buf) {
	let c = ~0;
	for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
	return ~c >>> 0;
}

/**
 * Minimal deflate-based zip writer. A dependency-free single-entry archive is
 * less machinery than pulling in a zip library or shelling out to 7z/zip, which
 * are not guaranteed to exist on a Windows dev box or in CI.
 *
 * Timestamps are fixed to the DOS epoch (1980-01-01) so the same source always
 * produces a byte-identical zip.
 */
function makeZip(entries) {
	const DOS_TIME = 0;
	const DOS_DATE = 0x0021;
	const locals = [];
	const centrals = [];
	let offset = 0;

	for (const { name, data } of entries) {
		const nameBuf = Buffer.from(name, "utf8");
		const compressed = deflateRawSync(data, { level: 9 });
		const crc = crc32(data);

		const local = Buffer.alloc(30 + nameBuf.length);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4); // version needed
		local.writeUInt16LE(0, 6); // flags
		local.writeUInt16LE(8, 8); // method: deflate
		local.writeUInt16LE(DOS_TIME, 10);
		local.writeUInt16LE(DOS_DATE, 12);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(compressed.length, 18);
		local.writeUInt32LE(data.length, 22);
		local.writeUInt16LE(nameBuf.length, 26);
		local.writeUInt16LE(0, 28); // extra field length
		nameBuf.copy(local, 30);

		const central = Buffer.alloc(46 + nameBuf.length);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(0x031e, 4); // version made by: 3.0, unix
		central.writeUInt16LE(20, 6);
		central.writeUInt16LE(0, 8);
		central.writeUInt16LE(8, 10);
		central.writeUInt16LE(DOS_TIME, 12);
		central.writeUInt16LE(DOS_DATE, 14);
		central.writeUInt32LE(crc, 16);
		central.writeUInt32LE(compressed.length, 20);
		central.writeUInt32LE(data.length, 24);
		central.writeUInt16LE(nameBuf.length, 28);
		central.writeUInt16LE(0, 30); // extra
		central.writeUInt16LE(0, 32); // comment
		central.writeUInt16LE(0, 34); // disk number
		central.writeUInt16LE(0, 36); // internal attrs
		central.writeUInt32LE((0o100644 << 16) >>> 0, 38); // external attrs: regular file, rw-r--r--
		central.writeUInt32LE(offset, 42);
		nameBuf.copy(central, 46);

		locals.push(local, compressed);
		centrals.push(central);
		offset += local.length + compressed.length;
	}

	const centralDir = Buffer.concat(centrals);
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0);
	eocd.writeUInt16LE(0, 4);
	eocd.writeUInt16LE(0, 6);
	eocd.writeUInt16LE(entries.length, 8);
	eocd.writeUInt16LE(entries.length, 10);
	eocd.writeUInt32LE(centralDir.length, 12);
	eocd.writeUInt32LE(offset, 16);
	eocd.writeUInt16LE(0, 20);

	return Buffer.concat([...locals, centralDir, eocd]);
}

/* -------------------------------------------------------------------- bundle */

/**
 * Bundles one manifest entry and zips it. Returns the paths and sizes, and
 * rejects if a function declared `pdf: false` ends up bundling unpdf.
 */
export async function buildFunction(spec, { version, outDir = defaultOutDir }) {
	const fnDir = join(outDir, spec.name);
	const outFile = join(fnDir, "index.js");
	mkdirSync(fnDir, { recursive: true });

	const { metafile } = await build({
		entryPoints: [join(root, spec.entry)],
		bundle: true,
		platform: "node",
		// The Genesys runtime, from the manifest (nodejs22.x on arm64).
		target: RUNTIME.target,
		format: "cjs",
		outfile: outFile,
		// The adapters are plain JS but import the shared TypeScript core directly.
		resolveExtensions: [".ts", ".js", ".mjs", ".json"],
		// Nothing external: the zip must be self-contained.
		external: [],
		minify: true,
		legalComments: "none",
		metafile: true,
		logLevel: "silent",
		define: {
			__CODE_VERSION__: JSON.stringify(version),
			__FUNCTION_NAME__: JSON.stringify(spec.name),
		},
		banner: { js: `/* ${spec.name} ${version} */` },
	});

	const inputs = Object.values(metafile.outputs)[0].inputs;
	const pdfBytes = Object.entries(inputs)
		// esbuild reports inputs with forward slashes on every platform
		.filter(([path]) => /node_modules\/(.+\/)?unpdf[@/]/.test(path))
		.reduce((sum, [, { bytesInOutput }]) => sum + bytesInOutput, 0);
	if (!spec.pdf && pdfBytes > 0) {
		throw new Error(
			`${spec.name} is declared pdf: false but bundles ${pdfBytes} bytes of unpdf — ` +
				"import the text-only modules (src/core-text.ts, src/parser.ts, src/genesys.ts), not src/core.ts or src/attachments.ts",
		);
	}

	const bundle = readFileSync(outFile);
	// `index.js` at the root of the zip → Genesys handler field is `index.handler`.
	const zipPath = join(outDir, `${spec.name}-${version.replace(/[+]/g, "_")}.zip`);
	const zip = makeZip([{ name: "index.js", data: bundle }]);
	writeFileSync(zipPath, zip);

	return { spec, outFile, zipPath, bundleBytes: bundle.length, zipBytes: zip.length, pdfBytes };
}

/* ----------------------------------------------------------------------- cli */

function argValue(flag) {
	const i = process.argv.indexOf(flag);
	return i !== -1 ? process.argv[i + 1] : undefined;
}

async function main() {
	const version = argValue("--version") || resolveVersion();
	const only = argValue("--only");

	const selected = only ? functions.filter((f) => f.name === only) : functions;
	if (selected.length === 0) {
		throw new Error(`Unknown function "${only}". Known: ${functions.map((f) => f.name).join(", ")}`);
	}

	const kb = (bytes) => `${(bytes / 1024).toFixed(0)} KB`;
	console.log(`version ${version}
`);
	for (const spec of selected) {
		const r = await buildFunction(spec, { version });
		console.log(spec.name);
		console.log(`  zip      ${r.zipPath} (${kb(r.zipBytes)})`);
		console.log(`  bundle   ${kb(r.bundleBytes)}${r.pdfBytes ? ` (unpdf ${kb(r.pdfBytes)})` : ""}`);
		console.log(`  genesys  handler ${RUNTIME.handler} · ${RUNTIME.runtime} ${RUNTIME.architecture} · ${spec.memory} MB · ${spec.timeout} s`);
		console.log("");
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((e) => {
		console.error(e.message);
		process.exit(1);
	});
}
