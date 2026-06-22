import type { Context } from "hono";

export interface Env {
	GENESYS_LIBRARY_ID: string;
	GENESYS_CLIENT_ID: string;
	GENESYS_CLIENT_SECRET: string;
}

export type AppContext = Context<{ Bindings: Env }>;

export interface ParseRequest {
	template: string;
	content: string;
	html?: boolean;
}

export interface ParseResult {
	[key: string]: string;
}
