import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { runClaudeAgent } from "./claude";
import { DEFAULT_BACKEND, DEFAULT_MODEL, DEFAULT_TIMEOUT_SECONDS, DEFAULT_TMUX_DISPLAY } from "./config";
import { renderCall, renderResult } from "./render";
import type { ClaudeAgentParams } from "./types";

const Params = Type.Object({
	task: Type.String({ description: "Task for the Claude Code delegate." }),
	backend: Type.Optional(
		Type.String({
			description: `Execution backend: "tmux" (interactive Claude in tmux with artifacts) or "print" (claude --print stream-json). Default: ${DEFAULT_BACKEND}.`,
		}),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for Claude. Default: Pi current cwd." })),
	model: Type.Optional(
		Type.String({ description: `Claude model or alias. Default: ${DEFAULT_MODEL ?? "Claude CLI default"}.` }),
	),
	effort: Type.Optional(
		Type.String({ description: "Optional Claude effort level: low, medium, high, xhigh, or max." }),
	),
	resume_session_id: Type.Optional(
		Type.String({ description: "Claude session id returned by a prior claude_agent call." }),
	),
	permission_mode: Type.Optional(
		Type.String({
			description:
				'Claude --permission-mode value. Supported: "default", "bypass", "bypassPermissions", "plan", "acceptEdits", "dontAsk", "auto".',
		}),
	),
	tools: Type.Optional(
		Type.String({
			description:
				'Claude built-in tool preset or raw --tools value. Presets: "default", "none", "read" (Read/Grep/Glob), "write" (Read/Grep/Glob/Edit/Write).',
		}),
	),
	allowed_tools: Type.Optional(
		Type.Array(Type.String({ description: "Claude tool name or permission pattern to allow." }), {
			description: "Extra permissions passed to --allowedTools.",
		}),
	),
	mcp_config: Type.Optional(
		Type.String({
			description:
				"Custom Claude --mcp-config value as a JSON string or path. Omit to inherit normal Claude MCP config.",
		}),
	),
	strict_mcp_config: Type.Optional(
		Type.Boolean({ description: "Pass --strict-mcp-config when mcp_config is set. Default: false." }),
	),
	system_prompt: Type.Optional(Type.String({ description: "Optional Claude --system-prompt value." })),
	append_system_prompt: Type.Optional(
		Type.String({ description: "Optional extra text appended via --append-system-prompt." }),
	),
	timeout_seconds: Type.Optional(
		Type.Number({ description: `Timeout in seconds. Default: ${DEFAULT_TIMEOUT_SECONDS}.` }),
	),
	max_budget_usd: Type.Optional(
		Type.Number({ description: "Optional Claude --max-budget-usd value for backend=print." }),
	),
	output_dir: Type.Optional(
		Type.String({
			description: "Artifact directory for backend=tmux. If omitted, a temporary directory is created.",
		}),
	),
	sandbox_mode: Type.Optional(
		Type.String({
			description:
				'Tmux/print access preset. "read-only" (default) sets tools=read and permission_mode=plan unless overridden. "default" leaves Claude CLI defaults intact.',
		}),
	),
	tmux_display: Type.Optional(
		Type.String({
			description: `Tmux display for backend=tmux: "detached" (hidden session) or "pane" (visible split in current tmux window). Default: ${DEFAULT_TMUX_DISPLAY}.`,
		}),
	),
	tmux_session_name: Type.Optional(
		Type.String({ description: "Optional detached tmux session name for backend=tmux and tmux_display=detached." }),
	),
	autoclose: Type.Optional(
		Type.Boolean({
			description: "Close the tmux session or pane when done. Default: true. Set false to leave it open.",
		}),
	),
});

export const claudeAgentTool = defineTool({
	name: "claude_agent",
	label: "Claude Agent",
	description:
		"Delegate work to the local Claude Code CLI. The tmux backend runs interactive Claude in the same cwd, records artifacts, and can run hidden or in a visible tmux pane.",
	promptSnippet:
		"Use claude_agent to delegate a task to local Claude Code. Prefer backend=tmux for interactive Claude with artifacts; set tmux_display=pane when the user wants to watch it.",
	promptGuidelines: [
		"Use claude_agent when a separate Claude Code perspective or isolated context is useful.",
		"Use backend=tmux for interactive Claude with inspectable artifacts.",
		"Use tmux_display=pane only when the user wants a visible split. Keep tmux_display=detached for hidden delegation.",
		"Set autoclose=false when the user wants to inspect the tmux pane or session after completion.",
		"Pass a prior [claude_session_id: ...] as resume_session_id when the follow-up should preserve that Claude conversation.",
		"Use mcp_config only for generic Claude MCP configuration; this extension has no built-in MCP profiles.",
	],
	parameters: Params,

	async execute(_toolCallId, params, signal, onUpdate, ctx) {
		const result = await runClaudeAgent(params as ClaudeAgentParams, ctx.cwd, signal, onUpdate);
		return {
			content: [{ type: "text", text: result.text }],
			details: result.details,
			isError: result.isError,
		};
	},

	renderCall(args, theme) {
		return renderCall(args as ClaudeAgentParams, theme);
	},

	renderResult(result, options, theme) {
		return renderResult(result, options, theme);
	},
});
