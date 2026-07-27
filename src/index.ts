import { fromHono, OpenAPIRoute } from "chanfana";
import { Hono } from "hono";
import { z } from "zod";
import { extractPdfText, SUSPICIOUSLY_SHORT_CHARS } from "./attachments";
import { parseWithTemplate } from "./core";
import type { GenesysAuth } from "./genesys";
import { parseTemplate } from "./parser";
import type { AppContext, Env } from "./types";

/** Debug header: `Genesys-Debug: true|false` (case-insensitive). Missing means off. */
function isDebug(c: AppContext): boolean {
	const header = c.req?.header("genesys-debug");
	return typeof header === "string" && header.toLowerCase() === "true";
}

/** Per-request credentials via `Authorization`, falling back to the configured vars/secrets. */
function authFrom(c: AppContext): GenesysAuth {
	return {
		authHeader: c.req?.header("authorization"),
		clientId: c.env.GENESYS_CLIENT_ID,
		clientSecret: c.env.GENESYS_CLIENT_SECRET,
	};
}

/** Per-request library via `Genesys-Library-Id`, falling back to the configured var. */
function libraryFrom(c: AppContext): string {
	const header = c.req?.header("genesys-library-id");
	return header && header.trim().length > 0 ? header : c.env.GENESYS_LIBRARY_ID;
}

const ErrorSchema = z.object({ error: z.string() });
const ResultSchema = z.record(z.string(), z.string());

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
			body: { content: { "application/json": { schema: ParseRequestSchema } } },
		},
		responses: {
			"200": {
				description: "Key-value pairs extracted from content",
				content: { "application/json": { schema: ResultSchema } },
			},
			"422": {
				description: "Content does not match the template",
				content: { "application/json": { schema: ErrorSchema } },
			},
		},
	};

	async handle(c: AppContext) {
		const data = await this.getValidatedData<typeof this.schema>();
		const { template, content, html, candidates } = data.body;
		const debug = isDebug(c);

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

/**
 * The generic entry point: whatever the content turns out to be, parse it with
 * the named canned response. A `content` that is a JSON array of attachments is
 * downloaded and read as a PDF instead of being parsed as text, so a caller
 * with a single string field — a Genesys Data Action, say — can send either.
 */
class GenesysTemplateParse extends OpenAPIRoute {
	schema = {
		tags: ["Parse"],
		summary: "Extract data using a Genesys canned response as template, from text or from a PDF attachment",
		request: {
			body: { content: { "application/json": { schema: GenesysParseRequestSchema } } },
		},
		responses: {
			"200": {
				description: "Key-value pairs extracted from content",
				content: { "application/json": { schema: ResultSchema } },
			},
			"422": {
				description: "Content does not match the template, canned response not found, or attachment unreadable",
				content: { "application/json": { schema: ErrorSchema } },
			},
		},
	};

	async handle(c: AppContext) {
		const data = await this.getValidatedData<typeof this.schema>();
		const { name, content, html } = data.body;
		const debug = isDebug(c);

		try {
			const result = await parseWithTemplate({
				name,
				content,
				auth: authFrom(c),
				libraryId: libraryFrom(c),
				html,
				debug,
			});
			return c.json(result);
		} catch (e) {
			if (debug) console.log("[Genesys Debug] GenesysTemplateParse - error:", (e as Error).message);
			return c.json({ error: (e as Error).message }, 422);
		}
	}
}

const AttachmentSchema = z.object({
	url: z.string().url(),
	mimeType: z.string().optional(),
	mediaType: z.string().optional(),
	name: z.string().optional(),
});

const AttachmentParseRequestSchema = z.object({
	name: z.string().min(1),
	attachments: z.array(AttachmentSchema).min(1),
	html: z.boolean().default(false),
});

class GenesysAttachmentParse extends OpenAPIRoute {
	schema = {
		tags: ["Parse"],
		summary: "Extract data from a PDF attachment using a Genesys canned response as template",
		request: {
			body: { content: { "application/json": { schema: AttachmentParseRequestSchema } } },
		},
		responses: {
			"200": {
				description: "Key-value pairs extracted from the attachment",
				content: { "application/json": { schema: ResultSchema } },
			},
			"422": {
				description: "No PDF found, attachment unreadable, or content does not match the template",
				content: { "application/json": { schema: ErrorSchema } },
			},
		},
	};

	async handle(c: AppContext) {
		const data = await this.getValidatedData<typeof this.schema>();
		const { name, attachments, html } = data.body;
		const debug = isDebug(c);

		try {
			const result = await parseWithTemplate({
				name,
				attachments,
				auth: authFrom(c),
				libraryId: libraryFrom(c),
				html,
				debug,
			});
			return c.json(result);
		} catch (e) {
			if (debug) console.log("[Genesys Debug] GenesysAttachmentParse - error:", (e as Error).message);
			return c.json({ error: (e as Error).message }, 422);
		}
	}
}

const ExtractRequestSchema = z.object({
	attachments: z.array(AttachmentSchema).min(1),
});

/**
 * Preview endpoint. Templates must be written against the text unpdf actually
 * produces (tables flatten by column, not by row), so whoever authors a canned
 * response calls this first and writes against the real string.
 */
class AttachmentExtract extends OpenAPIRoute {
	schema = {
		tags: ["Parse"],
		summary: "Extract the plain text of a PDF attachment, to author templates against",
		request: {
			body: { content: { "application/json": { schema: ExtractRequestSchema } } },
		},
		responses: {
			"200": {
				description: "Flattened text of the first PDF in the list",
				content: {
					"application/json": {
						schema: z.object({
							text: z.string(),
							chars: z.number(),
							pages: z.number(),
							source: z.string(),
							warning: z.string().optional(),
						}),
					},
				},
			},
			"422": {
				description: "No PDF found or the attachment could not be read",
				content: { "application/json": { schema: ErrorSchema } },
			},
		},
	};

	async handle(c: AppContext) {
		const data = await this.getValidatedData<typeof this.schema>();
		const { attachments } = data.body;

		try {
			const extracted = await extractPdfText(attachments);
			// A generated PDF yields thousands of characters; a scan yields almost none.
			const warning = extracted.chars < SUSPICIOUSLY_SHORT_CHARS
				? `Only ${extracted.chars} characters extracted — the PDF may be a scan and need OCR`
				: undefined;
			return c.json({ ...extracted, ...(warning ? { warning } : {}) });
		} catch (e) {
			if (isDebug(c)) console.log("[Genesys Debug] AttachmentExtract - error:", (e as Error).message);
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
openapi.post("/api/parse/attachment", GenesysAttachmentParse);
openapi.post("/api/extract", AttachmentExtract);

// 405 fallback for non-POST methods on this route
app.all("/api/parse", (c) => c.json({ error: "Method Not Allowed" }, 405));

export default app;
