"""One bounded snapshot effect for the native Crabbox warm-image owner.

The parent owns authorization, operation persistence, cancellation and retries.
This process neither allocates sandboxes nor stores credentials or receipts.
"""

from __future__ import annotations

import importlib.metadata
import json
import os
import re
import sys
import time
import uuid

SCHEMA = "openclaw.azure-sandbox-checkpoint.v1"
VERSIONS = {
    "azure-containerapps-sandbox": "0.1.0b4",
    "azure-identity": "1.26.0",
    "azure-core": "1.41.0",
}
SEGMENT = re.compile(r"^[A-Za-z0-9._()-]{1,256}$")


def segment(value: object) -> str:
    if not isinstance(value, str) or not SEGMENT.fullmatch(value) or value in (".", ".."):
        raise ValueError("Invalid scoped snapshot identity")
    return value


def request_from_stdin() -> dict:
    raw = sys.stdin.buffer.read(64 * 1024 + 1)
    if len(raw) > 64 * 1024:
        raise ValueError("Snapshot request exceeds its bound")
    request = json.loads(raw)
    if not isinstance(request, dict) or set(request) - {
        "schema", "action", "scope", "sourceSandboxId", "sourceDiskId", "operationId", "snapshotId"
    }:
        raise ValueError("Invalid snapshot request")
    if request.get("schema") != SCHEMA or request.get("action") not in (
        "capture", "inspect", "delete"
    ):
        raise ValueError("Unsupported snapshot action")
    scope = request.get("scope")
    if not isinstance(scope, dict) or set(scope) != {
        "region", "subscriptionId", "resourceGroup", "group"
    }:
        raise ValueError("Invalid snapshot provider scope")
    for value in scope.values():
        segment(value)
    if not re.fullmatch(r"[a-z0-9]+", scope["region"]):
        raise ValueError("Invalid snapshot region")
    segment(request.get("sourceSandboxId"))
    operation_id = request.get("operationId")
    if not isinstance(operation_id, str) or str(uuid.UUID(operation_id)) != operation_id:
        raise ValueError("Invalid snapshot operation identity")
    if "snapshotId" in request:
        segment(request["snapshotId"])
    if request["action"] == "delete" and "snapshotId" not in request:
        raise ValueError("Snapshot deletion requires its saved identity")
    if request["action"] == "capture" and "snapshotId" in request:
        raise ValueError("Capture cannot replace a saved snapshot")
    if request["action"] == "capture":
        segment(request.get("sourceDiskId"))
    return request


def check_runtime() -> None:
    if sys.version_info < (3, 10) or any(
        importlib.metadata.version(name) != version for name, version in VERSIONS.items()
    ):
        raise RuntimeError("Snapshot SDK runtime is not qualified")
    # Import/ABI qualification is side-effect free: no credential or client exists.
    import azure.containerapps.sandbox
    import azure.identity


def open_client(scope: dict):
    check_runtime()
    from azure.containerapps.sandbox import SandboxGroupClient
    from azure.identity import AzureCliCredential, ManagedIdentityCredential

    # Match the selected Crabbox provider identity. Never fall through between
    # managed identity and the operator CLI, or copy their bearer into an envelope.
    client_id = os.environ.get("CRABBOX_AZURE_SANDBOX_CLIENT_ID", "").strip()
    credential = (
        ManagedIdentityCredential(client_id=client_id) if client_id else AzureCliCredential()
    )
    client = SandboxGroupClient(
        "https://management." + scope["region"] + ".azuredevcompute.io",
        credential,
        subscription_id=scope["subscriptionId"],
        resource_group=scope["resourceGroup"],
        sandbox_group=scope["group"],
        audience="https://dynamicsessions.io/.default",
        api_version="2026-02-01-preview",
        retry_total=0,
        permit_redirects=False,
        connection_timeout=30,
        read_timeout=600,
    )
    return client, credential


def snapshot_fact(snapshot, request: dict) -> dict:
    snapshot_id = segment(snapshot.id)
    if snapshot.sandbox_id != request["sourceSandboxId"] or snapshot.labels.get("name") != (
        "openclaw-" + request["operationId"]
    ):
        raise ValueError("Snapshot differs from its saved source and operation")
    if request.get("snapshotId", snapshot_id) != snapshot_id:
        raise ValueError("Snapshot identity changed")
    return {
        "snapshotId": snapshot_id,
        "sourceSandboxId": snapshot.sandbox_id,
        "operationId": request["operationId"],
        "capturedAt": snapshot.created_at_utc,
    }


