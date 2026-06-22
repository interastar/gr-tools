import type { Context } from "hono";

export type AppContext = Context<{ Bindings: Env }>;

export interface ParseRequest {
	template: string;
	content: string;
	html?: boolean;
}

export interface ParseResult {
	[key: string]: string;
}
