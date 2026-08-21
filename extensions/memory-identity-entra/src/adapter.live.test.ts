import { describe, it } from "vitest";
import {
  isEnterpriseIdentityLiveTestEnabled,
  readLiveEnterpriseIdentityToken,
  requireLiveEnterpriseEnv,
  verifyLiveEnterpriseIdentityProvider,
} from "../../../test/helpers/enterprise-identity-live.js";
import { createEntraEnterpriseIdentityProvider } from "./adapter.js";

const describeLive = isEnterpriseIdentityLiveTestEnabled() ? describe : describe.skip;

describeLive("Entra enterprise identity live", () => {
  it("matches Microsoft discovery and verifies a fresh signed role snapshot when supplied", async () => {
    const roleGroupId = requireLiveEnterpriseEnv("OPENCLAW_LIVE_MEMORY_ENTRA_ROLE_GROUP_ID");
    const adapter = createEntraEnterpriseIdentityProvider({
      tenantId: requireLiveEnterpriseEnv("OPENCLAW_LIVE_MEMORY_ENTRA_TENANT_ID"),
      clientId: requireLiveEnterpriseEnv("OPENCLAW_LIVE_MEMORY_ENTRA_CLIENT_ID"),
      clientSecret: "live-proof-does-not-redeem-a-code",
      redirectUri: "https://gateway.example/memory/oidc/callback",
      roleGroupIds: [roleGroupId],
    });
    await verifyLiveEnterpriseIdentityProvider({
      adapter,
      token: readLiveEnterpriseIdentityToken("OPENCLAW_LIVE_MEMORY_ENTRA"),
      expectedRoleGroup: roleGroupId,
    });
  }, 30_000);
});