def measured(phases: list, name: str, run):
    started = time.monotonic()
    outcome = "failed"
    try:
        result = run()
        outcome = "success"
        return result
    finally:
        phases.append({
            "phase": name,
            "durationMs": round((time.monotonic() - started) * 1000),
            "outcome": outcome,
            "opaque": True,
        })


def observe(client, request: dict, phases: list):
    from azure.core.exceptions import ResourceNotFoundError

    if request.get("snapshotId"):
        try:
            return measured(phases, "snapshot.inspect.request", lambda: client.get_snapshot(request["snapshotId"]))
        except ResourceNotFoundError:
            return None
    # Recovery can discover a lost create response by the existing capture ID.
    # A bounded or ambiguous listing never proves absence or permits another POST.
    def lookup():
        found = None
        for index, snapshot in enumerate(client.list_snapshots()):
            if index >= 256:
                raise RuntimeError("Snapshot recovery inventory exceeds its bound")
            if snapshot.labels.get("name") == "openclaw-" + request["operationId"]:
                snapshot_fact(snapshot, request)
                if found is not None:
                    raise RuntimeError("Snapshot recovery has multiple matching effects")
                found = snapshot
        return found

    return measured(phases, "snapshot.recovery.lookup", lookup)


def execute(client, request: dict, phases: list) -> dict:
    action = request["action"]
    if action == "capture":
        source = client.get_sandbox_client(request["sourceSandboxId"])
        original = measured(phases, "snapshot.capture.source", source.get)
        if original.id != request["sourceSandboxId"]:
            raise ValueError("Snapshot source identity changed")
        if (
            original.sources_ref is None or original.sources_ref.disk_image is None or
            original.sources_ref.disk_image.id != request["sourceDiskId"]
        ):
            raise ValueError("Snapshot source disk differs from the selected prepared disk")
        snapshot = measured(
            phases, "snapshot.capture.request",
            lambda: source.create_snapshot(name="openclaw-" + request["operationId"]),
        )
        return {"state": "pending", "snapshot": snapshot_fact(snapshot, request)}
    snapshot = observe(client, request, phases)
    if snapshot is None:
        return {"state": "missing" if request.get("snapshotId") else "unknown"}
    fact = snapshot_fact(snapshot, request)
    if action == "delete":
        measured(phases, "snapshot.delete.request", lambda: client.delete_snapshot(fact["snapshotId"]))
        # The existing owner observes exact 404 before closing deletion debt.
        return {"state": "pending", "snapshot": fact}
    # The SDK's ResourceExistsPoller uses this same scoped GET as capture readiness.
    return {"state": "available", "snapshot": fact}


def main() -> int:
    started = time.monotonic()
    client = credential = None
    outcome = "failed"
    response = {"schema": SCHEMA, "state": "unknown"}
    phases = []
    try:
        if sys.argv[1:] == ["--check-runtime"]:
            check_runtime()
            response.update({"state": "available", "versions": VERSIONS})
        elif sys.argv[1:]:
            raise ValueError("Unsupported snapshot helper arguments")
        else:
            request = request_from_stdin()
            client, credential = open_client(request["scope"])
            response.update(execute(client, request, phases))
        outcome = "success"
        return_code = 0
    except Exception as error:
        # SDK exceptions can contain response bodies, URLs and identity details.
        # The native owner receives a closed failure code, never raw SDK output.
        status = getattr(error, "status_code", None)
        response["error"] = (
            "authorization_denied" if status in (401, 403) else "snapshot_operation_failed"
        )
        return_code = 1
    finally:
        for resource in (client, credential):
            if resource is not None:
                try:
                    resource.close()
                except Exception:
                    # Transport cleanup cannot erase a known snapshot outcome.
                    response["cleanupFailed"] = True
    response["timing"] = {
        "durationMs": round((time.monotonic() - started) * 1000),
        "outcome": outcome,
        "opaque": True,
        "nonAdditive": True,
    }
    response["phases"] = phases
    print(json.dumps(response, separators=(",", ":")))
    return return_code


if __name__ == "__main__":
    raise SystemExit(main())
