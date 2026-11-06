import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
	CallToolRequestSchema,
	CallToolResultSchema,
	ListToolsRequestSchema,
	ToolSchema
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";

import { API_KEY_HEADER } from "./api.js";
import { CLI_VERSION } from "./version.js";

/**
 * `seostudio mcp`: ONE LOCAL MCP CONNECTOR. It always serves the audit tools that run on this
 * computer (`./audit-tools`), free and with no account. With an API key it also forwards every tool of
 * the hosted SEOStudio MCP server (`<origin>/api/mcp`, the key in its header), so an agent connects
 * once and reaches both. Without a key nothing is forwarded and nothing but the audited sites is ever
 * contacted.
 */

/** One tool this computer serves. */
export interface LocalTool {
	name: string;
	description: string;
	/** The tool's input as JSON Schema. */
	inputSchema: Tool["inputSchema"];
	/** Runs it on validated-as-given arguments. */
	run(args: Record<string, unknown>): Promise<CallToolResult>;
}

/** The hosted tools, reached through the key. */
export interface HostedTools {
	list(): Promise<Tool[]>;
	call(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
}

/**
 * A tool's answer as one text block.
 *
 * @param value - The answer: a string as it is, anything else as JSON.
 * @param isError - Whether it is a refusal.
 * @returns The result.
 */
export function textResult(value: unknown, isError = false): CallToolResult {
	return {
		content: [
			{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }
		],
		...(isError ? { isError: true } : {})
	};
}

/**
 * A hosted tool listing, read leniently: a tool whose input schema leaves out `type: "object"` (a
 * tool with no input) is still served, with the type added, rather than failing the whole list.
 */
const HOSTED_TOOL_LIST = z.looseObject({
	tools: z.array(
		z.looseObject({ name: z.string(), inputSchema: z.record(z.string(), z.unknown()).default({}) })
	),
	nextCursor: z.string().optional()
});

/**
 * The hosted SEOStudio tools behind an API key, over MCP's streamable HTTP transport. It connects on
 * the first use and again after a failure; the key rides in its header only.
 *
 * @param options.origin - The SEOStudio origin.
 * @param options.key - The API key (it needs the MCP permission).
 * @param options.fetch - The transport; the global fetch by default.
 * @returns The hosted tools.
 */
export function hostedTools(options: {
	origin: string;
	key: string;
	fetch?: typeof fetch;
}): HostedTools {
	let client: Promise<Client> | null = null;
	const connect = (): Promise<Client> => {
		client ??= (async () => {
			const transport = new StreamableHTTPClientTransport(new URL(`${options.origin}/api/mcp`), {
				requestInit: { headers: { [API_KEY_HEADER]: options.key } },
				...(options.fetch === undefined ? {} : { fetch: options.fetch })
			});
			const connected = new Client({ name: "seostudio-cli", version: CLI_VERSION });
			await connected.connect(transport);
			return connected;
		})().catch((error: unknown) => {
			client = null;
			throw error;
		});
		return client;
	};
	return {
		async list() {
			const tools: Tool[] = [];
			let cursor: string | undefined;
			do {
				const page = await (await connect()).request(
					{ method: "tools/list", params: cursor === undefined ? {} : { cursor } },
					HOSTED_TOOL_LIST
				);
				for (const raw of page.tools) {
					const tool = ToolSchema.safeParse({
						...raw,
						inputSchema: { ...raw.inputSchema, type: "object" }
					});
					if (tool.success) tools.push(tool.data);
				}
				cursor = page.nextCursor;
			} while (cursor !== undefined);
			return tools;
		},
		async call(name, args) {
			const result = await (await connect()).callTool({ name, arguments: args });
			const parsed = CallToolResultSchema.safeParse(result);
			return parsed.success ? parsed.data : textResult(result.toolResult ?? null);
		}
	};
}

/**
 * The local MCP server: the tools of this computer, then the hosted ones when a key is set. A hosted
 * tool named like a local one is left out. When the hosted server cannot be reached, the local tools
 * still answer and the hosted list is tried again on the next listing.
 *
 * @param options.local - The tools this computer serves.
 * @param options.hosted - The hosted tools, or null without an API key.
 * @param options.warn - Told why the hosted tools are missing (stderr; never the key).
 * @returns The server, ready to connect to a transport.
 */
export function createMcpServer(options: {
	local: readonly LocalTool[];
	hosted: HostedTools | null;
	warn: (line: string) => void;
}): Server {
	const server = new Server(
		{ name: "seostudio", version: CLI_VERSION },
		{
			capabilities: { tools: { listChanged: false } },
			instructions:
				"The local_audit_* tools crawl a website from this computer and read the report, free and with no account. " +
				"Every other tool is the user's SEOStudio account, reached with their API key."
		}
	);
	const localNames = new Set(options.local.map((tool) => tool.name));
	let hostedNames = new Set<string>();
	server.setRequestHandler(ListToolsRequestSchema, async () => {
		const tools: Tool[] = options.local.map((tool) => ({
			name: tool.name,
			description: tool.description,
			inputSchema: tool.inputSchema
		}));
		if (options.hosted !== null) {
			try {
				const hosted = (await options.hosted.list()).filter((tool) => !localNames.has(tool.name));
				hostedNames = new Set(hosted.map((tool) => tool.name));
				tools.push(...hosted);
			} catch (error) {
				options.warn(
					`SEOStudio's tools could not be listed (${error instanceof Error ? error.message : "unknown error"}); serving the local audit tools only.`
				);
			}
		}
		return { tools };
	});
	server.setRequestHandler(CallToolRequestSchema, async (request) => {
		const { name } = request.params;
		const args = request.params.arguments ?? {};
		const local = options.local.find((tool) => tool.name === name);
		if (local !== undefined) {
			try {
				return await local.run(args);
			} catch (error) {
				return textResult(error instanceof Error ? error.message : String(error), true);
			}
		}
		if (options.hosted !== null && (hostedNames.size === 0 || hostedNames.has(name))) {
			try {
				return await options.hosted.call(name, args);
			} catch (error) {
				return textResult(
					`SEOStudio could not run ${name}: ${error instanceof Error ? error.message : String(error)}`,
					true
				);
			}
		}
		return textResult(
			options.hosted === null
				? `Unknown tool ${name}. SEOStudio's account tools need an API key: run \`seostudio login\` or set SEOSTUDIO_API_KEY.`
				: `Unknown tool ${name}.`,
			true
		);
	});
	return server;
}
