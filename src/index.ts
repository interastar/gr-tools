import { fromHono, OpenAPIRoute } from "chanfana";
import { Hono } from "hono";
import { z } from "zod";
import { parseTemplate, stripHtml } from "./parser";
import type { AppContext, Env } from "./types";

const ParseRequestSchema = z.object({
	template: z.string().min(1),
	content: z.string().min(1),
	html: z.boolean().default(true),
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
		const { template, content, html } = data.body;

		try {
			const result = parseTemplate(template, content, html);
			return c.json(result);
		} catch (e) {
			return c.json({ error: (e as Error).message }, 422);
		}
	}
}

const GenesysParseRequestSchema = z.object({
	name: z.string().min(1),
	content: z.string().min(1),
	html: z.boolean().default(true),
});

async function getGenesysToken(clientId: string, clientSecret: string): Promise<string> {
	const credentials = btoa(`${clientId}:${clientSecret}`);
	const res = await fetch("https://login.mypurecloud.com/oauth/token", {
		method: "POST",
		headers: {
			"Authorization": `Basic ${credentials}`,
			"Content-Type": "application/x-www-form-urlencoded",
		},
		body: "grant_type=client_credentials",
	});
	if (!res.ok) throw new Error(`Genesys auth failed: ${res.status}`);
	const data = await res.json() as { access_token: string };
	return data.access_token;
}

async function getGenesysCannedResponse(token: string, libraryId: string, name: string): Promise<string> {
	const url = `https://api.mypurecloud.com/api/v2/responsemanagement/responses?libraryId=${libraryId}&pageSize=200`;
	const res = await fetch(url, {
		headers: { "Authorization": `Bearer ${token}` },
	});
	if (!res.ok) throw new Error(`Genesys API failed: ${res.status}`);
	const data = await res.json() as { entities: Array<{ name: string; texts: Array<{ content: string }> }> };
	const match = data.entities.find((e) => e.name === name);
	if (!match) throw new Error(`Canned response not found: "${name}"`);
	const rawContent = match.texts?.[0]?.content;
	if (!rawContent) throw new Error(`Canned response "${name}" has no text content`);
	return stripHtml(rawContent);
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
			const token = await getGenesysToken(GENESYS_CLIENT_ID, GENESYS_CLIENT_SECRET);
			const template = await getGenesysCannedResponse(token, GENESYS_LIBRARY_ID, name);
			const result = parseTemplate(template, content, html);
			return c.json(result);
		} catch (e) {
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
