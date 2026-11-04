-- Qualified 10a4bc386f7 state-v33 worker table declarations. Schema only.

CREATE TABLE "worker_environments" (
  "environment_id" text COLLATE "C" NOT NULL,
  "provider_id" text COLLATE "C" NOT NULL,
  "profile_id" text COLLATE "C" NOT NULL,
  "profile_snapshot_json" text COLLATE "C" NOT NULL,
  "last_activated_at_ms" bigint,
  "preparation_key" text COLLATE "C",
  "preparation_purpose" text COLLATE "C",
  "preparation_demand_at_ms" bigint,
  "preparation_expires_at_ms" bigint,
  "preparation_consumed_at_ms" bigint,
  "provision_operation_id" text COLLATE "C" NOT NULL,
  "lease_id" text COLLATE "C",
  "node_setup_id" text COLLATE "C",
  "node_device_id" text COLLATE "C",
  "ssh_host" text COLLATE "C",
  "ssh_port" bigint,
  "ssh_user" text COLLATE "C",
  "ssh_host_key" text COLLATE "C",
  "ssh_key_ref_json" text COLLATE "C",
  "desktop_json" text COLLATE "C",
  "state" text COLLATE "C" NOT NULL,
  "bootstrap_bundle_hash" text COLLATE "C",
  "bootstrap_openclaw_version" text COLLATE "C",
  "bootstrap_protocol_features_json" text COLLATE "C",
  "bootstrap_install_kind" text COLLATE "C",
  "owner_epoch" bigint NOT NULL DEFAULT 0,
  "teardown_terminal_state" text COLLATE "C",
  "attached_session_ids_json" text COLLATE "C" NOT NULL DEFAULT '[]',
  "created_at_ms" bigint NOT NULL,
  "updated_at_ms" bigint NOT NULL,
  "state_changed_at_ms" bigint NOT NULL,
  "idle_since_at_ms" bigint,
  "destroy_requested_at_ms" bigint,
  "last_error" text COLLATE "C",
  "shared_host" bigint,
  "session_retention_json" text COLLATE "C",
  PRIMARY KEY ("environment_id"),
  CHECK (("preparation_key" IS NULL AND "preparation_demand_at_ms" IS NULL AND "preparation_expires_at_ms" IS NULL AND "preparation_consumed_at_ms" IS NULL) OR ("preparation_key" IS NOT NULL AND (char_length("preparation_key") = 64) AND ("preparation_key" COLLATE "C" !~ '\A.*[^0-9a-f].*\Z') AND "preparation_demand_at_ms" IS NOT NULL AND ("preparation_demand_at_ms" BETWEEN 0 AND 9007199254740991) AND "preparation_expires_at_ms" IS NOT NULL AND ("preparation_expires_at_ms" > "preparation_demand_at_ms") AND ("preparation_expires_at_ms" <= 9007199254740991) AND ("preparation_consumed_at_ms" IS NULL OR (("preparation_consumed_at_ms" >= "preparation_demand_at_ms") AND ("preparation_consumed_at_ms" < "preparation_expires_at_ms"))))),
  CHECK ("ssh_port" IS NULL OR (("ssh_port" >= 1) AND ("ssh_port" <= 65535))),
  CHECK (("state" IN ('requested', 'provisioning', 'bootstrapping', 'ready', 'attached', 'idle', 'draining', 'destroying', 'destroyed', 'failed', 'orphaned'))),
  CHECK (("owner_epoch" >= 0)),
  CHECK (("teardown_terminal_state" IN ('destroyed', 'failed'))),
  UNIQUE ("provision_operation_id")
);

