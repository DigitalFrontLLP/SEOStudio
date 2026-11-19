import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import { Readable, Writable } from "node:stream";

import { hostedRenderer } from "@seostudio/audit-engine/render-cdp";
import type { SeoCdpChannel, SeoPageHost } from "@seostudio/audit-engine/render-cdp";
import type { SeoCrawlFetcher, SeoPageRenderer } from "@seostudio/audit-engine/types";

/**
 * THE BROWSER THE AUDIT RENDERS IN: the person's own Chrome, Chromium or Edge, started headless with a
 * fresh, throwaway profile and driven over the DevTools protocol on a pipe (no port is opened). Each
 * page renders in a browser context of its own, closed once it is read. The render itself is the audit
 * engine's (`render-cdp`), the one the desktop app and the server run: every request the page makes is
 * paused and fetched through the engine's address guard, never by the browser.
 *
 * The browser's own network goes nowhere, as on the server: a proxy that is a black hole (loopback
 * included), no host it may resolve, no WebRTC outside the proxy, no QUIC. So what the render cannot
 * pause (a WebSocket) reaches nothing either. No dependency: Node's child process and the pipe.
 *
 * Off Windows the browser leads a process group of its own, so a Ctrl-C at the terminal reaches the
 * CLI (which stops gracefully) and not the browser in the middle of a page; the CLI kills the group
 * when it closes the browser or exits.
 */

/** The browser's own network: a proxy on a documentation-only address (RFC 5737) that answers nothing. */
const BLACK_HOLE_PROXY = "http://192.0.2.1:9";

/** How long the browser may take to start and answer, in ms. */
const START_MS = 20_000;

/** How long one call to the browser itself (open or close a page) may take, in ms. */
const CALL_MS = 15_000;

/** How long the browser may take to close before it is killed, in ms. */
const CLOSE_MS = 5_000;

/** Each renderer's JavaScript heap, in MB: a page that grows past it crashes alone. */
const RENDERER_HEAP_MB = 512;

/** Where a browser is looked for: the platform, its environment, and whether a file exists. */
export interface BrowserSearch {
	platform: NodeJS.Platform;
	env: Readonly<Record<string, string | undefined>>;
	exists: (path: string) => boolean;
}

/** A started browser: the renderer over its pages, and how to close it. */
export interface BrowserSession {
	render: SeoPageRenderer;
	/** Closes the browser and removes its profile; safe to call twice. */
	close: () => Promise<void>;
}

/**
 * Where Chrome, Chromium and Edge install themselves on this platform, most likely first.
 *
 * @param search - The platform and its environment.
 * @returns The paths to try.
 */
export function browserCandidates(search: Omit<BrowserSearch, "exists">): string[] {
	const { platform, env } = search;
	if (platform === "darwin") {
		const apps = [
			"Google Chrome.app/Contents/MacOS/Google Chrome",
			"Chromium.app/Contents/MacOS/Chromium",
			"Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
		];
		const roots = [
			"/Applications",
			...(env.HOME === undefined ? [] : [posix.join(env.HOME, "Applications")])
		];
		return roots.flatMap((root) => apps.map((app) => posix.join(root, app)));
	}
	if (platform === "win32") {
		const apps = [
			"Google\\Chrome\\Application\\chrome.exe",
			"Microsoft\\Edge\\Application\\msedge.exe",
			"Chromium\\Application\\chrome.exe"
		];
		const roots = [
			env.PROGRAMFILES ?? env.ProgramFiles,
			env["PROGRAMFILES(X86)"] ?? env["ProgramFiles(x86)"],
			env.LOCALAPPDATA
		].filter((root): root is string => root !== undefined && root !== "");
		return roots.flatMap((root) => apps.map((app) => win32.join(root, app)));
	}
	const names = [
		"google-chrome-stable",
		"google-chrome",
		"chromium",
		"chromium-browser",
		"microsoft-edge-stable",
		"microsoft-edge"
	];
	const dirs = [...(env.PATH ?? "").split(":"), "/usr/bin", "/snap/bin"].filter(
		(dir, at, all) => dir !== "" && all.indexOf(dir) === at
	);
	return [
		...names.flatMap((name) => dirs.map((dir) => posix.join(dir, name))),
		"/opt/google/chrome/chrome"
	];
}

/**
 * The browser to render in: the one named (by `--chrome` or `CHROME_PATH`) when it exists,
 * else the first installed Chrome, Chromium or Edge.
 *
 * @param override - The path the person named, or null.
 * @param search - The platform, its environment and the file check.
 * @returns The path, or null when there is none (or the one named does not exist).
 */
