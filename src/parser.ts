import type { ParseResult } from "./types";

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function stripHtml(html: string): string {
	return html
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&quot;/gi, '"')
		.replace(/&#39;/gi, "'")
		.replace(/&#x27;/gi, "'")
		.replace(/<[^>]*>/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

export function buildPattern(template: string): RegExp {
	// split gives [literal, varname, literal, varname, ..., literal]
	const parts = template.split(/\{(\w+)\}/);
	const varCount = Math.floor(parts.length / 2);
	let pattern = "";
	let varIndex = 0;

	for (let i = 0; i < parts.length; i++) {
		if (i % 2 === 0) {
			pattern += escapeRegex(parts[i]||'').replace(/ +/g, "\\s*");
		} else {
			const isLast = varIndex === varCount - 1;
			// last variable is greedy (.+) to avoid under-matching when template ends with a variable
			pattern += `(?<${parts[i]}>${isLast ? ".+" : ".+?"})`;
			varIndex++;
		}
	}

	return new RegExp(`[\\s\\S]*?${pattern}`, "s");
}

export function parseTemplate(
	template: string,
	content: string,
	html = true,
): ParseResult {
	const text = html ? stripHtml(content) : content;
	const regex = buildPattern(template);
	const match = regex.exec(text);

	if (!match?.groups) {
		throw new Error("Content does not match the provided template. Content: " + text + " Template: " + regex.toString());
	}

	const result: ParseResult = {};
	for (const [key, value] of Object.entries(match.groups)) {
		result[key] = value.trim();
	}
	return result;
}
