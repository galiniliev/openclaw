import fs from "node:fs";
import path from "node:path";
import { quickHydration, type QuickHydrationConfig } from "./quick-hydration.js";
import { globalCodeModeRegistry } from "../registry.js";

interface JsonHydrationEntry {
  id: string;
  namespaceName: string;
  displayName?: string;
  baseUrl: string;
  auth: Record<string, unknown>;
  headers?: Record<string, string>;
  endpoints: Record<string, unknown>;
  prompt?: string;
  timeoutMs?: number;
  maxTimeoutMs?: number;
  maxCodeBytes?: number;
}

interface JsonHydrationFile {
  hydrations: JsonHydrationEntry[];
}

export function loadJsonHydrations(workspacePath: string, openclawConfig?: unknown): void {
  const filePath = path.join(workspacePath, "code-mode-hydrations.json");
  if (!fs.existsSync(filePath)) return;

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch (err) {
    console.warn(`[code-mode] Failed to read ${filePath}:`, err);
    return;
  }

  let parsed: JsonHydrationFile;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.warn(`[code-mode] Invalid JSON in ${filePath}:`, err);
    return;
  }

  if (!parsed.hydrations || !Array.isArray(parsed.hydrations)) {
    console.warn(`[code-mode] ${filePath}: missing or invalid "hydrations" array`);
    return;
  }

  for (const entry of parsed.hydrations) {
    if (!entry.id || !entry.namespaceName || !entry.baseUrl || !entry.auth || !entry.endpoints) {
      console.warn(`[code-mode] Skipping invalid hydration entry: missing required fields (id, namespaceName, baseUrl, auth, endpoints)`);
      continue;
    }

    if (globalCodeModeRegistry.get(entry.id)) {
      console.warn(`[code-mode] Skipping JSON hydration "${entry.id}": already registered by extension`);
      continue;
    }

    try {
      quickHydration(entry as unknown as QuickHydrationConfig, openclawConfig);
    } catch (err) {
      console.warn(`[code-mode] Failed to register hydration "${entry.id}":`, err);
    }
  }
}
