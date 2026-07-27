/**
 * End-to-end run of the Genesys Cloud Function handler: a real PDF over HTTP
 * plus a stubbed Genesys API, through the same shared core the Worker uses.
 *
 * This is the local equivalent of invoking the deployed Lambda — it covers the
 * whole chain (credentials -> parallel fetches -> unpdf -> parseTemplate ->
 * `{ resultJson, error }`) without needing Genesys credentials.
 */
import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { bundleForTest, samplesDir } from "./_bundle.mjs";

const { handler } = await bundleForTest("functions/handler.mjs", "handler.e2e.mjs");

const TEMPLATE_HTML =
	"<p>Asegurado: {asegurado} Cobertura: {cobertura} Estatus inciso: {estatus_inciso} " +
	"Estatus pago: {estatus_pago} Forma Pago: {forma_pago} Estatus original</p>";

const GENESYS_RESPONSES = {
	entities: [
		{ name: "Otra plantilla", texts: [{ content: "<p>no aplica</p>" }] },
		{
			name: "Reporte de siniestro",
			texts: [{ content: TEMPLATE_HTML }],
			// a substitution description is the list of accepted values
			substitutions: [
				{ id: "forma_pago", description: '["ANUALL", "MENSUAL"]' },
				{ id: "estatus_pago", description: "ACTIVA, CANCELADA" },
			],
		},
		{ name: "Saludo", texts: [{ content: "<p>Hola {nombre}, tu pedido {pedido} está listo.</p>" }] },
	],
};

let server;
let origin;
let realFetch;
const calls = [];

before(async () => {
	server = createServer((req, res) => {
		const name = decodeURIComponent(req.url.replace(/^\//, ""));
		res.writeHead(200, { "Content-Type": "application/pdf" });
		createReadStream(join(samplesDir, name)).pipe(res);
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	origin = `http://127.0.0.1:${server.address().port}`;

	realFetch = globalThis.fetch;
	globalThis.fetch = async (input, init) => {
		const url = String(input);
		calls.push(url);
		if (url.startsWith("https://login.mypurecloud.com")) {
			assert.equal(init.headers.Authorization, "Basic dGVzdDp0ZXN0");
			return Response.json({ access_token: "tok-123" });
		}
		if (url.startsWith("https://api.mypurecloud.com")) {
			assert.equal(init.headers.Authorization, "Bearer tok-123");
			assert.match(url, /libraryId=lib-123/);
			return Response.json(GENESYS_RESPONSES);
		}
		return realFetch(input, init); // the local PDF server
	};
});

after(() => {
	globalThis.fetch = realFetch;
	server.close();
});

const clientContext = {
	Authorization: "Basic dGVzdDp0ZXN0",
	"Genesys-Library-Id": "lib-123",
};

const EXPECTED = {
	asegurado: "PROCESADORA DE ALIMENTOS MEXICANOS SA DE CV",
	cobertura: "LIGEROS INTEGRAL",
	estatus_inciso: "ACT",
	estatus_pago: "ACTIVA",
	// fuzzy-matched back to the accepted value from the substitution
	forma_pago: "ANUALL",
};

test("parses a PDF attachment against a canned response", async () => {
	const res = await handler(
		{
			name: "Reporte de siniestro",
			attachments: [{ url: `${origin}/103967-2026.pdf`, mediaType: "application/pdf" }],
		},
		{ clientContext },
	);

	assert.equal(res.error, "");
	assert.deepEqual(JSON.parse(res.resultJson), EXPECTED);
});

test("accepts attachments serialized as a JSON string, as Data Actions send them", async () => {
	const res = await handler(
		{
			name: "Reporte de siniestro",
			attachments: JSON.stringify([{ url: `${origin}/103967-2026.pdf`, mediaType: "application/pdf" }]),
		},
		{ clientContext },
	);

	assert.equal(res.error, "");
	assert.deepEqual(JSON.parse(res.resultJson), EXPECTED);
});

test("a content field holding a JSON array of attachments is read as a PDF", async () => {
	// this is how a Data Action with a single string input sends attachments
	const res = await handler(
		{
			name: "Reporte de siniestro",
			content: JSON.stringify([{ url: `${origin}/103967-2026.pdf`, mediaType: "application/pdf" }]),
		},
		{ clientContext },
	);

	assert.equal(res.error, "");
	assert.deepEqual(JSON.parse(res.resultJson), EXPECTED);
});

test("a content field holding text is parsed as text", async () => {
	const res = await handler(
		{ name: "Saludo", content: "<p>Hola Juan, tu pedido #4521 está listo.</p>" },
		{ clientContext },
	);

	assert.equal(res.error, "");
	assert.deepEqual(JSON.parse(res.resultJson), { nombre: "Juan", pedido: "#4521" });
});

test("html is honoured for text content and sent as a string", async () => {
	const res = await handler(
		{ name: "Saludo", content: "Hola Juan, tu pedido #4521 está listo.", html: "false" },
		{ clientContext },
	);

	assert.equal(res.error, "");
	assert.deepEqual(JSON.parse(res.resultJson), { nombre: "Juan", pedido: "#4521" });
});

test("the PDF download and the template lookup overlap", async () => {
	calls.length = 0;
	await handler(
		{
			name: "Reporte de siniestro",
			attachments: [{ url: `${origin}/103967-2026.pdf`, mediaType: "application/pdf" }],
		},
		{ clientContext },
	);
	// the download is issued before the token round trip resolves; serialised,
	// four sequential round trips can brush against the 15 s Genesys ceiling
	assert.ok(calls[0].startsWith(origin), `expected the PDF first, got ${calls[0]}`);
	assert.equal(calls.length, 3);
});

test("an unknown canned response comes back as an error, not an exception", async () => {
	const res = await handler(
		{
			name: "No existe",
			attachments: [{ url: `${origin}/103967-2026.pdf`, mediaType: "application/pdf" }],
		},
		{ clientContext },
	);

	assert.equal(res.resultJson, "");
	assert.match(res.error, /Canned response not found: "No existe"/);
});

test("a failed download comes back as an error", async () => {
	const res = await handler(
		{
			name: "Reporte de siniestro",
			attachments: [{ url: "https://example.invalid/x.pdf", mediaType: "application/pdf" }],
		},
		{ clientContext },
	);

	assert.equal(res.resultJson, "");
	assert.ok(res.error.length > 0);
});
