import { chmod, mkdir, mkdtemp, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TMUX_POLL_INTERVAL_MS, TMUX_READY_TIMEOUT_MS } from "./config";
import type { ClaudeAgentDetails, ClaudeSandboxMode, JsonRecord } from "./types";
import { delay, expandPath, pathExists, shellQuote } from "./utils";

export interface ArtifactPaths {
	dir: string;
	hookScript: string;
	settings: string;
	startScript: string;
	task: string;
	instructions: string;
	ready: string;
	done: string;
	final: string;
	capture: string;
	hookEvents: string;
	hookErrors: string;
	lastAssistantMessage: string;
	notifications: string;
	sessionEnd: string;
	submittedPrompt: string;
}

export async function prepareArtifacts(outputDir: string | undefined, task: string): Promise<ArtifactPaths> {
	const dir = await createArtifactDir(outputDir);
	const paths = artifactPaths(dir);
	await resetArtifactFiles([
		paths.ready,
		paths.done,
		paths.final,
		paths.capture,
		paths.hookEvents,
		paths.hookErrors,
		paths.lastAssistantMessage,
		paths.notifications,
		paths.sessionEnd,
		paths.submittedPrompt,
	]);
	await writeFile(paths.task, task, "utf8");
	return paths;
}

export async function writeArtifactScaffold(
	paths: ArtifactPaths,
	cwd: string,
	sandboxMode: ClaudeSandboxMode,
	command: string,
	args: string[],
): Promise<void> {
	await writeFile(paths.instructions, buildArtifactInstructions(cwd, paths.dir, sandboxMode), "utf8");
	await writeHookScript(paths.hookScript);
	await writeHookSettings(paths.settings, paths.hookScript, paths.dir);
	await writeStartScript(paths.startScript, command, args, cwd);
}

export function artifactFileList(paths: ArtifactPaths): string[] {
	return [paths.task, paths.instructions, paths.final, paths.done, paths.capture, paths.settings];
}

export async function waitForJsonFile(
	filePath: string,
	timeoutMs: number,
	signal: AbortSignal | undefined,
	onPoll?: () => Promise<void>,
): Promise<JsonRecord | undefined> {
	const deadline = Date.now() + timeoutMs;
	let lastPoll = 0;
	while (Date.now() < deadline) {
		if (signal?.aborted) throw new Error("aborted");
		if (await pathExists(filePath)) {
			const text = await readFile(filePath, "utf8");
			const parsed = JSON.parse(text) as unknown;
			return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
				? (parsed as JsonRecord)
				: undefined;
		}
		if (onPoll && Date.now() - lastPoll > 2000) {
			lastPoll = Date.now();
			await onPoll();
		}
		await delay(TMUX_POLL_INTERVAL_MS, signal);
	}
	return undefined;
}

export function readyTimeoutMs(): number {
	return TMUX_READY_TIMEOUT_MS;
}

export function formatArtifactResult(finalText: string, artifactDir: string, details: ClaudeAgentDetails): string {
	const lines = ["Claude tmux agent completed.", `Artifacts: ${artifactDir}`];
	if (details.sessionId) lines.push(`[claude_session_id: ${details.sessionId}]`);
	if (details.tmuxDisplay) {
		lines.push(
			`Tmux display: ${details.tmuxDisplay}${details.tmuxSplitDirection ? ` (${details.tmuxSplitDirection})` : ""}`,
		);
	}
	if (details.tmuxKeptAlive && details.tmuxAttachCommand) lines.push(`Tmux kept alive: ${details.tmuxAttachCommand}`);
	lines.push("", "Final:", finalText.trim() || "(no final output)");
	return lines.join("\n");
}

async function createArtifactDir(outputDir?: string): Promise<string> {
	if (outputDir?.trim()) {
		const dir = expandPath(outputDir.trim());
		await mkdir(dir, { recursive: true });
		return dir;
	}
	return mkdtemp(join(tmpdir(), "pi-claude-agent-"));
}

async function resetArtifactFiles(filePaths: string[]): Promise<void> {
	await Promise.all(filePaths.map((filePath) => unlink(filePath).catch(() => undefined)));
}

function artifactPaths(dir: string): ArtifactPaths {
	return {
		dir,
		hookScript: join(dir, "claude-agent-hook.cjs"),
		settings: join(dir, "claude-settings.json"),
		startScript: join(dir, "start-claude.sh"),
		task: join(dir, "task.md"),
		instructions: join(dir, "instructions.md"),
		ready: join(dir, "ready.json"),
		done: join(dir, "done.json"),
		final: join(dir, "final.md"),
		capture: join(dir, "tmux-capture.txt"),
		hookEvents: join(dir, "hook-events.jsonl"),
		hookErrors: join(dir, "hook-errors.log"),
		lastAssistantMessage: join(dir, "last-assistant-message.md"),
		notifications: join(dir, "notifications.jsonl"),
		sessionEnd: join(dir, "session-end.json"),
		submittedPrompt: join(dir, "submitted-prompt.json"),
	};
}

