import { AsyncLocalStorage } from "node:async_hooks";
import { setImmediate } from "node:timers/promises";
import { afterEach, expect, it } from "vitest";
import {
  clearGatewayRollingAdmission,
  resetGatewayWorkAdmission,
  runWithGatewayRollingStartupAdmission,
  setGatewayRollingAdmission,
  tryBeginGatewayIndependentRootWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
} from "../process/gateway-work-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import { GatewayRollingStartup, runOrDeferGatewayMutableStartup } from "./rolling-startup.js";

afterEach(() => resetGatewayWorkAdmission());

it("keeps external requests fenced while the existing startup owner initializes", async () => {
  setGatewayRollingAdmission("release", true);
  const outside = AsyncLocalStorage.bind(() =>
    tryBeginGatewayIndependentRootWorkAdmission("outside"),
  );
  let retained: (() => ReturnType<typeof tryBeginGatewayIndependentRootWorkAdmission>) | undefined;
  const gate = new GatewayRollingStartup(() => {}, "release");
  gate.defer(async () => {
    expect(outside()).toBeNull();
    expect(tryBeginGatewayRootWorkAdmission("ws:config.set")).toBeNull();
    const startup = tryBeginGatewayIndependentRootWorkAdmission("startup");
    expect(startup).not.toBeNull();
    startup?.release();
    retained = AsyncLocalStorage.bind(() =>
      tryBeginGatewayIndependentRootWorkAdmission("late-startup"),
    );
  });
  await runWithGatewayRollingStartupAdmission(
    "release",
    () => {},
    () => gate.activate(() => {}),
  );
  expect(retained?.()).toBeNull();
  expect(tryBeginGatewayRootWorkAdmission("ws:chat.send")).toBeNull();
  await gate.close();
});

it("opens external admission only after all deferred initialization completes", async () => {
  setGatewayRollingAdmission("release", true);
  const gate = new GatewayRollingStartup(() => {}, "release");
  const entered = createDeferredCore();
  const release = createDeferredCore();
  gate.defer(async () => {
    entered.resolve();
    await release.promise;
  });
  const activation = runWithGatewayRollingStartupAdmission(
    "release",
    () => {},
    () =>
      gate.activate(
        () => {},
        undefined,
        () => clearGatewayRollingAdmission("release"),
      ),
  );
  await entered.promise;
  expect(tryBeginGatewayRootWorkAdmission("ws:chat.send")).toBeNull();
  release.resolve();
  await activation;
  const admitted = tryBeginGatewayRootWorkAdmission("ws:chat.send");
  expect(admitted).not.toBeNull();
  admitted?.release();
  await gate.close();
});

it("awaits ordinary configuration publication after activation instead of deferring it again", async () => {
  const gate = new GatewayRollingStartup(() => {}, "release");
  await gate.activate(() => {});
  const entered = createDeferredCore();
  const release = createDeferredCore();
  let settled = false;
  const publication = runOrDeferGatewayMutableStartup(gate, async () => {
    entered.resolve();
    await release.promise;
  });
  void publication.then(() => {
    settled = true;
  });
  await entered.promise;
  await setImmediate();
  expect(settled).toBe(false);
  release.resolve();
  await publication;
  expect(settled).toBe(true);
  await gate.close();
});
