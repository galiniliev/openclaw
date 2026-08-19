/** CLI option shape shared by doctor command entrypoints and prompt helpers. */
export type DoctorOptions = {
  workspaceSuggestions?: boolean;
  yes?: boolean;
  nonInteractive?: boolean;
  deep?: boolean;
  repair?: boolean;
  force?: boolean;
  generateGatewayToken?: boolean;
  allowExec?: boolean;
  postUpgrade?: boolean;
  memoryIsolation?:
    | "status"
    | "shadow-read-only"
    | "legacy"
    | "dry-run"
    | "cutover"
    | "rollback"
    | "archive"
    | "export";
  memoryIsolationAgent?: string;
  memoryIsolationPlan?: string;
  memoryIsolationDecisions?: string;
  memoryIsolationExport?: string;
  stateSqlite?: "compact";
  sessionSqlite?: "dry-run" | "import" | "validate" | "inspect" | "compact" | "restore" | "recover";
  sessionSqliteStore?: string;
  sessionSqliteAgent?: string;
  sessionSqliteAllAgents?: boolean;
  sessionSqliteGithubIssue?: boolean;
  json?: boolean;
};
