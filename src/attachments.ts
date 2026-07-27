import { extractText } from "unpdf";

/**
 * Attachment download + PDF text extraction. Runtime-agnostic: `fetch` and
 * unpdf work identically in Workers and Node 20+, so the Worker and the
 * Genesys Cloud Function produce byte-identical text for the same PDF.
 */

export interface Attachment {
	url: string;
	/** Worker request shape. */
	mimeType?: string;
	/** Genesys Data Action shape. */
	mediaType?: string;
	name?: string;
}

export interface ExtractedText {
	/** Whitespace-flattened text of the whole document. */
	text: string;
	chars: number;
	pages: number;
	/** File name of the attachment the text came from. */
	source: string;
}

/** Attachments larger than this are rejected rather than parsed. */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/**
 * Below this many characters the PDF is almost certainly a scan (unpdf returns
 * little or nothing for image-only pages) rather than a generated document.
 */
export const SUSPICIOUSLY_SHORT_CHARS = 200;

function mimeOf(attachment: Attachment): string | undefined {
	return attachment.mimeType ?? attachment.mediaType;
}

function pathOf(attachment: Attachment): string {
	if (attachment.name) return attachment.name;
	try {
		return new URL(attachment.url).pathname;
	} catch {
		// not an absolute URL — match against the raw string, query string and all
		return attachment.url;
	}
}

export function isPdf(attachment: Attachment): boolean {
	const mime = mimeOf(attachment);
	if (mime) return mime.toLowerCase().includes("pdf");
	// no mime-type provided: fall back to the file extension, ignoring any query string
	return pathOf(attachment).toLowerCase().split("?")[0]!.endsWith(".pdf");
}

export function fileNameOf(attachment: Attachment): string {
	return attachment.name ?? pathOf(attachment).split("/").pop() ?? "attachment.pdf";
}

/**
 * Downloads the first PDF in `attachments` and extracts its text. The URLs are
 * expected to be public or pre-signed, so no credentials are attached.
 *
 * The text is whitespace-flattened before being returned: templates are matched
 * with the regex `s` flag, so without flattening the last (greedy) variable
 * runs across line breaks and swallows the rest of the document.
 */
export async function extractPdfText(attachments: Attachment[]): Promise<ExtractedText> {
	const pdf = attachments.find(isPdf);
	if (!pdf) throw new Error("No PDF attachment found in the provided list");

	const res = await fetch(pdf.url);
	if (!res.ok) throw new Error(`Failed to download attachment: ${res.status}`);
	const buffer = await res.arrayBuffer();
	if (buffer.byteLength === 0) throw new Error("Downloaded attachment is empty");
	if (buffer.byteLength > MAX_ATTACHMENT_BYTES) {
		throw new Error(`Attachment too large: ${buffer.byteLength} bytes (max ${MAX_ATTACHMENT_BYTES})`);
	}

	const source = fileNameOf(pdf);
	const { text, totalPages } = await extractText(new Uint8Array(buffer), { mergePages: true });
	const flat = flattenWhitespace(text);
	if (!flat) throw new Error(`Could not extract text from attachment "${source}" (is it a scanned PDF?)`);

	return { text: flat, chars: flat.length, pages: totalPages, source };
}

export function flattenWhitespace(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}
