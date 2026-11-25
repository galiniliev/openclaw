// Install transport fixtures before importing the publication owners.
// oxfmt-ignore
import { commandResult, githubPublicationTestMocks, installGitHubPublicationTestHarness } from "./github-publication.test-support.js";
import { expect, it, vi } from "vitest";
import { createRepositoryPublicationFixture } from "./github-repository-publication.test-support.js";

const checkpoint = vi.hoisted(() => vi.fn());
// mock-isolation: Synthetic accepted checkpoints; real coordinator, Git objects and API transport owner.
vi.mock("./worker-environments/session-repository-checkpoints.js", () => ({
  withSessionRepositoryPublicationCheckpoint: (...args: unknown[]) => checkpoint(...args),
}));
const mocks = githubPublicationTestMocks();
installGitHubPublicationTestHarness();

it.each([false, true])(
  "publishes a large accepted tree through bounded requests (later failure: %s)",
  async (failLater) => {
    const f = await createRepositoryPublicationFixture(checkpoint);
    const directory = Array.from({ length: 8 }, () => "directory-" + "x".repeat(180)).join("/");
    const accepted = await f.capture(
      "accepted\n",
      "large-tree",
      Object.fromEntries(
        Array.from({ length: 210 }, (_, i) => [`${directory}/${i}.txt`, "shared\n"]),
      ),
    );
    const route = mocks.runCommand.getMockImplementation()!;
    const bodies: string[] = [];
    let completedTrees = 0;
    let commitCalls = 0;
    mocks.runCommand.mockImplementation(async (args: string[], options) => {
      if (args.some((arg) => arg.endsWith("/git/commits"))) {
        commitCalls++;
      }
      if (args.some((arg) => arg.endsWith("/git/trees"))) {
        const body = String(options.input);
        bodies.push(body);
        // A synthetic provider body ceiling reproduces the observed shape failure;
        // it does not assert a documented GitHub API limit.
        if (Buffer.byteLength(body) > 256 * 1024 || (failLater && completedTrees === 1)) {
          return {
            ...commandResult("", 1),
            termination: "exit",
            stderr: Buffer.from("gh: failure (HTTP 502)"),
          };
        }
        completedTrees++;
      }
      return route(args, options);
    });
    const result = await f.publish("large-tree");
    if (failLater) {
      expect(result).toMatchObject({ status: "failed", code: "unavailable" });
      expect(completedTrees).toBe(1);
      expect(bodies).toHaveLength(3); // First batch succeeds; second has its one existing 502 retry.
      expect(bodies[1]).toBe(bodies[2]);
      expect(commitCalls).toBe(0);
      expect(f.runtime.effects).toEqual([]);
      expect(f.runtime.head).toBeNull();
    } else {
      expect(result).toMatchObject({ status: "published" });
      expect(completedTrees).toBeGreaterThan(1);
      expect(bodies.every((body) => Buffer.byteLength(body) <= 256 * 1024)).toBe(true);
      expect(f.git(["rev-parse", `${f.runtime.head}^{tree}`])).toBe(accepted.workspaceTree);
      expect(f.runtime.effects).toEqual(["push", "pull_request"]);
    }
  },
);
