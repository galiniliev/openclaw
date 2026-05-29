/**
 * Code Mode Session Manager
 *
 * Manages session-scoped code mode switching.
 * Tracks available namespaces and the currently active mode.
 */

import type { CodeModeNamespace, CodeModeSession } from "./types.js";

/**
 * Manages code mode activation and switching within a session.
 * Provides a registry of available namespaces and tracks which one is active.
 */
export class CodeModeSessionManager {
  private namespaces: Map<string, CodeModeNamespace>;
  private readonly activeModes = new Map<string, CodeModeSession>();

  private static readonly defaultSessionKey = "__global__";

  /**
   * Create a new mode manager with the given namespaces.
   * @param namespaces - Initial list of available namespaces
   */
  constructor(namespaces: CodeModeNamespace[]) {
    this.namespaces = new Map();
    for (const ns of namespaces) {
      this.namespaces.set(ns.id, ns);
    }
  }

  /**
   * Activate a code mode by namespace ID.
   * @param namespaceId - The ID of the namespace to activate
   * @param context - Optional domain-specific context
   * @throws Error if namespace ID is not found
   */
  activate(namespaceId: string, context?: unknown, sessionKey?: string): void {
    const ns = this.namespaces.get(namespaceId);
    if (!ns) {
      throw new Error(`Unknown namespace ID: ${namespaceId}`);
    }

    this.activeModes.set(this.resolveSessionKey(sessionKey), {
      namespaceId,
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
   * Get the namespace for the currently active mode.
   * @returns The active namespace or null if no mode is active
   */
  getActiveNamespace(sessionKey?: string): CodeModeNamespace | null {
    const activeMode = this.getActiveMode(sessionKey);
    if (!activeMode) {
      return null;
    }
    return this.namespaces.get(activeMode.namespaceId) ?? null;
  }

  /**
   * Get the system prompt for the currently active mode.
   * @returns The system prompt or null if no mode is active
   */
  getActivePrompt(sessionKey?: string): string | null {
    const activeMode = this.getActiveMode(sessionKey);
    const ns = this.getActiveNamespace(sessionKey);
    if (!ns) {
      return null;
    }
    return ns.getSystemPrompt(activeMode?.context);
  }

  /**
   * List all available namespaces.
   */
  listAvailable(): CodeModeNamespace[] {
    return Array.from(this.namespaces.values());
  }

  /**
   * Register a new namespace.
   */
  register(ns: CodeModeNamespace): void {
    this.namespaces.set(ns.id, ns);
  }

  unregister(namespaceId: string): boolean {
    for (const [sessionKey, mode] of this.activeModes.entries()) {
      if (mode.namespaceId === namespaceId) {
        this.activeModes.delete(sessionKey);
      }
    }
    return this.namespaces.delete(namespaceId);
  }

  private resolveSessionKey(sessionKey: string | undefined): string {
    return sessionKey?.trim() || CodeModeSessionManager.defaultSessionKey;
  }
}