CREATE TABLE "worker_session_placements" (
  "session_id" text COLLATE "C" NOT NULL,
  "agent_id" text COLLATE "C" NOT NULL,
  "session_key" text COLLATE "C" NOT NULL,
  "execution_mode" text COLLATE "C",
  "state" text COLLATE "C" NOT NULL,
  "environment_id" text COLLATE "C",
  "transition_generation" bigint NOT NULL DEFAULT 0,
  "active_owner_epoch" bigint,
  "workspace_base_manifest_ref" text COLLATE "C",
  "repository_preparation" text COLLATE "C",
  "confirmed_loss_recovery_json" text COLLATE "C",
  "remote_workspace_dir" text COLLATE "C",
  "worker_bundle_hash" text COLLATE "C",
  "last_transcript_ack_cursor" bigint,
  "last_live_event_ack_cursor" bigint,
  "recovery_error" text COLLATE "C",
  "turn_claim_owner" text COLLATE "C",
  "turn_claim_id" text COLLATE "C",
  "turn_claim_run_id" text COLLATE "C",
  "turn_claim_generation" bigint,
  "turn_claim_owner_epoch" bigint,
  "created_at_ms" bigint NOT NULL,
  "updated_at_ms" bigint NOT NULL,
  "state_changed_at_ms" bigint NOT NULL,
  "terminal_reason" text COLLATE "C",
  "terminal_at_ms" bigint,
  PRIMARY KEY ("session_id"),
  CHECK (("execution_mode" IN ('worker-turn', 'remote-exec'))),
  CHECK (("state" IN ('local', 'requested', 'provisioning', 'syncing', 'starting', 'active', 'draining', 'reconciling', 'reclaimed', 'failed'))),
  CHECK (("transition_generation" >= 0)),
  CHECK ("active_owner_epoch" IS NULL OR ("active_owner_epoch" >= 1)),
  CHECK ("last_transcript_ack_cursor" IS NULL OR ("last_transcript_ack_cursor" >= 0)),
  CHECK ("last_live_event_ack_cursor" IS NULL OR ("last_live_event_ack_cursor" >= 0)),
  CHECK (("turn_claim_owner" IN ('local', 'worker'))),
  CHECK ("turn_claim_generation" IS NULL OR ("turn_claim_generation" >= 0)),
  CHECK ("turn_claim_owner_epoch" IS NULL OR ("turn_claim_owner_epoch" >= 1)),
  CHECK ((("state" IN ('local', 'requested')) AND "environment_id" IS NULL AND "active_owner_epoch" IS NULL AND "workspace_base_manifest_ref" IS NULL AND "remote_workspace_dir" IS NULL AND "worker_bundle_hash" IS NULL AND "last_transcript_ack_cursor" IS NULL AND "last_live_event_ack_cursor" IS NULL AND "recovery_error" IS NULL) OR ("state" IS NOT DISTINCT FROM 'provisioning' AND "active_owner_epoch" IS NULL AND "workspace_base_manifest_ref" IS NULL AND "remote_workspace_dir" IS NULL AND "worker_bundle_hash" IS NULL AND "last_transcript_ack_cursor" IS NULL AND "last_live_event_ack_cursor" IS NULL AND "recovery_error" IS NULL) OR ("state" IS NOT DISTINCT FROM 'syncing' AND "environment_id" IS NOT NULL AND "active_owner_epoch" IS NULL AND "workspace_base_manifest_ref" IS NULL AND "remote_workspace_dir" IS NULL AND "worker_bundle_hash" IS NOT NULL AND "last_transcript_ack_cursor" IS NULL AND "last_live_event_ack_cursor" IS NULL AND "recovery_error" IS NULL) OR ("state" IS NOT DISTINCT FROM 'starting' AND "environment_id" IS NOT NULL AND "active_owner_epoch" IS NULL AND "workspace_base_manifest_ref" IS NOT NULL AND "remote_workspace_dir" IS NOT NULL AND "worker_bundle_hash" IS NOT NULL AND "last_transcript_ack_cursor" IS NULL AND "last_live_event_ack_cursor" IS NULL AND "recovery_error" IS NULL) OR (("state" IN ('active', 'draining', 'reconciling')) AND "environment_id" IS NOT NULL AND "active_owner_epoch" IS NOT NULL AND "workspace_base_manifest_ref" IS NOT NULL AND "remote_workspace_dir" IS NOT NULL AND "worker_bundle_hash" IS NOT NULL AND "recovery_error" IS NULL) OR ("state" IS NOT DISTINCT FROM 'reclaimed' AND "environment_id" IS NOT NULL AND "active_owner_epoch" IS NOT NULL AND "workspace_base_manifest_ref" IS NOT NULL AND "remote_workspace_dir" IS NOT NULL AND "worker_bundle_hash" IS NOT NULL AND "recovery_error" IS NULL AND "turn_claim_owner" IS NULL AND "turn_claim_id" IS NULL AND "turn_claim_run_id" IS NULL AND "turn_claim_generation" IS NULL AND "turn_claim_owner_epoch" IS NULL) OR ("state" IS NOT DISTINCT FROM 'failed' AND "recovery_error" IS NOT NULL)),
  CHECK (("turn_claim_owner" IS NULL AND "turn_claim_id" IS NULL AND "turn_claim_run_id" IS NULL AND "turn_claim_generation" IS NULL AND "turn_claim_owner_epoch" IS NULL) OR ("turn_claim_owner" IS NOT DISTINCT FROM 'local' AND "turn_claim_id" IS NOT NULL AND "turn_claim_run_id" IS NOT NULL AND "turn_claim_generation" IS NOT NULL AND "turn_claim_owner_epoch" IS NULL) OR ("turn_claim_owner" IS NOT DISTINCT FROM 'worker' AND "turn_claim_id" IS NOT NULL AND "turn_claim_run_id" IS NOT NULL AND "turn_claim_generation" IS NOT NULL AND "turn_claim_owner_epoch" IS NOT NULL)),
  CHECK ("turn_claim_owner" IS NULL OR ("turn_claim_owner" IS NOT DISTINCT FROM 'local' AND (("state" IN ('local', 'requested', 'failed')) OR (("state" IN ('active', 'draining')) AND "execution_mode" IS NOT DISTINCT FROM 'remote-exec'))) OR ("turn_claim_owner" IS NOT DISTINCT FROM 'worker' AND ("state" IN ('active', 'draining')) AND ("execution_mode" IS NULL OR "execution_mode" IS NOT DISTINCT FROM 'worker-turn') AND "turn_claim_owner_epoch" IS NOT DISTINCT FROM "active_owner_epoch"))
);

CREATE TABLE "worker_workspace_pending_results" (
  "session_id" text COLLATE "C" NOT NULL,
  "environment_id" text COLLATE "C" NOT NULL,
  "owner_epoch" bigint NOT NULL,
  "placement_generation" bigint NOT NULL,
  "claim_id" text COLLATE "C" NOT NULL,
  "run_id" text COLLATE "C" NOT NULL,
  "gateway_instance_id" text COLLATE "C" NOT NULL,
  "recovery_requested_at_ms" bigint,
  "workspace_accepted_at_ms" bigint,
  "staged_result_ref" text COLLATE "C",
  "repository_workspace_id" text COLLATE "C",
  "disk_authority_json" text COLLATE "C",
  "created_at_ms" bigint NOT NULL,
  PRIMARY KEY ("session_id"),
  CHECK (("owner_epoch" >= 1)),
  CHECK (("placement_generation" >= 0))
);

