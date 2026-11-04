import { z } from "zod";
import type { RepositoryWorkspaceRecovery } from "./session-repository-workspaces.types.js";

const commit = z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u);
const manifest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const recoverySchema = z.strictObject({
  reason: z.enum(["missing-checkpoint-artifact", "missing-worker"]),
  atMs: z.number().int().nonnegative(),
  original: z.strictObject({
    revision: z.number().int().nonnegative(),
    baseCommit: commit.nullable(),
    baseManifestHash: manifest.nullable(),
    checkpointRef: z
      .string()
      .regex(/^refs\/openclaw\/worker-results\/[A-Za-z0-9-]+$/u)
      .nullable(),
    manifestHash: manifest.nullable(),
  }),
  sourceCommit: commit,
  source: z.enum(["published-branch", "recorded-base"]),
  unrecoverablePrivateContent: z.literal(true),
});

/** Validate persisted metadata once where the database row enters the owner. */
export function readRepositoryWorkspaceRecovery(raw: string): RepositoryWorkspaceRecovery {
  return recoverySchema.parse(JSON.parse(raw));
}
