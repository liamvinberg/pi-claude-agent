import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { JsonRecord } from "./types";

export function clampInteger(value: number, min: number, max: number): number {
	if (!Number.isFinite(value)) return min;
	return Math.min(Math.max(Math.trunc(value), min), max);
}

export function summarize(text: string, maxLength = 120): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	if (normalized.length <= maxLength) return normalized;
	return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

export function formatDuration(durationMs?: number): string {
	if (durationMs === undefined) return "";
	if (durationMs < 1000) return `${durationMs}ms`;
	return `${(durationMs / 1000).toFixed(1)}s`;
}

export function expandPath(input: string): string {
	if (input === "~") return homedir();
	if (input.startsWith("~/")) return `${homedir()}${input.slice(1)}`;
	return input.startsWith("/") ? input : resolve(input);
}

export function unique(values: string[]): string[] {
	return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

export function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "");
}

export function delay(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolveDelay, reject) => {
		if (signal?.aborted) {
			reject(new Error("aborted"));
			return;
		}

		const timeout = setTimeout(done, ms);
		const onAbort = () => {
			clearTimeout(timeout);
			reject(new Error("aborted"));
		};

		function done() {
			signal?.removeEventListener("abort", onAbort);
			resolveDelay();
		}

		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

export async function pathExists(filePath: string): Promise<boolean> {
	try {
		await access(filePath);
		return true;
	} catch {
		return false;
	}
}

export async function readOptionalText(filePath: string): Promise<string> {
	try {
		return await readFile(filePath, "utf8");
	} catch {
		return "";
	}
}

export function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stringField(value: unknown, key: string): string | undefined {
	if (!isRecord(value)) return undefined;
	const field = value[key];
	return typeof field === "string" ? field : undefined;
}

export function numberField(value: unknown, key: string): number | undefined {
	if (!isRecord(value)) return undefined;
	const field = value[key];
	return typeof field === "number" ? field : undefined;
}

export function booleanField(value: unknown, key: string): boolean | undefined {
	if (!isRecord(value)) return undefined;
	const field = value[key];
	return typeof field === "boolean" ? field : undefined;
}
