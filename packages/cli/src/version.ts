import { createRequire } from "node:module";

/**
 * The CLI's version, read from its own package.json (one folder above both `src/` and `dist/`).
 */
export const CLI_VERSION: string = ((): string => {
	const manifest: unknown = createRequire(import.meta.url)("../package.json");
	if (typeof manifest === "object" && manifest !== null && "version" in manifest) {
		return typeof manifest.version === "string" ? manifest.version : "0.0.0";
	}
	return "0.0.0";
})();
