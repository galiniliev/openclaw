import type { OpenClawConfig } from "../../config/config.js";
import type { WorktreeCleanupOwnerPolicy } from "./gc-removal.js";
import type { ExactStateRetirement } from "./snapshot-exact-state-contract.js";
import type {
  CreateManagedWorktreeParams,
  WorktreeWorkerAuthority,
  ManagedWorktreeRunEndCleanup,
  ManagedWorktreeGcResult,
} from "./types.js";

export type ServiceOptions = {
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  getConfig?: () => OpenClawConfig;
};

export type ManagedWorktreeGcParams = WorktreeCleanupOwnerPolicy &
  WorktreeMutationGuard & {
    checkpoint?: (progress: ManagedWorktreeGcResult) => Promise<void>;
  };

export type WorktreeMutationGuard = Pick<CreateManagedWorktreeParams, "signal" | "commitGuard"> & {
  workerAuthority?: WorktreeWorkerAuthority;
};

export type RemoveWorktreeParams = WorktreeMutationGuard & {
  id: string;
  reason: string;
  allowSnapshotLoss?: boolean;
  /** Explicit owner-fenced detached retirement; never combined with force or clean-only removal. */
  exactState?: ExactStateRetirement;
  requireLossless?: boolean;
  inspectedHead?: string;
  claimToken?: string;
  rollbackGuard?: () => void;
  runEndCleanup?: ManagedWorktreeRunEndCleanup;
};
export type MaterializedRepositoryWorktree = {
  name: string;
  worktreePath: string;
  branch: string;
  recordBase: string;
  provisionedBytes: number;
  setupBytes: number;
  runRepositorySetup: boolean;
};
