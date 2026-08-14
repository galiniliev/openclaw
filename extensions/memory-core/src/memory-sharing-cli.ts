import type { Command } from "commander";
import {
  addGatewayClientOptions,
  callGatewayFromCli,
  type GatewayRpcOpts,
} from "openclaw/plugin-sdk/gateway-runtime";

type SharingCliOptions = GatewayRpcOpts & {
  agent: string;
  itemId?: string;
  projectionId?: string;
  sourceRevisionId?: string;
  storeId?: string;
  targetKind?: string;
  targetId?: string;
  purpose?: string;
  preview?: string;
  content?: string;
  reviewedContent?: string;
  expiresAt?: string;
  expiryAuditReason?: string;
  mode?: string;
  decision?: string;
};

const ADMIN_SCOPE = ["operator.admin"] as const;

function requireOption(value: string | undefined, option: string): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new Error(`${option} is required.`);
  }
  return normalized;
}

function requireProjectionTargetKind(value: string | undefined): "conversation" | "role" | "agent-shared" {
  const kind = requireOption(value, "--target-kind");
  if (kind !== "conversation" && kind !== "role" && kind !== "agent-shared") {
    throw new Error("--target-kind must be conversation, role, or agent-shared.");
  }
  return kind;
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function addGatewayOptions(command: Command): Command {
  return addGatewayClientOptions(command)
    .requiredOption("--agent <id>", "Agent id")
    .option("--json", "Print JSON", false);
}

function registerGatewayAction(
  command: Command,
  method: string,
  params: (options: SharingCliOptions) => Record<string, unknown>,
): void {
  command.action(async (options: SharingCliOptions) => {
    const result = await callGatewayFromCli(
      method,
      options,
      { agentId: requireOption(options.agent, "--agent"), ...params(options) },
      { scopes: [...ADMIN_SCOPE] },
    );
    print(result);
  });
}

function projectionParams(options: SharingCliOptions, options2: { content: boolean }) {
  const expiresAt = options.expiresAt?.trim();
  // Commander reserves a `--no-*` option as a negation and removes the prefix
  // from its attribute name, even when the option takes a required value.
  const noExpiryAuditReason = options.expiryAuditReason?.trim();
  if ((expiresAt ? 1 : 0) + (noExpiryAuditReason ? 1 : 0) !== 1) {
    throw new Error("provide exactly one of --expires-at or --no-expiry-audit-reason.");
  }
  return {
    sourceRevisionId: requireOption(options.sourceRevisionId, "--source-revision-id"),
    purpose: requireOption(options.purpose, "--purpose"),
    preview: requireOption(options.preview, "--preview"),
    ...(options2.content ? { content: requireOption(options.content, "--content") } : {}),
    ...(expiresAt ? { expiresAt } : { noExpiryAuditReason }),
  };
}

/** Gateway-only operator client for explicit sharing and quarantined postbox review. */
export function registerMemorySharingCli(memory: Command): void {
  const sharing = memory
    .command("sharing")
    .description("Review explicit memory projections and quarantined postbox items");
  const projection = sharing.command("projection").description("Manage reviewed projection copies");
  const postbox = sharing.command("postbox").description("Review quarantined postbox items");

  registerGatewayAction(
    addGatewayOptions(sharing.command("status").description("Show redacted sharing status")),
    "memory.sharing.status",
    () => ({}),
  );
  registerGatewayAction(
    addGatewayOptions(
      projection
        .command("target-register")
        .description("Register one existing non-private store as a reviewed projection target")
        .requiredOption("--target-kind <kind>", "conversation, role, or agent-shared")
        .requiredOption("--target-id <id>", "Named target audience")
        .requiredOption("--store-id <id>", "Existing store with the same non-private audience"),
    ),
    "memory.sharing.projection.target.register",
    (options) => ({
      targetKind: requireProjectionTargetKind(options.targetKind),
      targetId: requireOption(options.targetId, "--target-id"),
      storeId: requireOption(options.storeId, "--store-id"),
    }),
  );
  registerGatewayAction(
    addGatewayOptions(
      projection
        .command("preview")
        .description("Validate the source and target before creating a reviewed projection")
        .requiredOption("--source-revision-id <id>", "Immutable source revision")
        .requiredOption("--target-kind <kind>", "conversation, role, or agent-shared")
        .requiredOption("--target-id <id>", "Named target audience")
        .requiredOption("--purpose <text>", "Human-readable purpose")
        .requiredOption("--preview <text>", "Human-readable preview")
        .option("--expires-at <timestamp>", "Future ISO timestamp")
        .option("--no-expiry-audit-reason <text>", "Audited reason for no expiry"),
    ),
    "memory.sharing.projection.preview",
    (options) => {
      const params = projectionParams(options, { content: false });
      return {
        ...params,
        targetKind: requireProjectionTargetKind(options.targetKind),
        targetId: requireOption(options.targetId, "--target-id"),
      };
    },
  );
  registerGatewayAction(
    addGatewayOptions(
      projection
        .command("create")
        .description("Create one reviewed projection copy")
        .requiredOption("--source-revision-id <id>", "Immutable source revision")
        .requiredOption("--target-kind <kind>", "conversation, role, or agent-shared")
        .requiredOption("--target-id <id>", "Named target audience")
        .requiredOption("--purpose <text>", "Human-readable purpose")
        .requiredOption("--preview <text>", "Human-readable preview")
        .requiredOption("--content <text>", "Reviewed copy content")
        .option("--expires-at <timestamp>", "Future ISO timestamp")
        .option("--no-expiry-audit-reason <text>", "Audited reason for no expiry"),
    ),
    "memory.sharing.projection.create",
    (options) => ({
      ...projectionParams(options, { content: true }),
      targetKind: requireProjectionTargetKind(options.targetKind),
      targetId: requireOption(options.targetId, "--target-id"),
    }),
  );
  registerGatewayAction(
    addGatewayOptions(
      projection
        .command("refresh")
        .description("Create a new reviewed copy and revoke the replaced projection")
        .requiredOption("--projection-id <id>", "Projection to replace")
        .requiredOption("--source-revision-id <id>", "Immutable source revision")
        .requiredOption("--purpose <text>", "Human-readable purpose")
        .requiredOption("--preview <text>", "Human-readable preview")
        .requiredOption("--content <text>", "Reviewed copy content")
        .option("--expires-at <timestamp>", "Future ISO timestamp")
        .option("--no-expiry-audit-reason <text>", "Audited reason for no expiry"),
    ),
    "memory.sharing.projection.refresh",
    (options) => ({
      ...projectionParams(options, { content: true }),
      projectionId: requireOption(options.projectionId, "--projection-id"),
    }),
  );
  registerGatewayAction(
    addGatewayOptions(
      projection
        .command("revoke")
        .description("Revoke a projection and report prior exposure ids")
        .requiredOption("--projection-id <id>", "Projection id"),
    ),
    "memory.sharing.projection.revoke",
    (options) => ({ projectionId: requireOption(options.projectionId, "--projection-id") }),
  );
  registerGatewayAction(
    addGatewayOptions(
      projection
        .command("impact")
        .description("Show redacted prior exposure ids for one projection")
        .requiredOption("--projection-id <id>", "Projection id"),
    ),
    "memory.sharing.projection.impact",
    (options) => ({ projectionId: requireOption(options.projectionId, "--projection-id") }),
  );

  registerGatewayAction(
    addGatewayOptions(
      postbox
        .command("mode")
        .description("Set postbox mode")
        .requiredOption("--mode <mode>", "off or review-required"),
    ),
    "memory.sharing.postbox.mode.set",
    (options) => ({ mode: requireOption(options.mode, "--mode") }),
  );
  registerGatewayAction(
    addGatewayOptions(
      postbox
        .command("inspect")
        .description("Read one pending postbox item for authorized review")
        .requiredOption("--item-id <id>", "Postbox item id"),
    ),
    "memory.sharing.postbox.inspect",
    (options) => ({ itemId: requireOption(options.itemId, "--item-id") }),
  );
  registerGatewayAction(
    addGatewayOptions(
      postbox
        .command("review")
        .description("Approve an original or edited reviewed copy, or reject one quarantined item")
        .requiredOption("--item-id <id>", "Postbox item id")
        .requiredOption("--decision <decision>", "approve or reject")
        .option("--reviewed-content <text>", "Edited content to promote only on approval"),
    ),
    "memory.sharing.postbox.review",
    (options) => ({
      itemId: requireOption(options.itemId, "--item-id"),
      decision: requireOption(options.decision, "--decision"),
      ...(options.reviewedContent?.trim()
        ? { reviewedContent: options.reviewedContent.trim() }
        : {}),
    }),
  );
  registerGatewayAction(
    addGatewayOptions(
      postbox
        .command("purge")
        .description("Purge a quarantined or reviewed postbox item")
        .requiredOption("--item-id <id>", "Postbox item id"),
    ),
    "memory.sharing.postbox.purge",
    (options) => ({ itemId: requireOption(options.itemId, "--item-id") }),
  );

  sharing.action(() => sharing.outputHelp());
  projection.action(() => projection.outputHelp());
  postbox.action(() => postbox.outputHelp());
}
