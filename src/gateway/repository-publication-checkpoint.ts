export type PrepareRepositoryPublicationCheckpoint = (
  identity: { sessionId: string; sessionKey: string; agentId: string },
  assertCurrent: () => void,
) => Promise<void>;

export type RepositoryPublicationIntegrationInput = {
  readNativeCredential?: import("../agents/github-credential-reader.js").GitHubCredentialReader;
  snapshotRoot: string;
  snapshotDigest: string;
  mainCommit: string;
  sourceUrl: string;
  targetUrl: string;
  token: string;
  assertCurrent: () => void;
};
export type RepositoryPublicationIntegrationResult = {
  knownBlobs: readonly string[];
  snapshotRoot: string;
  snapshot: import("./github-repository-publication-snapshot.js").GitHubRepositoryPublicationSnapshot;
  release: () => Promise<void>;
};
export type PrepareRepositoryPublicationIntegration = (
  identity: { sessionId: string; sessionKey: string; agentId: string },
  input: RepositoryPublicationIntegrationInput,
) => Promise<RepositoryPublicationIntegrationResult>;
