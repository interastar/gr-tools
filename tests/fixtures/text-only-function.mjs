// A text-only Genesys Function, as a new one would be written: it imports
// src/core-text.ts rather than src/core.ts, so its bundle carries no unpdf.
// Used by build.test.mjs to keep that split honest.
import { parseTextWithTemplate } from "../../src/core-text";
import { defineFunction, genesysCredentials } from "../../functions/_runtime.mjs";

export const handler = defineFunction(async (event, { headers, debug }) =>
	parseTextWithTemplate({ ...genesysCredentials(headers), name: event.name, content: event.content, debug }),
);
