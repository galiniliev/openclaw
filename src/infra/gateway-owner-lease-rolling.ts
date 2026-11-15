import type { GatewayRollingContract } from "../gateway/rolling-release-contract.js";
import type { GatewayOwnerLease, GatewayOwnerLeaseIdentity } from "./gateway-owner-lease.types.js";

/** Execution-owner transfer is distinct from the later positively observed read retirement. */
export function admitGatewayRollingSuccessor(
  observed: GatewayOwnerLeaseIdentity | undefined,
  contract: GatewayRollingContract,
): GatewayOwnerLeaseIdentity {
  if (
    !observed ||
    observed.rollingReturnToOwner !== undefined ||
    !contract.companionGeneration ||
    observed.owner !== contract.predecessorOwner ||
    contract.expiresAtMs <= Date.now() ||
    !observed.rollingHandoff ||
    Object.entries(contract).some(
      ([key, value]) => observed.rollingHandoff?.[key as keyof GatewayRollingContract] !== value,
    )
  ) {
    throw new Error("Exact yielded Gateway rolling execution handoff was not observed");
  }
  return observed;
}

/** The lock's physical custody guards its existing execution-lease operations. */
export function createGatewayRollingLeaseControls(
  ownerLease: GatewayOwnerLease | undefined,
  assertStateOwnerCurrent: () => void,
) {
  const currentOwner = (message = "Gateway execution owner is unavailable") => {
    assertStateOwnerCurrent();
    if (!ownerLease) {
      throw new Error(message);
    }
    return ownerLease;
  };
  return {
    yieldExecutionForRollingHandoff: async (contract: GatewayRollingContract) =>
      currentOwner("Gateway rolling handoff requires the current global owner lease").yieldTo(
        contract,
      ),
    observeRollingExecutionHandoff: async () => currentOwner().observeYield(),
    rebindRollingExecutionHandoff: async (
      previous: GatewayRollingContract,
      candidateBootId: string,
      expectedOwner: string,
    ) => currentOwner().rebindYield(previous, candidateBootId, expectedOwner),
    restoreExecutionAfterRollingHandoff: async () => {
      const owner = currentOwner();
      await owner.restoreYield();
      owner.markListening();
    },
    returnRollingPreparationToPredecessor: async () =>
      currentOwner("Gateway rolling preparation owner is unavailable").returnToPredecessor(),
    commitRollingPreparation: (releaseId: string) =>
      currentOwner("Gateway preparation owner is unavailable").commitPreparation(releaseId),
    gatewayOwnerId: ownerLease?.owner,
  };
}
