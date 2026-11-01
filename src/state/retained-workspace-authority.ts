import { z } from "zod";

/** Exact private disk and checkout; never an authorization to replace lost contents. */
export const RetainedWorkspaceAuthority = z
  .object({
    environmentId: z.string().min(1),
    sessionId: z.string().min(1),
    ownerEpoch: z.number().int().positive(),
    ownerBinding: z.string().min(1),
    identity: z
      .object({
        leaseId: z.string().min(1),
        attemptLeaseId: z.string().min(1),
        slug: z.string().min(1),
        resourceId: z.string().min(1),
      })
      .strict(),
    workspaceDir: z.string().min(1),
  })
  .strict();
export type RetainedWorkspaceAuthority = z.infer<typeof RetainedWorkspaceAuthority>;

export function readRetainedWorkspaceAuthority(raw: string): RetainedWorkspaceAuthority {
  return RetainedWorkspaceAuthority.parse(JSON.parse(raw));
}
