/**
 * DSL Mode Manager
 *
 * Manages session-scoped DSL mode switching.
 * Tracks available hydrations and the currently active mode.
 */

import type { DslHydration, DslMode } from "./types.js";

/**
 * Manages DSL mode activation and switching within a session.
 * Provides a registry of available hydrations and tracks which one is active.
 */
export class DslModeManager {
  private hydrations: Map<string, DslHydration>;
  private activeMode: DslMode | null = null;

  /**
   * Create a new mode manager with the given hydrations.
   * @param hydrations - Initial list of available hydrations
   */
  constructor(hydrations: DslHydration[]) {
    this.hydrations = new Map();
    for (const hydration of hydrations) {
      this.hydrations.set(hydration.id, hydration);
    }
  }

  /**
   * Activate a DSL mode by hydration ID.
   * @param hydrationId - The ID of the hydration to activate
   * @param context - Optional domain-specific context
   * @throws Error if hydration ID is not found
   */
  activate(hydrationId: string, context?: any): void {
    const hydration = this.hydrations.get(hydrationId);
    if (!hydration) {
      throw new Error(`Unknown hydration ID: ${hydrationId}`);
    }

    this.activeMode = {
      hydrationId,
      activatedAt: Date.now(),
      context,
    };
  }

  /**
   * Deactivate the current mode.
   */
  deactivate(): void {
    this.activeMode = null;
  }

  /**
   * Get the currently active mode.
   * @returns The active mode or null if no mode is active
   */
  getActiveMode(): DslMode | null {
    return this.activeMode;
  }

  /**
   * Get the hydration for the currently active mode.
   * @returns The active hydration or null if no mode is active
   */
  getActiveHydration(): DslHydration | null {
    if (!this.activeMode) {
      return null;
    }
    return this.hydrations.get(this.activeMode.hydrationId) ?? null;
  }

  /**
   * Get the system prompt for the currently active mode.
   * @returns The system prompt or null if no mode is active
   */
  getActivePrompt(): string | null {
    const hydration = this.getActiveHydration();
    if (!hydration) {
      return null;
    }
    return hydration.getSystemPrompt(this.activeMode?.context);
  }

  /**
   * List all available hydrations.
   * @returns Array of all registered hydrations
   */
  listAvailable(): DslHydration[] {
    return Array.from(this.hydrations.values());
  }

  /**
   * Register a new hydration.
   * @param hydration - The hydration to register
   */
  register(hydration: DslHydration): void {
    this.hydrations.set(hydration.id, hydration);
  }
}
