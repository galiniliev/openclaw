import {
  missingScopeErrorShape,
  type ErrorShape,
  type SessionPermissionMode,
} from "../../packages/gateway-protocol/src/index.js";
import { ADMIN_SCOPE, WRITE_SCOPE } from "./operator-scopes.js";

/** Resolve an attended default and its current scope requirement for creation and display. */
export function resolveAttendedSessionPermissionDefault(
  configuredMode: SessionPermissionMode | undefined,
  scopes: readonly string[],
):
  | { ok: true; mode: SessionPermissionMode | undefined }
  | { ok: false; mode: "full"; error: ErrorShape } {
  const mode =
    configuredMode === "full" && !scopes.includes(ADMIN_SCOPE) && scopes.includes(WRITE_SCOPE)
      ? "workspace"
      : configuredMode;
  if (mode === "full" && !scopes.includes(ADMIN_SCOPE)) {
    return {
      ok: false,
      mode,
      error: missingScopeErrorShape({ missingScope: ADMIN_SCOPE, requiredScopes: [ADMIN_SCOPE] }),
    };
  }
  return { ok: true, mode };
}
