import fs from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  resolvePortableArchivePathKey,
  buildBackupArchivePath,
} from "../infra/backup-archive-path-policy.js";
import { readEngineAnchor } from "../infra/database-engine/open.js";
import { isPostgresCompanionSelection } from "../infra/database-engine/registry.js";
import type { DatabaseEngineSelection } from "../infra/database-engine/types.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { SQLITE_SIDECAR_SUFFIXES } from "../infra/sqlite-files.js";
import { assertSqliteIntegrity } from "../infra/sqlite-integrity.js";
import type { BackupManifest, NormalizedArchiveEntry } from "./backup-verify-manifest.js";

type SqliteSnapshotOwner = { archivePath: string } & (
  | { role: "global" }
  | { role: "agent"; agentId: string }
);

export const LOCAL_COMPANION_WARNING =
  "Local-companion checkpoint contains no PostgreSQL rows and is not disaster recovery; restore keeps the same PostgreSQL stores and namespaces.";

export function assertLocalCompanionSelection(
  selection: DatabaseEngineSelection | undefined,
  onlyConfig: boolean,
): asserts selection is DatabaseEngineSelection {
  if (onlyConfig || !isPostgresCompanionSelection(selection)) {
    throw new Error(
      "Local companion capture requires PostgreSQL for all portable database families.",
    );
  }
}

/** Legacy audit reconciliation needs a source write lease, unlike these read-only profiles. */
export function assertMutableLegacyAuditCapture(options: {
  preserveSourceArtifacts?: boolean;
  localCompanion?: boolean;
}): void {
  if (options.preserveSourceArtifacts || options.localCompanion) {
    throw new Error(
      "Quiesced migration capture requires legacy audit migration to finish before suspension; no source write lease was acquired.",
    );
  }
}

export type BackupManifestPostgresAnchor = {
  sourcePath: string;
  storeId: string;
  namespace: string;
};

function parseBackupManifestPostgresAnchors(
  value: unknown,
  parseSourcePath: (value: unknown, label: string) => string,
): BackupManifestPostgresAnchor[] {
  if (!Array.isArray(value)) {
    throw new Error("Local-companion manifest requires PostgreSQL anchor inventory.");
  }
  const paths = new Set<string>();
  return value.map((anchor) => {
    if (
      !isRecord(anchor) ||
      Object.keys(anchor).length !== 3 ||
      typeof anchor.storeId !== "string" ||
      !anchor.storeId.trim() ||
      typeof anchor.namespace !== "string" ||
      !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(anchor.namespace)
    ) {
      throw new Error("Backup manifest contains an invalid PostgreSQL anchor.");
    }
    const sourcePath = parseSourcePath(anchor.sourcePath, "PostgreSQL anchor");
    const key = sourcePath.replaceAll("\\", "/").normalize("NFC").toLowerCase();
    if (paths.has(key)) {
      throw new Error("Backup manifest contains duplicate PostgreSQL anchor paths.");
    }
    paths.add(key);
    return { sourcePath, storeId: anchor.storeId, namespace: anchor.namespace };
  });
}

export function parseLocalCompanionProfile(
  parsed: Record<string, unknown>,
  parseSourcePath: (value: unknown, label: string) => string,
): { profile?: "local-companion"; postgresAnchors?: BackupManifestPostgresAnchor[] } {
  if (parsed.profile !== undefined && parsed.profile !== "local-companion") {
    throw new Error("Backup manifest contains an unsupported profile.");
  }
  const postgresAnchors =
    parsed.profile === "local-companion"
      ? parseBackupManifestPostgresAnchors(parsed.postgresAnchors, parseSourcePath)
      : undefined;
  if (parsed.profile === "local-companion") {
    if (
      !Array.isArray(parsed.postgresSnapshots) ||
      parsed.postgresSnapshots.length !== 0 ||
      !Array.isArray(parsed.sqliteSnapshots)
    ) {
      throw new Error(
        "Local-companion backups require SQLite inventory and no PostgreSQL exports.",
      );
    }
  } else if (parsed.postgresAnchors !== undefined) {
    throw new Error("PostgreSQL anchor inventory requires the local-companion profile.");
  }

  return parsed.profile === "local-companion" ? { profile: parsed.profile, postgresAnchors } : {};
}

