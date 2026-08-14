import { Command } from "commander";
import type { callGatewayFromCli as CallGatewayFromCli } from "openclaw/plugin-sdk/gateway-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerMemorySharingCli } from "./memory-sharing-cli.js";

const callGatewayFromCli = vi.hoisted(() =>
  vi.fn<typeof CallGatewayFromCli>(async () => ({ ok: true })),
);

vi.mock("openclaw/plugin-sdk/gateway-runtime", () => ({
  addGatewayClientOptions(command: Command) {
    return command
      .option("--url <url>")
      .option("--token <token>")
      .option("--password <password>")
      .option("--timeout <ms>")
      .option("--expect-final");
  },
  callGatewayFromCli,
}));

function createProgram(): Command {
  const program = new Command();
  program.name("test");
  registerMemorySharingCli(program.command("memory"));
  return program;
}

async function run(args: string[]) {
  const program = createProgram();
  await program.parseAsync(["memory", "sharing", ...args], { from: "user" });
}

describe("memory sharing CLI", () => {
  afterEach(() => {
    callGatewayFromCli.mockClear();
    vi.restoreAllMocks();
  });

  it("exposes the complete Gateway-only projection and postbox workflow", () => {
    const memory = createProgram().commands[0];
    const sharing = memory?.commands.find((command) => command.name() === "sharing");
    expect(sharing?.commands.map((command) => command.name())).toEqual([
      "projection",
      "postbox",
      "status",
    ]);
    expect(
      sharing?.commands
        .find((command) => command.name() === "projection")
        ?.commands.map((command) => command.name()),
    ).toEqual(["target-register", "preview", "create", "refresh", "revoke", "impact"]);
    expect(
      sharing?.commands
        .find((command) => command.name() === "postbox")
        ?.commands.map((command) => command.name()),
    ).toEqual(["mode", "inspect", "review", "purge"]);
  });

  it("sends an edited approval only through the profile-authenticated Gateway method", async () => {
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((() => true) as typeof process.stdout.write);
    try {
      await run([
        "postbox",
        "review",
        "--agent",
        "main",
        "--item-id",
        "postbox-1",
        "--decision",
        "approve",
        "--reviewed-content",
        "owner-edited copy",
      ]);
    } finally {
      write.mockRestore();
    }

    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "memory.sharing.postbox.review",
      expect.objectContaining({ agent: "main" }),
      {
        agentId: "main",
        itemId: "postbox-1",
        decision: "approve",
        reviewedContent: "owner-edited copy",
      },
      { scopes: ["operator.admin"] },
    );
    const payload = callGatewayFromCli.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(payload).not.toHaveProperty("principalId");
    expect(payload).not.toHaveProperty("storeId");
    expect(payload).not.toHaveProperty("reviewerPrincipalId");
  });

  it("preserves the required audited no-expiry decision despite Commander no-prefix parsing", async () => {
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((() => true) as typeof process.stdout.write);
    try {
      await run([
        "projection",
        "preview",
        "--agent",
        "main",
        "--source-revision-id",
        "revision-1",
        "--target-kind",
        "conversation",
        "--target-id",
        "conversation-team",
        "--purpose",
        "share",
        "--preview",
        "approved summary",
        "--no-expiry-audit-reason",
        "owner approved durable reference",
      ]);
    } finally {
      write.mockRestore();
    }

    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "memory.sharing.projection.preview",
      expect.objectContaining({ agent: "main" }),
      {
        agentId: "main",
        sourceRevisionId: "revision-1",
        targetKind: "conversation",
        targetId: "conversation-team",
        purpose: "share",
        preview: "approved summary",
        noExpiryAuditReason: "owner approved durable reference",
      },
      { scopes: ["operator.admin"] },
    );
  });

  it("rejects a raw private-user target before making any Gateway request", async () => {
    await expect(
      run([
        "projection",
        "target-register",
        "--agent",
        "main",
        "--target-kind",
        "user",
        "--target-id",
        "principal-bob",
        "--store-id",
        "store-bob",
      ]),
    ).rejects.toThrow("--target-kind must be conversation, role, or agent-shared.");
    expect(callGatewayFromCli).not.toHaveBeenCalled();
  });
});
