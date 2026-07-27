/**
 * Builds the Genesys Cloud Function bundle.
 *
 * Everything is bundled into a single CommonJS file — no `node_modules` in the
 * zip — and stamped with a code version so a bundle sitting in the Genesys UI
 * can be traced back to a commit.
 *
 * Usage:
 *   pnpm build:function                  # version from package.json + git
 *   pnpm build:function --version 1.4.0  # explicit version
 *
 * Output: functions/dist/index.js and functions/dist/gr-parse-attachment-<version>.zip
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";
import { build } from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = join(root, "functions", "dist");
const outFile = join(outDir, "index.js");
const NAME = "gr-parse-attachment";

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
function resolveVersion() {
	const flagIndex = process.argv.indexOf("--version");
	if (flagIndex !== -1 && process.argv[flagIndex + 1]) return process.argv[flagIndex + 1];

	const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
	const sha = git("rev-parse", "--short", "HEAD");
	if (!sha) return pkg.version;
	const dirty = git("status", "--porcelain") ? "-dirty" : "";
	return `${pkg.version}+${sha}${dirty}`;
}

const version = resolveVersion();

/* -------------------------------------------------------------------- bundle */

mkdirSync(outDir, { recursive: true });

await build({
	entryPoints: [join(root, "functions", "handler.mjs")],
	bundle: true,
	platform: "node",
	// Genesys Cloud Functions runs nodejs20.x on arm64.
	target: "node20",
	format: "cjs",
	outfile: outFile,
	// The handler is plain JS but imports the shared TypeScript core directly.
	resolveExtensions: [".ts", ".js", ".mjs", ".json"],
	// Nothing external: the zip must be self-contained.
	external: [],
	minify: true,
	legalComments: "none",
	define: { __CODE_VERSION__: JSON.stringify(version) },
	banner: { js: `/* ${NAME} ${version} */` },
});

const bundle = readFileSync(outFile);

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

// `index.js` at the root of the zip → Genesys handler field is `index.handler`.
const zipPath = join(outDir, `${NAME}-${version.replace(/[+]/g, "_")}.zip`);
writeFileSync(zipPath, makeZip([{ name: "index.js", data: bundle }]));

const kb = (bytes) => `${(bytes / 1024).toFixed(0)} KB`;
console.log(`${NAME} ${version}`);
console.log(`  bundle  ${outFile} (${kb(bundle.length)})`);
console.log(`  zip     ${zipPath} (${kb(statSync(zipPath).size)})`);
console.log(`  handler index.handler`);