CREATE TABLE "session_repository_workspaces" (
  "workspace_id" text COLLATE "C" NOT NULL,
  "agent_id" text COLLATE "C" NOT NULL,
  "session_key" text COLLATE "C" NOT NULL,
  "url" text COLLATE "C" NOT NULL,
  "requested_ref" text COLLATE "C",
  "run_setup_script" bigint NOT NULL DEFAULT 0,
  "base_commit" text COLLATE "C",
  "base_manifest_hash" text COLLATE "C",
  "branch" text COLLATE "C" NOT NULL,
  "checkpoint_ref" text COLLATE "C",
  "manifest_hash" text COLLATE "C",
  "recovery_json" text COLLATE "C",
  "disk_authority_json" text COLLATE "C",
  "revision" bigint NOT NULL,
  "created_at_ms" bigint NOT NULL,
  "updated_at_ms" bigint NOT NULL,
  PRIMARY KEY ("workspace_id"),
  CHECK ((char_length("workspace_id") = 36)),
  CHECK ((char_length("agent_id") BETWEEN 1 AND 128)),
  CHECK ((char_length("session_key") BETWEEN 1 AND 1024)),
  CHECK ((char_length("url") BETWEEN 1 AND 4096)),
  CHECK ("requested_ref" IS NULL OR (char_length("requested_ref") BETWEEN 1 AND 1024)),
  CHECK (("run_setup_script" IN (0, 1))),
  CHECK ("base_commit" IS NULL OR (char_length("base_commit") IN (40, 64))),
  CHECK ((char_length("branch") BETWEEN 1 AND 256)),
  CHECK (("revision" >= 0)),
  CHECK ("base_manifest_hash" IS NULL OR "base_commit" IS NOT NULL),
  CHECK (("checkpoint_ref" IS NULL AND "manifest_hash" IS NULL) OR ("checkpoint_ref" IS NOT NULL AND "manifest_hash" IS NOT NULL AND "base_manifest_hash" IS NOT NULL)),
  UNIQUE ("agent_id", "session_key")
);

-- Earlier qualified v33 index declarations, before main index-ordering migrations.

