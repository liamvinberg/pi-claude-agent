export type ClaudeAgentBackend = "print" | "tmux";
export type ClaudeTmuxDisplay = "detached" | "pane";
export type ClaudeSandboxMode = "read-only" | "default";

export type ClaudePermissionMode = "default" | "bypassPermissions" | "plan" | "acceptEdits" | "dontAsk" | "auto";

export interface ClaudeAgentParams {
	task: string;
	backend?: string;
	cwd?: string;
	model?: string;
	effort?: string;
	resume_session_id?: string;
	permission_mode?: string;
	tools?: string;
	allowed_tools?: string[];
	mcp_config?: string;
	strict_mcp_config?: boolean;
	system_prompt?: string;
	append_system_prompt?: string;
	timeout_seconds?: number;
	max_budget_usd?: number;
	output_dir?: string;
	sandbox_mode?: string;
	tmux_display?: string;
	tmux_session_name?: string;
	autoclose?: boolean;
}

export interface ClaudeUsage {
	inputTokens: number;
	outputTokens: number;
	cacheReadInputTokens: number;
	cacheCreationInputTokens: number;
	costUsd: number;
}

export interface ClaudeToolCall {
	name: string;
	inputPreview?: string | undefined;
}

export interface ClaudeAgentDetails {
	backend: "claude-code";
	transport: ClaudeAgentBackend;
	command: string;
	cwd: string;
	model: string;
	effort?: string | undefined;
	resumed: boolean;
	sessionId?: string | undefined;
	tools: string;
	allowedTools: string[];
	mcpConfig: "inherited" | "custom";
	permissionMode: ClaudePermissionMode;
	status: "running" | "done" | "error";
	durationMs?: number | undefined;
	usage?: ClaudeUsage | undefined;
	stopReason?: string | undefined;
	permissionDenials?: unknown[] | undefined;
	toolCalls: ClaudeToolCall[];
	truncated?: boolean | undefined;
	stderr?: string | undefined;
	exitCode?: number | null | undefined;
	killed?: boolean | undefined;
	artifactDir?: string | undefined;
	artifactFiles?: string[] | undefined;
	sandboxMode?: ClaudeSandboxMode | undefined;
	tmuxSession?: string | undefined;
	tmuxPaneId?: string | undefined;
	tmuxAttachCommand?: string | undefined;
	tmuxSelectCommand?: string | undefined;
	tmuxKeptAlive?: boolean | undefined;
	tmuxDisplay?: ClaudeTmuxDisplay | undefined;
	tmuxSplitDirection?: string | undefined;
	tmuxAutoclose?: boolean | undefined;
	settingsPath?: string | undefined;
}

export interface ToolRunResult {
	text: string;
	details: ClaudeAgentDetails;
	isError?: boolean | undefined;
}

export interface ToolUpdate {
	content: Array<{ type: "text"; text: string }>;
	details: ClaudeAgentDetails;
}

export type ToolUpdateHandler = (partial: ToolUpdate) => void;

export type JsonRecord = Record<string, unknown>;
