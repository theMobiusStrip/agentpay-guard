import type { DatabaseSync } from "node:sqlite";

export const SCHEMA_VERSION = 1;

const RESERVATION_COLUMNS = [
  "id",
  "principal_id",
  "mandate_id",
  "amount_atomic",
  "pay_to",
  "status",
  "reserved_at_ms",
  "settled_at_ms",
  "safe_release_at_ms",
  "recovery_release_at_ms",
  "window_ms",
  "network",
  "asset",
  "payer",
  "authorization_nonce",
  "valid_before_s",
  "settlement_tx",
  "updated_at_ms",
] as const;

const RESERVATION_INDEXES = [
  "reservations_mandate_status",
  "reservations_principal_status",
  "reservations_payee_status",
  "reservations_safe_release",
  "reservations_recovery_release",
  "reservations_authorization",
] as const;

const CREATE_SCHEMA = `
  CREATE TABLE schema_meta (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    schema_version INTEGER NOT NULL,
    created_at_ms INTEGER NOT NULL,
    migrated_at_ms INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE reservations (
    id TEXT PRIMARY KEY,
    principal_id TEXT NOT NULL,
    mandate_id TEXT NOT NULL,
    amount_atomic TEXT NOT NULL CHECK (
      amount_atomic <> ''
      AND amount_atomic NOT GLOB '*[^0-9]*'
      AND (amount_atomic = '0' OR substr(amount_atomic, 1, 1) <> '0')
    ),
    pay_to TEXT NOT NULL,
    status TEXT NOT NULL CHECK (
      status IN (
        'reserved',
        'signed',
        'submitted',
        'settled',
        'unknown',
        'expired',
        'released'
      )
    ),
    reserved_at_ms INTEGER NOT NULL,
    settled_at_ms INTEGER,
    safe_release_at_ms INTEGER NOT NULL,
    recovery_release_at_ms INTEGER NOT NULL,
    window_ms INTEGER NOT NULL CHECK (window_ms > 0),
    network TEXT,
    asset TEXT,
    payer TEXT,
    authorization_nonce TEXT,
    valid_before_s INTEGER,
    settlement_tx TEXT,
    updated_at_ms INTEGER NOT NULL,
    CHECK (recovery_release_at_ms >= safe_release_at_ms + window_ms),
    CHECK (
      (
        network IS NULL
        AND asset IS NULL
        AND payer IS NULL
        AND authorization_nonce IS NULL
        AND valid_before_s IS NULL
      )
      OR
      (
        network IS NOT NULL
        AND asset IS NOT NULL
        AND payer IS NOT NULL
        AND authorization_nonce IS NOT NULL
        AND valid_before_s IS NOT NULL
      )
    )
  ) STRICT;

  CREATE INDEX reservations_mandate_status
    ON reservations (principal_id, mandate_id, status);
  CREATE INDEX reservations_principal_status
    ON reservations (principal_id, status);
  CREATE INDEX reservations_payee_status
    ON reservations (principal_id, pay_to, status);
  CREATE INDEX reservations_safe_release
    ON reservations (status, safe_release_at_ms);
  CREATE INDEX reservations_recovery_release
    ON reservations (status, recovery_release_at_ms);
  CREATE UNIQUE INDEX reservations_authorization
    ON reservations (
      asset COLLATE NOCASE,
      payer COLLATE NOCASE,
      authorization_nonce COLLATE NOCASE
    )
    WHERE authorization_nonce IS NOT NULL;

  CREATE TABLE dedup (
    key_digest BLOB PRIMARY KEY,
    expires_at_ms INTEGER NOT NULL
  ) STRICT;
`;

function tableNames(db: DatabaseSync): string[] {
  return db
    .prepare(
      `SELECT name
       FROM sqlite_master
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
       ORDER BY name`,
    )
    .all()
    .map((row) => {
      const name = row["name"];
      if (typeof name !== "string") {
        throw new Error("invalid SQLite schema table name");
      }
      return name;
    });
}