function buildArtifactInstructions(cwd: string, artifactDir: string, sandboxMode: ClaudeSandboxMode): string {
	return [
		"# Pi delegated Claude worker",
		"",
		`Working directory: ${cwd}`,
		`Artifact directory: ${artifactDir}`,
		`Sandbox mode: ${sandboxMode}`,
		"",
		"Rules:",
		"- Complete the task from task.md directly.",
		"- Keep the final chat answer concise and self-contained.",
		"- Do not mention tmux or hooks unless relevant to a failure.",
		"- In read-only sandbox mode, inspect only; do not attempt edits or shell commands that mutate state.",
		"- Optional artifacts may be written in this directory: notes.md, changed-files.txt, result.json.",
		"- The Stop hook will preserve your final assistant message as final.md.",
	].join("\n");
}

async function writeHookScript(filePath: string): Promise<void> {
	await writeFile(
		filePath,
		`#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const eventName = process.argv[2] || "unknown";
const runDir = process.argv[3];
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  try {
    if (!runDir) throw new Error("missing run dir");
    fs.mkdirSync(runDir, { recursive: true });
    let event = {};
    try { event = input.trim() ? JSON.parse(input) : {}; } catch (error) { event = { parse_error: String(error), raw: input }; }
    const record = { at: new Date().toISOString(), event: eventName, input: event };
    fs.appendFileSync(path.join(runDir, "hook-events.jsonl"), JSON.stringify(record) + "\\n");

    if (eventName === "SessionStart") {
      fs.writeFileSync(path.join(runDir, "ready.json"), JSON.stringify({
        at: record.at,
        session_id: event.session_id,
        transcript_path: event.transcript_path,
        cwd: event.cwd,
        source: event.source,
        model: event.model
      }, null, 2));
    }

    if (eventName === "UserPromptSubmit") {
      fs.writeFileSync(path.join(runDir, "submitted-prompt.json"), JSON.stringify({
        at: record.at,
        session_id: event.session_id,
        prompt: event.prompt
      }, null, 2));
    }

    if (eventName === "Notification") {
      fs.appendFileSync(path.join(runDir, "notifications.jsonl"), JSON.stringify({
        at: record.at,
        session_id: event.session_id,
        notification_type: event.notification_type,
        title: event.title,
        message: event.message
      }) + "\\n");
    }

    if (eventName === "Stop") {
      const finalPath = path.join(runDir, "final.md");
      const lastMessagePath = path.join(runDir, "last-assistant-message.md");
      const message = typeof event.last_assistant_message === "string" ? event.last_assistant_message : "";
      fs.writeFileSync(lastMessagePath, message);
      if (!fs.existsSync(finalPath)) fs.writeFileSync(finalPath, message || "(no final assistant message captured)");
      fs.writeFileSync(path.join(runDir, "done.json"), JSON.stringify({
        at: record.at,
        session_id: event.session_id,
        transcript_path: event.transcript_path,
        cwd: event.cwd,
        stop_hook_active: event.stop_hook_active,
        final_path: finalPath,
        last_assistant_message_path: lastMessagePath
      }, null, 2));
    }

    if (eventName === "SessionEnd") {
      fs.writeFileSync(path.join(runDir, "session-end.json"), JSON.stringify({
        at: record.at,
        session_id: event.session_id,
        reason: event.reason
      }, null, 2));
    }

    process.stdout.write(JSON.stringify({ suppressOutput: true }));
  } catch (error) {
    try { fs.appendFileSync(path.join(runDir || process.cwd(), "hook-errors.log"), String(error) + "\\n"); } catch {}
    process.stdout.write(JSON.stringify({ suppressOutput: true, systemMessage: "pi claude_agent hook error: " + String(error) }));
  }
});
`,
		"utf8",
	);
	await chmod(filePath, 0o700);
}

async function writeHookSettings(settingsPath: string, hookScriptPath: string, artifactDir: string): Promise<void> {
	const hook = (eventName: string, timeout = 5) => ({
		type: "command",
		command: "node",
		args: [hookScriptPath, eventName, artifactDir],
		timeout,
	});
	const settings = {
		hooks: {
			SessionStart: [{ matcher: "startup|resume", hooks: [hook("SessionStart")] }],
			UserPromptSubmit: [{ hooks: [hook("UserPromptSubmit")] }],
			Notification: [{ hooks: [hook("Notification")] }],
			Stop: [{ hooks: [hook("Stop")] }],
			SessionEnd: [{ hooks: [hook("SessionEnd", 2)] }],
		},
	};
	await writeFile(settingsPath, JSON.stringify(settings, null, 2), "utf8");
}

async function writeStartScript(scriptPath: string, command: string, args: string[], cwd: string): Promise<void> {
	const line = [shellQuote(command), ...args.map(shellQuote)].join(" ");
	await writeFile(
		scriptPath,
		`#!/bin/bash
set -euo pipefail
cd ${shellQuote(cwd)}
exec ${line}
`,
		"utf8",
	);
	await chmod(scriptPath, 0o700);
}
