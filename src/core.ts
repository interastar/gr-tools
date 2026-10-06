import { type Attachment, type ExtractedText, extractPdfText, SUSPICIOUSLY_SHORT_CHARS } from "./attachments";
import { assertTemplateSource, defaultLog, logCannedResponse, type TemplateSource } from "./core-text";
import { getTemplate } from "./genesys";
import { parseTemplate } from "./parser";
import type { ParseResult } from "./types";

/**
 * Shared orchestration for "parse something with a Genesys canned response as
 * template". Knows nothing about hono or about Lambda: the Cloudflare Worker
 * routes and the Genesys Cloud Function handler are all thin adapters over this.
 *
 * The content may arrive as plain text or as a list of attachments, and callers
 * are not always able to tell which — a Genesys Data Action passes everything
 * through a single string input. So a `content` string that turns out to be a
 * JSON array of attachments is treated as one; anything else is text.
 *
 * Importing this module bundles unpdf. A caller that only ever has text should
 * use `parseTextWithTemplate` from `./core-text` instead.
 */

export interface ParseWithTemplateInput extends TemplateSource {
	/** Plain text, or the JSON representation of an attachment array. */
	content?: string;
	/** Attachments as a real array, when the caller already has one. */
	attachments?: Attachment[];
	/** Strip HTML before parsing. Defaults to true for text, and is always off for PDF text. */
	html?: boolean;
}

export interface ResolvedContent {
	text: string;
	/** Set when the text came from a PDF rather than from the request itself. */
	extracted?: ExtractedText;
}

/**
 * Returns the attachment list a string represents, or null if the string is
 * just content. Requires every element to carry a `contentUri`, so a JSON
 * array that happens to be the actual content isn't mistaken for a list of
 * attachments.
 */
export function asAttachmentList(content: string): Attachment[] | null {
	const trimmed = content.trim();
	if (!trimmed.startsWith("[")) return null;

	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return null;
	}

	if (!Array.isArray(parsed) || parsed.length === 0) return null;
	const looksLikeAttachments = parsed.every(
		(item) => item !== null && typeof item === "object" && typeof (item as Attachment).contentUri === "string",
	);
	return looksLikeAttachments ? (parsed as Attachment[]) : null;
}

/** Decides whether to parse the request's own text or to go download a PDF. */
export async function resolveContent(content?: string, attachments?: Attachment[]): Promise<ResolvedContent> {
	if (attachments?.length) {
		const extracted = await extractPdfText(attachments);
		return { text: extracted.text, extracted };
	}

	if (content === undefined || content === null) {
		throw new Error("Missing required input: content or attachments");
	}

	const list = asAttachmentList(content);
	if (!list) return { text: content };

	const extracted = await extractPdfText(list);
	return { text: extracted.text, extracted };
}

/**
 * Rejects with the first error, but never leaves the loser's rejection
 * unhandled — an unhandled rejection tears down the Lambda process.
 */
async function bothOrFirstError<A, B>(a: Promise<A>, b: Promise<B>): Promise<[A, B]> {
	const [ra, rb] = await Promise.allSettled([a, b]);
	if (ra.status === "rejected") throw ra.reason;
	if (rb.status === "rejected") throw rb.reason;
	return [ra.value, rb.value];
}

export async function parseWithTemplate(input: ParseWithTemplateInput): Promise<ParseResult> {
	const { name, content, attachments, auth, libraryId, html, debug = false } = input;
	const log = input.log ?? defaultLog;

	assertTemplateSource(input);

	if (debug && attachments) log("[Debug] attachments:", attachments);

	// Both round trips run at once. Serialised (token -> responses -> download ->
	// extract) this can brush against the 15 s ceiling of a Genesys Function on
	// a cold start.
	const [resolved, canned] = await bothOrFirstError(
		resolveContent(content, attachments),
		getTemplate(auth, libraryId, name),
	);

	if (debug) logCannedResponse(canned, log);

	if (resolved.extracted) {
		const { chars, pages, source } = resolved.extracted;
		if (debug) log(`[Debug] extracted ${chars} chars from ${pages} page(s) of ${source}:`, resolved.text);
		if (chars < SUSPICIOUSLY_SHORT_CHARS) {
			log(`[Warn] only ${chars} chars extracted from "${source}" — possibly a scanned PDF`);
		}
	} else if (debug) {
		log("[Debug] content:", resolved.text);
	}

	// PDF text is already plain, and stripping tags would mangle any literal
	// angle brackets in it, so HTML handling only applies to caller-sent text.
	const stripTags = resolved.extracted ? false : (html ?? true);

	const result = parseTemplate(canned.template, resolved.text, stripTags, canned.candidates);
	if (debug) log("[Debug] result:", result);
	return result;
}
