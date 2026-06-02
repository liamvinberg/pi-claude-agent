import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { TMUX_CAPTURE_LINES, TMUX_MAX_BUFFER } from "./config";
import type { ClaudeAgentDetails } from "./types";

const execFileAsync = promisify(execFile);

export interface VisiblePane {
	paneId: string;
	sessionName: string;
	splitDirection: string;
}

export async function tmux(args: string[], signal?: AbortSignal): Promise<string> {
	try {
		const { stdout } = await execFileAsync("tmux", args, {
			encoding: "utf8",
			maxBuffer: TMUX_MAX_BUFFER,
			signal,
		});
		return stdout;
	} catch (error) {
		if (isMissingCommandError(error)) {
			throw new Error('backend="tmux" requires tmux to be installed. Install tmux or set backend="print".');
		}
		throw error;
	}
}

function isMissingCommandError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export async function createVisibleTmuxPane(
	cwd: string,
	startScriptPath: string,
	signal?: AbortSignal,
): Promise<VisiblePane> {
	if (!process.env.TMUX) {
		throw new Error(
			'tmux_display="pane" requires Pi to be running inside tmux. Use tmux_display="detached" instead.',
		);
	}

	const current = (
		await tmux(["display-message", "-p", "#{session_name}\t#{pane_id}\t#{pane_width}\t#{pane_height}"], signal)
	).trim();
	const [sessionName, currentPaneId, widthText, heightText] = current.split("\t");
	const width = Number(widthText) || 0;
	const height = Number(heightText) || 0;
	const split = chooseTmuxSplit(width, height);
	const targetPane = currentPaneId || undefined;
	if (!targetPane) throw new Error("Could not detect current tmux pane id.");

	const paneId = (
		await tmux(
			["split-window", "-d", split.flag, "-P", "-F", "#{pane_id}", "-t", targetPane, "-c", cwd, startScriptPath],
			signal,
		)
	).trim();

	if (!paneId) throw new Error("tmux split-window did not return a pane id");
	return { paneId, sessionName: sessionName || "unknown", splitDirection: split.label };
}

export function chooseTmuxSplit(width: number, height: number): { flag: "-h" | "-v"; label: string } {
	if (width >= Math.max(120, height * 3)) return { flag: "-h", label: "side-by-side" };
	return { flag: "-v", label: "top-bottom" };
}

export async function closeTmuxTarget(
	details: ClaudeAgentDetails,
	detachedSessionName: string,
	signal?: AbortSignal,
): Promise<void> {
	if (details.tmuxDisplay === "pane") {
		if (details.tmuxPaneId) await tmux(["kill-pane", "-t", details.tmuxPaneId], signal).catch(() => undefined);
		return;
	}
	await killTmuxSession(detachedSessionName, signal);
}

export async function sendTmuxText(paneId: string | undefined, text: string, signal?: AbortSignal): Promise<void> {
	if (!paneId) throw new Error("missing tmux pane id");
	const bufferName = `pi-claude-${randomBytes(6).toString("hex")}`;
	await tmux(["set-buffer", "-b", bufferName, "--", text], signal);
	await tmux(["paste-buffer", "-d", "-b", bufferName, "-t", paneId], signal);
	await tmux(["send-keys", "-t", paneId, "Enter"], signal);
}

export async function captureTmuxPane(
	paneId: string | undefined,
	lines: number,
	signal?: AbortSignal,
): Promise<string> {
	if (!paneId) return "";
	return tmux(["capture-pane", "-p", "-J", "-S", `-${lines}`, "-E", "-", "-t", paneId], signal);
}

export async function writeTmuxCapture(
	paneId: string | undefined,
	filePath: string,
	signal?: AbortSignal,
): Promise<void> {
	const capture = await captureTmuxPane(paneId, TMUX_CAPTURE_LINES, signal);
	await writeFile(filePath, capture, "utf8");
}

export async function killTmuxSession(sessionName: string, signal?: AbortSignal): Promise<void> {
	await tmux(["kill-session", "-t", sessionName], signal).catch(() => undefined);
}