export function isRegularArchiveFile(entryType: string | undefined): boolean {
  return entryType === "File" || entryType === "OldFile" || entryType === "ContiguousFile";
}

export async function assertSqliteSnapshotFileShape(
  extractedPath: string,
  archivePath: string,
  expectedSize: number,
): Promise<void> {
  const header = Buffer.alloc(100);
  const handle = await fs.open(extractedPath, "r");
  try {
    const { bytesRead } = await handle.read(header, 0, header.byteLength, 0);
    if (
      bytesRead !== header.byteLength ||
      header.subarray(0, 16).toString("utf8") !== "SQLite format 3\u0000"
    ) {
      throw new Error(`SQLite snapshot ${archivePath} has an invalid database header.`);
    }
  } finally {
    await handle.close();
  }

  const encodedPageSize = header.readUInt16BE(16);
  const pageSize = encodedPageSize === 1 ? 65_536 : encodedPageSize;
  const validPageSize = pageSize >= 512 && pageSize <= 65_536 && (pageSize & (pageSize - 1)) === 0;
  if (!validPageSize || expectedSize % pageSize !== 0) {
    throw new Error(`SQLite snapshot ${archivePath} has an invalid page layout.`);
  }

  const changeCounter = header.readUInt32BE(24);
  const declaredPageCount = header.readUInt32BE(28);
  const versionValidFor = header.readUInt32BE(92);
  const hasAuthoritativePageCount = declaredPageCount !== 0 && changeCounter === versionValidFor;
  if (hasAuthoritativePageCount && declaredPageCount !== expectedSize / pageSize) {
    throw new Error(`SQLite snapshot ${archivePath} has an invalid page layout.`);
  }
}

export async function verifyLocalCompanionAnchors(
  entries: NormalizedArchiveEntry[],
  manifest: BackupManifest,
  prepareArtifacts: (entries: NormalizedArchiveEntry[]) => Promise<string>,
): Promise<{ owners: SqliteSnapshotOwner[]; paths: Set<string> }> {
  if (manifest.profile !== "local-companion" || !manifest.postgresAnchors?.length) {
    return { owners: [], paths: new Set() };
  }
  const anchors = manifest.postgresAnchors.map((anchor) => ({
    ...anchor,
    archivePath: buildBackupArchivePath(manifest.archiveRoot, anchor.sourcePath),
  }));
  const artifacts = anchors.map((anchor) => {
    const entry = entries.find((candidate) => candidate.normalized === anchor.archivePath);
    if (
      !entry ||
      !isRegularArchiveFile(entry.type) ||
      entry.size === undefined ||
      SQLITE_SIDECAR_SUFFIXES.some((suffix) =>
        entries.some(
          (candidate) =>
            resolvePortableArchivePathKey(candidate.normalized) ===
            resolvePortableArchivePathKey(`${anchor.archivePath}${suffix}`),
        ),
      )
    ) {
      throw new Error(
        `Local-companion anchor is missing, invalid, or has sidecars: ${anchor.archivePath}`,
      );
    }
    return entry;
  });
  const tempDir = await prepareArtifacts(artifacts);
  for (const entry of artifacts) {
    await assertSqliteSnapshotFileShape(
      path.join(tempDir, entry.normalized),
      entry.normalized,
      entry.size!,
    );
  }
  const owners = anchors.flatMap((anchor): SqliteSnapshotOwner[] => {
    const imagePath = path.join(tempDir, anchor.archivePath);
    using database = openNodeSqliteDatabase(imagePath, { readOnly: true });
    database.exec("PRAGMA query_only = ON; PRAGMA trusted_schema = OFF;");
    assertSqliteIntegrity(database, anchor.archivePath);
    const rows = readEngineAnchor(database);
    if (
      rows?.length !== 1 ||
      rows[0]?.engine !== "postgres" ||
      rows[0].store_id !== anchor.storeId ||
      rows[0].schema !== anchor.namespace
    ) {
      throw new Error(`Local-companion PostgreSQL identity mismatch: ${anchor.archivePath}`);
    }
    const owner = manifest.sqliteSnapshots!.find(
      (snapshot) => snapshot.sourcePath === anchor.sourcePath,
    );
    return owner ? [{ ...owner, archivePath: anchor.archivePath }] : [];
  });
  return { owners, paths: new Set(anchors.map((anchor) => anchor.archivePath)) };
}
