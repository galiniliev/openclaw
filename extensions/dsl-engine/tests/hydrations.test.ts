import { describe, it, expect, vi } from "vitest";
import { createM365Hydration } from "../src/hydrations/m365.js";
import { createEngageHydration } from "../src/hydrations/engage.js";
import { createPlannerHydration } from "../src/hydrations/planner.js";

describe("M365 Hydration", () => {
  it("should have correct metadata", () => {
    const hydration = createM365Hydration({
      createM365Namespace: vi.fn(),
      getM365SystemPrompt: vi.fn(() => "m365 prompt"),
      MessageSet: class {},
      EventSet: class {},
      ChatSet: class {},
    });

    expect(hydration.id).toBe("m365");
    expect(hydration.toolName).toBe("execute_m365_dsl");
    expect(hydration.displayName).toBe("M365 Copilot");
    expect(hydration.namespaceName).toBe("M365");
  });

  it("should provide collection classes", () => {
    class MockMessageSet {}
    class MockEventSet {}
    class MockChatSet {}

    const hydration = createM365Hydration({
      createM365Namespace: vi.fn(),
      getM365SystemPrompt: vi.fn(),
      MessageSet: MockMessageSet,
      EventSet: MockEventSet,
      ChatSet: MockChatSet,
    });

    expect(hydration.collectionClasses.MessageSet).toBe(MockMessageSet);
    expect(hydration.collectionClasses.EventSet).toBe(MockEventSet);
    expect(hydration.collectionClasses.ChatSet).toBe(MockChatSet);
  });

  it("should return system prompt", () => {
    const mockPrompt = "M365 system prompt text";
    const hydration = createM365Hydration({
      createM365Namespace: vi.fn(),
      getM365SystemPrompt: vi.fn(() => mockPrompt),
      MessageSet: class {},
      EventSet: class {},
      ChatSet: class {},
    });

    expect(hydration.getSystemPrompt()).toBe(mockPrompt);
  });

  it("should create namespace from API", () => {
    const mockApi = { foo: "bar" };
    const mockNamespace = { baz: "qux" };
    const createNamespace = vi.fn(() => mockNamespace);

    const hydration = createM365Hydration({
      createM365Namespace: createNamespace,
      getM365SystemPrompt: vi.fn(),
      MessageSet: class {},
      EventSet: class {},
      ChatSet: class {},
    });

    const result = hydration.createNamespace(mockApi);
    expect(createNamespace).toHaveBeenCalledWith(mockApi);
    expect(result).toBe(mockNamespace);
  });
});

describe("Engage Hydration", () => {
  it("should have correct metadata", () => {
    const hydration = createEngageHydration({
      createEngageNamespace: vi.fn(),
      getEngageSystemPrompt: vi.fn(() => "engage prompt"),
      ThreadSet: class {},
      CommunitySet: class {},
      EngageUserSet: class {},
      EngageEventSet: class {},
    });

    expect(hydration.id).toBe("engage");
    expect(hydration.toolName).toBe("execute_engage_dsl");
    expect(hydration.displayName).toBe("Viva Engage Copilot");
    expect(hydration.namespaceName).toBe("Engage");
  });

  it("should provide collection classes", () => {
    class MockThreadSet {}
    class MockCommunitySet {}
    class MockEngageUserSet {}
    class MockEngageEventSet {}

    const hydration = createEngageHydration({
      createEngageNamespace: vi.fn(),
      getEngageSystemPrompt: vi.fn(),
      ThreadSet: MockThreadSet,
      CommunitySet: MockCommunitySet,
      EngageUserSet: MockEngageUserSet,
      EngageEventSet: MockEngageEventSet,
    });

    expect(hydration.collectionClasses.ThreadSet).toBe(MockThreadSet);
    expect(hydration.collectionClasses.CommunitySet).toBe(MockCommunitySet);
    expect(hydration.collectionClasses.EngageUserSet).toBe(MockEngageUserSet);
    expect(hydration.collectionClasses.EngageEventSet).toBe(MockEngageEventSet);
  });

  it("should return system prompt", () => {
    const mockPrompt = "Engage system prompt text";
    const hydration = createEngageHydration({
      createEngageNamespace: vi.fn(),
      getEngageSystemPrompt: vi.fn(() => mockPrompt),
      ThreadSet: class {},
      CommunitySet: class {},
      EngageUserSet: class {},
      EngageEventSet: class {},
    });

    expect(hydration.getSystemPrompt()).toBe(mockPrompt);
  });

  it("should create namespace from API", () => {
    const mockApi = { foo: "bar" };
    const mockNamespace = { baz: "qux" };
    const createNamespace = vi.fn(() => mockNamespace);

    const hydration = createEngageHydration({
      createEngageNamespace: createNamespace,
      getEngageSystemPrompt: vi.fn(),
      ThreadSet: class {},
      CommunitySet: class {},
      EngageUserSet: class {},
      EngageEventSet: class {},
    });

    const result = hydration.createNamespace(mockApi);
    expect(createNamespace).toHaveBeenCalledWith(mockApi);
    expect(result).toBe(mockNamespace);
  });
});

describe("Planner Hydration", () => {
  it("should have correct metadata", () => {
    const hydration = createPlannerHydration({
      createPlannerNamespace: vi.fn(),
      getPlannerSystemPrompt: vi.fn(() => "planner prompt"),
      PlanSet: class {},
      TaskSet: class {},
      GoalSet: class {},
    });

    expect(hydration.id).toBe("planner");
    expect(hydration.toolName).toBe("execute_planner_dsl");
    expect(hydration.displayName).toBe("Planner Copilot");
    expect(hydration.namespaceName).toBe("Planner");
  });

  it("should provide collection classes", () => {
    class MockPlanSet {}
    class MockTaskSet {}
    class MockGoalSet {}

    const hydration = createPlannerHydration({
      createPlannerNamespace: vi.fn(),
      getPlannerSystemPrompt: vi.fn(),
      PlanSet: MockPlanSet,
      TaskSet: MockTaskSet,
      GoalSet: MockGoalSet,
    });

    expect(hydration.collectionClasses.PlanSet).toBe(MockPlanSet);
    expect(hydration.collectionClasses.TaskSet).toBe(MockTaskSet);
    expect(hydration.collectionClasses.GoalSet).toBe(MockGoalSet);
  });

  it("should return system prompt", () => {
    const mockPrompt = "Planner system prompt text";
    const hydration = createPlannerHydration({
      createPlannerNamespace: vi.fn(),
      getPlannerSystemPrompt: vi.fn(() => mockPrompt),
      PlanSet: class {},
      TaskSet: class {},
      GoalSet: class {},
    });

    expect(hydration.getSystemPrompt()).toBe(mockPrompt);
  });

  it("should create namespace from API", () => {
    const mockApi = { foo: "bar" };
    const mockNamespace = { baz: "qux" };
    const createNamespace = vi.fn(() => mockNamespace);

    const hydration = createPlannerHydration({
      createPlannerNamespace: createNamespace,
      getPlannerSystemPrompt: vi.fn(),
      PlanSet: class {},
      TaskSet: class {},
      GoalSet: class {},
    });

    const result = hydration.createNamespace(mockApi);
    expect(createNamespace).toHaveBeenCalledWith(mockApi);
    expect(result).toBe(mockNamespace);
  });
});
