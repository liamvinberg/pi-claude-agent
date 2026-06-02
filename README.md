# pi-claude-agent

Pi extension that delegates work to the local Claude Code CLI.

It adds one tool, `claude_agent`, that can run Claude in either:

- `backend: "tmux"` — interactive Claude in a tmux session or pane, with artifacts written to disk.
- `backend: "print"` — `claude --print --output-format stream-json`, streamed back to Pi.

The tmux backend is the main feature: it uses the same working directory as Pi, writes an inspectable artifact directory, and can run hidden or in a visible split pane.

## Install

Prerequisites:

- [Pi](https://pi.dev)
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) available as `claude`
- `tmux` for `backend: "tmux"`

Install from GitHub:

```bash
pi install git:github.com/liamvinberg/pi-claude-agent@v0.1.0
```

For a local checkout:

```bash
pi install /path/to/pi-claude-agent
```

## Usage

Ask Pi to delegate to Claude:

```text
Use claude_agent to inspect this repository and suggest one cleanup.
```

Explicit tmux run:

```json
{
  "backend": "tmux",
  "task": "Inspect this repository and summarize the package structure."
}
```

Watch Claude in a visible tmux split:

```json
{
  "backend": "tmux",
  "tmux_display": "pane",
  "task": "Review the current diff."
}
```

Leave the tmux session or pane open after completion:

```json
{
  "backend": "tmux",
  "tmux_display": "pane",
  "autoclose": false,
  "task": "Investigate this failing test."
}
```

Resume a previous Claude session:

```json
{
  "backend": "tmux",
  "resume_session_id": "00000000-0000-0000-0000-000000000000",
  "task": "Continue from the previous investigation."
}
```

Use a custom MCP config:

```json
{
  "backend": "tmux",
  "mcp_config": "./claude-mcp.json",
  "strict_mcp_config": true,
  "allowed_tools": ["mcp__example__tool"],
  "task": "Use the configured MCP server to answer the question."
}
```

## Options

Common options:

- `task` — delegated task for Claude.
- `backend` — `"tmux"` or `"print"`. Default: `tmux`.
- `cwd` — working directory. Default: Pi's current cwd.
- `model` — Claude model or alias. Omitted by default, so Claude CLI chooses its default.
- `resume_session_id` — Claude session id returned by a prior run.
- `timeout_seconds` — run timeout. Default: `300`.
- `sandbox_mode` — `"read-only"` or `"default"`. Default: `read-only`.
- `permission_mode`, `tools`, `allowed_tools` — forwarded to Claude permission/tool flags.
- `mcp_config`, `strict_mcp_config` — generic Claude MCP config. No MCP profiles are built in.

Tmux options:

- `tmux_display` — `"detached"` or `"pane"`. Default: `detached`.
- `autoclose` — close the tmux target when done. Default: `true`.
- `output_dir` — artifact directory. Default: a temporary `pi-claude-agent-*` directory.
- `tmux_session_name` — optional name for detached sessions.

Environment defaults:

```bash
export PI_CLAUDE_COMMAND=claude
export PI_CLAUDE_AGENT_BACKEND=tmux
export PI_CLAUDE_AGENT_TMUX_DISPLAY=detached
export PI_CLAUDE_AGENT_MODEL=sonnet
export PI_CLAUDE_AGENT_TIMEOUT_SECONDS=600
```

## Artifacts

Tmux runs write files such as:

- `task.md` — delegated task
- `instructions.md` — run instructions for Claude
- `final.md` — final assistant message captured by the Stop hook
- `ready.json`, `done.json` — lifecycle markers
- `hook-events.jsonl` — Claude hook events
- `tmux-capture.txt` — recent tmux pane capture

Pi returns the artifact directory path in the tool result.

## Security

This extension runs your local `claude` CLI with your local Claude credentials and filesystem access. The default `sandbox_mode: "read-only"` limits Claude's built-in tools, but it is not an OS sandbox. Review requested permissions before enabling write tools or bypass permissions.

## License

MIT
