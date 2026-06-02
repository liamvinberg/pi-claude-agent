import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { formatSize, truncateTail } from "@earendil-works/pi-coding-agent";
import {
	artifactFileList,
	formatArtifactResult,
	prepareArtifacts,
	readyTimeoutMs,
	waitForJsonFile,
	writeArtifactScaffold,
} from "./artifacts";
import {
	buildSharedArgs,
	normalizeBackend,
	normalizeSandboxMode,
	normalizeTmuxDisplay,
	withReadOnlyDefaults,
} from "./claude-options";
import {
	CLAUDE_COMMAND,
	DEFAULT_TIMEOUT_SECONDS,
	MAX_OUTPUT_BYTES,
	MAX_OUTPUT_LINES,
	MAX_TIMEOUT_SECONDS,
	TMUX_CAPTURE_LINES,
} from "./config";
import { captureTmuxPane, closeTmuxTarget, createVisibleTmuxPane, sendTmuxText, tmux, writeTmuxCapture } from "./tmux";
import type {
	ClaudeAgentDetails,
	ClaudeAgentParams,
	ClaudeToolCall,
	ClaudeUsage,
	JsonRecord,
	ToolRunResult,
	ToolUpdateHandler,
} from "./types";
import {
	booleanField,
	clampInteger,
	expandPath,
	isRecord,
	numberField,
	readOptionalText,
	stringField,
	stripAnsi,
	summarize,
} from "./utils";

export async function runClaudeAgent(
	params: ClaudeAgentParams,
	defaultCwd: string,
	signal: AbortSignal | undefined,
	onUpdate: ToolUpdateHandler | undefined,
): Promise<ToolRunResult> {
	const backend = normalizeBackend(params.backend);
	if (backend === "tmux") return runClaudeAgentTmux(params, defaultCwd, signal, onUpdate);
	return runClaudeAgentPrint(params, defaultCwd, signal, onUpdate);
}

function truncateForParent(text: string): { text: string; truncated: boolean } {
	const truncation = truncateTail(text, {
		maxBytes: MAX_OUTPUT_BYTES,
		maxLines: MAX_OUTPUT_LINES,
	});

	if (!truncation.truncated) return { text: truncation.content, truncated: false };

	const notice = [
		"",
		`[claude_agent output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`,
		`(${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).]`,
	].join(" ");

	return { text: `${truncation.content}${notice}`, truncated: true };
}

function usageFromResult(event: JsonRecord): ClaudeUsage | undefined {
	const modelUsage = event.modelUsage;
	if (isRecord(modelUsage)) {
		const usage: ClaudeUsage = {
			inputTokens: 0,
			outputTokens: 0,
			cacheReadInputTokens: 0,
			cacheCreationInputTokens: 0,
			costUsd: 0,
		};
		for (const value of Object.values(modelUsage)) {
			if (!isRecord(value)) continue;
			usage.inputTokens += numberField(value, "inputTokens") ?? 0;
			usage.outputTokens += numberField(value, "outputTokens") ?? 0;
			usage.cacheReadInputTokens += numberField(value, "cacheReadInputTokens") ?? 0;
			usage.cacheCreationInputTokens += numberField(value, "cacheCreationInputTokens") ?? 0;
			usage.costUsd += numberField(value, "costUSD") ?? 0;
		}
		return usage;
	}

	const rawUsage = event.usage;
	if (!isRecord(rawUsage)) return undefined;
	return {
		inputTokens: numberField(rawUsage, "input_tokens") ?? 0,
		outputTokens: numberField(rawUsage, "output_tokens") ?? 0,
		cacheReadInputTokens: numberField(rawUsage, "cache_read_input_tokens") ?? 0,
		cacheCreationInputTokens: numberField(rawUsage, "cache_creation_input_tokens") ?? 0,
		costUsd: numberField(event, "total_cost_usd") ?? 0,
	};
}

function extractTextFromAssistantMessage(message: unknown): string {
	if (!isRecord(message) || !Array.isArray(message.content)) return "";
	return message.content
		.filter((item): item is JsonRecord => isRecord(item) && item.type === "text" && typeof item.text === "string")
		.map((item) => item.text as string)
		.join("")
		.trim();
}

function extractToolCalls(message: unknown): ClaudeToolCall[] {
	if (!isRecord(message) || !Array.isArray(message.content)) return [];
	return message.content
		.filter((item): item is JsonRecord => isRecord(item) && item.type === "tool_use" && typeof item.name === "string")
		.map((item) => ({
			name: item.name as string,
			inputPreview: item.input ? summarize(JSON.stringify(item.input), 160) : undefined,
		}));
}

