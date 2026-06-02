import { existsSync } from "node:fs";
import { AGENT_APPEND_SYSTEM_PROMPT, DEFAULT_BACKEND, DEFAULT_MODEL, DEFAULT_TMUX_DISPLAY } from "./config";
import type {
	ClaudeAgentBackend,
	ClaudeAgentParams,
	ClaudePermissionMode,
	ClaudeSandboxMode,
	ClaudeTmuxDisplay,
} from "./types";
import { expandPath, unique } from "./utils";

const TOOL_PRESETS: Record<string, { cliValue: string | undefined; allowedTools: string[]; displayValue: string }> = {
	default: { cliValue: undefined, allowedTools: [], displayValue: "default" },
	none: { cliValue: "", allowedTools: [], displayValue: "none" },
	read: { cliValue: "Read,Grep,Glob", allowedTools: ["Read", "Grep", "Glob"], displayValue: "read" },
	write: {
		cliValue: "Read,Grep,Glob,Edit,Write",
		allowedTools: ["Read", "Grep", "Glob", "Edit", "Write"],
		displayValue: "write",
	},
};

export interface ToolConfig {
	cliValue?: string | undefined;
	displayValue: string;
	allowedTools: string[];
}

export interface McpConfig {
	args: string[];
	label: "inherited" | "custom";
}

export interface ClaudeInvocation {
	args: string[];
	cwd: string;
	model: string;
	effort?: string | undefined;
	tools: string;
	allowedTools: string[];
	mcpConfig: McpConfig["label"];
	permissionMode: ClaudePermissionMode;
}

export function normalizeBackend(value?: string): ClaudeAgentBackend {
	const requested = value?.trim() || DEFAULT_BACKEND;
	if (requested === "print" || requested === "tmux") return requested;
	throw new Error(`Unsupported claude_agent backend: ${requested}. Supported backends: print, tmux.`);
}

export function normalizeTmuxDisplay(value?: string): ClaudeTmuxDisplay {
	const requested = value?.trim() || DEFAULT_TMUX_DISPLAY;
	if (requested === "detached" || requested === "pane") return requested;
	if (requested === "split" || requested === "visible") return "pane";
	throw new Error(`Unsupported claude_agent tmux_display: ${requested}. Supported displays: detached, pane.`);
}

export function normalizeSandboxMode(value?: string): ClaudeSandboxMode {
	const requested = value?.trim() || "read-only";
	if (requested === "read-only" || requested === "default") return requested;
	throw new Error(`Unsupported claude_agent sandbox_mode: ${requested}. Supported modes: read-only, default.`);
}

export function normalizePermissionMode(value?: string): ClaudePermissionMode | undefined {
	const requested = value?.trim();
	if (!requested) return undefined;
	if (requested === "bypass") return "bypassPermissions";
	if (
		requested === "default" ||
		requested === "bypassPermissions" ||
		requested === "plan" ||
		requested === "acceptEdits" ||
		requested === "dontAsk" ||
		requested === "auto"
	) {
		return requested;
	}
	throw new Error(
		`Unsupported permission_mode: ${requested}. Supported: default, bypass, bypassPermissions, plan, acceptEdits, dontAsk, auto.`,
	);
}

export function normalizeTools(tools?: string): ToolConfig {
	const requested = tools?.trim() || "default";
	const preset = TOOL_PRESETS[requested];
	if (preset) return preset;
	return { cliValue: requested, allowedTools: [], displayValue: requested };
}

export function resolveMcpConfig(params: ClaudeAgentParams): McpConfig {
	const config = params.mcp_config?.trim();
	if (!config) return { args: [], label: "inherited" };

	const resolved = resolveMcpConfigValue(config);
	const args = ["--mcp-config", resolved];
	if (params.strict_mcp_config) args.push("--strict-mcp-config");
	return { args, label: "custom" };
}

export function resolveMcpConfigValue(value: string): string {
	const trimmed = value.trim();
	if (trimmed.startsWith("{")) return trimmed;

	const filePath = expandPath(trimmed);
	if (!existsSync(filePath)) throw new Error(`mcp_config path does not exist: ${filePath}`);
	return filePath;
}

export function withReadOnlyDefaults(params: ClaudeAgentParams, sandboxMode: ClaudeSandboxMode): ClaudeAgentParams {
	if (sandboxMode !== "read-only") return params;
	return {
		...params,
		tools: params.tools?.trim() ? params.tools : "read",
		permission_mode: params.permission_mode?.trim() ? params.permission_mode : "plan",
	};
}

export function resolvePermissionMode(params: ClaudeAgentParams, fallback: ClaudePermissionMode): ClaudePermissionMode {
	return normalizePermissionMode(params.permission_mode) ?? fallback;
}

export function buildSystemPromptArgs(params: ClaudeAgentParams): string[] {
	const args: string[] = [];
	const systemPrompt = params.system_prompt?.trim();
	const appendParts = [AGENT_APPEND_SYSTEM_PROMPT, params.append_system_prompt?.trim()].filter(
		(part): part is string => Boolean(part),
	);

	if (systemPrompt) args.push("--system-prompt", systemPrompt);
	if (appendParts.length > 0) args.push("--append-system-prompt", appendParts.join("\n\n"));
	return args;
}

export function buildSharedArgs(
	params: ClaudeAgentParams,
	cwd: string,
	fallbackPermission: ClaudePermissionMode,
): ClaudeInvocation {
	const model = params.model?.trim() || DEFAULT_MODEL;
	const effort = params.effort?.trim() || undefined;
	const toolConfig = normalizeTools(params.tools);
	const mcpConfig = resolveMcpConfig(params);
	const permissionMode = resolvePermissionMode(params, fallbackPermission);
	const allowedTools = unique([...toolConfig.allowedTools, ...(params.allowed_tools ?? [])]);
	const args: string[] = [];

	if (model) args.push("--model", model);
	if (effort) args.push("--effort", effort);
	args.push(...mcpConfig.args);
	if (toolConfig.cliValue !== undefined) args.push("--tools", toolConfig.cliValue);

	if (permissionMode === "bypassPermissions") {
		args.push("--dangerously-skip-permissions");
	} else if (permissionMode !== "default") {
		args.push("--permission-mode", permissionMode);
	}

	if (allowedTools.length > 0) args.push("--allowedTools", allowedTools.join(","));
	args.push(...buildSystemPromptArgs(params));
	if (params.resume_session_id?.trim()) args.push("--resume", params.resume_session_id.trim());

	return {
		args,
		cwd,
		model: model ?? "default",
		effort,
		tools: toolConfig.displayValue,
		allowedTools,
		mcpConfig: mcpConfig.label,
		permissionMode,
	};
}
