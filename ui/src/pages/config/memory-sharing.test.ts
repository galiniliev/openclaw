/* @vitest-environment jsdom */

import { html, render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { renderMemorySharingHost } from "./memory-sharing-host.ts";

type Request = (method: string, params: Record<string, unknown>) => Promise<unknown>;

const SHARING_METHODS = [
  "memory.sharing.status",
  "memory.sharing.projection.target.register",
  "memory.sharing.projection.preview",
  "memory.sharing.projection.create",
  "memory.sharing.projection.refresh",
  "memory.sharing.projection.revoke",
  "memory.sharing.projection.impact",
  "memory.sharing.postbox.mode.set",
  "memory.sharing.postbox.inspect",
  "memory.sharing.postbox.review",
  "memory.sharing.postbox.purge",
] as const;

type SharingElement = HTMLElement & {
  client: { request: Request } | null;
  connected: boolean;
  canAdmin: boolean;
  methodsAvailable: boolean;
  agentId: string | null;
  updateComplete: Promise<unknown>;
};

function findButton(element: HTMLElement, text: string): HTMLButtonElement {
  const button = [...element.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  if (!button) {
    throw new Error(`button ${text} is unavailable`);
  }
  return button;
}

function renderSharingHost(params: {
  methods: readonly string[];
  scopes?: readonly string[];
  request: Request;
}) {
  const container = document.createElement("div");
  render(
    renderMemorySharingHost(
      {
        phase: "connected",
        client: { request: params.request },
        hello: {
          auth: { role: "operator", scopes: params.scopes ?? ["operator.admin"] },
          features: { methods: [...params.methods] },
        },
      } as never,
      "main",
    ),
    container,
  );
  const element = container.querySelector<SharingElement>("openclaw-memory-sharing");
  if (!element) {
    throw new Error("sharing control is unavailable");
  }
  document.body.append(container);
  return { container, element };
}

describe("MemorySharingElement", () => {
  it("stays hidden unless an admin Gateway advertises the complete sharing contract", async () => {
    const request = vi.fn();
    const partial = renderSharingHost({ methods: SHARING_METHODS.slice(0, -1), request });
    const readOnly = renderSharingHost({
      methods: SHARING_METHODS,
      scopes: ["operator.read"],
      request,
    });
    try {
      await partial.element.updateComplete;
      await readOnly.element.updateComplete;
      expect(partial.element.textContent).toBe("");
      expect(readOnly.element.textContent).toBe("");
      expect(request).not.toHaveBeenCalled();
    } finally {
      partial.container.remove();
      readOnly.container.remove();
    }
  });

  it("uses only agent and reviewed-operation fields in postbox requests", async () => {
    const request = vi.fn<Request>((method) => {
      if (method === "memory.sharing.status") {
        return Promise.resolve({
          postboxMode: "off",
          projections: [],
          postboxItems: [
            {
              itemId: "postbox-1",
              state: "postbox",
              sourceChannelRef: "telegram:alice",
              createdAt: 1,
            },
          ],
        });
      }
      if (method === "memory.sharing.postbox.inspect") {
        return Promise.resolve({ itemId: "postbox-1", content: "sender observation" });
      }
      return Promise.resolve({ itemId: "postbox-1" });
    });
    const { container, element } = renderSharingHost({ methods: SHARING_METHODS, request });
    try {
      await waitForFast(() => expect(element.textContent).toContain("telegram:alice"));
      expect(request).toHaveBeenCalledWith("memory.sharing.status", { agentId: "main" });

      request.mockClear();
      findButton(element, "Inspect").click();
      await waitForFast(() =>
        expect(request).toHaveBeenCalledWith("memory.sharing.postbox.inspect", {
          agentId: "main",
          itemId: "postbox-1",
        }),
      );
      const reviewTextarea = () =>
        [...element.querySelectorAll<HTMLTextAreaElement>("textarea")].at(-1);
      await waitForFast(() => expect(reviewTextarea()?.value).toBe("sender observation"));
      const textarea = reviewTextarea();
      if (!textarea) {
        throw new Error("review textarea is unavailable");
      }
      textarea.value = "owner-edited copy";
      textarea.dispatchEvent(new Event("input", { bubbles: true }));

      request.mockClear();
      findButton(element, "Approve").click();
      await waitForFast(() =>
        expect(request).toHaveBeenCalledWith("memory.sharing.postbox.review", {
          agentId: "main",
          itemId: "postbox-1",
          decision: "approve",
          reviewedContent: "owner-edited copy",
        }),
      );
      expect(request.mock.calls.every(([, payload]) => !("principalId" in payload))).toBe(true);
      expect(request.mock.calls.every(([, payload]) => !("storeId" in payload))).toBe(true);
    } finally {
      container.remove();
    }
  });

  it("renders prior projection exposure without accepting a caller-selected audience", async () => {
    const request = vi.fn<Request>((method) => {
      if (method === "memory.sharing.status") {
        return Promise.resolve({
          postboxMode: "off",
          postboxItems: [],
          projections: [
            {
              projectionId: "projection-1",
              purpose: "handoff",
              preview: "reviewed note",
              state: "active",
              target: { kind: "role", id: "support" },
              expiresAt: null,
            },
          ],
        });
      }
      if (method === "memory.sharing.projection.impact") {
        return Promise.resolve({ exposureSetIds: ["exposure-1", "exposure-2"] });
      }
      return Promise.resolve({});
    });
    const { container, element } = renderSharingHost({ methods: SHARING_METHODS, request });
    try {
      await waitForFast(() => expect(element.textContent).toContain("handoff"));
      request.mockClear();
      findButton(element, "Prior exposure impact").click();
      await waitForFast(() =>
        expect(request).toHaveBeenCalledWith("memory.sharing.projection.impact", {
          agentId: "main",
          projectionId: "projection-1",
        }),
      );
      await waitForFast(() => expect(element.textContent).toContain("2 prior exposure records"));
      expect(request.mock.calls.every(([, payload]) => !("audience" in payload))).toBe(true);
    } finally {
      container.remove();
    }
  });

  it("renders no private-user projection target input", async () => {
    const request = vi.fn<Request>((method) =>
      Promise.resolve(
        method === "memory.sharing.status"
          ? { postboxMode: "off", projections: [], postboxItems: [] }
          : {},
      ),
    );
    const { container, element } = renderSharingHost({ methods: SHARING_METHODS, request });
    try {
      await waitForFast(() => expect(element.querySelector("select")).not.toBeNull());
      expect(
        [...element.querySelectorAll<HTMLSelectElement>("select")]
          .flatMap((select) => [...select.options].map((option) => option.value)),
      ).toEqual(expect.arrayContaining(["conversation", "role", "agent-shared"]));
      expect(element.querySelectorAll('option[value="user"]')).toHaveLength(0);
      expect(element.textContent).not.toContain("private-user");
    } finally {
      container.remove();
    }
  });
});
