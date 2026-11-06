import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** The environment variable an API key may come from; it wins over the saved key. */
export const API_KEY_ENV = "SEOSTUDIO_API_KEY";

/** The environment variable that moves the config folder (a container's volume, a test's folder). */
export const CONFIG_DIR_ENV = "SEOSTUDIO_CONFIG_DIR";

/** The file the saved key lives in, inside the config folder. */
const CONFIG_FILE = "config.json";

/** What the config file holds. */
interface StoredConfig {
	apiKey?: string;
}

/** Where a key came from, so the CLI can say which one it used without showing it. */
export type KeySource = "env" | "saved";

/** An API key and where it came from. */
export interface ResolvedKey {
	key: string;
	source: KeySource;
}

/**
 * The folder the CLI keeps its config in: the OS's per-user config folder (`~/Library/Application
 * Support` on macOS, `%APPDATA%` on Windows, `$XDG_CONFIG_HOME` or `~/.config` elsewhere), or the one
 * {@link CONFIG_DIR_ENV} names.
 *
 * @param env - The process environment.
 * @param platform - The OS.
 * @returns The folder.
 */
export function configDir(
	env: Readonly<Record<string, string | undefined>> = process.env,
	platform: NodeJS.Platform = process.platform
): string {
	const override = env[CONFIG_DIR_ENV]?.trim();
	if (override !== undefined && override !== "") return override;
	if (platform === "darwin") return join(homedir(), "Library", "Application Support", "seostudio");
	if (platform === "win32") {
		return join(env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "seostudio");
	}
	const xdg = env.XDG_CONFIG_HOME?.trim();
	return join(xdg !== undefined && xdg !== "" ? xdg : join(homedir(), ".config"), "seostudio");
}

/**
 * Reads the config file; a missing or unreadable file holds nothing.
 *
 * @param dir - The config folder.
 * @returns What it holds.
 */
async function readConfig(dir: string): Promise<StoredConfig> {
	try {
		const parsed: unknown = JSON.parse(await readFile(join(dir, CONFIG_FILE), "utf-8"));
		if (typeof parsed !== "object" || parsed === null) return {};
		const apiKey = "apiKey" in parsed ? parsed.apiKey : undefined;
		return typeof apiKey === "string" && apiKey.trim() !== "" ? { apiKey: apiKey.trim() } : {};
	} catch {
		return {};
	}
}

/**
 * The API key to use: {@link API_KEY_ENV} when set, else the saved one.
 *
 * @param env - The process environment.
 * @param dir - The config folder.
 * @returns The key and its source, or null when there is none.
 */
export async function resolveApiKey(
	env: Readonly<Record<string, string | undefined>> = process.env,
	dir: string = configDir(env)
): Promise<ResolvedKey | null> {
	const fromEnv = env[API_KEY_ENV]?.trim();
	if (fromEnv !== undefined && fromEnv !== "") return { key: fromEnv, source: "env" };
	const saved = (await readConfig(dir)).apiKey;
	return saved === undefined ? null : { key: saved, source: "saved" };
}

/**
 * Saves an API key, readable by this user only: the folder 0700, the file 0600, written beside and
 * renamed into place so a crash never leaves half a file.
 *
 * @param key - The key.
 * @param dir - The config folder.
 * @returns The file written.
 */
export async function saveApiKey(key: string, dir: string = configDir()): Promise<string> {
	await mkdir(dir, { recursive: true, mode: 0o700 });
	const file = join(dir, CONFIG_FILE);
	const temporary = join(dir, `${CONFIG_FILE}.${String(process.pid)}.tmp`);
	const body: StoredConfig = { ...(await readConfig(dir)), apiKey: key.trim() };
	await writeFile(temporary, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
	await chmod(temporary, 0o600);
	await rename(temporary, file);
	return file;
}

/**
 * Removes the saved API key.
 *
 * @param dir - The config folder.
 * @returns Whether a key was saved.
 */
export async function forgetApiKey(dir: string = configDir()): Promise<boolean> {
	const held = await readConfig(dir);
	if (held.apiKey === undefined) return false;
	await rm(join(dir, CONFIG_FILE), { force: true });
	return true;
}
