import type { ParseResult } from "./types";

export function normalizeStr(s: string): string {
	return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().trim();
}

function levenshtein(a: string, b: string): number {
	const m = a.length, n = b.length;
	const dp: number[] = Array.from({ length: n + 1 }, (_, i) => i);
	for (let i = 1; i <= m; i++) {
		let prev = dp[0]!;
		dp[0] = i;
		for (let j = 1; j <= n; j++) {
			const tmp = dp[j]!;
			dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j]!, dp[j - 1]!);
			prev = tmp;
		}
	}
	return dp[n]!;
}

/**
 * Returns the best-matching candidate for `value`, or `value` unchanged if no
 * candidate is within 2 edits (after accent/case normalization).
 */
export function fuzzyMatch(value: string, candidates: string[]): string {
	if (!candidates.length) return value;
	const normValue = normalizeStr(value);
	let bestCandidate = value;
	let bestDist = Infinity;
	for (const candidate of candidates) {
		const dist = levenshtein(normValue, normalizeStr(candidate));
		if (dist < bestDist) {
			bestDist = dist;
			bestCandidate = candidate;
		}
	}
	return bestDist <= 2 ? bestCandidate : value;
}

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function stripHtml(html: string): string {
	// Remove tags first, then decode entities to preserve intended characters
	const withoutTags = html.replace(/<[^>]*>/g, "");
	const decoded = decodeHtmlEntities(withoutTags);
	return decoded.replace(/\s+/g, " ").trim();
}

function decodeHtmlEntities(str: string): string {
	if (!str) return str;

	// Replace numeric decimal entities: &#NNNN;
	str = str.replace(/&#(\d+);/g, (_, dec) => {
		const code = parseInt(dec, 10);
		return Number.isNaN(code) ? `` : String.fromCodePoint(code);
	});

	// Replace numeric hex entities: &#xHHHH;
	str = str.replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
		const code = parseInt(hex, 16);
		return Number.isNaN(code) ? `` : String.fromCodePoint(code);
	});

	// Some common named entities mapping. This covers typical Latin-1 and punctuation
	// used in content. Unknown named entities are left unchanged.
	const named: Record<string, string> = {
		nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
		Aacute: 'Á', aacute: 'á', Eacute: 'É', eacute: 'é', Iacute: 'Í', iacute: 'í',
		Oacute: 'Ó', oacute: 'ó', Uacute: 'Ú', uacute: 'ú', Ntilde: 'Ñ', ntilde: 'ñ',
		AElig: 'Æ', aelig: 'æ', Ccedil: 'Ç', ccedil: 'ç', Oslash: 'Ø', oslash: 'ø',
		Uuml: 'Ü', uuml: 'ü', copy: '©', reg: '®', trade: '™', ndash: '–', mdash: '—',
		hellip: '…', deg: '°', para: '¶', middot: '·', bull: '•'
	};

	str = str.replace(/&([a-zA-Z]+);/g, (_, name) => {
		return named[name] ?? `&${name};`;
	});

	return str;
}

const VAR_TOKEN = /^\{{1,2}(\.\.\.|\w+)\}{1,2}/;

/**
 * Compiles one segment of a template into a regex pattern fragment.
 * `[...]` marks an optional section (may contain literal text and `{vars}`)
 * that is wrapped in a non-capturing optional group, so content that omits
 * it still matches. `insideOptional` tracks whether `]` should close the
 * current segment (nested) or be treated as a literal character (top level).
 */
function compileSegment(
	template: string,
	pos: number,
	varCount: number,
	varIndexRef: { value: number },
	insideOptional: boolean,
): { pattern: string; pos: number } {
	let pattern = "";
	let literal = "";

	const flushLiteral = () => {
		// zero-or-more (not one-or-more): adjacent boundaries around an empty
		// optional value would otherwise both demand whitespace that only
		// exists once in the content, causing spurious match failures
		pattern += escapeRegex(literal).replace(/ +/g, "\\s*");
		literal = "";
	};

	while (pos < template.length) {
		const ch = template[pos];
		if (ch === "\\" && "[]{}\\".includes(template[pos + 1] ?? "")) {
			// backslash-escape a literal [ ] { } \ so it isn't treated as template syntax
			literal += template[pos + 1];
			pos += 2;
			continue;
		}
		if (ch === "[") {
			flushLiteral();
			const inner = compileSegment(template, pos + 1, varCount, varIndexRef, true);
			pattern += `(?:${inner.pattern})?`;
			pos = inner.pos;
			continue;
		}
		if (ch === "]" && insideOptional) {
			flushLiteral();
			return { pattern, pos: pos + 1 };
		}
		if (ch === "{") {
			const braceMatch = VAR_TOKEN.exec(template.slice(pos));
			if (braceMatch) {
				flushLiteral();
				const name = braceMatch[1]!;
				if (name === "...") {
					// match anything (including newlines), non-greedy, do not capture
					pattern += "(?:[\\s\\S]*?)";
				} else {
					const isLast = varIndexRef.value === varCount - 1;
					// last captured variable is greedy (.*) to avoid under-matching when template ends with a variable
					// zero-width allowed so a field can be legitimately empty (e.g. "Label: " with no value)
					pattern += `(?<${name}>${isLast ? ".*" : ".*?"})`;
					varIndexRef.value++;
				}
				pos += braceMatch[0].length;
				continue;
			}
		}
		literal += ch;
		pos++;
	}

	if (insideOptional) throw new Error("Unbalanced '[' in template: missing closing ']'");

	flushLiteral();
	return { pattern, pos };
}

export function buildPattern(template: string): RegExp {
	// count only real variables (exclude '...') to determine greediness for the last captured var
	const varNames = template
		.split(/\{{1,2}(\.\.\.|\w+)\}{1,2}/)
		.filter((_, idx) => idx % 2 === 1)
		.filter((n) => n !== "...");
	const varCount = varNames.length;

	const { pattern } = compileSegment(template, 0, varCount, { value: 0 }, false);

	// allow arbitrary prefix before the template (existing behavior)
	return new RegExp(`[\\s\\S]*?${pattern}`, "s");
}

export function parseTemplate(
	template: string,
	content: string,
	html = true,
	candidates: Record<string, string[]> = {},
): ParseResult {
	const text = html ? stripHtml(content) : content;
	const regex = buildPattern(template);
	const match = regex.exec(text);

	if (!match?.groups) {
		throw new Error("Content does not match the provided template. Content: " + text + " Template: " + regex.toString());
	}

	const result: ParseResult = {};
	for (const [key, value] of Object.entries(match.groups)) {
		// unmatched optional sections leave their capture group undefined
		if (value === undefined) {
			result[key] = "";
			continue;
		}
		const trimmed = value.trim();
		result[key] = candidates[key]?.length ? fuzzyMatch(trimmed, candidates[key]) : trimmed;
	}
	return result;
}
