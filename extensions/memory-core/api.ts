// Memory Core API module exposes the plugin public contract.
export type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
export type {
  MemoryEmbeddingProbeResult,
  MemoryProviderStatus,
  MemorySyncProgressUpdate,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";

const HOST_AUTHORIZED_RUNTIME_MAINTENANCE_ERROR =
  "Memory diary maintenance requires host-authorized runtime maintenance access.";

/**
 * @deprecated Workspace-path diary mutation is no longer a public API. Hosts
 * must use the runtime maintenance facade with configured agent authority.
 */
export async function dedupeDreamDiaryEntries(_params: {
  workspaceDir: string;
}): Promise<{ dreamsPath: string; removed: number; kept: number }> {
  throw new Error(HOST_AUTHORIZED_RUNTIME_MAINTENANCE_ERROR);
}

/** @deprecated See {@link dedupeDreamDiaryEntries}. */
export async function writeBackfillDiaryEntries(_params: {
  workspaceDir: string;
  entries: Array<{ isoDay: string; bodyLines: string[]; sourcePath?: string }>;
  preserveExisting?: boolean;
  timezone?: string;
}): Promise<{ dreamsPath: string; written: number; replaced: number }> {
  throw new Error(HOST_AUTHORIZED_RUNTIME_MAINTENANCE_ERROR);
}

/** @deprecated See {@link dedupeDreamDiaryEntries}. */
export async function removeBackfillDiaryEntries(_params: {
  workspaceDir: string;
}): Promise<{ dreamsPath: string; removed: number }> {
  throw new Error(HOST_AUTHORIZED_RUNTIME_MAINTENANCE_ERROR);
}

export { previewGroundedRemMarkdown } from "./src/rem-evidence.js";
export { filterRecallEntriesWithinLookback } from "./src/dreaming-phases.js";
export { previewRemHarness } from "./src/rem-harness.js";
export type { PreviewRemHarnessOptions, PreviewRemHarnessResult } from "./src/rem-harness.js";
export { configureMemoryCoreDreamingState } from "./src/dreaming-state.js";
export { filterMemorySearchHitsBySessionVisibility } from "./src/session-search-visibility.js";
