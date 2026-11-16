-- Read-only metadata projection. The existing operator job supplies a quoted state search_path
-- inside BEGIN READ ONLY. No settings, credentials, transcript, or raw receipt payloads leave PG.
WITH environments AS (
  SELECT *, CASE WHEN session_retention_json IS JSON
    THEN session_retention_json::jsonb END AS retention
  FROM worker_environments
)
SELECT provider_id, state,
  CASE WHEN session_retention_json IS NULL THEN 'sql-null'
    WHEN session_retention_json IS NOT JSON THEN 'invalid'
    ELSE jsonb_typeof(retention) END AS retention_kind,
  lease_id IS NOT NULL AS has_lease,
  node_device_id IS NOT NULL AS has_node,
  destroy_requested_at_ms IS NOT NULL AS destroy_pending,
  preparation_key IS NOT NULL AS prepared,
  retention -> 'receipt' IS NOT NULL AND retention -> 'receipt' <> 'null'::jsonb AS has_receipt,
  retention -> 'operation' IS NOT NULL AND retention -> 'operation' <> 'null'::jsonb AS has_operation,
  retention #>> '{receipt,schema}' AS receipt_schema,
  retention #>> '{receipt,observedState}' AS observed_state,
  count(*) AS environments
FROM environments
GROUP BY 1,2,3,4,5,6,7,8,9,10,11
ORDER BY 1,2,3;

WITH workspaces AS (
  SELECT *, CASE WHEN disk_authority_json IS JSON
    THEN disk_authority_json::jsonb END AS authority
  FROM session_repository_workspaces
), environments AS (
  SELECT *, CASE WHEN session_retention_json IS JSON
    THEN session_retention_json::jsonb END AS retention
  FROM worker_environments
)
SELECT
  CASE WHEN workspace.disk_authority_json IS NULL THEN 'sql-null'
    WHEN workspace.disk_authority_json IS NOT JSON THEN 'invalid'
    ELSE jsonb_typeof(workspace.authority) END AS authority_kind,
  environment.environment_id IS NOT NULL AS environment_exists,
  environment.state AS environment_state,
  placement.session_id IS NOT NULL AS placement_exists,
  workspace.authority ->> 'sessionId' = placement.session_id AS same_session,
  workspace.authority ->> 'ownerEpoch' = environment.owner_epoch::text AS same_epoch,
  workspace.authority ->> 'workspaceDir' = placement.remote_workspace_dir AS same_directory,
  workspace.authority ->> 'ownerBinding' = environment.retention ->> 'ownerBinding' AS same_binding,
  workspace.authority #>> '{identity,leaseId}' = environment.lease_id AS same_lease,
  workspace.authority #>> '{identity,attemptLeaseId}' = environment.lease_id AS same_attempt_lease,
  workspace.authority #>> '{identity,slug}' = environment.retention #>> '{receipt,identity,slug}' AS same_slug,
  workspace.authority #>> '{identity,resourceId}' = environment.retention #>> '{receipt,identity,resourceId}' AS same_resource,
  count(*) AS workspaces
FROM workspaces workspace
LEFT JOIN environments environment ON environment.environment_id = workspace.authority ->> 'environmentId'
LEFT JOIN worker_session_placements placement
  ON placement.agent_id = workspace.agent_id AND placement.session_key = workspace.session_key
GROUP BY 1,2,3,4,5,6,7,8,9,10,11,12
ORDER BY 1,2,3;
