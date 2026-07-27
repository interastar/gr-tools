import { normalizeStr, stripHtml } from "./parser";

/**
 * Genesys Cloud API access. Runtime-agnostic: only uses `fetch` and `btoa`,
 * both globals in Workers and in Node 20+, so the same module serves the
 * Cloudflare Worker and the Genesys Cloud Function bundle.
 */

export interface GenesysSubstitution {
	id: string;
	description?: string;
}

export interface GenesysAuth {
	/** Full Authorization header value, e.g. `Basic <base64(id:secret)>`. Takes precedence. */
	authHeader?: string;
	clientId?: string;
	clientSecret?: string;
}

export interface CannedResponse {
	template: string;
	candidates: Record<string, string[]>;
	/** Raw API payload, kept for debug logging. */
	raw: unknown;
}

const LOGIN_URL = "https://login.mypurecloud.com/oauth/token";
const API_BASE = "https://api.mypurecloud.com/api/v2";

/** Builds the Basic header from an explicit header or from client id + secret. */
export function buildAuthHeader(auth: GenesysAuth): string {
	if (auth.authHeader && auth.authHeader.trim().length > 0) return auth.authHeader;
	if (auth.clientId && auth.clientSecret) return `Basic ${btoa(`${auth.clientId}:${auth.clientSecret}`)}`;
	throw new Error("Missing Genesys credentials: provide an Authorization header or client id + secret");
}

export async function getGenesysToken(auth: GenesysAuth | string): Promise<string> {
	const authHeader = typeof auth === "string" ? auth : buildAuthHeader(auth);

	const res = await fetch(LOGIN_URL, {
		method: "POST",
		headers: {
			"Authorization": authHeader,
			"Content-Type": "application/x-www-form-urlencoded",
		},
		body: "grant_type=client_credentials",
	});
	if (!res.ok) throw new Error(`Genesys auth failed: ${res.status}`);
	const data = await res.json() as { access_token: string };
	return data.access_token;
}

/**
 * Turns the `description` of each canned response substitution into the list of
 * accepted values used for fuzzy matching. A description may be a JSON array or
 * a plain comma-separated list.
 */
export function parseCandidates(substitutions: GenesysSubstitution[]): Record<string, string[]> {
	const candidates: Record<string, string[]> = {};
	for (const sub of substitutions) {
		if (!sub.description) continue;
		const normalized = normalizeStr(sub.description);
		try {
			const parsed: unknown = JSON.parse(normalized);
			if (Array.isArray(parsed)) {
				candidates[sub.id] = parsed.map(String).filter(Boolean);
				continue;
			}
		} catch {
			// not JSON — fall through to comma-split
		}
		candidates[sub.id] = normalized.split(",").map((v) => v.trim()).filter(Boolean);
	}
	return candidates;
}

export async function getGenesysCannedResponse(token: string, libraryId: string, name: string): Promise<CannedResponse> {
	const url = `${API_BASE}/responsemanagement/responses?libraryId=${libraryId}&pageSize=200`;
	const res = await fetch(url, {
		headers: { "Authorization": `Bearer ${token}` },
	});
	if (!res.ok) throw new Error(`Genesys API failed: ${res.status}`);
	const data = await res.json() as { entities: Array<{ name: string; texts: Array<{ content: string }>; substitutions?: GenesysSubstitution[] }> };
	const match = data.entities.find((e) => e.name === name);
	if (!match) throw new Error(`Canned response not found: "${name}" in library: ${JSON.stringify(data)}`);
	const rawContent = match.texts?.[0]?.content;
	if (!rawContent) throw new Error(`Canned response "${name}" has no text content`);
	const candidates = parseCandidates(match.substitutions ?? []);
	return { template: stripHtml(rawContent), candidates, raw: data };
}

/** Convenience for callers that only need the template: token + lookup in one call. */
export async function getTemplate(auth: GenesysAuth, libraryId: string, name: string): Promise<CannedResponse> {
	const token = await getGenesysToken(auth);
	return getGenesysCannedResponse(token, libraryId, name);
}