export function findBrowser(override: string | null, search: BrowserSearch): string | null {
	if (override !== null) return search.exists(override) ? override : null;
	return browserCandidates(search).find((path) => search.exists(path)) ?? null;
}

/**
 * {@link findBrowser} on this computer.
 *
 * @param override - The path the person named, or null.
 * @returns The path, or null.
 */
export function findInstalledBrowser(override: string | null): string | null {
	return findBrowser(override, {
		platform: process.platform,
		env: process.env,
		exists: existsSync
	});
}

/**
 * The switches the browser starts with: headless, the pipe, a throwaway profile, and no network of its
 * own (the switches the server's browser starts with).
 *
 * @param profile - The throwaway profile folder.
 * @returns The switches.
 */
function browserArgs(profile: string): string[] {
	return [
		"--headless",
		"--remote-debugging-pipe",
		`--user-data-dir=${profile}`,
		"--no-startup-window",
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-extensions",
		"--disable-sync",
		"--disable-default-apps",
		"--disable-background-networking",
		"--disable-component-update",
		"--disable-breakpad",
		"--disable-client-side-phishing-detection",
		"--disable-search-engine-choice-screen",
		"--edge-skip-compat-layer-relaunch",
		"--password-store=basic",
		"--use-mock-keychain",
		"--hide-scrollbars",
		"--mute-audio",
		`--proxy-server=${BLACK_HOLE_PROXY}`,
		"--proxy-bypass-list=<-loopback>",
		"--host-resolver-rules=MAP * ~NOTFOUND",
		"--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
		"--webrtc-ip-handling-policy=disable_non_proxied_udp",
		"--disable-quic",
		"--disable-3d-apis",
		"--no-pings",
		`--js-flags=--max-old-space-size=${String(RENDERER_HEAP_MB)}`
	];
}

/**
 * A field of a protocol message, when the message is an object that has it.
 *
 * @param value - The message.
 * @param key - The field.
 * @returns The field's value, or undefined.
 */
function field(value: unknown, key: string): unknown {
	return typeof value === "object" && value !== null && key in value
		? Reflect.get(value, key)
		: undefined;
}

/**
 * A text field of a protocol message.
 *
 * @param value - The message.
 * @param key - The field.
 * @returns The text, or an empty string.
 */
function text(value: unknown, key: string): string {
	const found = field(value, key);
	return typeof found === "string" ? found : "";
}

/** A call waiting for the browser's answer. */
interface Pending {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	sessionId: string;
	timer: ReturnType<typeof setTimeout> | null;
}

/** The DevTools protocol over the browser's pipe: NUL-terminated JSON messages each way. */
class PipeConnection {
	private nextId = 1;
	private readonly decoder = new TextDecoder();
	private buffered = "";
	private readonly pending = new Map<number, Pending>();
	private readonly listeners = new Map<string, Map<string, ((params: unknown) => void)[]>>();
	private closedError: Error | null = null;

	/**
	 * @param writer - The browser's command pipe.
	 * @param reader - The browser's answer pipe.
	 */
	constructor(
		private readonly writer: Writable,
		reader: Readable
	) {
		reader.on("data", (chunk: Uint8Array) => {
			this.receive(chunk);
		});
		reader.on("close", () => {
			this.fail(new Error("The browser closed."));
		});
		reader.on("error", () => {
			this.fail(new Error("The browser closed."));
		});
		writer.on("error", () => {
			this.fail(new Error("The browser closed."));
		});
	}

	/**
	 * Sends a command, to the browser or to one page's session.
	 *
	 * @param method - The protocol method.
	 * @param params - Its parameters.
	 * @param sessionId - The page's session, or an empty string for the browser.
	 * @param timeoutMs - The longest wait for the answer, or null for none.
	 * @returns The result.
	 */
	send(
		method: string,
		params: Record<string, unknown>,
		sessionId: string,
		timeoutMs: number | null
	): Promise<unknown> {
		if (this.closedError !== null) return Promise.reject(this.closedError);
		const id = this.nextId;
		this.nextId += 1;
		return new Promise((resolve, reject) => {
			const timer =
				timeoutMs === null
					? null
					: setTimeout(() => {
							this.pending.delete(id);
							reject(new Error(`The browser did not answer ${method}.`));
						}, timeoutMs);
			this.pending.set(id, { resolve, reject, sessionId, timer });
			const message = { id, method, params, ...(sessionId === "" ? {} : { sessionId }) };
			this.writer.write(`${JSON.stringify(message)}\0`);
		});
	}

