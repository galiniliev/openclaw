// Keep the real worker source/placement/reader owners; fixture only child provisioning and model I/O.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { RepositoryIntegration } from "../../plugins/repository-integration.types.js";
import * as profiles from "../../state/user-profile-list.js";
import { assertRepositoryDispatchAdmission } from "../repository-dispatch.js";
import type { WorkerPlacementDispatchContract } from "./service-contract.js";
import {
  CHILD,
  SOURCE,
  installWorkerSessionToolTestFixture,
  workerSessionToolTestMocks,
} from "./worker-session-tool-executor.test-support.js";
const source = { id: "synthetic-parent-source", expiresAtMs: Date.now() + 300_000 };
export function registerWorkerRepositorySpawnTests(
  mocks: ReturnType<typeof workerSessionToolTestMocks>,
  policy: { current: RepositoryIntegration | undefined },
) {
  afterEach(() => {
    policy.current = undefined;
    vi.restoreAllMocks();
  });
  describe.each(["current", "absent", "revoked", "nonrepository"] as const)(
    "repository worker child (%s)",
    (authority) => {
      const getFixture = installWorkerSessionToolTestFixture(mocks, {
        operatorProfileId:
          authority === "absent" || authority === "nonrepository" ? undefined : "parent-profile",
        repositoryCredentialSource: source,
      });
      it("admits the exact child under its live parent before readiness and sends its task once", async () => {
        vi.spyOn(profiles, "captureResidentUserProfileAccess").mockReturnValue({
          assertCurrent: () => ({
            id: "parent-profile",
            display_name: null,
            avatar_mime: null,
            avatar_sha256: null,
            merged_into: null,
            created_at: 1,
            updated_at: 1,
            role: null,
            has_avatar: 0,
          }),
          readCurrentFacts: () => ({
            profileId: "parent-profile",
            emails: ["github:example.test:42"],
            assignedRole: null,
            githubLogin: null,
          }),
        });
        const fixture = getFixture();
        fixture.setEntry(SOURCE.sessionKey, SOURCE.sessionId);
        const create = mocks.gatewayCreate.getMockImplementation()!;
        mocks.gatewayCreate.mockImplementation(async (...args) => {
          const created = await create(...args);
          const child = mocks.sessionEntries.get(fixture.spawnState.childSessionKey!)!;
          if (authority !== "nonrepository") {
            child.repositoryWorkspaceId = "synthetic-child-repository";
          }
          return created;
        });
        const entered = createDeferred();
        const release = createDeferred();
        const admission = vi.fn();
        const withIdentity: RepositoryIntegration["withIdentity"] = async (context, run) => {
          admission(context.operation);
          context.assertCurrent();
          expect(context.actor).toMatchObject({
            profileId: "parent-profile",
            credentialSource: source,
            authorization: { kind: "admitted-operation" },
          });
          expect(context.operation).toMatchObject({
            purpose: "session-dispatch-project",
            binding: {
              kind: "session-dispatch",
              agentId: CHILD.agentId,
              sessionId: CHILD.sessionId,
              sessionKey: fixture.spawnState.childSessionKey,
            },
          });
          entered.resolve();
          await release.promise;
          context.assertCurrent();
          return run({
            env: {},
            assertCurrent: context.assertCurrent,
            readNativeCredential: async () => undefined,
          });
        };
        policy.current = {
          version: 1,
          preparedCapacity: "image",
          resolveConnectionIdentity: () => undefined,
          withIdentity,
        };
        const provision = mocks.dispatchChild.getMockImplementation()!;
        mocks.dispatchChild.mockImplementation(
          async (...args: Parameters<WorkerPlacementDispatchContract["dispatch"]>) => {
            if (authority !== "nonrepository") {
              assertRepositoryDispatchAdmission(args[0].readNativeCredential);
              await args[0].readNativeCredential!.admit!();
            }
            return provision(...args);
          },
        );
        const pending = fixture.spawn("repo-child-task", "inspect the synthetic repository");
        // Missing admission settles immediately; otherwise pause inside real repository admission.
        await Promise.race([entered.promise, pending]);
        if (authority !== "nonrepository") {
          expect(mocks.gatewayRequest).not.toHaveBeenCalled();
          expect(fixture.placements.get(CHILD.sessionId)).toBeUndefined();
        }
        if (authority === "revoked") {
          fixture.revokeOperatorAuthority();
        }
        release.resolve();
        const result = await pending;
        const replay = await fixture.spawn("repo-child-task", "inspect the synthetic repository");
        expect(mocks.gatewayCreate).toHaveBeenCalledOnce();
        if (authority === "current" || authority === "nonrepository") {
          expect(result.resultJson).toContain('"runStarted":true');
          expect(replay.resultJson).toBe(result.resultJson);
          expect(admission).toHaveBeenCalledTimes(authority === "current" ? 1 : 0);
          expect(fixture.spawnState.order).toEqual(["create", "dispatch", "send"]);
          expect(mocks.gatewayRequest).toHaveBeenCalledOnce();
          expect(mocks.gatewayRequest.mock.calls[0]?.[0].params).toMatchObject({
            sessionId: CHILD.sessionId,
            message: "inspect the synthetic repository",
          });
        } else {
          expect(result.resultJson).toContain("outcome is unknown");
          expect(replay.resultJson).toContain("prior operation outcome is unknown");
          expect(mocks.gatewayRequest).not.toHaveBeenCalled();
          expect(fixture.placements.get(CHILD.sessionId)).toBeUndefined();
          expect(admission).toHaveBeenCalledTimes(authority === "absent" ? 0 : 1);
        }
      });
    },
  );
}