function buildPrintArgs(params: ClaudeAgentParams, cwd: string) {
	const sandboxMode = normalizeSandboxMode(params.sandbox_mode);
	const effectiveParams = withReadOnlyDefaults(params, sandboxMode);
	const invocation = buildSharedArgs(effectiveParams, cwd, sandboxMode === "read-only" ? "plan" : "default");
	const args = ["--print", "--verbose", "--output-format", "stream-json", ...invocation.args];
	if (effectiveParams.max_budget_usd !== undefined)
		args.push("--max-budget-usd", String(effectiveParams.max_budget_usd));
	args.push(effectiveParams.task);
	return { ...invocation, args };
}

function buildTmuxArgs(params: ClaudeAgentParams, cwd: string, settingsPath: string, artifactDir: string) {
	const sandboxMode = normalizeSandboxMode(params.sandbox_mode);
	const effectiveParams = withReadOnlyDefaults(params, sandboxMode);
	const invocation = buildSharedArgs(effectiveParams, cwd, sandboxMode === "read-only" ? "plan" : "default");
	const args = ["--settings", settingsPath, "--add-dir", artifactDir, ...invocation.args];
	return { ...invocation, args, sandboxMode };
}

function createRunningDetails(invocation: ReturnType<typeof buildPrintArgs>, resumed: boolean): ClaudeAgentDetails {
	return {
		backend: "claude-code",
		transport: "print",
		command: CLAUDE_COMMAND,
		cwd: invocation.cwd,
		model: invocation.model,
		effort: invocation.effort,
		resumed,
		tools: invocation.tools,
		allowedTools: invocation.allowedTools,
		mcpConfig: invocation.mcpConfig,
		permissionMode: invocation.permissionMode,
		status: "running",
		toolCalls: [],
	};
}

async function runClaudeAgentPrint(
	params: ClaudeAgentParams,
	defaultCwd: string,
	signal: AbortSignal | undefined,
	onUpdate: ToolUpdateHandler | undefined,
): Promise<ToolRunResult> {
	const cwd = params.cwd?.trim() ? expandPath(params.cwd) : defaultCwd;
	const timeoutSeconds = clampInteger(params.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS, 1, MAX_TIMEOUT_SECONDS);
	const invocation = buildPrintArgs(params, cwd);
	const startedAt = Date.now();
	const details = createRunningDetails(invocation, Boolean(params.resume_session_id?.trim()));

	let stderr = "";
	let finalText = "";
	let lastAssistantText = "";
	let wasKilled = false;
	let timedOut = false;
	let claudeReportedError = false;

	const emit = (text: string) => onUpdate?.({ content: [{ type: "text", text }], details: { ...details } });
	emit(`Claude agent running · ${details.resumed ? "resuming" : "new session"} · model=${invocation.model}`);

	const exitCode = await new Promise<number | null>((resolvePromise) => {
		const proc = spawn(CLAUDE_COMMAND, invocation.args, {
			cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdoutBuffer = "";
		let settled = false;
		let killTimer: NodeJS.Timeout | undefined;

		const finish = (code: number | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			if (killTimer) clearTimeout(killTimer);
			if (signal) signal.removeEventListener("abort", abortHandler);
			resolvePromise(code);
		};

		const killProcess = () => {
			wasKilled = true;
			proc.kill("SIGTERM");
			killTimer = setTimeout(() => {
				if (!settled) proc.kill("SIGKILL");
			}, 5000);
		};

		const timeout = setTimeout(() => {
			timedOut = true;
			killProcess();
		}, timeoutSeconds * 1000);

		const abortHandler = () => killProcess();
		if (signal) {
			if (signal.aborted) abortHandler();
			else signal.addEventListener("abort", abortHandler, { once: true });
		}

		const processLine = (line: string) => {
			if (!line.trim()) return;
			let event: unknown;
			try {
				event = JSON.parse(line) as unknown;
			} catch {
				return;
			}
			if (!isRecord(event)) return;

			const sessionId = stringField(event, "session_id");
			if (sessionId && !details.sessionId) details.sessionId = sessionId;

			if (event.type === "system" && event.subtype === "init") {
				const model = stringField(event, "model");
				if (model) details.model = model;
				emit(`Claude agent started · session=${details.sessionId ?? "pending"} · tools=${details.tools}`);
				return;
			}

			if (event.type === "assistant") {
				const message = event.message;
				const text = extractTextFromAssistantMessage(message);
				if (text) {
					lastAssistantText = text;
					emit(summarize(text, 220) || "Claude agent responding...");
				}

				const toolCalls = extractToolCalls(message);
				if (toolCalls.length > 0) {
					details.toolCalls.push(...toolCalls);
					const lastTool = toolCalls[toolCalls.length - 1];
					if (lastTool)
						emit(
							`Claude agent tool · ${lastTool.name}${lastTool.inputPreview ? ` ${lastTool.inputPreview}` : ""}`,
						);
				}
				return;
			}

			if (event.type === "result") {
				details.durationMs = numberField(event, "duration_ms") ?? Date.now() - startedAt;
				details.stopReason = stringField(event, "stop_reason") ?? stringField(event, "terminal_reason");
				const denials = event.permission_denials;
				details.permissionDenials = Array.isArray(denials) ? denials : undefined;
				details.usage = usageFromResult(event);
				claudeReportedError = Boolean(booleanField(event, "is_error") || event.subtype === "error");
				const result = stringField(event, "result");
				if (result) finalText = result;
				const finalSessionId = stringField(event, "session_id");
				if (finalSessionId) details.sessionId = finalSessionId;
			}
		};

		proc.stdout.on("data", (chunk: Buffer) => {
			stdoutBuffer += chunk.toString();
			const lines = stdoutBuffer.split("\n");
			stdoutBuffer = lines.pop() ?? "";
			for (const line of lines) processLine(line);
		});

		proc.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});

		proc.on("error", (error) => {
			stderr += error instanceof Error ? error.message : String(error);
			finish(1);
		});

		proc.on("close", (code) => {
			if (stdoutBuffer.trim()) processLine(stdoutBuffer);
			finish(code);
		});
	});

	details.status = exitCode === 0 && !timedOut && !wasKilled && !claudeReportedError ? "done" : "error";
	details.durationMs ??= Date.now() - startedAt;
	details.stderr = stderr.trim().slice(-4000) || undefined;
	details.exitCode = exitCode;
	details.killed = wasKilled || undefined;

	const rawText = finalText || lastAssistantText || "";
	const sessionFooter = details.sessionId ? `\n\n[claude_session_id: ${details.sessionId}]` : "";
	const output = truncateForParent(`${rawText || "(no output)"}${sessionFooter}`);
	details.truncated = output.truncated;

	if (timedOut)
		return { text: `claude_agent timed out after ${timeoutSeconds}s.${sessionFooter}`, details, isError: true };
	if (wasKilled && signal?.aborted)
		return { text: `claude_agent was aborted.${sessionFooter}`, details, isError: true };

	if (exitCode !== 0 || claudeReportedError) {
		const errorText = details.stderr || rawText || `Claude exited with code ${exitCode}`;
		return { text: `claude_agent failed: ${errorText}${sessionFooter}`, details, isError: true };
	}

	if (details.permissionDenials && details.permissionDenials.length > 0) {
		details.status = "error";
		return {
			text: `${output.text}\n\n[claude_agent warning: Claude reported permission denials. Pass allowed_tools if tool use was expected.]`,
			details,
			isError: true,
		};
	}

	return { text: output.text, details };
}

