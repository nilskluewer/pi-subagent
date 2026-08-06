import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";

export function outputArtifactPath(sessionsDir: string, sessionId: string): string {
	return path.join(sessionsDir, `${sessionId}.output.md`);
}

function isSafeSessionId(sessionId: string): boolean {
	if (!sessionId || sessionId.includes("\0") || sessionId.includes("/") || sessionId.includes("\\")) return false;
	if (path.isAbsolute(sessionId) || sessionId === "." || sessionId === "..") return false;
	return !sessionId.split(/[\\/]/).includes("..");
}

/** Persist the uncapped result payload without exposing a partially written file. */
export async function writeOutputArtifact(
	sessionsDir: string,
	sessionId: string,
	output: string,
): Promise<string | undefined> {
	if (!isSafeSessionId(sessionId) || output.trim().length === 0) return undefined;

	const resolvedSessionsDir = path.resolve(sessionsDir);
	const targetPath = outputArtifactPath(sessionsDir, sessionId);
	const resolvedTargetPath = path.resolve(targetPath);
	if (path.dirname(resolvedTargetPath) !== resolvedSessionsDir) return undefined;

	let tempPath: string | undefined;
	try {
		await fs.promises.mkdir(resolvedSessionsDir, { recursive: true, mode: 0o700 });
		await withFileMutationQueue(resolvedTargetPath, async () => {
			const nextTempPath = path.join(resolvedSessionsDir, `.${sessionId}.output.${crypto.randomUUID()}.tmp`);
			tempPath = nextTempPath;
			await fs.promises.writeFile(nextTempPath, output, { encoding: "utf-8", mode: 0o600, flag: "wx" });
			await fs.promises.chmod(nextTempPath, 0o600);
			await fs.promises.rename(nextTempPath, resolvedTargetPath);
			tempPath = undefined;
		});
		return targetPath;
	} catch {
		return undefined;
	} finally {
		if (tempPath) {
			try {
				await fs.promises.unlink(tempPath);
			} catch {
				/* Ignore cleanup failures after a failed artifact write. */
			}
		}
	}
}
