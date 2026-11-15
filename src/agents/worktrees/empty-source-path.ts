import path from "node:path";
import { resolveStateDir } from "../../config/state-dir.js";

export function resolveEmptyWorktreeSourceParent(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), "worktree-sources", "empty");
}

/** Presentation-only classification; Git/source authority remains with empty-source. */
export function isEmptyWorktreeSourcePath(
  folder: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const relative = path.relative(resolveEmptyWorktreeSourceParent(env), folder);
  return /^[a-f0-9]{64}[/\\]workspace$/u.test(relative);
}
