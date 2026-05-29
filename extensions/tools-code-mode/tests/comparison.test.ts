/**
 * Side-by-side comparison: direct tool calls vs. code mode.
 *
 * Goal: produce hard numbers (round-trips, bytes returned to context, wall-clock)
 * for the same task done two ways, so the README can quote them with proof.
 *
 * Scenario: "List all users with more than 5 posts, sorted by post count descending."
 *
 * The API exposes two methods:
 *   - users.list()           → returns 10 users with metadata
 *   - posts.byUser(userId)   → returns that user's posts
 *
 * In *direct* mode, each agent turn = one method call. The agent must:
 *   turn 1:        users.list()                          (10 users in context)
 *   turns 2..11:   posts.byUser(u.id) for each user      (all posts in context)
 *   turn 12:       compose final answer
 *
 * In *code mode*, the model writes one script that does the whole thing.
 * Only the final filtered/sorted result enters the LLM context.
 */

import { describe, it, expect, afterAll } from "vitest";
import { executeCodeMode, shutdown } from "../src/executor.js";
import type { CodeModeNamespace } from "../src/types.js";

// ---------- Fixture: instrumented API ----------

interface User { id: number; name: string; email: string; joinedAt: string; }
interface Post { id: number; userId: number; title: string; body: string; }

const USERS: User[] = Array.from({ length: 10 }, (_, i) => ({
  id: i + 1,
  name: `User ${i + 1}`,
  email: `user${i + 1}@example.test`,
  joinedAt: "2026-01-01T00:00:00Z",
}));

const POSTS_PER_USER: Record<number, number> = {
  1: 12, 2: 3, 3: 8, 4: 1, 5: 7, 6: 0, 7: 15, 8: 4, 9: 6, 10: 2,
};

function makePosts(userId: number): Post[] {
  return Array.from({ length: POSTS_PER_USER[userId] ?? 0 }, (_, i) => ({
    id: userId * 100 + i,
    userId,
    title: `Post ${i + 1} by user ${userId}`,
    body: "Lorem ipsum dolor sit amet, consectetur adipiscing elit.".repeat(3),
  }));
}

interface CallStats { calls: number; bytesReturned: number; }

function instrumentApi(stats: CallStats) {
  return {
    users: {
      list: async () => {
        stats.calls++;
        const result = USERS;
        stats.bytesReturned += JSON.stringify(result).length;
        return result;
      },
    },
    posts: {
      byUser: async (userId: number) => {
        stats.calls++;
        const result = makePosts(userId);
        stats.bytesReturned += JSON.stringify(result).length;
        return result;
      },
    },
  };
}

type Api = ReturnType<typeof instrumentApi>;

const ns: CodeModeNamespace<Api, Api> = {
  id: "demo",
  toolName: "execute_code",
  displayName: "Demo Code Mode",
  namespaceName: "Demo",
  createNamespace: (api) => api,
  collectionClasses: {},
  getSystemPrompt: () => "Demo namespace with Demo.users.list() and Demo.posts.byUser(id).",
};

// ---------- Mode A: direct tool calls (simulated) ----------

/**
 * Simulates what the agent loop sees with one method = one turn.
 * Returns the answer plus the same call counters the code-mode path will see.
 */
async function runDirectToolCalls(api: Api) {
  // Turn 1: list users.
  const users = await api.users.list();

  // Each user → its own turn that lands posts in LLM context.
  const buckets: Array<{ user: User; postCount: number }> = [];
  for (const user of users) {
    const posts = await api.posts.byUser(user.id);
    buckets.push({ user, postCount: posts.length });
  }

  // Final reasoning turn (no API call) produces the answer.
  return buckets
    .filter((b) => b.postCount > 5)
    .sort((a, b) => b.postCount - a.postCount)
    .map((b) => ({ name: b.user.name, postCount: b.postCount }));
}

// ---------- Mode B: code mode (one execute_code turn) ----------

const CODE_MODE_SCRIPT = `
  const users = await Demo.users.list();
  const counts = await Promise.all(
    users.map(async (u) => ({ name: u.name, postCount: (await Demo.posts.byUser(u.id)).length })),
  );
  return counts.filter((c) => c.postCount > 5).sort((a, b) => b.postCount - a.postCount);
`;

// ---------- Comparison harness ----------

interface Measurement {
  agentRoundTrips: number;
  apiCalls: number;
  bytesIntoContext: number;
  wallClockMs: number;
  result: unknown;
}

afterAll(() => {
  shutdown();
});

describe("direct tool calls vs. code mode", () => {
  it("code mode reduces agent round-trips and context payload for the same task", async () => {
    // --- Mode A: direct tool calls ---
    const directStats: CallStats = { calls: 0, bytesReturned: 0 };
    const directApi = instrumentApi(directStats);
    const t0 = Date.now();
    const directResult = await runDirectToolCalls(directApi);
    const directMs = Date.now() - t0;

    const direct: Measurement = {
      // each API call lands a tool result in the LLM context = one round trip,
      // plus one final reasoning turn that produces the answer.
      agentRoundTrips: directStats.calls + 1,
      apiCalls: directStats.calls,
      bytesIntoContext: directStats.bytesReturned,
      wallClockMs: directMs,
      result: directResult,
    };

    // --- Mode B: code mode ---
    const codeStats: CallStats = { calls: 0, bytesReturned: 0 };
    const codeApi = instrumentApi(codeStats);
    const t1 = Date.now();
    const codeOutcome = await executeCodeMode(CODE_MODE_SCRIPT, [{ namespace: ns, scope: codeApi }]);
    const codeMs = Date.now() - t1;

    expect(codeOutcome.kind).toBe("Succeeded");

    const code: Measurement = {
      // exactly one execute_code tool call regardless of how many API hops happen inside.
      agentRoundTrips: 1,
      apiCalls: codeStats.calls,
      // only the final return value enters LLM context, not every intermediate response.
      bytesIntoContext: JSON.stringify(codeOutcome.result).length,
      wallClockMs: codeMs,
      result: codeOutcome.result,
    };

    // --- Assertions: same answer, dramatically less LLM work ---
    expect(code.result).toEqual(direct.result);

    // 1 list + 10 byUser = 11 API calls, 12 agent round-trips, against 1 round-trip.
    expect(direct.agentRoundTrips).toBe(12);
    expect(code.agentRoundTrips).toBe(1);

    // code mode makes the same underlying API calls, just inside one turn.
    expect(code.apiCalls).toBe(direct.apiCalls);

    // code mode keeps intermediate payloads out of the LLM context.
    expect(code.bytesIntoContext).toBeLessThan(direct.bytesIntoContext / 5);

    // Emit a small comparison table so the README can quote concrete numbers.
    // Vitest captures stdout per test.
    // eslint-disable-next-line no-console
    console.log(
      [
        "",
        "metric                | direct tool calls | code mode",
        "----------------------|-------------------|----------",
        `agent round-trips     | ${String(direct.agentRoundTrips).padStart(17)} | ${code.agentRoundTrips}`,
        `underlying API calls  | ${String(direct.apiCalls).padStart(17)} | ${code.apiCalls}`,
        `bytes into LLM context| ${String(direct.bytesIntoContext).padStart(17)} | ${code.bytesIntoContext}`,
        `wall-clock ms         | ${String(direct.wallClockMs).padStart(17)} | ${code.wallClockMs}`,
        "",
      ].join("\n"),
    );
  });
});
