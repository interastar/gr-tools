/**
 * The `gr-extract-pdf` Genesys Cloud Function: a public URL or an attachment
 * list in, the PDF's plain text out. The samples are served over a throwaway
 * HTTP server, so this runs the real download -> unpdf -> flattening path,
 * offline.
 */
import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { bundleForTest, samplesDir } from "./_bundle.mjs";

const { handler } = await bundleForTest("functions/extract-pdf.mjs", "extract.test.build.mjs");
const core = await bundleForTest("tests/_entry.ts", "extract.core.test.mjs");

let server;
let origin;

before(async () => {
	server = createServer((req, res) => {
		const path = decodeURIComponent(req.url.split("?")[0].replace(/^\//, ""));
		if (path === "share") {
			// what a "share" link of a file host typically answers: a preview page
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			res.end("<!doctype html><html><body>Vista previa</body></html>");
			return;
		}
		if (path === "missing.pdf") {
			res.writeHead(404);
			res.end();
			return;
		}
		res.writeHead(200, { "Content-Type": "application/pdf" });
		createReadStream(join(samplesDir, path)).pipe(res);
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	origin = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

const extract = (source) => handler({ source }, { clientContext: {} });

test("returns the same text the parser sees for that PDF", async () => {
	const res = await extract(`${origin}/103967-2026.pdf`);
	const direct = await core.extractPdfText([{ contentType: "application/pdf", contentUri: `${origin}/103967-2026.pdf` }]);

	assert.deepEqual(Object.keys(res).sort(), ["chars", "pages", "source", "text", "warning"]);
	assert.equal(res.text, direct.text);
	assert.equal(res.chars, res.text.length);
	assert.equal(res.pages, 1);
	assert.equal(res.source, "103967-2026.pdf");
	assert.equal(res.warning, "");
});

test("merges every page of a multi-page PDF", async () => {
	const res = await extract(`${origin}/20260710_1119.pdf`);
	assert.equal(res.pages, 2);
});

test("a URL without a .pdf extension is still read", async () => {
	const res = await extract(`${origin}/103967-2026.pdf?download=1`);
	assert.ok(res.text.startsWith("REPORTE GENERAL DE SINIESTRO"));
});

test("needs no Genesys credentials", async () => {
	const res = await handler({ source: `${origin}/103967-2026.pdf` }, undefined);
	assert.equal(res.error, undefined);
	assert.ok(res.chars > 1000);
});

test("a share link that answers with HTML is reported as not a PDF", async () => {
	const res = await extract(`${origin}/share`);
	assert.deepEqual(Object.keys(res), ["error"]);
	assert.match(res.error, /is not a PDF \(content-type: text\/html/);
});

test("a failed download is an error field, not an exception", async () => {
	const res = await extract(`${origin}/missing.pdf`);
	assert.match(res.error, /Failed to download attachment: 404/);
});

test("rejects a missing, malformed or non-http source", async () => {
	for (const [source, message] of [
		[undefined, /Missing required input: source/],
		["   ", /Missing required input: source/],
		["no es un url", /neither a URL nor an attachment array/],
		["file:///etc/passwd", /must be http\(s\)/],
		["[not json", /looks like JSON but is not an attachment array/],
		['[{"name":"x.pdf"}]', /looks like JSON but is not an attachment array/],
		['{"contentUri":"https://x/y.pdf"}', /looks like JSON but is not an attachment array/],
	]) {
		const res = await extract(source);
		assert.match(res.error, message, `source: ${source}`);
	}
});

/* ------------------------------------------- attachments of a Genesys email */

// the shape Genesys sends for an email conversation's attachments
const emailAttachments = () => [
	{ contentLength: 1024, contentType: "image/png", contentUri: `${origin}/logo.png`, id: "a1", name: "logo.png" },
	{ contentLength: 45991, contentType: "application/pdf", contentUri: `${origin}/103967-2026.pdf`, id: "19f9b9824f148d185ad3", name: "103967-2026.pdf" },
];

test("source as the JSON array of a Genesys email's attachments reads the first PDF", async () => {
	const res = await extract(JSON.stringify(emailAttachments()));
	assert.equal(res.source, "103967-2026.pdf");
	assert.ok(res.text.startsWith("REPORTE GENERAL DE SINIESTRO"));
	assert.equal(res.warning, "");
});

test("source as a real array works too", async () => {
	const res = await extract(emailAttachments());
	assert.equal(res.source, "103967-2026.pdf");
});

test("URL and attachment list give the same text for the same file", async () => {
	const byUrl = await extract(`${origin}/103967-2026.pdf`);
	const byList = await extract(JSON.stringify(emailAttachments()));
	assert.equal(byList.text, byUrl.text);
});

test("an attachment list with no PDF is an error", async () => {
	const res = await extract(JSON.stringify([emailAttachments()[0]]));
	assert.match(res.error, /No PDF attachment found/);
});
