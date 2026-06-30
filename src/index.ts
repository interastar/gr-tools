import { fromHono, OpenAPIRoute } from "chanfana";
import { Hono } from "hono";
import { z } from "zod";
import { normalizeStr, parseTemplate, stripHtml } from "./parser";
import type { AppContext, Env } from "./types";

const ParseRequestSchema = z.object({
	template: z.string().min(1),
	content: z.string().min(1),
	html: z.boolean().default(true),
	candidates: z.record(z.string(), z.array(z.string())).optional(),
});

class TemplateParse extends OpenAPIRoute {
	schema = {
		tags: ["Parse"],
		summary: "Extract data from content using a reverse template",
		request: {
			body: {
				content: {
					"application/json": {
						schema: ParseRequestSchema,
					},
				},
			},
		},
		responses: {
			"200": {
				description: "Key-value pairs extracted from content",
				content: {
					"application/json": {
						schema: z.record(z.string(), z.string()),
					},
				},
			},
			"422": {
				description: "Content does not match the template",
				content: {
					"application/json": {
						schema: z.object({ error: z.string() }),
					},
				},
			},
		},
	};

	async handle(c: AppContext) {
		const data = await this.getValidatedData<typeof this.schema>();
		const { template, content, html, candidates } = data.body;

		// Debug header: Genesys-Debug: true|false (case-insensitive). If missing, debug is off.
		const debugHeader = c.req?.header("genesys-debug");
		const debug = typeof debugHeader === "string" && debugHeader.toLowerCase() === "true";

		try {
			if (debug) {
				console.log("[Genesys Debug] TemplateParse - template:", template);
				console.log("[Genesys Debug] TemplateParse - content:", content);
				if (candidates) console.log("[Genesys Debug] TemplateParse - candidates:", candidates);
			}
			const result = parseTemplate(template, content, html, candidates);
			if (debug) console.log("[Genesys Debug] TemplateParse - result:", result);
			return c.json(result);
		} catch (e) {
			if (debug) console.log("[Genesys Debug] TemplateParse - error:", (e as Error).message);
			return c.json({ error: (e as Error).message }, 422);
		}
	}
}

const GenesysParseRequestSchema = z.object({
	name: z.string().min(1),
	content: z.string().min(1),
	html: z.boolean().default(true),
});

async function getGenesysToken(clientIdOrAuthHeader: string, clientSecret?: string): Promise<string> {
	// If a client secret is provided, build a Basic auth header from id:secret.
	// Otherwise treat the first argument as a full Authorization header value
	// (for example: "Basic <base64>").
	const authHeader = clientSecret
		? `Basic ${btoa(`${clientIdOrAuthHeader}:${clientSecret}`)}`
		: clientIdOrAuthHeader;

	const res = await fetch("https://login.mypurecloud.com/oauth/token", {
		method: "POST",
		headers: {
			"Authorization": authHeader,
			"Content-Type": "application/x-www-form-urlencoded",
		},
		body: "grant_type=client_credentials",
	});
	if (!res.ok) throw new Error(`Genesys auth failed: ${res.status}`);
	const data = await res.json() as { access_token: string };
	return data.access_token;
}

interface GenesysSubstitution {
	id: string;
	description?: string;
}

function parseCandidates(substitutions: GenesysSubstitution[]): Record<string, string[]> {
	const candidates: Record<string, string[]> = {};
	for (const sub of substitutions) {
		if (!sub.description) continue;
		const normalized = normalizeStr(sub.description);
		try {
			const parsed: unknown = JSON.parse(normalized);
			if (Array.isArray(parsed)) {
				candidates[sub.id] = parsed.map(String).filter(Boolean);
				continue;
			}
		} catch {
			// not JSON — fall through to comma-split
		}
		candidates[sub.id] = normalized.split(",").map((v) => v.trim()).filter(Boolean);
	}
	return candidates;
}

