import { html, type TemplateResult } from "lit";
import type { ApplicationContext } from "../../app/context.ts";
import { readGatewayOperatorAccess } from "../../app/operator-access.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import "./memory-sharing.ts";

const MEMORY_SHARING_METHODS = [
  "memory.sharing.status",
  "memory.sharing.projection.target.register",
  "memory.sharing.projection.preview",
  "memory.sharing.projection.create",
  "memory.sharing.projection.refresh",
  "memory.sharing.projection.revoke",
  "memory.sharing.projection.impact",
  "memory.sharing.postbox.mode.set",
  "memory.sharing.postbox.inspect",
  "memory.sharing.postbox.review",
  "memory.sharing.postbox.purge",
] as const;

type GatewaySnapshot = ApplicationContext["gateway"]["snapshot"];

/** Hide the sharing controls until this Gateway advertises the complete profile-derived contract. */
export function renderMemorySharingHost(
  gateway: GatewaySnapshot,
  agentId: string | null,
): TemplateResult {
  const methodsAvailable = MEMORY_SHARING_METHODS.every(
    (method) => isGatewayMethodAdvertised(gateway, method) === true,
  );
  return html`
    <openclaw-memory-sharing
      .client=${gateway.client}
      .connected=${gateway.phase === "connected"}
      .canAdmin=${readGatewayOperatorAccess(gateway).canAdmin}
      .methodsAvailable=${methodsAvailable}
      .agentId=${agentId}
    ></openclaw-memory-sharing>
  `;
}
