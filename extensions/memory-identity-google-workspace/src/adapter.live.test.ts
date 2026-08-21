import { describe, it } from "vitest";
import {
  isEnterpriseIdentityLiveTestEnabled,
  readLiveEnterpriseIdentityToken,
  requireLiveEnterpriseEnv,
  verifyLiveEnterpriseIdentityProvider,
} from "../../../test/helpers/enterprise-identity-live.js";
import { createGoogleWorkspaceEnterpriseIdentityProvider } from "./adapter.js";

const describeLive = isEnterpriseIdentityLiveTestEnabled() ? describe : describe.skip;

describeLive("Google Workspace enterprise identity live", () => {
  it("matches Google discovery and verifies a fresh directory-backed role snapshot when supplied", async () => {
    const token = readLiveEnterpriseIdentityToken("OPENCLAW_LIVE_MEMORY_GOOGLE_WORKSPACE");
    const roleGroupResourceName = requireLiveEnterpriseEnv(
      "OPENCLAW_LIVE_MEMORY_GOOGLE_WORKSPACE_ROLE_GROUP_RESOURCE_NAME",
    );
    const adapter = createGoogleWorkspaceEnterpriseIdentityProvider({
      hostedDomain: requireLiveEnterpriseEnv("OPENCLAW_LIVE_MEMORY_GOOGLE_WORKSPACE_HOSTED_DOMAIN"),
      clientId: requireLiveEnterpriseEnv("OPENCLAW_LIVE_MEMORY_GOOGLE_WORKSPACE_CLIENT_ID"),
      clientSecret: "live-proof-does-not-redeem-a-code",
      redirectUri: "https://gateway.example/memory/oidc/callback",
      delegatedAdminEmail: requireLiveEnterpriseEnv(
        "OPENCLAW_LIVE_MEMORY_GOOGLE_WORKSPACE_DELEGATED_ADMIN_EMAIL",
      ),
      directoryServiceAccount: token
        ? requireLiveEnterpriseEnv("OPENCLAW_LIVE_MEMORY_GOOGLE_WORKSPACE_DIRECTORY_SERVICE_ACCOUNT")
        : undefined,
      roleGroupResourceNames: [roleGroupResourceName],
    });
    await verifyLiveEnterpriseIdentityProvider({
      adapter,
      token,
      expectedRoleGroup: roleGroupResourceName,
    });
  }, 30_000);
});
