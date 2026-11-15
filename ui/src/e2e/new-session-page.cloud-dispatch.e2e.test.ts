import { expect, it } from "vitest";
import { createStandardCloudProfile } from "../test-helpers/session-placement.ts";
import {
  WORKSPACE,
  captureUiProof,
  checkoutBaseRefInput,
  createNewSessionPageE2eSuite,
  createdSessionListResult,
  installMockGateway,
  pollLocatorText,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();

suite.define(() => {
  it("creates a registered cloud project from its GitHub source without a Gateway checkout", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { width: 1280, height: 900 } },
      async ({ page }) => {
        const sessionKey = "agent:main:registered-cloud-project";
        const message = "Inspect the registered service on the worker";
        const gateway = await installMockGateway(page, {
          operatorScopes: ["operator.admin", "operator.read", "operator.write"],
          agentModel: "synthetic/synthetic-model",
          models: [{ id: "synthetic-model", provider: "synthetic", name: "Synthetic model" }],
          workspaceGit: true,
          featureMethods: [
            "agent.wait",
            "chat.metadata",
            "chat.startup",
            "sessions.create",
            "sessions.dispatch",
            "environments.list",
            "projects.list",
            "projects.checkoutOptions",
            "worktrees.branches",
          ],
          deferredMethods: ["sessions.dispatch"],
          methodResponses: {
            "agents.list": {
              agents: [{ id: "main", workspace: WORKSPACE, workspaceGit: true }],
              defaultId: "main",
              mainKey: "main",
              scope: "agent",
            },
            "projects.list": {
              githubHost: "ghe.example.test",
              projects: [
                {
                  id: "registered-service",
                  displayName: "Registered service",
                  source: "registered",
                  repoRoot: "/workspace/registered-service",
                  originUrl: "git@ghe.example.test:acme/service.git",
                },
              ],
            },
            "projects.checkoutOptions": { current: true, worktree: true },
            "environments.list": {
              environments: [],
              profiles: [createStandardCloudProfile({ id: "cloud-worker", machines: [] })],
            },
            "worktrees.branches": {
              branches: [
                { kind: "local", name: "main" },
                { kind: "local", name: "unpublished/local-only" },
                { kind: "remote", name: "origin/main" },
                { kind: "remote", name: "origin/release/proof" },
                { kind: "remote", name: "upstream/main" },
              ],
              defaultBranch: "origin/main",
              repositoryStatus: "git",
            },
            "sessions.create": { key: sessionKey },
            "sessions.list": createdSessionListResult(sessionKey),
          },
        });
        await page.goto(`${suite.server.baseUrl}new`);
        await gateway.waitForRequest("projects.list");
        const project = page.locator("#new-session-project-trigger");
        await project.click();
        await page
          .locator('.new-session-page__project-popover [data-value="project:registered-service"]')
          .click();
        await pollLocatorText(project).toContain("Registered service");
        await gateway.waitForRequest("projects.checkoutOptions");

        const where = page.locator("#new-session-where-trigger");
        await where.click();
        await page
          .locator(".new-session-page__where-popover")
          .getByRole("button", { name: "cloud-worker", exact: true })
          .click();
        await expect.poll(() => where.getAttribute("data-cloud-profile")).toBe("cloud-worker");
        await page.keyboard.press("Escape");
        await page.locator("#new-session-checkout-trigger").click();
        const checkout = page.locator(".oc-popover.new-session-page__checkout-popover");
        const from = checkoutBaseRefInput(checkout);
        await from.click();
        await page.getByRole("option", { name: "origin/release/proof", exact: true }).waitFor();
        // Capture the same picker before assertions so a base-head run retains its old appearance.
        await captureUiProof(suite, page, "registered-cloud-source-picker.png", {
          surface: page.locator(".shell"),
          content: [project, where, from],
        });
        expect(await checkout.locator("[data-worktree-name]").count()).toBe(0);
        expect(
          await checkout.locator('[data-value="checkout"], [data-value="worktree"]').count(),
        ).toBe(0);
        expect(
          await page
            .locator("#new-session-worktree-branch-suggestions [role=option]")
            .allTextContents(),
        ).toEqual(["origin/main", "origin/release/proof"]);
        await page.getByRole("option", { name: "origin/release/proof", exact: true }).click();
        await expect.poll(() => from.inputValue()).toBe("origin/release/proof");
        await page.keyboard.press("Escape");
        await page.locator(".new-session-page__message").fill(message);
        await page.getByRole("button", { name: "Start session" }).click();
        const create = await gateway.waitForRequest("sessions.create");
        expect(create.params).toMatchObject({
          agentId: "main",
          message: "",
          repository: { url: "https://ghe.example.test/acme/service.git", ref: "release/proof" },
        });
        for (const field of [
          "projectId",
          "projectGitUrl",
          "cwd",
          "worktree",
          "worktreeSource",
          "worktreeBaseRef",
          "worktreeName",
        ]) {
          expect(create.params).not.toHaveProperty(field);
        }
        const dispatch = await gateway.waitForRequest("sessions.dispatch");
        expect(dispatch.params).toEqual({
          key: sessionKey,
          agentId: "main",
          profileId: "cloud-worker",
        });
        expect(await gateway.getRequests("projects.add")).toHaveLength(0);
        expect(await gateway.getRequests("worktrees.create")).toHaveLength(0);
        await pollLocatorText(page.locator(".chat-thread")).toContain(message);
        await pollLocatorText(
          page.locator('.chat-thread .chat-working-indicator[role="status"]'),
        ).toContain("Provisioning environment…");
        await captureUiProof(suite, page, "registered-cloud-source-provisioning.png");
      },
    );
  });

  it("dispatches an optionless cloud profile without a machine override", async () => {
    await suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
      const sessionKey = "agent:main:optionless-cloud";
      const gateway = await installMockGateway(page, {
        operatorScopes: ["operator.admin", "operator.read", "operator.write"],
        workspaceGit: true,
        deferredMethods: ["sessions.dispatch"],
        methodResponses: {
          "agents.list": {
            agents: [{ id: "main", workspace: WORKSPACE, workspaceGit: true }],
            defaultId: "main",
            mainKey: "main",
            scope: "agent",
          },
          "environments.list": {
            environments: [],
            profiles: [createStandardCloudProfile(), { id: "machine0", providerId: "crabbox" }],
          },
          "worktrees.branches": {
            branches: [{ kind: "local", name: "main" }],
            defaultBranch: "main",
            repositoryStatus: "git",
          },
          "sessions.create": { key: sessionKey },
          "sessions.list": createdSessionListResult(sessionKey),
        },
      });

      await page.goto(`${suite.server.baseUrl}new`);
      await gateway.waitForRequest("environments.list");
      const trigger = page.locator("#new-session-where-trigger");
      const place = page.locator(".oc-popover.new-session-page__where-popover");
      await trigger.click();
      await place.getByRole("button", { name: "aws", exact: true }).click();
      await place.getByRole("button", { name: "Fast", exact: true }).click();
      await expect.poll(() => trigger.getAttribute("data-machine-class")).toBe("fast");
      await place.getByRole("button", { name: "machine0", exact: true }).click();
      await expect.poll(() => trigger.getAttribute("data-cloud-profile")).toBe("machine0");
      await expect.poll(() => trigger.getAttribute("data-machine-class")).toBeNull();
      await expect
        .poll(() => place.getByRole("button", { name: "machine0", exact: true }).isDisabled())
        .toBe(false);
      await expect.poll(() => place.getByText("Machine", { exact: true }).isVisible()).toBe(false);
      await expect.poll(() => place.locator('[data-value^="machine:"]:visible').count()).toBe(0);
      await captureUiProof(suite, page, "optionless-cloud-profile.png");
      await page.keyboard.press("Escape");

      await page.locator(".new-session-page__message").fill("Use the configured machine size");
      await page.getByRole("button", { name: "Start session" }).click();
      const dispatch = await gateway.waitForRequest("sessions.dispatch");
      expect(dispatch.params).toEqual({ key: sessionKey, agentId: "main", profileId: "machine0" });
      await pollLocatorText(page.locator(".chat-thread")).toContain(
        "Use the configured machine size",
      );
      await pollLocatorText(
        page.locator('.chat-thread .chat-working-indicator[role="status"]'),
      ).toContain("Provisioning environment…");
      expect(await page.locator(".agent-chat__composer-status-band").count()).toBe(0);
      await captureUiProof(suite, page, "cloud-provisioning.png");
    });
  });
});
