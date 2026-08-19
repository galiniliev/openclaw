import fs from "node:fs/promises";
import path from "node:path";
import { closeOpenClawAgentDatabasesForTest } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { completeTestMemoryIsolationCutover } from "../../../../src/test-utils/memory-isolation-cutover.js";
import { prepareCodexAttemptConnection } from "./run-attempt-connection.js";
import { createParams, setupRunAttemptTestHooks, tempDir } from "./run-attempt-test-harness.js";
import { testCodexAppServerBindingStore } from "./session-binding.test-helpers.js";

setupRunAttemptTestHooks();

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
});

function markAgentMemoryCutOver(agentId: string): void {
  completeTestMemoryIsolationCutover({ agentId });
}

describe("Codex memory-isolation boundary", () => {
  it("fails closed before the app-server can receive an unconstrained workspace", async () => {
    const agentId = "codex-project-document-fence";
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(tempDir, "state"));
    markAgentMemoryCutOver(agentId);

    const workspaceDir = path.join(tempDir, "workspace");
    const agentDir = path.join(tempDir, "agent");
    const configTomlPath = path.join(agentDir, "codex-home", "config.toml");
    const legacyMemoryPath = path.join(workspaceDir, "MEMORY.md");
    const legacyMemory = "legacy-memory-must-not-reach-codex";
    const configToml = 'project_doc_fallback_filenames = ["MEMORY.md"]\n';
    await fs.mkdir(path.dirname(configTomlPath), { recursive: true });
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(configTomlPath, configToml, "utf8");
    await fs.writeFile(legacyMemoryPath, legacyMemory, "utf8");

    const params = createParams(path.join(tempDir, "session.jsonl"), workspaceDir, {
      sessionKey: `agent:${agentId}:session-1`,
    });
    params.agentId = agentId;
    params.agentDir = agentDir;

    await expect(
      prepareCodexAttemptConnection({
        params,
        options: { bindingStore: testCodexAppServerBindingStore },
      }),
    ).rejects.toThrow(
      "Codex is unavailable for this memory-isolated agent: use a brokered OpenClaw coding runtime until Codex supports authorized virtual memory views.",
    );
    expect(await fs.readFile(configTomlPath, "utf8")).toBe(configToml);
    expect(await fs.readFile(legacyMemoryPath, "utf8")).toBe(legacyMemory);
  });

  it("refuses a pre-existing app-server that cannot receive the startup fence", async () => {
    const agentId = "codex-project-document-remote-fence";
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(tempDir, "remote-state"));
    markAgentMemoryCutOver(agentId);
    const params = createParams(
      path.join(tempDir, "remote-session.jsonl"),
      path.join(tempDir, "remote-workspace"),
      {
        sessionKey: `agent:${agentId}:session-1`,
      },
    );
    params.agentId = agentId;

    await expect(
      prepareCodexAttemptConnection({
        params,
        options: {
          bindingStore: testCodexAppServerBindingStore,
          pluginConfig: { appServer: { transport: "websocket", url: "ws://127.0.0.1:39175" } },
        },
      }),
    ).rejects.toThrow("Codex is unavailable for this memory-isolated agent");
  });
});