function validateColumns(
  db: DatabaseSync,
  table: string,
  expected: readonly string[],
  primaryKey: string,
): void {
  const rows = db.prepare(`PRAGMA table_info('${table}')`).all();
  const names = rows.map((row) => {
    const name = row["name"];
    if (typeof name !== "string") {
      throw new Error(`invalid SQLite ${table} column`);
    }
    return name;
  });
  if (
    names.length !== expected.length ||
    names.some((name, index) => name !== expected[index])
  ) {
    throw new Error(`invalid SQLite schema: ${table} columns differ`);
  }
  const pk = rows.find((row) => row["name"] === primaryKey)?.["pk"];
  if (pk !== 1) {
    throw new Error(`invalid SQLite schema: ${table} primary key differs`);
  }
}

function validateCurrentSchema(db: DatabaseSync): void {
  validateColumns(
    db,
    "schema_meta",
    [
      "singleton",
      "schema_version",
      "created_at_ms",
      "migrated_at_ms",
    ],
    "singleton",
  );
  validateColumns(
    db,
    "reservations",
    RESERVATION_COLUMNS,
    "id",
  );
  validateColumns(
    db,
    "dedup",
    ["key_digest", "expires_at_ms"],
    "key_digest",
  );

  const indexes = db
    .prepare("PRAGMA index_list('reservations')")
    .all();
  const names = new Set(
    indexes.map((row) => {
      const name = row["name"];
      if (typeof name !== "string") {
        throw new Error("invalid SQLite reservations index");
      }
      return name;
    }),
  );
  for (const expected of RESERVATION_INDEXES) {
    if (!names.has(expected)) {
      throw new Error(
        `invalid SQLite schema: ${expected} index missing`,
      );
    }
  }
  const authorization = indexes.find(
    (row) => row["name"] === "reservations_authorization",
  );
  if (
    authorization?.["unique"] !== 1 ||
    authorization["partial"] !== 1
  ) {
    throw new Error(
      "invalid SQLite schema: authorization index differs",
    );
  }
  const authorizationColumns = db
    .prepare("PRAGMA index_info('reservations_authorization')")
    .all()
    .map((row) => row["name"]);
  if (
    authorizationColumns.length !== 3 ||
    authorizationColumns[0] !== "asset" ||
    authorizationColumns[1] !== "payer" ||
    authorizationColumns[2] !== "authorization_nonce"
  ) {
    throw new Error(
      "invalid SQLite schema: authorization index columns differ",
    );
  }
  const authorizationKeyRows = db
    .prepare("PRAGMA index_xinfo('reservations_authorization')")
    .all()
    .filter((row) => row["key"] === 1);
  if (
    authorizationKeyRows.length !== 3 ||
    authorizationKeyRows.some(
      (row) =>
        typeof row["coll"] !== "string" ||
        row["coll"].toUpperCase() !== "NOCASE",
    )
  ) {
    throw new Error(
      "invalid SQLite schema: authorization index collation differs",
    );
  }
}

/**
 * Run inside BEGIN EXCLUSIVE. Version 1 is initial schema; unknown state fails.
 */
export function migrateSchema(
  db: DatabaseSync,
  metadataNow: number,
): void {
  const tables = tableNames(db);
  if (tables.length === 0) {
    db.exec(CREATE_SCHEMA);
    db.prepare(
      `INSERT INTO schema_meta (
         singleton,
         schema_version,
         created_at_ms,
         migrated_at_ms
       ) VALUES (1, ?, ?, ?)`,
    ).run(SCHEMA_VERSION, metadataNow, metadataNow);
    validateCurrentSchema(db);
    return;
  }

  if (!tables.includes("schema_meta")) {
    throw new Error("unrecognized SQLite database: schema_meta missing");
  }

  const rows = db
    .prepare(
      `SELECT schema_version
       FROM schema_meta
       WHERE singleton = 1`,
    )
    .all();
  if (rows.length !== 1) {
    throw new Error("invalid SQLite schema metadata");
  }
  const version = rows[0]?.["schema_version"];
  if (typeof version !== "number" || !Number.isSafeInteger(version)) {
    throw new Error("invalid SQLite schema version");
  }
  if (version > SCHEMA_VERSION) {
    throw new Error(
      `SQLite schema version ${version} is newer than supported ${SCHEMA_VERSION}`,
    );
  }
  if (version < SCHEMA_VERSION) {
    throw new Error(
      `SQLite schema version ${version} has no registered migration`,
    );
  }
  for (const expected of ["reservations", "dedup"]) {
    if (!tables.includes(expected)) {
      throw new Error(`invalid SQLite schema: ${expected} missing`);
    }
  }
  validateCurrentSchema(db);
}
