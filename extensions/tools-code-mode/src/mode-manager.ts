/**
 * Code Mode Session Manager
 *
 * Manages session-scoped code mode switching.
 * Tracks available hydrations and the currently active mode.
 */

import type { CodeModeHydration, CodeModeSession } from "./types.js";

/**
 * Manages code mode activation and switching within a session.
 * Provides a registry of available hydrations and tracks which one is active.
 */
export class CodeModeSessionManager {
  private hydrations: Map<string, CodeModeHydration>;
  private readonly activeModes = new Map<string, CodeModeSession>();

  private static readonly defaultSessionKey = "__global__";

  /**
   * Create a new mode manager with the given hydrations.
   * @param hydrations - Initial list of available hydrations
   */
  constructor(hydrations: CodeModeHydration[]) {
    this.hydrations = new Map();
    for (const hydration of hydrations) {
      this.hydrations.set(hydration.id, hydration);
    }
  }

  /**
   * Activate a code mode by hydration ID.
   * @param hydrationId - The ID of the hydration to activate
   * @param context - Optional domain-specific context
   * @throws Error if hydration ID is not found
   */
  activate(hydrationId: string, context?: unknown, sessionKey?: string): void {
    const hydration = this.hydrations.get(hydrationId);
    if (!hydration) {
      throw new Error(`Unknown hydration ID: ${hydrationId}`);
    }

    this.activeModes.set(this.resolveSessionKey(sessionKey), {
      hydrationId,
      activatedAt: Date.now(),
      context,
    });
  }

  /**
   * Deactivate the current mode.
   */
  deactivate(sessionKey?: string): void {
    this.activeModes.delete(this.resolveSessionKey(sessionKey));
  }

  /**
   * Get the currently active mode.
   * @returns The active mode or null if no mode is active
   */
  getActiveMode(sessionKey?: string): CodeModeSession | null {
    return this.activeModes.get(this.resolveSessionKey(sessionKey)) ?? null;
  }

  /**
   * Get the hydration for the currently active mode.
   * @returns The active hydration or null if no mode is active
   */
  getActiveHydration(sessionKey?: string): CodeModeHydration | null {
    const activeMode = this.getActiveMode(sessionKey);
    if (!activeMode) {
      return null;
    }
    return this.hydrations.get(activeMode.hydrationId) ?? null;
  }

  /**
   * Get the system prompt for the currently active mode.
   * @returns The system prompt or null if no mode is active
   */
  getActivePrompt(sessionKey?: string): string | null {
    const activeMode = this.getActiveMode(sessionKey);
    const hydration = this.getActiveHydration(sessionKey);
    if (!hydration) {
      return null;
    }
    return hydration.getSystemPrompt(activeMode?.context);
  }

  /**
   * List all available hydrations.
   * @returns Array of all registered hydrations
   */
  listAvailable(): CodeModeHydration[] {
    return Array.from(this.hydrations.values());
  }

  /**
   * Register a new hydration.
   * @param hydration - The hydration to register
   */
  register(hydration: CodeModeHydration): void {
    this.hydrations.set(hydration.id, hydration);
  }

  unregister(hydrationId: string): boolean {
    for (const [sessionKey, mode] of this.activeModes.entries()) {
      if (mode.hydrationId === hydrationId) {
        this.activeModes.delete(sessionKey);
      }
    }
    return this.hydrations.delete(hydrationId);
  }

  private resolveSessionKey(sessionKey: string | undefined): string {
    return sessionKey?.trim() || CodeModeSessionManager.defaultSessionKey;
  }
}
