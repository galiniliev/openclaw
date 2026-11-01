import { describe, expect, it } from "vitest";
import { requireWorkerProfile } from "../gateway/worker-environments/service-validation.js";
import { isPluginJsonValue } from "../plugins/host-hook-json.js";
import { OpenClawSchema } from "./zod-schema.js";

function cloudProfile(profile: Record<string, unknown>) {
  return { cloudWorkers: { profiles: { development: { provider: "qa-lab", ...profile } } } };
}

describe("OpenClawSchema cloudWorkers config", () => {
  it("uses the scoped worker settings value budget through config and loaded profile validation", () => {
    const settings = {
      setup: "s".repeat(68_034),
      keyRef: { source: "file", provider: "default", id: "/fixture/worker-key" },
    };
    expect(isPluginJsonValue(settings)).toBe(false);
    expect(
      OpenClawSchema.safeParse({
        storage: {
          locations: { fixture: { provider: "filesystem", settings, encryption: "none" } },
        },
      }).success,
    ).toBe(false);
    expect(
      OpenClawSchema.parse(cloudProfile({ settings })).cloudWorkers?.profiles?.development
        ?.settings,
    ).toEqual(settings);
    expect(requireWorkerProfile(settings)).toBe(settings);
  });

  it.each([
    { setup: "s".repeat(128 * 1024 + 1) },
    { setup: "s".repeat(128 * 1024), other: "s".repeat(128 * 1024) },
    { ["k".repeat(64 * 1024 + 1)]: "value" },
    { setup: "s".repeat(68_034), timeout: Infinity },
    { setup: "s".repeat(68_034), keyRef: "plain-private-key" },
  ])("preserves the worker settings boundaries %#", (settings) => {
    expect(OpenClawSchema.safeParse(cloudProfile({ settings })).success).toBe(false);
    expect(() => requireWorkerProfile(settings)).toThrow();
  });

  it.each([{ "github.com/acme/app": " " }, { "github.com/acme": "development" }])(
    "rejects invalid per-project profile mappings %#",
    (projectProfiles) => {
      expect(OpenClawSchema.safeParse({ cloudWorkers: { projectProfiles } }).success).toBe(false);
    },
  );

  it("accepts provider-owned settings with SecretRefs and defaults to bundled installation", () => {
    const settings = {
      host: "worker.example.test",
      port: 22,
      user: "openclaw",
      keyRef: { source: "file", provider: "default", id: "/cloud-workers/development/privateKey" },
    };
    expect(
      OpenClawSchema.parse(cloudProfile({ provider: "static-ssh", settings })).cloudWorkers,
    ).toStrictEqual({
      profiles: { development: { provider: "static-ssh", install: "bundle", settings } },
    });
  });

  it("accepts only a boolean repository setup policy without changing the default", () => {
    expect(
      OpenClawSchema.parse(cloudProfile({})).cloudWorkers?.profiles?.development,
    ).not.toHaveProperty("runSetupScript");
    for (const runSetupScript of [false, true]) {
      expect(
        OpenClawSchema.parse(cloudProfile({ runSetupScript })).cloudWorkers?.profiles?.development
          ?.runSetupScript,
      ).toBe(runSetupScript);
    }
    for (const runSetupScript of ["false", null, {}]) {
      expect(OpenClawSchema.safeParse(cloudProfile({ runSetupScript })).success).toBe(false);
    }
  });

  it("accepts provider-owned secret maps without admitting plaintext", () => {
    const setupSecrets = {
      registry_token: { source: "store", provider: "default", id: "NPM_TOKEN" },
    };
    expect(
      OpenClawSchema.safeParse(cloudProfile({ provider: "crabbox", settings: { setupSecrets } }))
        .success,
    ).toBe(true);
    expect(OpenClawSchema.safeParse(cloudProfile({ settings: { setupSecrets: {} } })).success).toBe(
      true,
    );
    for (const value of [
      "inline",
      { TOKEN: "inline" },
      { TOKEN: { source: "store", provider: "default", id: "bad-id" } },
    ]) {
      expect(
        OpenClawSchema.safeParse(cloudProfile({ settings: { setupSecrets: value } })).success,
      ).toBe(false);
    }
  });

  it("rejects a malformed idle suspend duration", () => {
    expect(OpenClawSchema.safeParse(cloudProfile({ suspendAfter: "-1m" })).success).toBe(false);
  });

  it("rejects non-finite provider settings", () => {
    expect(
      OpenClawSchema.safeParse(cloudProfile({ settings: { timeout: Infinity } })).success,
    ).toBe(false);
  });

  it("rejects nested plaintext provider secrets", () => {
    expect(
      OpenClawSchema.safeParse(cloudProfile({ settings: { auth: { apiKey: "plain-api-key" } } }))
        .success,
    ).toBe(false);
  });
});
