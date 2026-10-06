/**
 * The Genesys adapter's contract: never throw; answer the result as is, or
 * `{ error }` on failure. Only the pre-flight paths are covered here — they
 * return before any network call, so the suite stays offline.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { bundleForTest } from "./_bundle.mjs";

const { handler } = await bundleForTest("functions/parse-attachment.mjs", "handler.test.build.mjs");

const CTX = {
	clientContext: {
		// Genesys is inconsistent about capitalization; the handler lowercases keys
		Authorization: "Basic dGVzdDp0ZXN0",
		"Genesys-Library-Id": "lib-123",
	},
};
const EVENT = { name: "MiPlantilla", attachments: [{ contentType: "application/pdf", contentUri: "https://example.com/x.pdf", name: "x.pdf" }] };

const call = (event, clientContext) => handler(event, { clientContext });

test("missing credentials is an error field, not a thrown exception", async () => {
	const res = await call(EVENT, { "genesys-library-id": "lib-123" });
	assert.deepEqual(Object.keys(res), ["error"]);
	assert.match(res.error, /Missing credentials/);
});

test("accepts client id + secret as separate headers", async () => {
	// gets past the credential check and fails on the missing library instead
	const res = await call(EVENT, {
		"x-genesysclientid": "id",
		"x-genesysclientsecret": "secret",
	});
	assert.match(res.error, /genesys-library-id/);
});

test("missing library id", async () => {
	const res = await call(EVENT, { authorization: "Basic dGVzdDp0ZXN0" });
	assert.match(res.error, /genesys-library-id/);
});

test("missing name", async () => {
	const res = await call({ attachments: EVENT.attachments }, CTX.clientContext);
	assert.match(res.error, /Missing required input: name/);
});

test("missing both content and attachments", async () => {
	const res = await call({ name: "MiPlantilla" }, CTX.clientContext);
	assert.match(res.error, /Missing required input: content or attachments/);
});

test("an empty content string counts as missing", async () => {
	const res = await call({ name: "MiPlantilla", content: "" }, CTX.clientContext);
	assert.match(res.error, /Missing required input: content or attachments/);
});

test("attachments serialized as a JSON string is rejected only when malformed", async () => {
	const res = await call({ name: "MiPlantilla", attachments: "[not json" }, CTX.clientContext);
	assert.match(res.error, /not valid JSON/);
});

test("attachments serialized as a JSON object is rejected", async () => {
	const res = await call({ name: "MiPlantilla", attachments: '{"contentUri":"x"}' }, CTX.clientContext);
	assert.match(res.error, /must be an array/);
});

test("a missing clientContext does not crash the handler", async () => {
	for (const context of [{}, undefined]) {
		const res = await handler(EVENT, context);
		assert.deepEqual(Object.keys(res), ["error"]);
		assert.ok(res.error.length > 0);
	}
});

test("a missing event does not crash the handler", async () => {
	const res = await handler(undefined, CTX);
	assert.match(res.error, /Missing required input: name/);
});