	/**
	 * Listens to one event of the browser or of one page's session.
	 *
	 * @param sessionId - The page's session, or an empty string for the browser.
	 * @param event - The protocol event.
	 * @param listener - Called with its parameters.
	 */
	on(sessionId: string, event: string, listener: (params: unknown) => void): void {
		const own = this.listeners.get(sessionId) ?? new Map<string, ((params: unknown) => void)[]>();
		own.set(event, [...(own.get(event) ?? []), listener]);
		this.listeners.set(sessionId, own);
	}

	/**
	 * Forgets a page's session: its listeners go, and the calls still waiting on it fail.
	 *
	 * @param sessionId - The session.
	 */
	forget(sessionId: string): void {
		this.listeners.delete(sessionId);
		for (const [id, waiting] of this.pending) {
			if (waiting.sessionId !== sessionId) continue;
			this.pending.delete(id);
			if (waiting.timer !== null) clearTimeout(waiting.timer);
			waiting.reject(new Error("The page closed."));
		}
	}

	/**
	 * Reads what the browser wrote: every whole message dispatched, the rest kept for the next chunk. A
	 * NUL never occurs inside a message (JSON escapes it, and no UTF-8 sequence holds a zero byte).
	 *
	 * @param chunk - The bytes.
	 */
	private receive(chunk: Uint8Array): void {
		const from = this.buffered.length;
		this.buffered += this.decoder.decode(chunk, { stream: true });
		for (
			let end = this.buffered.indexOf("\0", from);
			end !== -1;
			end = this.buffered.indexOf("\0")
		) {
			const message = this.buffered.slice(0, end);
			this.buffered = this.buffered.slice(end + 1);
			this.dispatch(message);
		}
	}

	/**
	 * Hands one message to the call it answers or the listeners of its event.
	 *
	 * @param raw - The message's JSON.
	 */
	private dispatch(raw: string): void {
		let message: unknown;
		try {
			message = JSON.parse(raw);
		} catch {
			return;
		}
		const id = field(message, "id");
		if (typeof id === "number") {
			const waiting = this.pending.get(id);
			if (waiting === undefined) return;
			this.pending.delete(id);
			if (waiting.timer !== null) clearTimeout(waiting.timer);
			const error = field(message, "error");
			if (error === undefined) waiting.resolve(field(message, "result"));
			else waiting.reject(new Error(text(error, "message") || "The browser refused a call."));
			return;
		}
		const method = text(message, "method");
		const sessionId = text(message, "sessionId");
		for (const listener of this.listeners.get(sessionId)?.get(method) ?? []) {
			listener(field(message, "params"));
		}
	}

	/**
	 * Fails every waiting call once the browser is gone.
	 *
	 * @param error - Why.
	 */
	private fail(error: Error): void {
		if (this.closedError !== null) return;
		this.closedError = error;
		for (const waiting of this.pending.values()) {
			if (waiting.timer !== null) clearTimeout(waiting.timer);
			waiting.reject(error);
		}
		this.pending.clear();
	}
}

/**
 * Waits for a child process to exit, up to a bound.
 *
 * @param child - The process.
 * @param ms - The longest wait.
 * @returns Whether it exited.
 */
function exited(child: ChildProcess, ms: number): Promise<boolean> {
	if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			resolve(false);
		}, ms);
		child.once("exit", () => {
			clearTimeout(timer);
			resolve(true);
		});
	});
}

/**
 * Kills the browser and every process it started: its own process group off Windows (it is started
 * as the leader of one), the process itself on Windows.
 *
 * @param child - The browser's process.
 */
function killBrowser(child: ChildProcess): void {
	const { pid } = child;
	if (process.platform !== "win32" && pid !== undefined) {
		try {
			process.kill(-pid, "SIGKILL");
			return;
		} catch {
			child.kill("SIGKILL");
			return;
		}
	}
	child.kill("SIGKILL");
}

/**
 * Removes a folder at once, as a process that is exiting can; one it cannot remove is left to the
 * system's temp folder cleanup.
 *
 * @param path - The folder.
 * @returns Whether it was removed.
 */
function removeNow(path: string): boolean {
	try {
		rmSync(path, { recursive: true, force: true });
		return true;
	} catch {
		return false;
	}
}