CREATE INDEX "capture_events_flow_idx" ON "capture_events" (("flow_id") ASC NULLS FIRST, ("ts") ASC NULLS FIRST);
CREATE INDEX "capture_events_session_ts_idx" ON "capture_events" (("session_id") ASC NULLS FIRST, ("ts") ASC NULLS FIRST);
CREATE UNIQUE INDEX "cron_run_receipts_cursor_id_idx" ON "cron_run_receipts" (("cursor_id") ASC NULLS FIRST);
CREATE INDEX "execution_decision_facts_context_occurred_idx" ON "execution_decision_facts" (("context_id") ASC NULLS FIRST, ("occurred_at") ASC NULLS FIRST, ("receipt_id") ASC NULLS FIRST);
CREATE UNIQUE INDEX "execution_decision_facts_cursor_id_idx" ON "execution_decision_facts" (("cursor_id") ASC NULLS FIRST);
CREATE INDEX "execution_decision_facts_run_occurred_idx" ON "execution_decision_facts" (("run_id") ASC NULLS FIRST, ("occurred_at") ASC NULLS FIRST, ("receipt_id") ASC NULLS FIRST);
CREATE INDEX "execution_identity_contexts_run_created_idx" ON "execution_identity_contexts" (("run_id") ASC NULLS FIRST, ("created_at") ASC NULLS FIRST, ("execution_id") ASC NULLS FIRST);
CREATE INDEX "idx_acp_replay_sessions_key_updated" ON "acp_replay_sessions" (("session_key") ASC NULLS FIRST, ("complete") ASC NULLS FIRST, ("updated_at") DESC NULLS LAST, ("session_id") ASC NULLS FIRST);
CREATE INDEX "idx_acp_replay_sessions_updated" ON "acp_replay_sessions" (("updated_at") DESC NULLS LAST, ("session_id") ASC NULLS FIRST);
CREATE INDEX "idx_acp_sessions_agent_activity" ON "acp_sessions" (("agent") ASC NULLS FIRST, ("last_activity_at") DESC NULLS LAST, ("session_key") ASC NULLS FIRST);
CREATE INDEX "idx_acp_sessions_resume_acpx" ON "acp_sessions" (("resume_acpx_session_id") ASC NULLS FIRST);
CREATE INDEX "idx_acp_sessions_resume_agent" ON "acp_sessions" (("resume_agent_session_id") ASC NULLS FIRST);
CREATE INDEX "idx_acp_sessions_state_activity" ON "acp_sessions" (("state") ASC NULLS FIRST, ("last_activity_at") DESC NULLS LAST, ("session_key") ASC NULLS FIRST);
CREATE INDEX "idx_apns_registrations_updated" ON "apns_registrations" (("updated_at_ms") DESC NULLS LAST, ("node_id") ASC NULLS FIRST);
CREATE INDEX "idx_audit_events_agent_sequence" ON "audit_events" (("agent_id") ASC NULLS FIRST, ("sequence") DESC NULLS LAST);
CREATE INDEX "idx_audit_events_channel_sequence" ON "audit_events" (("channel") ASC NULLS FIRST, ("sequence") DESC NULLS LAST);
CREATE INDEX "idx_audit_events_direction_sequence" ON "audit_events" (("direction") ASC NULLS FIRST, ("sequence") DESC NULLS LAST);
CREATE INDEX "idx_audit_events_kind_sequence" ON "audit_events" (("kind") ASC NULLS FIRST, ("sequence") DESC NULLS LAST);
CREATE INDEX "idx_audit_events_run_sequence" ON "audit_events" (("run_id") ASC NULLS FIRST, ("sequence") DESC NULLS LAST);
CREATE INDEX "idx_audit_events_session_sequence" ON "audit_events" (("session_key") ASC NULLS FIRST, ("sequence") DESC NULLS LAST);
CREATE INDEX "idx_audit_events_status_sequence" ON "audit_events" (("status") ASC NULLS FIRST, ("sequence") DESC NULLS LAST);
CREATE INDEX "idx_audit_events_time" ON "audit_events" (("occurred_at") DESC NULLS LAST, ("sequence") DESC NULLS LAST);
CREATE INDEX "idx_backup_runs_created" ON "backup_runs" (("created_at") DESC NULLS LAST, ("id") ASC NULLS FIRST);
CREATE INDEX "idx_channel_ingress_claims" ON "channel_ingress_events" (("queue_name") ASC NULLS FIRST, ("status") ASC NULLS FIRST, ("claimed_at") ASC NULLS FIRST);
CREATE INDEX "idx_channel_ingress_lane" ON "channel_ingress_events" (("queue_name") ASC NULLS FIRST, ("status") ASC NULLS FIRST, ("lane_key") ASC NULLS FIRST);
CREATE INDEX "idx_channel_ingress_pending" ON "channel_ingress_events" (("queue_name") ASC NULLS FIRST, ("status") ASC NULLS FIRST, ("received_at") ASC NULLS FIRST, ("event_id") ASC NULLS FIRST);
CREATE INDEX "idx_channel_pairing_allow_account" ON "channel_pairing_allow_entries" (("channel_key") ASC NULLS FIRST, ("account_id") ASC NULLS FIRST, ("sort_order") ASC NULLS FIRST, ("entry") ASC NULLS FIRST);
CREATE INDEX "idx_channel_pairing_requests_code" ON "channel_pairing_requests" (("channel_key") ASC NULLS FIRST, ("code") ASC NULLS FIRST);
CREATE INDEX "idx_channel_pairing_requests_created" ON "channel_pairing_requests" (("channel_key") ASC NULLS FIRST, ("created_at") ASC NULLS FIRST, ("request_id") ASC NULLS FIRST);
CREATE INDEX "idx_cron_job_scratch_store_updated" ON "cron_job_scratch" (("store_key") ASC NULLS FIRST, ("updated_at_ms") DESC NULLS LAST, ("job_id") ASC NULLS FIRST);
CREATE INDEX "idx_cron_jobs_store_order" ON "cron_jobs" (("store_key") ASC NULLS FIRST, ("sort_order") ASC NULLS FIRST, ("updated_at") ASC NULLS FIRST, ("job_id") ASC NULLS FIRST);
CREATE UNIQUE INDEX "idx_cron_run_receipts_active_job" ON "cron_run_receipts" (("store_key") ASC NULLS FIRST, ("job_id") ASC NULLS FIRST) WHERE ("status" = 'running');
CREATE INDEX "idx_cron_run_receipts_job_history" ON "cron_run_receipts" (("store_key") ASC NULLS FIRST, ("job_id") ASC NULLS FIRST, ("started_at_ms") DESC NULLS LAST, ("receipt_id") DESC NULLS LAST);
CREATE INDEX "idx_current_conversation_bindings_conversation" ON "current_conversation_bindings" (("channel") ASC NULLS FIRST, ("account_id") ASC NULLS FIRST, ("conversation_kind") ASC NULLS FIRST, ("conversation_id") ASC NULLS FIRST);
CREATE INDEX "idx_current_conversation_bindings_expires" ON "current_conversation_bindings" (("expires_at") ASC NULLS FIRST, ("binding_key") ASC NULLS FIRST);
CREATE INDEX "idx_current_conversation_bindings_target" ON "current_conversation_bindings" (("target_session_key") ASC NULLS FIRST, ("updated_at") DESC NULLS LAST, ("binding_key") ASC NULLS FIRST);
CREATE INDEX "idx_delivery_queue_bounded_retention" ON "delivery_queue_entries" (("queue_name") ASC NULLS FIRST, ("retention_id_prefix") ASC NULLS FIRST, ("enqueued_at") DESC NULLS LAST, ("id") DESC NULLS LAST) WHERE ("status" IN ('completed', 'failed')) AND ("recovery_state" = 'completed_bounded') AND "retention_id_prefix" IS NOT NULL;
CREATE INDEX "idx_delivery_queue_failed" ON "delivery_queue_entries" (("status") ASC NULLS FIRST, ("queue_name") ASC NULLS FIRST, ("failed_at") ASC NULLS FIRST, ("id") ASC NULLS FIRST);
CREATE INDEX "idx_delivery_queue_pending" ON "delivery_queue_entries" (("queue_name") ASC NULLS FIRST, ("status") ASC NULLS FIRST, ("enqueued_at") ASC NULLS FIRST, ("id") ASC NULLS FIRST);
CREATE INDEX "idx_delivery_queue_session" ON "delivery_queue_entries" (("queue_name") ASC NULLS FIRST, ("status") ASC NULLS FIRST, ("session_key") ASC NULLS FIRST, ("enqueued_at") ASC NULLS FIRST, ("id") ASC NULLS FIRST) WHERE "session_key" IS NOT NULL;
CREATE INDEX "idx_delivery_queue_target" ON "delivery_queue_entries" (("queue_name") ASC NULLS FIRST, ("status") ASC NULLS FIRST, ("channel") ASC NULLS FIRST, ("target") ASC NULLS FIRST, ("enqueued_at") ASC NULLS FIRST, ("id") ASC NULLS FIRST) WHERE "channel" IS NOT NULL AND "target" IS NOT NULL;
CREATE INDEX "idx_device_bootstrap_tokens_ts" ON "device_bootstrap_tokens" (("ts") ASC NULLS FIRST);
CREATE INDEX "idx_device_pairing_paired_approved" ON "device_pairing_paired" (("approved_at_ms") DESC NULLS LAST, ("device_id") ASC NULLS FIRST);
CREATE INDEX "idx_device_pairing_pending_device" ON "device_pairing_pending" (("device_id") ASC NULLS FIRST, ("ts") DESC NULLS LAST);
CREATE INDEX "idx_diagnostic_events_scope_sequence" ON "diagnostic_events" (("scope") ASC NULLS FIRST, ("sequence") ASC NULLS FIRST, ("event_key") ASC NULLS FIRST);
CREATE INDEX "idx_flow_runs_owner_key" ON "flow_runs" (("owner_key") ASC NULLS FIRST);
CREATE INDEX "idx_flow_runs_status" ON "flow_runs" (("status") ASC NULLS FIRST);
CREATE INDEX "idx_flow_runs_updated_at" ON "flow_runs" (("updated_at") ASC NULLS FIRST);
CREATE INDEX "idx_gateway_boot_lifecycle_started" ON "gateway_boot_lifecycle" (("started_at_ms") ASC NULLS FIRST);
CREATE INDEX "idx_gateway_restart_handoff_expiry" ON "gateway_restart_handoff" (("expires_at") ASC NULLS FIRST, ("pid") ASC NULLS FIRST);
CREATE INDEX "idx_gateway_restart_sentinel_ts" ON "gateway_restart_sentinel" (("ts") DESC NULLS LAST, ("sentinel_key") ASC NULLS FIRST);
CREATE INDEX "idx_github_personal_publication_owner_session" ON "github_personal_publication_requests" (("owner_profile_id") ASC NULLS FIRST, ("session_id") ASC NULLS FIRST, ("created_at_ms") ASC NULLS FIRST);
CREATE INDEX "idx_github_personal_publication_pending" ON "github_personal_publication_requests" (("status") ASC NULLS FIRST, ("updated_at_ms") ASC NULLS FIRST, ("request_id") ASC NULLS FIRST);
CREATE INDEX "idx_github_publication_requests_pending" ON "github_publication_requests" (("status") ASC NULLS FIRST, ("updated_at_ms") ASC NULLS FIRST, ("request_id") ASC NULLS FIRST);
CREATE UNIQUE INDEX "idx_github_repository_publication_personal_request" ON "github_repository_publication_requests" (("owner_profile_id") ASC NULLS FIRST, ("session_id") ASC NULLS FIRST, ("idempotency_key") ASC NULLS FIRST) WHERE "owner_profile_id" IS NOT NULL;
CREATE UNIQUE INDEX "idx_github_repository_publication_shared_request" ON "github_repository_publication_requests" (("session_id") ASC NULLS FIRST, ("idempotency_key") ASC NULLS FIRST) WHERE "owner_profile_id" IS NULL;
CREATE INDEX "idx_macos_port_guardian_records_port" ON "macos_port_guardian_records" (("port") ASC NULLS FIRST, ("timestamp") DESC NULLS LAST);
CREATE INDEX "idx_managed_outgoing_images_agent_message" ON "managed_outgoing_image_records" (("session_key") ASC NULLS FIRST, ("agent_id") ASC NULLS FIRST, ("message_id") ASC NULLS FIRST, ("attachment_id") ASC NULLS FIRST) WHERE "message_id" IS NOT NULL;
CREATE INDEX "idx_managed_outgoing_images_agent_session" ON "managed_outgoing_image_records" (("session_key") ASC NULLS FIRST, ("agent_id") ASC NULLS FIRST, ("created_at") DESC NULLS LAST, ("attachment_id") ASC NULLS FIRST);
CREATE INDEX "idx_managed_outgoing_images_message" ON "managed_outgoing_image_records" (("session_key") ASC NULLS FIRST, ("message_id") ASC NULLS FIRST, ("attachment_id") ASC NULLS FIRST) WHERE "message_id" IS NOT NULL;
CREATE INDEX "idx_managed_outgoing_images_session" ON "managed_outgoing_image_records" (("session_key") ASC NULLS FIRST, ("created_at") DESC NULLS LAST, ("attachment_id") ASC NULLS FIRST);
CREATE INDEX "idx_meeting_transcript_sessions_account" ON "meeting_transcript_sessions" (("source_account_id") ASC NULLS FIRST);
CREATE INDEX "idx_meeting_transcript_sessions_agent" ON "meeting_transcript_sessions" (("metadata_agent_id") ASC NULLS FIRST);
CREATE INDEX "idx_meeting_transcript_sessions_chronology" ON "meeting_transcript_sessions" (("started_at_ms") DESC NULLS LAST, ("session_id") ASC NULLS FIRST, ("started_at") ASC NULLS FIRST);
CREATE INDEX "idx_meeting_transcript_sessions_export_key" ON "meeting_transcript_sessions" (("export_key") ASC NULLS FIRST);
CREATE INDEX "idx_meeting_transcript_sessions_id" ON "meeting_transcript_sessions" (("session_id") ASC NULLS FIRST, ("started_at") DESC NULLS LAST);
CREATE INDEX "idx_meeting_transcript_sessions_slug" ON "meeting_transcript_sessions" (("session_slug") ASC NULLS FIRST, ("started_at") DESC NULLS LAST);
CREATE INDEX "idx_meeting_transcript_sessions_source" ON "meeting_transcript_sessions" (("provider_id") ASC NULLS FIRST, ("source_account_id") ASC NULLS FIRST, ("source_guild_id") ASC NULLS FIRST, ("source_channel_id") ASC NULLS FIRST, ("source_meeting_url") ASC NULLS FIRST, ("source_thread_ts") ASC NULLS FIRST, ("source_file_id") ASC NULLS FIRST, ("stopped_at") DESC NULLS LAST, ("started_at") DESC NULLS LAST, ("session_id") ASC NULLS FIRST);
CREATE INDEX "idx_meeting_transcript_sessions_started" ON "meeting_transcript_sessions" (("started_at") DESC NULLS LAST, ("session_id") ASC NULLS FIRST);
CREATE INDEX "idx_meeting_transcript_utterances_id" ON "meeting_transcript_utterances" (("session_id") ASC NULLS FIRST, ("session_started_at") ASC NULLS FIRST, ("utterance_id") ASC NULLS FIRST) WHERE "utterance_id" IS NOT NULL;
CREATE INDEX "idx_migration_runs_started" ON "migration_runs" (("started_at") DESC NULLS LAST, ("id") ASC NULLS FIRST);
CREATE INDEX "idx_migration_sources_path" ON "migration_sources" (("source_path") ASC NULLS FIRST, ("migration_kind") ASC NULLS FIRST, ("target_table") ASC NULLS FIRST);
CREATE INDEX "idx_migration_sources_run" ON "migration_sources" (("last_run_id") ASC NULLS FIRST, ("source_path") ASC NULLS FIRST);
CREATE INDEX "idx_native_hook_relay_bridges_expires" ON "native_hook_relay_bridges" (("expires_at_ms") ASC NULLS FIRST, ("relay_id") ASC NULLS FIRST);
CREATE INDEX "idx_node_worker_launches_terminal_completed" ON "node_worker_launches" (("completed_at_ms") ASC NULLS FIRST, ("launch_id") ASC NULLS FIRST) WHERE "completed_at_ms" IS NOT NULL;
CREATE UNIQUE INDEX "idx_node_worker_turns_active_owner" ON "node_worker_turns" (("owner_launch_id") ASC NULLS FIRST) WHERE ("state" = 'running');
CREATE INDEX "idx_node_worker_turns_terminal_completed" ON "node_worker_turns" (("completed_at_ms") ASC NULLS FIRST, ("turn_id") ASC NULLS FIRST) WHERE "completed_at_ms" IS NOT NULL;
CREATE INDEX "idx_official_external_plugin_catalog_snapshots_updated" ON "official_external_plugin_catalog_snapshots" (("updated_at_ms") DESC NULLS LAST, ("feed_url") ASC NULLS FIRST);
CREATE INDEX "idx_operator_approval_standing_grants_binding" ON "operator_approval_standing_grants" (("agent_id") ASC NULLS FIRST, ("cron_job_id") ASC NULLS FIRST, ("operation_binding") ASC NULLS FIRST, ("created_at_ms") DESC NULLS LAST);
CREATE UNIQUE INDEX "idx_operator_approvals_cursor_id" ON "operator_approvals" (("cursor_id") ASC NULLS FIRST);
CREATE UNIQUE INDEX "idx_operator_approvals_resolution_ref" ON "operator_approvals" (("resolution_ref") ASC NULLS FIRST);
CREATE INDEX "idx_operator_approvals_resolved" ON "operator_approvals" (("resolved_at_ms") ASC NULLS FIRST, ("approval_id") ASC NULLS FIRST) WHERE "resolved_at_ms" IS NOT NULL;
CREATE INDEX "idx_operator_approvals_runtime_pending" ON "operator_approvals" (("runtime_epoch") ASC NULLS FIRST, ("approval_id") ASC NULLS FIRST) WHERE ("status" = 'pending');
CREATE INDEX "idx_operator_approvals_source_run_resolved" ON "operator_approvals" (("source_run_id") ASC NULLS FIRST, ("resolved_at_ms") ASC NULLS FIRST, ("approval_id") ASC NULLS FIRST) WHERE "source_run_id" IS NOT NULL AND "resolved_at_ms" IS NOT NULL;
CREATE INDEX "idx_operator_approvals_source_session_created" ON "operator_approvals" (("source_session_key") ASC NULLS FIRST, ("created_at_ms") DESC NULLS LAST, ("approval_id") ASC NULLS FIRST);
CREATE INDEX "idx_operator_approvals_status_expiry" ON "operator_approvals" (("status") ASC NULLS FIRST, ("expires_at_ms") ASC NULLS FIRST, ("approval_id") ASC NULLS FIRST);
CREATE INDEX "idx_plugin_binding_approvals_plugin" ON "plugin_binding_approvals" (("plugin_id") ASC NULLS FIRST, ("approved_at") DESC NULLS LAST);
CREATE INDEX "idx_plugin_blob_expiry" ON "plugin_blob_entries" (("expires_at") ASC NULLS FIRST) WHERE "expires_at" IS NOT NULL;
CREATE INDEX "idx_plugin_blob_listing" ON "plugin_blob_entries" (("plugin_id") ASC NULLS FIRST, ("namespace") ASC NULLS FIRST, ("created_at") ASC NULLS FIRST, ("entry_key") ASC NULLS FIRST);
CREATE INDEX "idx_plugin_state_expiry" ON "plugin_state_entries" (("expires_at") ASC NULLS FIRST) WHERE "expires_at" IS NOT NULL;
CREATE INDEX "idx_plugin_state_listing" ON "plugin_state_entries" (("plugin_id") ASC NULLS FIRST, ("namespace") ASC NULLS FIRST, ("created_at") ASC NULLS FIRST, ("entry_key") ASC NULLS FIRST, ("expires_at") ASC NULLS FIRST);
CREATE INDEX "idx_sandbox_persistent_execs_container" ON "sandbox_persistent_execs" (("container_id") ASC NULLS FIRST, ("owner_key") ASC NULLS FIRST);
CREATE INDEX "idx_sandbox_persistent_execs_container_name" ON "sandbox_persistent_execs" (("container_name") ASC NULLS FIRST, ("owner_key") ASC NULLS FIRST);
CREATE INDEX "idx_sandbox_persistent_execs_source" ON "sandbox_persistent_execs" (("source_identity") ASC NULLS FIRST, ("owner_key") ASC NULLS FIRST);
CREATE INDEX "idx_sandbox_registry_last_used" ON "sandbox_registry_entries" (("registry_kind") ASC NULLS FIRST, ("last_used_at_ms") DESC NULLS LAST, ("container_name") ASC NULLS FIRST) WHERE "last_used_at_ms" IS NOT NULL;
CREATE INDEX "idx_sandbox_registry_session" ON "sandbox_registry_entries" (("registry_kind") ASC NULLS FIRST, ("session_key") ASC NULLS FIRST, ("last_used_at_ms") DESC NULLS LAST, ("container_name") ASC NULLS FIRST) WHERE "session_key" IS NOT NULL;
CREATE INDEX "idx_sandbox_registry_updated" ON "sandbox_registry_entries" (("registry_kind") ASC NULLS FIRST, ("updated_at") DESC NULLS LAST, ("container_name") ASC NULLS FIRST);
CREATE INDEX "idx_session_state_events_session_sequence" ON "session_state_events" (("session_key") ASC NULLS FIRST, ("sequence") DESC NULLS LAST);
CREATE INDEX "idx_session_state_events_time" ON "session_state_events" (("occurred_at") DESC NULLS LAST, ("sequence") DESC NULLS LAST);
CREATE INDEX "idx_session_upstream_links_catalog_id" ON "session_upstream_links" (("catalog_id") ASC NULLS FIRST);
CREATE INDEX "idx_session_watch_cursors_target" ON "session_watch_cursors" (("target_session_key") ASC NULLS FIRST);
CREATE INDEX "idx_skill_uploads_expiry" ON "skill_uploads" (("expires_at") ASC NULLS FIRST);
CREATE INDEX "idx_skill_uploads_idempotency" ON "skill_uploads" (("idempotency_key_hash") ASC NULLS FIRST) WHERE "idempotency_key_hash" IS NOT NULL;
CREATE INDEX "idx_skill_workshop_changes_agent_time" ON "skill_workshop_changes" (("agent_id") ASC NULLS FIRST, ("created_at_ms") ASC NULLS FIRST);
CREATE INDEX "idx_state_leases_expiry" ON "state_leases" (("expires_at") ASC NULLS FIRST, ("scope") ASC NULLS FIRST, ("lease_key") ASC NULLS FIRST) WHERE "expires_at" IS NOT NULL;
CREATE INDEX "idx_state_leases_owner" ON "state_leases" (("owner") ASC NULLS FIRST);
CREATE INDEX "idx_subagent_runs_child_session_key" ON "subagent_runs" (("child_session_key") ASC NULLS FIRST, ("created_at") DESC NULLS LAST, ("run_id") ASC NULLS FIRST);
CREATE INDEX "idx_subagent_runs_controller_session_key" ON "subagent_runs" (("controller_session_key") ASC NULLS FIRST, ("created_at") DESC NULLS LAST, ("run_id") ASC NULLS FIRST);
CREATE INDEX "idx_subagent_runs_requester_session_key" ON "subagent_runs" (("requester_session_key") ASC NULLS FIRST, ("created_at") DESC NULLS LAST, ("run_id") ASC NULLS FIRST);
CREATE INDEX "idx_task_runs_cron_runtime_order" ON "task_runs" (("runtime") ASC NULLS FIRST, ("created_at") ASC NULLS FIRST, ("task_id") ASC NULLS FIRST) WHERE ("runtime" = 'cron');
CREATE INDEX "idx_task_runs_cron_source_order" ON "task_runs" (("source_id") ASC NULLS FIRST, ("created_at") ASC NULLS FIRST, ("task_id") ASC NULLS FIRST) WHERE ("runtime" = 'cron');
CREATE INDEX "idx_task_runs_runtime_run" ON "task_runs" (("runtime") ASC NULLS FIRST, ("run_id") ASC NULLS FIRST, ("source_id") ASC NULLS FIRST, ("created_at") ASC NULLS FIRST, ("task_id") ASC NULLS FIRST);
CREATE INDEX "idx_update_runs_active" ON "update_runs" (("status") ASC NULLS FIRST, ("created_at_ms") DESC NULLS LAST, ("run_id") ASC NULLS FIRST);
CREATE INDEX "idx_update_runs_created" ON "update_runs" (("created_at_ms") DESC NULLS LAST, ("run_id") ASC NULLS FIRST);
CREATE INDEX "idx_user_profile_emails_profile_id" ON "user_profile_emails" (("profile_id") ASC NULLS FIRST);
CREATE UNIQUE INDEX "idx_user_profile_identities_authorization" ON "user_profile_identities" (("authorization_id") ASC NULLS FIRST);
CREATE INDEX "idx_user_profile_identities_profile_id" ON "user_profile_identities" (("profile_id") ASC NULLS FIRST);
CREATE INDEX "idx_web_push_approval_deliveries_subscription" ON "web_push_approval_deliveries" (("subscription_id") ASC NULLS FIRST, ("approval_id") ASC NULLS FIRST);
CREATE INDEX "idx_web_push_subscriptions_updated" ON "web_push_subscriptions" (("updated_at_ms") DESC NULLS LAST, ("subscription_id") ASC NULLS FIRST);
CREATE UNIQUE INDEX "idx_worker_environments_provider_lease" ON "worker_environments" (("provider_id") ASC NULLS FIRST, ("lease_id") ASC NULLS FIRST) WHERE "lease_id" IS NOT NULL;
CREATE INDEX "idx_worker_environments_terminal_changed" ON "worker_environments" (("state_changed_at_ms") ASC NULLS FIRST, ("environment_id") ASC NULLS FIRST);
CREATE UNIQUE INDEX "idx_worker_inference_turns_pending_run" ON "worker_inference_turns" (("session_id") ASC NULLS FIRST, ("run_epoch") ASC NULLS FIRST, ("run_id") ASC NULLS FIRST) WHERE ("state" = 'pending');
CREATE INDEX "idx_worker_session_placements_environment" ON "worker_session_placements" (("environment_id") ASC NULLS FIRST) WHERE "environment_id" IS NOT NULL;
CREATE INDEX "idx_worker_session_placements_reconcile" ON "worker_session_placements" (("updated_at_ms") ASC NULLS FIRST, ("session_id") ASC NULLS FIRST);
CREATE INDEX "idx_worker_session_placements_session_key" ON "worker_session_placements" (("agent_id") ASC NULLS FIRST, ("session_key") ASC NULLS FIRST);
CREATE INDEX "idx_workspace_path_aliases_workspace" ON "workspace_path_aliases" (("workspace_key") ASC NULLS FIRST);
CREATE INDEX "idx_workspace_setup_state_path" ON "workspace_setup_state" (("workspace_path") ASC NULLS FIRST);
CREATE INDEX "idx_worktrees_removed_at" ON "worktrees" (("removed_at") ASC NULLS FIRST);
CREATE INDEX "idx_worktrees_repo_fingerprint" ON "worktrees" (("repo_fingerprint") ASC NULLS FIRST);
CREATE INDEX "outbound_message_execution_bindings_execution_event_idx" ON "outbound_message_execution_bindings" (("context_id") ASC NULLS FIRST, ("execution_id") ASC NULLS FIRST, ("run_id") ASC NULLS FIRST, ("event_id") ASC NULLS FIRST);
CREATE INDEX "outbound_message_progress_occurred_idx" ON "outbound_message_progress" (("occurred_at") ASC NULLS FIRST, ("sequence") ASC NULLS FIRST);
CREATE INDEX "outbound_message_progress_run_occurred_idx" ON "outbound_message_progress" (("run_id") ASC NULLS FIRST, ("occurred_at") ASC NULLS FIRST, ("sequence") ASC NULLS FIRST);
CREATE INDEX "secret_store_entries_live_idx" ON "secret_store_entries" (("scope_kind") ASC NULLS FIRST, ("scope_id") ASC NULLS FIRST, ("name") ASC NULLS FIRST) WHERE "deleted_at_ms" IS NULL;
CREATE UNIQUE INDEX "skill_workshop_changes_cursor_id_idx" ON "skill_workshop_changes" (("cursor_id") ASC NULLS FIRST);
CREATE INDEX "worker_environment_session_attachments_session_key" ON "worker_environment_session_attachments" (("agent_id") ASC NULLS FIRST, ("session_key") ASC NULLS FIRST);
