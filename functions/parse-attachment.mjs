/**
 * Genesys Cloud Function: parse content with a canned response as template.
 * Standalone equivalent of `POST /api/parse/template` — the content may be text
 * or a JSON array of attachments, in which case the first PDF is downloaded and
 * read instead.
 *
 * Only the Genesys adapter lives here; the work is `parseWithTemplate` in
 * `src/core.ts`, shared verbatim with the Cloudflare Worker. Credentials, input
 * coercion and the output contract (the result as is, or `{ error }`) come from
 * `./_runtime.mjs`.
 */
import { parseWithTemplate } from "../src/core";
import { coerceAttachments, coerceBoolean, defineFunction, genesysCredentials } from "./_runtime.mjs";

export const handler = defineFunction(async (event, { headers, debug }) => {
	const { auth, libraryId } = genesysCredentials(headers);
	if (!event.name) throw new Error("Missing required input: name");

	// `content` carries either the text to parse or the JSON array of
	// attachments; `attachments` is the explicit form of the same thing.
	const attachments = coerceAttachments(event.attachments);
	const content = typeof event.content === "string" && event.content ? event.content : undefined;
	if (!attachments && content === undefined) {
		throw new Error("Missing required input: content or attachments");
	}

	return parseWithTemplate({
		name: event.name,
		content,
		attachments,
		auth,
		libraryId,
		html: coerceBoolean(event.html),
		debug,
	});
});