async function runClaudeAgentTmux(
	params: ClaudeAgentParams,
	defaultCwd: string,
	signal: AbortSignal | undefined,
	onUpdate: ToolUpdateHandler | undefined,
): Promise<ToolRunResult> {
	const cwd = params.cwd?.trim() ? expandPath(params.cwd) : defaultCwd;
	const timeoutSeconds = clampInteger(params.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS, 1, MAX_TIMEOUT_SECONDS);
	const startedAt = Date.now();
	const paths = await prepareArtifacts(params.output_dir, params.task);
	const sessionName = params.tmux_session_name?.trim() || `pi-claude-${randomBytes(5).toString("hex")}`;
	const tmuxDisplay = normalizeTmuxDisplay(params.tmux_display);
	const tmuxAutoclose = params.autoclose !== false;
	const keepTmuxSession = !tmuxAutoclose;
	const invocation = buildTmuxArgs(params, cwd, paths.settings, paths.dir);
	await writeArtifactScaffold(paths, cwd, invocation.sandboxMode, CLAUDE_COMMAND, invocation.args);

	const details: ClaudeAgentDetails = {
		backend: "claude-code",
		transport: "tmux",
		command: CLAUDE_COMMAND,
		cwd,
		model: invocation.model,
		effort: invocation.effort,
		resumed: Boolean(params.resume_session_id?.trim()),
		tools: invocation.tools,
		allowedTools: invocation.allowedTools,
		mcpConfig: invocation.mcpConfig,
		permissionMode: invocation.permissionMode,
		status: "running",
		toolCalls: [],
		artifactDir: paths.dir,
		artifactFiles: artifactFileList(paths),
		sandboxMode: invocation.sandboxMode,
		tmuxSession: sessionName,
		tmuxAttachCommand: tmuxDisplay === "detached" ? `tmux attach -t ${sessionName}` : undefined,
		tmuxKeptAlive: keepTmuxSession,
		tmuxDisplay,
		tmuxAutoclose,
		settingsPath: paths.settings,
	};

	const emit = (text: string) => onUpdate?.({ content: [{ type: "text", text }], details: { ...details } });
	emit(`Claude tmux agent starting · display=${tmuxDisplay} · target=${sessionName} · artifacts=${paths.dir}`);

	let tmuxStarted = false;
	try {
		if (tmuxDisplay === "pane") {
			const pane = await createVisibleTmuxPane(cwd, paths.startScript, signal);
			tmuxStarted = true;
			details.tmuxPaneId = pane.paneId;
			details.tmuxSession = pane.sessionName;
			details.tmuxSplitDirection = pane.splitDirection;
			details.tmuxSelectCommand = `tmux select-pane -t ${pane.paneId}`;
			details.tmuxAttachCommand = details.tmuxSelectCommand;
			emit(`Claude tmux agent launched in visible ${pane.splitDirection} split · pane=${pane.paneId}`);
		} else {
			await tmux(["new-session", "-d", "-s", sessionName, "-c", cwd, paths.startScript], signal);
			tmuxStarted = true;
			details.tmuxPaneId = (
				await tmux(["display-message", "-p", "-t", `${sessionName}:0.0`, "#{pane_id}"], signal)
			).trim();
			emit(`Claude tmux agent launched · attach=${details.tmuxAttachCommand}`);
		}

		const ready = await waitForJsonFile(paths.ready, readyTimeoutMs(), signal, async () => {
			emit("Claude tmux agent waiting for SessionStart hook...");
		});

		if (!ready) {
			await writeTmuxCapture(details.tmuxPaneId, paths.capture, signal);
			details.status = "error";
			details.durationMs = Date.now() - startedAt;
			if (!keepTmuxSession) await closeTmuxTarget(details, sessionName, signal);
			return {
				text: `claude_agent tmux backend did not become ready within ${Math.round(readyTimeoutMs() / 1000)}s. Artifacts: ${paths.dir}. Capture: ${paths.capture}. Attach while running: ${details.tmuxAttachCommand}`,
				details,
				isError: true,
			};
		}

		details.sessionId = stringField(ready, "session_id") ?? details.sessionId;
		emit(`Claude tmux agent ready · session=${details.sessionId ?? "unknown"}`);

		const launchPrompt = [
			`Read and complete the delegated task in ${paths.task}.`,
			`Follow the artifact instructions in ${paths.instructions}.`,
			`Keep the final chat answer concise; the Stop hook will copy it to ${paths.final}.`,
		].join(" ");
		await sendTmuxText(details.tmuxPaneId, launchPrompt, signal);
		emit("Claude tmux agent prompted; waiting for Stop hook...");

		const done = await waitForJsonFile(paths.done, timeoutSeconds * 1000, signal, async () => {
			const capture = await captureTmuxPane(details.tmuxPaneId, TMUX_CAPTURE_LINES, signal).catch(() => "");
			if (capture.trim()) await writeFile(paths.capture, capture, "utf8").catch(() => undefined);
			emit(capture.trim() ? summarize(stripAnsi(capture), 220) : "Claude tmux agent still running...");
		});

		details.durationMs = Date.now() - startedAt;
		if (!done) {
			await writeTmuxCapture(details.tmuxPaneId, paths.capture, signal);
			details.status = "error";
			details.killed = !keepTmuxSession || undefined;
			if (!keepTmuxSession) await closeTmuxTarget(details, sessionName, signal);
			return {
				text: `claude_agent tmux backend timed out after ${timeoutSeconds}s. Artifacts: ${paths.dir}. Capture: ${paths.capture}. ${keepTmuxSession ? `Attach: ${details.tmuxAttachCommand}` : "tmux target was closed"}`,
				details,
				isError: true,
			};
		}

		details.sessionId = stringField(done, "session_id") ?? details.sessionId;
		details.stopReason = "stop_hook";
		await writeTmuxCapture(details.tmuxPaneId, paths.capture, signal);
		const finalText = await readOptionalText(paths.final);
		details.status = "done";

		if (!keepTmuxSession) {
			await closeTmuxTarget(details, sessionName, signal);
			details.tmuxKeptAlive = false;
		}

		const output = truncateForParent(formatArtifactResult(finalText, paths.dir, details));
		details.truncated = output.truncated;
		return { text: output.text, details };
	} catch (error) {
		details.status = "error";
		details.durationMs = Date.now() - startedAt;
		details.stderr = error instanceof Error ? error.message : String(error);
		if (tmuxStarted && details.tmuxPaneId) {
			await writeTmuxCapture(details.tmuxPaneId, paths.capture, undefined).catch(() => undefined);
			if (!keepTmuxSession) await closeTmuxTarget(details, sessionName, undefined).catch(() => undefined);
		}
		return {
			text: `claude_agent tmux backend failed: ${details.stderr}\nArtifacts: ${paths.dir}`,
			details,
			isError: true,
		};
	}
}
