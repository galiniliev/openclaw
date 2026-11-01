import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  snapshot: vi.fn(),
  input: vi.fn(),
  anchor: vi.fn(),
  query: vi.fn(),
  bootstrap: vi.fn(),
  reader: vi.fn(),
  version: vi.fn(),
  close: vi.fn(),
  release: vi.fn(),
  acquire: vi.fn(),
  guard: vi.fn(),
  active: false,
  running: false,
}));
// mock-isolation: fixed catalog/config/anchor I/O and native bootstrap boundary;
// the production identity gate, branch selection and custody/close order remain real.
vi.mock("./config-preflight-snapshot.js", () => ({
  readConfigSnapshotForEngineSelection: mocks.snapshot,
}));
vi.mock("../infra/database-engine/context.js", () => ({ getDatabaseEngineInput: mocks.input }));
vi.mock("../infra/database-engine/port-provider.js", () => ({
  withDatabasePortConnection: (_config: unknown, run: (client: unknown) => Promise<unknown>) =>
    run({ query: mocks.query }),
}));
vi.mock("../infra/database-port-recovery.js", () => ({
  assertDatabasePortStartupAllowed: mocks.guard,
}));
vi.mock("../infra/gateway-state-owner.js", () => ({
  acquireStateDatabaseSchemaLease: mocks.acquire,
}));
vi.mock("../snapshot/database-backup.js", () => ({ readBackupEngine: mocks.anchor }));
vi.mock("../state/openclaw-state-db-engine.js", () => ({
  openExistingStatePostgresConnection: mocks.reader,
}));
vi.mock("../state/openclaw-state-db-schema-version.js", () => ({
  readStateSchemaContentVersion: mocks.version,
}));
vi.mock("../state/openclaw-state-db.js", () => ({
  closeOpenClawStateDatabaseAsync: mocks.close,
  withOpenClawStateStartupMigrationCheckpointDatabase: mocks.bootstrap,
}));
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import { prepareDatabaseState } from "./database-prepare-state.js";
const expected = {
  expectedStoreId: "95ef0309-ec44-4812-b6ad-b9540d1947df",
  expectedNamespace: "openclaw_state_95ef0309ec444812",
};
const anchor = {
  engine: "postgres",
  storeId: expected.expectedStoreId,
  namespace: expected.expectedNamespace,
};
beforeEach(() => {
  vi.resetAllMocks();
  mocks.active = false;
  mocks.running = false;
  mocks.snapshot.mockResolvedValue({ valid: true, config: { database: { engine: "postgres" } } });
  mocks.input.mockReturnValue({ schemaPrefix: "openclaw", connection: "private" });
  mocks.anchor.mockReturnValue(anchor);
  mocks.query.mockResolvedValue({ rows: [] });
  mocks.version.mockReturnValue(OPENCLAW_STATE_SCHEMA_VERSION);
  mocks.release.mockImplementation(() => {
    mocks.active = false;
  });
  mocks.acquire.mockImplementation(() => {
    mocks.active = true;
    return {
      assertCurrent() {
        expect(mocks.active).toBe(true);
      },
      run<T>(callback: () => T) {
        mocks.running = true;
        try {
          return callback();
        } finally {
          mocks.running = false;
        }
      },
      release: mocks.release,
    };
  });
  mocks.bootstrap.mockImplementation((callback: () => void) => {
    expect(mocks.running).toBe(true);
    callback();
  });
  mocks.reader.mockImplementation(() => {
    expect(mocks.running).toBe(true);
    return { database: { db: {} }, close: () => true };
  });
  mocks.close.mockImplementation(async () => {
    expect(mocks.active).toBe(true);
  });
});
it("bootstraps an absent matching shared namespace while holding schema-owner custody and validates a ready retry without bootstrap", async () => {
  await expect(prepareDatabaseState(expected)).resolves.toMatchObject({
    ok: true,
    status: "prepared",
    storeId: anchor.storeId,
    namespace: anchor.namespace,
  });
  expect(mocks.bootstrap).toHaveBeenCalledTimes(1);
  expect(Number(mocks.close.mock.invocationCallOrder[0])).toBeLessThan(
    Number(mocks.release.mock.invocationCallOrder[0]),
  );
  mocks.query.mockResolvedValue({ rows: [{ exists: 1 }] });
  await expect(prepareDatabaseState(expected)).resolves.toMatchObject({
    ok: true,
    status: "ready",
  });
  expect(mocks.bootstrap).toHaveBeenCalledTimes(1);
});
it.each(["missing metadata", "mismatched metadata"])(
  "refuses existing %s without writable bootstrap or credential disclosure",
  async (reason) => {
    mocks.query.mockResolvedValue({ rows: [{ exists: 1 }] });
    mocks.reader.mockImplementation(() => {
      const connection = new URL("postgres://example.invalid/db");
      connection.username = "user";
      connection.password = "private";
      throw new Error(`${reason} ${connection}`);
    });
    const error = await prepareDatabaseState(expected).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(`ready-validation failed: ${reason}`);
    expect((error as Error).message).not.toContain("user:private");
    expect(mocks.bootstrap).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledOnce();
  },
);
it.each([{ storeId: "other" }, { namespace: "other" }, { engine: "sqlite" }])(
  "refuses an unexpected anchor before any server/bootstrap call (%j)",
  async (change) => {
    mocks.anchor.mockReturnValue({ ...anchor, ...change });
    await expect(prepareDatabaseState(expected)).rejects.toThrow("anchor does not match");
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.bootstrap).not.toHaveBeenCalled();
  },
);
it("retains ownership when native close cannot be confirmed", async () => {
  mocks.close.mockRejectedValue(new Error("unconfirmed close"));
  await expect(prepareDatabaseState(expected)).rejects.toThrow("ownership remains retained");
  expect(mocks.release).not.toHaveBeenCalled();
});

it("retains the bootstrap phase and nested cause code without changing bootstrap policy", async () => {
  mocks.bootstrap.mockImplementation(() => {
    throw new Error("native open refused", {
      cause: Object.assign(new Error("schema authority unavailable"), { code: "EACCES" }),
    });
  });
  const error = await prepareDatabaseState(expected).catch((failure: unknown) => failure);
  expect(error).toBeInstanceOf(Error);
  for (const detail of [
    "writable-bootstrap failed",
    "native open refused",
    "schema authority unavailable",
    "EACCES",
  ]) {
    expect((error as Error).message).toContain(detail);
  }
  expect(mocks.reader).not.toHaveBeenCalled();
  expect(mocks.release).toHaveBeenCalledOnce();
});
