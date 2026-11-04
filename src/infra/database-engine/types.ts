export type DatabaseEngineInput =
  | Readonly<{
      connection: string;
      schemaPrefix: string;
      /** Host-owned credential source; child exec must not inherit its value. */
      connectionEnvKey?: string;
      /** Runtime-owned standby admission; never enables creation or migrations. */
      readOnly?: true;
      /** Compatible schema admission with future writer handles, before mutable activation. */
      readOnlySchema?: true;
    }>
  | undefined;
export type DatabaseEngineId = "sqlite" | "postgres";
export type DatabaseEngineFamily =
  | "state"
  | "agent"
  | "workboard"
  | "logbook"
  | "team-reports"
  | "quarantine"
  | "managed-update"
  | "package-activation";

export type DatabaseEngineSelection = Readonly<{
  /** Runtime-owned per-operation access; never persisted as database configuration. */
  access?: "read-only" | "writer-preparation" | "read-write";
  effectiveEngines: Readonly<Record<DatabaseEngineFamily, DatabaseEngineId>>;
  postgres?: Exclude<DatabaseEngineInput, undefined>;
}>;
