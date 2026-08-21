import { describe, it } from "vitest";
import {
  isEnterpriseIdentityLiveTestEnabled,
  readLiveEnterpriseIdentityToken,
  requireLiveEnterpriseEnv,
  verifyLiveEnterpriseIdentityProvider,
} from "../../../test/helpers/enterprise-identity-live.js";
import { createOktaEnterpriseIdentityProvider } from "./adapter.js";

const describeLive = isEnterpriseIdentityLiveTestEnabled() ? describe : describe.skip;

describeLive("Okta enterprise identity live", () => {
  it("matches Okta discovery and verifies a fresh signed role snapshot when supplied", async () => {
    const roleGroupId = requireLiveEnterpriseEnv("OPENCLAW_LIVE_MEMORY_OKTA_ROLE_GROUP_ID");
    const adapter = createOktaEnterpriseIdentityProvider({
      issuer: requireLiveEnterpriseEnv("OPENCLAW_LIVE_MEMORY_OKTA_ISSUER"),
      clientId: requireLiveEnterpriseEnv("OPENCLAW_LIVE_MEMORY_OKTA_CLIENT_ID"),
      clientSecret: "live-proof-does-not-redeem-a-code",
      redirectUri: "https://gateway.example/memory/oidc/callback",
      groupIdsClaim: requireLiveEnterpriseEnv("OPENCLAW_LIVE_MEMORY_OKTA_GROUP_IDS_CLAIM"),
      roleGroupIds: [roleGroupId],
    });
    await verifyLiveEnterpriseIdentityProvider({
      adapter,
      token: readLiveEnterpriseIdentityToken("OPENCLAW_LIVE_MEMORY_OKTA"),
      expectedRoleGroup: roleGroupId,
    });
  }, 30_000);
});
