import { fromHono, OpenAPIRoute } from "chanfana";
import { Hono } from "hono";
import { z } from "zod";
import { parseTemplate } from "./parser";
import type { AppContext } from "./types";

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

const app = new Hono<{ Bindings: Env }>();

const openapi = fromHono(app, {
	docs_url: "/",
});

openapi.post("/api/parse", TemplateParse);

// 405 fallback for non-POST methods on this route
app.all("/api/parse", (c) => c.json({ error: "Method Not Allowed" }, 405));

export default app;