async function getGenesysCannedResponse(token: string, libraryId: string, name: string): Promise<{ template: string; candidates: Record<string, string[]>; raw: any }> {
	const url = `https://api.mypurecloud.com/api/v2/responsemanagement/responses?libraryId=${libraryId}&pageSize=200`;
	const res = await fetch(url, {
		headers: { "Authorization": `Bearer ${token}` },
	});
	if (!res.ok) throw new Error(`Genesys API failed: ${res.status}`);
	const data = await res.json() as { entities: Array<{ name: string; texts: Array<{ content: string }>; substitutions?: GenesysSubstitution[] }> };
	const match = data.entities.find((e) => e.name === name);
	if (!match) throw new Error(`Canned response not found: "${name}" in library: ${JSON.stringify(data)}`);
	const rawContent = match.texts?.[0]?.content;
	if (!rawContent) throw new Error(`Canned response "${name}" has no text content`);
	const candidates = parseCandidates(match.substitutions ?? []);
	return { template: stripHtml(rawContent), candidates, raw: data };
}

class GenesysTemplateParse extends OpenAPIRoute {
	schema = {
		tags: ["Parse"],
		summary: "Extract data using a Genesys canned response as template",
		request: {
			body: {
				content: {
					"application/json": {
						schema: GenesysParseRequestSchema,
					},
				},
			},
		},
		responses: {
			"200": {
				description: "Key-value pairs extracted from content",
				content: {
					"application/json": {
						schema: z.record(z.string(), z.string()),
					},
				},
			},
			"422": {
				description: "Content does not match the template or canned response not found",
				content: {
					"application/json": {
						schema: z.object({ error: z.string() }),
					},
				},
			},
		},
	};

	async handle(c: AppContext) {
		const data = await this.getValidatedData<typeof this.schema>();
		const { name, content, html } = data.body;

		try {
			const { GENESYS_CLIENT_ID, GENESYS_CLIENT_SECRET, GENESYS_LIBRARY_ID } = c.env;
			// Prefer an Authorization header from the request; fall back to configured secrets.
			const authHeader = c.req?.header("authorization");
			const token = authHeader
				? await getGenesysToken(authHeader)
				: await getGenesysToken(GENESYS_CLIENT_ID, GENESYS_CLIENT_SECRET);

			// Prefer a custom header `Genesys-Library-Id` over the configured var.
			const libraryHeader = c.req?.header("genesys-library-id");
			const libraryId = libraryHeader && libraryHeader.trim().length > 0 ? libraryHeader : GENESYS_LIBRARY_ID;

			// Debug header handling
			const debugHeader = c.req?.header("genesys-debug");
			const debug = typeof debugHeader === "string" && debugHeader.toLowerCase() === "true";

			const { template, candidates, raw } = await getGenesysCannedResponse(token, libraryId, name);
			if (debug) {
				console.log("[Genesys Debug] GenesysTemplateParse - request content:", content);
				console.log("[Genesys Debug] GenesysTemplateParse - genesys raw response:", raw);
				console.log("[Genesys Debug] GenesysTemplateParse - template to use:", template);
				console.log("[Genesys Debug] GenesysTemplateParse - candidates:", candidates);
			}

			const result = parseTemplate(template, content, html, candidates);
			if (debug) console.log("[Genesys Debug] GenesysTemplateParse - result:", result);
			return c.json(result);
		} catch (e) {
			// Log error when debug enabled
			const debugHeader = c.req?.header("genesys-debug");
			const debug = typeof debugHeader === "string" && debugHeader.toLowerCase() === "true";
			if (debug) console.log("[Genesys Debug] GenesysTemplateParse - error:", (e as Error).message);
			return c.json({ error: (e as Error).message }, 422);
		}
	}
}

const app = new Hono<{ Bindings: Env }>();

const openapi = fromHono(app, {
	docs_url: "/",
});

openapi.post("/api/parse", TemplateParse);
openapi.post("/api/parse/template", GenesysTemplateParse);

// 405 fallback for non-POST methods on this route
app.all("/api/parse", (c) => c.json({ error: "Method Not Allowed" }, 405));

export default app;