/**
 * This process's environment without SEOStudio's own variables (the API key): the browser runs the
 * crawled sites' scripts and needs none of them.
 *
 * @returns The environment.
 */
function browserEnv(): Record<string, string> {
	const kept: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined && !key.toUpperCase().startsWith("SEOSTUDIO_")) kept[key] = value;
	}
	return kept;
}

/**
 * STARTS THE BROWSER headless on a throwaway profile and answers once it has answered: a browser that
 * cannot start, or does not speak the protocol in time, throws here instead of failing every page.
 * Killed, and its profile removed, when this process exits before {@link BrowserSession.close}.
 *
 * @param path - The browser's executable.
 * @param fetch - The guarded transport every request of a page goes through.
 * @returns The session.
 * @throws When the browser cannot start.
 */
export async function launchBrowser(path: string, fetch: SeoCrawlFetcher): Promise<BrowserSession> {
	const profile = await mkdtemp(join(tmpdir(), "seostudio-browser-"));
	const removeProfile = (): Promise<void> =>
		rm(profile, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
	let child: ChildProcess;
	try {
		child = spawn(path, browserArgs(profile), {
			stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
			env: browserEnv(),
			detached: process.platform !== "win32"
		});
	} catch (error) {
		await removeProfile();
		throw error;
	}
	child.on("error", () => undefined);
	const spawnFailed = new Promise<never>((_resolve, reject) => {
		child.once("error", reject);
		child.once("exit", () => {
			reject(new Error("The browser stopped as it started."));
		});
	});
	spawnFailed.catch(() => undefined);
	const writer = child.stdio[3];
	const reader = child.stdio[4];
	if (!(writer instanceof Writable) || !(reader instanceof Readable)) {
		killBrowser(child);
		await removeProfile();
		throw new Error("The browser's pipe could not be opened.");
	}
	const connection = new PipeConnection(writer, reader);
	const onExit = (): void => {
		killBrowser(child);
		removeNow(profile);
	};
	process.once("exit", onExit);
	let closed = false;
	const close = async (): Promise<void> => {
		if (closed) return;
		closed = true;
		process.off("exit", onExit);
		await connection.send("Browser.close", {}, "", CLOSE_MS).catch(() => undefined);
		if (!(await exited(child, CLOSE_MS))) {
			killBrowser(child);
			await exited(child, CLOSE_MS);
		}
		await removeProfile();
	};
	let chromeMajor: string;
	try {
		const version = await Promise.race([
			connection.send("Browser.getVersion", {}, "", START_MS),
			spawnFailed
		]);
		chromeMajor = /(\d+)\.\d+/.exec(text(version, "product"))?.[1] ?? "0";
		connection.on("", "Target.targetCreated", (params) => {
			const info = field(params, "targetInfo");
			if (text(info, "type") !== "page" || text(info, "openerId") === "") return;
			void connection
				.send("Target.closeTarget", { targetId: text(info, "targetId") }, "", CALL_MS)
				.catch(() => undefined);
		});
		await connection.send("Target.setDiscoverTargets", { discover: true }, "", CALL_MS);
	} catch (error) {
		await close();
		throw error;
	}
	const browserCall = (method: string, params: Record<string, unknown>): Promise<unknown> =>
		connection.send(method, params, "", CALL_MS);
	const host: SeoPageHost = async (work) => {
		const context = text(
			await browserCall("Target.createBrowserContext", { disposeOnDetach: true }),
			"browserContextId"
		);
		let sessionId = "";
		try {
			await browserCall("Browser.setDownloadBehavior", {
				behavior: "deny",
				browserContextId: context
			}).catch(() => undefined);
			const targetId = text(
				await browserCall("Target.createTarget", { url: "about:blank", browserContextId: context }),
				"targetId"
			);
			sessionId = text(
				await browserCall("Target.attachToTarget", { targetId, flatten: true }),
				"sessionId"
			);
			if (sessionId === "") throw new Error("The browser opened no page.");
			const own = sessionId;
			const channel: SeoCdpChannel = {
				send: (method, params) => connection.send(method, params ?? {}, own, null),
				on: (event, listener) => {
					connection.on(own, event, listener);
				}
			};
			return await work(channel, chromeMajor);
		} finally {
			if (sessionId !== "") connection.forget(sessionId);
			await browserCall("Target.disposeBrowserContext", { browserContextId: context }).catch(
				() => undefined
			);
		}
	};
	return { render: hostedRenderer(host, fetch), close };
}
