export const CLAUDE_COMMAND = process.env.PI_CLAUDE_COMMAND?.trim() || "claude";
export const DEFAULT_BACKEND = process.env.PI_CLAUDE_AGENT_BACKEND?.trim() || "tmux";
export const DEFAULT_TMUX_DISPLAY = process.env.PI_CLAUDE_AGENT_TMUX_DISPLAY?.trim() || "detached";
export const DEFAULT_MODEL = process.env.PI_CLAUDE_AGENT_MODEL?.trim() || undefined;

const timeoutFromEnv = Number(process.env.PI_CLAUDE_AGENT_TIMEOUT_SECONDS);

export const DEFAULT_TIMEOUT_SECONDS = Number.isFinite(timeoutFromEnv) ? timeoutFromEnv : 300;
export const MAX_TIMEOUT_SECONDS = 1800;
export const MAX_OUTPUT_BYTES = 32_000;
export const MAX_OUTPUT_LINES = 800;
export const TMUX_READY_TIMEOUT_MS = 30_000;
export const TMUX_POLL_INTERVAL_MS = 500;
export const TMUX_CAPTURE_LINES = 160;
export const TMUX_MAX_BUFFER = 2 * 1024 * 1024;

export const AGENT_APPEND_SYSTEM_PROMPT = `You are running as a delegated Claude Code agent launched from Pi.
Complete the delegated task directly. Return a concise final answer for the caller.`;
