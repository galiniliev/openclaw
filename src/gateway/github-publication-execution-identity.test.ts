import { describe, expect, it, vi } from "vitest";
import type { PreparedGitHubPublicationIdentity } from "../agents/github-tool-identity.js";

vi.mock("./github-publication-availability.js", () => ({
  matchesCurrentGitHubPublicationIdentity: () => true,
  prepareCurrentGitHubPublicationIdentity: () => {
    throw new Error("Expected the injected credential owner");
  },
}));
import { createGitHubPublicationExecutionIdentity } from "./github-publication-execution-identity.js";

const row = {
  agent_id: "main",
  identity_source: "system-configured",
  identity_profile_id: "app-test",
  identity_account_id: 42,
  identity_login: "test-app[bot]",
};
function credential(
  token: string,
  revoked: string[],
  accountId = 42,
): PreparedGitHubPublicationIdentity {
  return {
    source: "system-configured",
    profileId: "app-test",
    account: { accountId, login: "test-app[bot]", avatarUrl: null },
    env: { GH_TOKEN: token },
    revoke: async () => {
      revoked.push(token);
    },
  };
}

describe("publication credential custody", () => {
  it("revokes a replaced App token and the final token when execution ends", async () => {
    const revoked: string[] = [];
    const identities = [credential("first", revoked), credential("second", revoked)];
    const prepare = vi.fn(async () => identities.shift()!);
    const owner = createGitHubPublicationExecutionIdentity({
      row,
      identity: { prepare, isCurrent: () => true },
      validateAuthority: () => true,
      assertWorkspace: () => {},
    });
    await owner.refreshIdentity();
    await owner.refreshIdentity();
    expect(revoked).toEqual(["first"]);
    await owner[Symbol.asyncDispose]();
    expect(revoked).toEqual(["first", "second"]);
    await expect(owner.refreshIdentity()).rejects.toThrow("authority changed");
    expect(prepare).toHaveBeenCalledTimes(2);
  });

  it("revokes an unadmitted token without replacing the admitted credential", async () => {
    const revoked: string[] = [];
    const identities = [credential("admitted", revoked), credential("wrong-account", revoked, 99)];
    await using owner = createGitHubPublicationExecutionIdentity({
      row,
      identity: { prepare: async () => identities.shift()!, isCurrent: () => true },
      validateAuthority: () => true,
      assertWorkspace: () => {},
    });
    await owner.refreshIdentity();
    await expect(owner.refreshIdentity()).rejects.toThrow("identity changed");
    expect(revoked).toEqual(["wrong-account"]);
    owner.assertCurrent();
    await owner[Symbol.asyncDispose]();
    expect(revoked).toEqual(["wrong-account", "admitted"]);
  });

  it("revokes a grant that finishes after execution disposal", async () => {
    const revoked: string[] = [];
    const grant = Promise.withResolvers<PreparedGitHubPublicationIdentity>();
    const owner = createGitHubPublicationExecutionIdentity({
      row,
      identity: { prepare: () => grant.promise, isCurrent: () => true },
      validateAuthority: () => true,
      assertWorkspace: () => {},
    });
    const refresh = owner.refreshIdentity();
    await owner[Symbol.asyncDispose]();
    grant.resolve(credential("late", revoked));
    await expect(refresh).rejects.toThrow("authority changed");
    expect(revoked).toEqual(["late"]);
  });
});
