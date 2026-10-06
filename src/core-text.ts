import { type CannedResponse, type GenesysAuth, getTemplate } from "./genesys";
import { parseTemplate } from "./parser";
import type { ParseResult } from "./types";

/**
 * The text-only half of "parse something with a Genesys canned response as
 * template". Deliberately free of `./attachments`: that module pulls in unpdf
 * (~1.6 MB bundled), and a Genesys Function that only ever parses text should
 * not carry it. `core.ts` builds the PDF-aware entry point on top of this.
 */

export type Log = (message: string, value?: unknown) => void;

export interface TemplateSource {
	/** Name of the canned response to use as template. */
	name: string;
	auth: GenesysAuth;
	libraryId: string;
	debug?: boolean;
	log?: Log;
}

export const defaultLog: Log = (message, value) => {
	if (value === undefined) console.log(message);
	else console.log(message, typeof value === "string" ? value : JSON.stringify(value));
};

export function assertTemplateSource({ name, libraryId }: TemplateSource): void {
	if (!name) throw new Error("Missing required input: name");
	if (!libraryId) throw new Error("Missing required input: libraryId");
}

export function logCannedResponse({ raw, template, candidates }: CannedResponse, log: Log): void {
	log("[Debug] genesys raw response:", raw);
	log("[Debug] template:", template);
	log("[Debug] candidates:", candidates);
}

/** Parses caller-sent text with the named canned response. */
export async function parseTextWithTemplate(
	input: TemplateSource & { content: string; html?: boolean },
): Promise<ParseResult> {
	const { name, content, auth, libraryId, html, debug = false } = input;
	const log = input.log ?? defaultLog;

	assertTemplateSource(input);
	if (content === undefined || content === null) throw new Error("Missing required input: content");

	const canned = await getTemplate(auth, libraryId, name);
	if (debug) {
		logCannedResponse(canned, log);
		log("[Debug] content:", content);
	}

	const result = parseTemplate(canned.template, content, html ?? true, canned.candidates);
	if (debug) log("[Debug] result:", result);
	return result;
}
