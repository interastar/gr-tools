// Bundle entry for the tests: re-exports the shared runtime-agnostic modules so
// `tests/_bundle.mjs` can hand them to Node as a single ESM file. The sources
// use extensionless imports (resolved by wrangler/esbuild, not by Node), which
// is why the tests go through the same bundler the deployables do.
export * from "../src/attachments";
export * from "../src/core";
export * from "../src/genesys";
export * from "../src/parser";
