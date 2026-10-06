/**
 * What every Genesys Cloud Function in this repo shares: reading the Data
 * Action headers out of `clientContext`, coercing the string-typed inputs Data
 * Actions send, and the output contract.
 *
 * Output contract: a function returns its result object as is, or `{ error }`
 * when it fails — never an exception, so Architect branches on `error` instead
 * of having to handle a failed data action. `error` is therefore a reserved key:
 * no successful result may contain it.
 *
 * Each function file is a thin adapter: `defineFunction(async (event, ctx) => …)`
 * validates its own inputs and calls into `src/`.
 */

/** Replaced at build time by functions/build.mjs. */
const CODE_VERSION = typeof __CODE_VERSION__ === "string" ? __CODE_VERSION__ : "dev";
const FUNCTION_NAME = typeof __FUNCTION_NAME__ === "string" ? __FUNCTION_NAME__ : "dev";

// Logged once per cold start, so CloudWatch says which bundle answered.
console.log(`${FUNCTION_NAME} ${CODE_VERSION}`);

/** The key a failed call answers with, and that a successful result may not use. */
export const RESERVED_KEY = "error";

/**
 * Genesys hands `clientContext` keys back with inconsistent capitalization
 * (`Authorization` or `authorization` depending on the platform), so every
 * lookup goes through a lowercased copy.
 */
export function lowercaseKeys(obj) {
	return Object.fromEntries(Object.entries(obj || {}).map(([k, v]) => [k.toLowerCase(), v]));
}

/** Data Actions may deliver an array input as its JSON string representation. */
export function coerceAttachments(value) {
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
export function coerceBoolean(value) {
	if (typeof value === "boolean") return value;
	if (typeof value === "string" && value.trim()) return value.trim().toLowerCase() === "true";
	return undefined;
}

/**
 * Genesys API credentials and canned-response library from the Data Action
 * headers. Form A (preferred): `authorization: Basic <base64(id:secret)>`.
 * Form B: client id and secret as separate headers.
 */
export function genesysCredentials(headers) {
	const authHeader = headers["authorization"]
		|| (headers["x-genesysclientid"] && headers["x-genesysclientsecret"]
			? `Basic ${Buffer.from(`${headers["x-genesysclientid"]}:${headers["x-genesysclientsecret"]}`).toString("base64")}`
			: null);
	if (!authHeader) {
		throw new Error("Missing credentials: provide an authorization header, or x-genesysclientid + x-genesysclientsecret");
	}

	const libraryId = headers["genesys-library-id"];
	if (!libraryId) throw new Error("Missing required header: genesys-library-id");

	return { auth: { authHeader }, libraryId };
}

/**
 * Wraps a function body in the shared contract. `run` receives the event
 * (never undefined) and `{ headers, debug }`, where `headers` is the lowercased
 * `clientContext` and `debug` reflects the `genesys-debug: true` header.
 */
export function defineFunction(run) {
	return async (event, context) => {
		const headers = lowercaseKeys(context && context.clientContext);
		const debug = String(headers["genesys-debug"] || "").toLowerCase() === "true";

		try {
			if (debug) console.log("[Debug] code version:", CODE_VERSION);
			const result = await run(event || {}, { headers, debug });
			if (result && Object.hasOwn(result, RESERVED_KEY)) {
				throw new Error(`Result uses the reserved key "${RESERVED_KEY}" — rename that template variable`);
			}
			return result;
		} catch (e) {
			console.error(`${FUNCTION_NAME} failed:`, e);
			return { [RESERVED_KEY]: e && e.message ? e.message : String(e) };
		}
	};
}
