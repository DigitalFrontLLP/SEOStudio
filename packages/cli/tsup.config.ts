import { defineConfig } from "tsup";

/**
 * The npm build: `dist/cli.js` with the audit engine, the MCP SDK and every other dependency bundled
 * in, so `npx seostudio` installs one package and nothing else. What the CLI imports on demand (the
 * spelling dictionaries, the AMP validator, the site reader) lands in chunks next to it, loaded on
 * first use; one file would also break, since a lazily initialised module there leaves zod's classes
 * undefined. The banner gives the bundled CommonJS dependencies the `require` an ES module lacks.
 */
export default defineConfig({
	entry: { cli: "src/cli.ts" },
	format: ["esm"],
	platform: "node",
	target: "node22",
	noExternal: [/.*/],
	splitting: true,
	sourcemap: false,
	minify: true,
	clean: true,
	metafile: true,
	removeNodeProtocol: false,
	banner: {
		js: 'import { createRequire as __seostudioRequire } from "node:module"; const require = __seostudioRequire(import.meta.url);'
	}
});
