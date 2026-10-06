/**
 * Genesys Cloud Function: the plain text of a PDF, to author templates against.
 * Standalone equivalent of `POST /api/extract`.
 *
 * Templates must be written against the text unpdf actually produces (tables
 * flatten by column, not by row), and this returns exactly the text that
 * `gr-parse-attachment` would parse for the same file.
 *
 * `source` is a single string so one Data Action serves both callers: a person
 * pasting a public URL into the Test tab, and Architect passing the attachments
 * of an email conversation as their JSON array. It is told apart the same way
 * `gr-parse-attachment` tells apart its `content`.
 *
 * Needs no Genesys credentials: it never calls the Genesys API.
 */
import { extractPdfText, shortTextWarning } from "../src/attachments";
import { asAttachmentList, asPdfUrl } from "../src/core";
import { defineFunction } from "./_runtime.mjs";

/** The attachment list `source` stands for: the array itself, its JSON, or a single URL. */
function toAttachments(source) {
	if (Array.isArray(source)) return source;

	const value = typeof source === "string" ? source.trim() : "";
	if (!value) throw new Error("Missing required input: source");

	const list = asAttachmentList(value);
	if (list) return list;
	if (value.startsWith("[") || value.startsWith("{")) {
		throw new Error("Input source looks like JSON but is not an attachment array: each item needs a contentUri");
	}

	// same detection as `content` in gr-parse-attachment, so both accept the same URLs
	const url = asPdfUrl(value);
	if (url) return url;
	if (/^[a-z][a-z\d+.-]*:\/\//i.test(value) && !/^https?:/i.test(value)) {
		throw new Error("Input source URL must be http(s)");
	}
	throw new Error(`Input source is neither an http(s) URL nor an attachment array: "${value}"`);
}

export const handler = defineFunction(async (event) => {
	const { text, chars, pages, source } = await extractPdfText(toAttachments(event.source));

	// `warning` is always present so the Data Action output contract is fixed
	return { text, chars, pages, source, warning: shortTextWarning(chars) ?? "" };
});
