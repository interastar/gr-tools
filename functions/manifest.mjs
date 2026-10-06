/**
 * The Genesys Cloud Functions this repo builds. `pnpm build:function` produces
 * one self-contained zip per entry; adding a function is adding an entry here
 * plus its adapter file.
 *
 * Genesys is configured through its own UI (Admin > Integrations > Functions),
 * so the runtime values below are the written record of what to enter there —
 * the build prints them next to each zip.
 *
 *   name         function name; also the zip name and the cold-start log line
 *   entry        adapter file, exporting `handler` (built with `defineFunction`)
 *   description  what the Data Action does
 *   pdf          whether the function reads PDFs. unpdf is ~1.6 MB bundled, so
 *                a function declared `pdf: false` fails the build if it pulls it in
 *   memory       MB
 *   timeout      seconds; 15 is the Genesys maximum
 */

/** Shared by every function: the Genesys runtime and the zip layout. */
// Genesys deprecated nodejs20.x; nodejs22.x is the runtime it asks for.
export const RUNTIME = { runtime: "nodejs22.x", architecture: "arm64", handler: "index.handler", target: "node22" };

export default [
	{
		name: "gr-parse-attachment",
		entry: "functions/parse-attachment.mjs",
		description: "Parse text or a PDF attachment using a Genesys canned response as template",
		pdf: true,
		memory: 1024, // unpdf uses more memory than the plain-text parser
		timeout: 15, // the parallel fetches in core.ts are what keep it under
	},
	{
		name: "gr-extract-pdf",
		entry: "functions/extract-pdf.mjs",
		description: "Extract the plain text of a PDF from a public URL, to author templates against",
		pdf: true,
		memory: 1024,
		timeout: 15,
	},
];
