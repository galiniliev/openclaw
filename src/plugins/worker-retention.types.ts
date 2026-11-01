/** Session-owned disk retention never grants execution or replaces live placement authority. */
export type WorkerDiskRetentionPolicy = {
  mode: "session-disk";
  computeWindowSeconds: number;
};

export type WorkerRetainedLeaseIdentity = {
  leaseId: string;
  attemptLeaseId: string;
  slug: string;
  resourceId: string;
};

export type WorkerRetainedLeaseReceipt = {
  schema: string;
  mode: "session-disk";
  ownerBinding: string;
  identity: WorkerRetainedLeaseIdentity;
  claimRevision: string;
  computeWindowSeconds: number;
  desiredState: "running" | "suspended" | "retired";
  operation?: {
    id: string;
    action: "pause" | "resume";
    phase: "pending" | "observed";
    expectedClaimRevision: string;
  };
  computeWindow: {
    id: string;
    authorizedAt: string;
    expiresAt: string;
    state: "active" | "closed";
  };
  policyVerified: boolean;
  observedState: string;
  stopPending: boolean;
};

export type WorkerSessionDiskRetention = {
  policy: WorkerDiskRetentionPolicy;
  owner: { sessionId: string; sessionKey: string; agentId: string };
  ownerBinding: string;
  desiredState: "running" | "suspended";
  receipt: WorkerRetainedLeaseReceipt | null;
  operation: {
    id: string;
    action: "pause" | "resume";
    expectedClaimRevision: string;
  } | null;
};
