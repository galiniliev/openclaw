export type PrepareRepositoryPublicationCheckpoint = (
  identity: { sessionId: string; sessionKey: string; agentId: string },
  assertCurrent: () => void,
) => Promise<void>;
