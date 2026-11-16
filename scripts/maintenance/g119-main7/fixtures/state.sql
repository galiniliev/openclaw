-- DISPOSABLE REHEARSAL ONLY. Execute in the Native-created source-state37 namespace.
-- Never point this seed at a retained Root/production store. No DDL or external effects.
INSERT INTO schema_meta(meta_key,role,schema_version,agent_id,app_version,created_at,updated_at)
VALUES ('primary','global',37,NULL,'fixture-g119',1,1);
INSERT INTO config_machine_state(state_key,value_json,updated_at_ms)
VALUES ('state.schema.contentVersion','37',1);

INSERT INTO worker_environments
(environment_id,provider_id,profile_id,profile_snapshot_json,provision_operation_id,
 lease_id,node_setup_id,node_device_id,state,bootstrap_bundle_hash,bootstrap_openclaw_version,
 bootstrap_protocol_features_json,bootstrap_install_kind,owner_epoch,attached_session_ids_json,
 created_at_ms,updated_at_ms,state_changed_at_ms,shared_host,session_retention_json)
VALUES ('fixture-environment','crabbox','fixture-azure','{"install":"bundle","settings":{"provider":"azure","class":"small","ttl":"4h","idleTimeout":"15m","warmImage":false}}','provision:v2:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
 'openclaw-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb','fixture-node-setup','fixture-device','attached','cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc','2026.11.3',
 '[]','bundle',7,'["019a848b-7c00-7000-8000-000000000001"]',1794700800000,1794700800000,1794700800000,0,NULL);

INSERT INTO worker_session_placements
(session_id,agent_id,session_key,execution_mode,state,environment_id,transition_generation,
 active_owner_epoch,workspace_base_manifest_ref,repository_preparation,confirmed_loss_recovery_json,
 remote_workspace_dir,worker_bundle_hash,last_transcript_ack_cursor,last_live_event_ack_cursor,
 created_at_ms,updated_at_ms,state_changed_at_ms)
VALUES ('019a848b-7c00-7000-8000-000000000001','main','agent:main:dashboard:fixture-preserved','worker-turn','reconciling','fixture-environment',4,
 7,'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',NULL,'{"version":1,"predecessor":{"agentId":"main","sessionKey":"agent:main:dashboard:fixture-preserved","sessionId":"019a848b-7c00-7000-8000-000000000001","environmentId":"fixture-lost-environment","ownerEpoch":2},"predecessorGeneration":3,"replacementDispatchGeneration":4}','/home/fixture/workspace','cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',12,19,
 1794700800000,1794700800000,1794700800000);

INSERT INTO session_repository_workspaces
(workspace_id,agent_id,session_key,url,requested_ref,run_setup_script,base_commit,
 base_manifest_hash,branch,checkpoint_ref,manifest_hash,recovery_json,disk_authority_json,
 revision,created_at_ms,updated_at_ms)
VALUES ('11111111-1111-4111-8111-111111111111','main','agent:main:dashboard:fixture-preserved','https://github.com/fixture/preserved.git',
 'refs/heads/clawson/fixture-preserved',0,'dddddddddddddddddddddddddddddddddddddddd','sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb','clawson/fixture-preserved',
 'refs/openclaw/worker-results/fixture-current','sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb','{"reason":"missing-worker","atMs":1794700800000,"original":{"revision":2,"baseCommit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","baseManifestHash":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","checkpointRef":"refs/openclaw/worker-results/fixture-prior","manifestHash":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"},"sourceCommit":"dddddddddddddddddddddddddddddddddddddddd","source":"published-branch","unrecoverablePrivateContent":true}',NULL,3,1794700800000,1794700800000);

INSERT INTO worker_workspace_pending_results
(session_id,environment_id,owner_epoch,placement_generation,claim_id,run_id,gateway_instance_id,
 recovery_requested_at_ms,workspace_accepted_at_ms,staged_result_ref,repository_workspace_id,
 disk_authority_json,created_at_ms)
VALUES ('019a848b-7c00-7000-8000-000000000001','fixture-environment',7,4,'fixture-claim','fixture-run','fixture-old-gateway',
 1794700800000,NULL,'fixture-staged-result','11111111-1111-4111-8111-111111111111',NULL,1794700800000);

-- Personal repository publication: original requester authority is unknown, so it remains held.
-- Digest below is a fixed SHA-256 of the explicit immutable field array in expected.json.
INSERT INTO github_repository_publication_requests
(request_id,owner_profile_id,connection_generation,idempotency_key,request_digest,
 session_id,session_lifecycle_revision,requester_authority_json,session_key,agent_id,workspace_id,
 identity_source,identity_profile_id,identity_account_id,identity_login,title,body,status,
 branch,created_at_ms,updated_at_ms)
VALUES ('33333333-3333-4333-8333-333333333333','22222222-2222-4222-8222-222222222222','44444444-4444-4444-8444-444444444444','fixture-personal-publish','0fa7297dd857e9150f42c9fdc668f569de8d82f284d2a7b8e5ff652bc6e82b25',
 '019a848b-7c00-7000-8000-000000000001','fixture-incarnation-1',NULL,'agent:main:dashboard:fixture-preserved','main','11111111-1111-4111-8111-111111111111',
 'personal','22222222-2222-4222-8222-222222222222',101,'fixture-person','Fixture personal publication',
 'Keep this deferred request byte-for-byte.','requested','clawson/fixture-preserved',1794700800000,1794700800000);
