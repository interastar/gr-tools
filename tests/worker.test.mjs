/**
 * Route-level tests for the Cloudflare Worker: request validation and the
 * `{ attachments }` input coercion, over a real PDF served on localhost.
 *
 * `parseWithTemplate` is covered by `templates.test.mjs` and `e2e.test.mjs`;
 * what this file exercises is the hono/chanfana layer on top of it.
 */
import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { bundleForTest, samplesDir } from "./_bundle.mjs";

const app = (await bundleForTest("src/index.ts", "worker.test.build.mjs")).default;

let server;
let origin;

before(async () => {
	server = createServer((req, res) => {
		const name = decodeURIComponent(req.url.split("?")[0].replace(/^\//, ""));
		res.writeHead(200, { "Content-Type": "application/pdf" });
		createReadStream(join(samplesDir, name)).pipe(res);
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	origin = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

const extract = async (attachments) => {
	const res = await app.request("/api/extract", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ attachments }),
	});
	return { status: res.status, body: await res.json() };
};

const attachment = () => ({
	contentLength: 45991,
	contentType: "application/pdf",
	contentUri: `${origin}/103967-2026.pdf`,
	id: "19f9b9824f148d185ad3",
	name: "103967-2026.pdf",
});

test("/api/extract accepts an array of attachments", async () => {
	const { status, body } = await extract([attachment()]);
	assert.equal(status, 200);
	assert.equal(body.source, "103967-2026.pdf");
	assert.ok(body.text.startsWith("REPORTE GENERAL DE SINIESTRO"));
});

test("/api/extract accepts the array as a JSON string, as Data Actions send it", async () => {
	const { status, body } = await extract(JSON.stringify([attachment()]));
	assert.equal(status, 200);
	assert.equal(body.source, "103967-2026.pdf");
	assert.ok(body.text.startsWith("REPORTE GENERAL DE SINIESTRO"));
});

test("/api/extract reports a string that is not JSON", async () => {
	const { status, body } = await extract("[not json");
	assert.equal(status, 422);
	assert.match(body.error, /not valid JSON/);
});

test("/api/extract reports a JSON string that is not an attachment array", async () => {
	for (const value of ['{"contentUri":"https://x/y.pdf"}', "[]", '[{"name":"x.pdf"}]']) {
		const { status, body } = await extract(value);
		assert.equal(status, 422, `expected 422 for ${value}`);
		assert.match(body.error, /not a valid attachment array/);
	}
});

test("/api/extract rejects a body with no attachments at all", async () => {
	const res = await app.request("/api/extract", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({}),
	});
	assert.equal(res.status, 400);
});

test("the OpenAPI schema documents both input forms", async () => {
	const spec = await (await app.request("/openapi.json")).json();
	const schema = spec.paths["/api/extract"].post.requestBody.content["application/json"].schema;
	const [asArray, asString] = schema.properties.attachments.anyOf;
	assert.equal(asArray.type, "array");
	assert.deepEqual(asArray.items.required, ["contentUri"]);
	assert.equal(asString.type, "string");
});
