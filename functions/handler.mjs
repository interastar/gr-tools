/**
 * Genesys Cloud Function: parse content with a canned response as template.
 * Standalone equivalent of `POST /api/parse/template` — the content may be text
 * or a JSON array of attachments, in which case the first PDF is downloaded and
 * read instead.
 *
 * This file is only the Genesys adapter — credentials, input coercion and the
 * `{ resultJson, error }` output contract. The actual work lives in
 * `src/core.ts`, shared verbatim with the Cloudflare Worker.
 *
 * `functions/build.mjs` bundles this to CommonJS, so the deployed entry point
 * ends up as `exports.handler` in `index.js` at the root of the zip.
 */
import { parseWithTemplate } from "../src/core";

/** Replaced at build time by functions/build.mjs. */
const CODE_VERSION = typeof __CODE_VERSION__ === "string" ? __CODE_VERSION__ : "dev";

// Logged once per cold start, so CloudWatch says which bundle answered.
console.log(`gr-parse-attachment ${CODE_VERSION}`);

/**
 * Genesys hands `clientContext` keys back with inconsistent capitalization
 * (`Authorization` or `authorization` depending on the platform), so every
 * lookup goes through a lowercased copy.
 */
function lowercaseKeys(obj) {
	return Object.fromEntries(Object.entries(obj || {}).map(([k, v]) => [k.toLowerCase(), v]));
}

/** Data Actions may deliver an array input as its JSON string representation. */
function coerceAttachments(value) {
	if (value === undefined || value === null || value === "") return undefined;
	if (Array.isArray(value)) return value;
	if (typeof value === "string") {
		let parsed;
		try {
			parsed = JSON.parse(value);
		} catch {
			throw new Error("Input `attachments` is a string but not valid JSON");
		}
		if (!Array.isArray(parsed)) throw new Error("Input `attachments` must be an array");
		return parsed;
	}
	throw new Error("Input `attachments` must be an array");
}

/** Data Actions type everything as a string, booleans included. */
function coerceBoolean(value) {
	if (typeof value === "boolean") return value;
	if (typeof value === "string" && value.trim()) return value.trim().toLowerCase() === "true";
	return undefined;
}

export const handler = async (event, context) => {
	const ctx = lowercaseKeys(context && context.clientContext);
	const debug = String(ctx["genesys-debug"] || "").toLowerCase() === "true";

	try {
		// Form A (preferred): `authorization: Basic <base64(id:secret)>`.
		// Form B: client id and secret as separate headers.
		const authHeader = ctx["authorization"]
			|| (ctx["x-genesysclientid"] && ctx["x-genesysclientsecret"]
				? `Basic ${Buffer.from(`${ctx["x-genesysclientid"]}:${ctx["x-genesysclientsecret"]}`).toString("base64")}`
				: null);
		if (!authHeader) {
			throw new Error("Missing credentials: provide an authorization header, or x-genesysclientid + x-genesysclientsecret");
		}

		const libraryId = ctx["genesys-library-id"];
		if (!libraryId) throw new Error("Missing required header: genesys-library-id");
		if (!event || !event.name) throw new Error("Missing required input: name");

		// `content` carries either the text to parse or the JSON array of
		// attachments; `attachments` is the explicit form of the same thing.
		const attachments = coerceAttachments(event.attachments);
		const content = typeof event.content === "string" && event.content ? event.content : undefined;
		if (!attachments && content === undefined) {
			throw new Error("Missing required input: content or attachments");
		}

		if (debug) console.log("[Debug] code version:", CODE_VERSION);

		const result = await parseWithTemplate({
			name: event.name,
			content,
			attachments,
			auth: { authHeader },
			libraryId,
			html: coerceBoolean(event.html),
			debug,
		});

		return result;
	} catch (e) {
		// Never throw at Genesys: Architect branches on `error` instead of having
		// to handle a failed data action.
		console.error("parseAttachment failed:", e);
		return { error: e && e.message ? e.message : String(e) };
	}
};
