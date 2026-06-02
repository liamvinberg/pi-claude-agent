import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
	normalizeBackend,
	normalizeSandboxMode,
	normalizeTmuxDisplay,
	resolvePermissionMode,
	withReadOnlyDefaults,
} from "./claude-options";
import { DEFAULT_MODEL } from "./config";
import type { ClaudeAgentDetails, ClaudeAgentParams, ClaudeUsage } from "./types";
import { formatDuration, summarize } from "./utils";

export function renderCall(args: ClaudeAgentParams, theme: Theme): Text {
	const mode = args.resume_session_id ? "resume" : "new";
	const backend = normalizeBackend(args.backend);
	const sandboxMode = normalizeSandboxMode(args.sandbox_mode);
	const effectiveArgs = withReadOnlyDefaults(args, sandboxMode);
	const tmuxDisplay = normalizeTmuxDisplay(args.tmux_display);
	const model = args.model || DEFAULT_MODEL || "default";
	const mcp = args.mcp_config ? "custom" : "inherited";
	const tools = effectiveArgs.tools || "default";
	const permission = resolvePermissionMode(effectiveArgs, sandboxMode === "read-only" ? "plan" : "default");
	let text = theme.fg("toolTitle", theme.bold("claude_agent"));
	text += theme.fg("muted", ` ${mode}`);
	text += theme.fg("dim", ` · backend=${backend} · model=${model} · tools=${tools} · mcp=${mcp} · perm=${permission}`);
	if (backend === "tmux") text += theme.fg("dim", ` · sandbox=${sandboxMode} · display=${tmuxDisplay}`);
	text += `\n${theme.fg("dim", summarize(args.task || "", 160))}`;
	return new Text(text, 0, 0);
}

export function renderResult(
	result: { content?: Array<{ type: string; text?: string }>; details?: unknown },
	options: { expanded: boolean; isPartial?: boolean },
	theme: Theme,
): Text {
	const details = result.details as ClaudeAgentDetails | undefined;
	const content = result.content?.[0];
	const textContent = content?.type === "text" ? (content.text ?? "") : "";

	if (!details) return new Text(textContent || "(no output)", 0, 0);

	const active = details.status === "running" || options.isPartial;
	const statusColor = details.status === "done" ? "success" : active ? "warning" : "error";
	const icon = details.status === "done" ? "✓" : active ? "…" : "✗";
	let text = theme.fg(statusColor, `${icon} claude_agent`);
	text += theme.fg("dim", ` ${details.transport}`);
	text += theme.fg("dim", ` ${details.resumed ? "resumed" : "new"}`);
	if (details.sessionId) text += theme.fg("muted", ` · ${details.sessionId.slice(0, 8)}`);
	if (details.durationMs !== undefined) text += theme.fg("dim", ` · ${formatDuration(details.durationMs)}`);
	const usage = formatUsage(details.usage);
	if (usage) text += theme.fg("dim", ` · ${usage}`);
	if (details.truncated) text += theme.fg("warning", " · output truncated");

	if (options.expanded) {
		text += `\n${theme.fg("dim", `cwd=${details.cwd}`)}`;
		text += `\n${theme.fg("dim", `model=${details.model} · tools=${details.tools} · mcp=${details.mcpConfig} · perm=${details.permissionMode}`)}`;
		if (details.artifactDir) text += `\n${theme.fg("dim", `artifacts=${details.artifactDir}`)}`;
		if (details.tmuxSession) {
			text += `\n${theme.fg(
				"dim",
				`tmux=${details.tmuxSession}${details.tmuxDisplay ? ` · display=${details.tmuxDisplay}` : ""}${details.tmuxSplitDirection ? ` · split=${details.tmuxSplitDirection}` : ""}${details.tmuxAutoclose !== undefined ? ` · autoclose=${details.tmuxAutoclose}` : ""}${details.tmuxAttachCommand ? ` · ${details.tmuxAttachCommand}` : ""}`,
			)}`;
		}
		if (details.allowedTools.length > 0) text += `\n${theme.fg("dim", `allowed=${details.allowedTools.join(",")}`)}`;
		if (details.toolCalls.length > 0) {
			text += `\n${theme.fg("muted", "tool calls:")}`;
			for (const call of details.toolCalls.slice(-12)) {
				text += `\n${theme.fg("dim", `→ ${call.name}${call.inputPreview ? ` ${call.inputPreview}` : ""}`)}`;
			}
		}
		if (details.stderr) text += `\n${theme.fg("error", summarize(details.stderr, 300))}`;
		if (!options.isPartial && textContent) {
			text += `\n\n${theme.fg("muted", "Returned answer:")}`;
			text += `\n${theme.fg("dim", textContent.split("\n").slice(0, 16).join("\n"))}`;
		}
	} else if (options.isPartial && textContent) {
		text += `\n${theme.fg("dim", summarize(textContent, 180))}`;
	}

	return new Text(text, 0, 0);
}

function formatUsage(usage?: ClaudeUsage): string {
	if (!usage) return "";
	const parts = [];
	if (usage.inputTokens) parts.push(`↑${usage.inputTokens}`);
	if (usage.outputTokens) parts.push(`↓${usage.outputTokens}`);
	if (usage.cacheReadInputTokens) parts.push(`R${usage.cacheReadInputTokens}`);
	if (usage.cacheCreationInputTokens) parts.push(`W${usage.cacheCreationInputTokens}`);
	if (usage.costUsd) parts.push(`$${usage.costUsd.toFixed(4)}`);
	return parts.join(" ");
}
