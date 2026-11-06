import { defineConfig } from "tsup";

/**
 * The npm build: ESM JavaScript and bundled type declarations for each public entry, in `dist/`. `facts`,
 * `types` and `host-gate` hold the shapes the other entries' options and results name. The
 * dependencies stay external (npm installs them); the spelling dictionaries load as their own chunks,
 * on first use.
 */
export default defineConfig({
	entry: {
		index: "src/index.ts",
		reading: "src/reading.ts",
		"resource-check": "src/resource-check.ts",
		facts: "src/facts.ts",
		types: "src/types.ts",
		"host-gate": "src/host-gate.ts"
	},
	format: ["esm"],
	platform: "node",
	target: "node22",
	dts: true,
	splitting: true,
	sourcemap: false,
	clean: true,
	metafile: true,
	treeshake: true,
	removeNodeProtocol: false
});
