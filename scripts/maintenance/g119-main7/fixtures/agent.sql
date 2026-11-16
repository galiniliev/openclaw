-- DISPOSABLE REHEARSAL ONLY. Execute in the Native-created source-agent39 namespace.
INSERT INTO schema_meta(meta_key,role,schema_version,agent_id,app_version,created_at,updated_at)
VALUES ('primary','agent',39,'main','fixture-g119',1,1);
INSERT INTO session_key_contract(id,main_key,updated_at) VALUES (1,'main',0);
INSERT INTO memory_index_state(id,revision) VALUES (1,0);
INSERT INTO session_nodes(session_key,current_session_id,entry_json,entry_valid,updated_at,status,display_name)
VALUES ('agent:main:dashboard:fixture-preserved','019a848b-7c00-7000-8000-000000000001','{"sessionId":"019a848b-7c00-7000-8000-000000000001","lifecycleRevision":"fixture-incarnation-1","updatedAt":1794700800000,"displayName":"Preserved fixture conversation","status":"done"}',1,1794700800000,'done','Preserved fixture conversation');
INSERT INTO session_windows(session_id,session_key,reason,created_at,updated_at,transcript_updated_at,
 model_provider,model,display_name)
VALUES ('019a848b-7c00-7000-8000-000000000001','agent:main:dashboard:fixture-preserved','initial',1794700800000,1794700800000,1794700800000,'fixture','fixture-model','Preserved fixture conversation');
INSERT INTO transcript_events(session_id,seq,event_json,created_at,message_role)
VALUES ('019a848b-7c00-7000-8000-000000000001',1,'{"type":"message","id":"fixture-message-1","message":{"role":"user","content":"Preserve this transcript exactly."}}',1794700800000,'user');
INSERT INTO session_transcript_fts_rows(id,session_id,message_id) VALUES (17,'019a848b-7c00-7000-8000-000000000001','fixture-message-1');
INSERT INTO session_transcript_fts(rowid,text,session_id,message_id,role,timestamp)
VALUES (17,'Preserve this transcript exactly.','019a848b-7c00-7000-8000-000000000001','fixture-message-1','user',1794700800000);

INSERT INTO session_creation_operations(operation_digest,request_fingerprint,session_id,expires_at)
VALUES ('036088e7af76a74673329138918d63f580d172bb2c2697590ac534dbf374c43f','3b3b0d8196a7c5e241e66cb5d0f221d87cc17fab707979b337d8d68f75b55460','01a05a43-fc00-7000-8000-000000000009',1790812800000);

-- Real memory contents with deterministic two-dimensional Float32 little-endian [1,2].
-- Search extensions/derived rich-search DDL must be installed by the Native owner, not seed SQL.
INSERT INTO memory_index_sources(id,path,source,hash,mtime,size)
VALUES (23,'memory/fixture.md','memory','fixture-memory-source-hash',1794700800,53);
INSERT INTO memory_index_chunks(chunk_rowid,id,path,source,start_line,end_line,hash,model,text,embedding,updated_at)
VALUES (29,'fixture-memory-chunk','memory/fixture.md','memory',2,3,'fixture-memory-chunk-hash',
 'fixture-embedding-v1','Café fixture: retain vector and keyword evidence.',decode('0000803f00000040','hex'),1794700800000);
INSERT INTO memory_embedding_cache(provider,model,provider_key,hash,embedding,dims,updated_at)
VALUES ('fixture','fixture-embedding-v1','fixture-provider-key','fixture-memory-chunk-hash',
 decode('0000803f00000040','hex'),2,1794700800000);
INSERT INTO memory_index_chunk_provenance(chunk_id,origin_class,session_kind,observed_at)
VALUES ('fixture-memory-chunk','owner','interactive',1794700800000);
INSERT INTO memory_index_chunk_recall_metadata(chunk_id,importance,triggers,project_key)
VALUES ('fixture-memory-chunk',8,'fixture keyword preservation','fixture/preserved');
