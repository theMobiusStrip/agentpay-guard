import { createHash, randomUUID } from "node:crypto";
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  statSync,
} from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PENDING_STATUSES, type ReservationStatus } from "../../types.js";
import {
  type AtomicStore,
  type RecoveryResult,
  type Reservation,
  type ReserveRequest,
  type ReserveResult,
  type SignedAuthorizationReference,
  type TransitionOptions,
} from "../types.js";
import { migrateSchema } from "./schema.js";

const DEFAULT_BUSY_TIMEOUT_MS = 250;
const DEFAULT_BUSY_RETRIES = 2;
const DEFAULT_RETRY_JITTER_MS = 25;

export interface SqliteStoreOptions {
  busyTimeoutMs?: number;
  busyRetries?: number;
  retryJitterMs?: number;
  /** Migration metadata clock. Never used for spend decisions. */
  metadataNow?: () => number;
}

interface ResolvedOptions {
  busyTimeoutMs: number;
  busyRetries: number;
  retryJitterMs: number;
  metadataNow: () => number;
}

type SqliteRow = Record<string, unknown>;

function optionInteger(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
  return resolved;
}

function resolveOptions(options: SqliteStoreOptions): ResolvedOptions {
  return {
    busyTimeoutMs: optionInteger(
      options.busyTimeoutMs,
      DEFAULT_BUSY_TIMEOUT_MS,
      "busyTimeoutMs",
    ),
    busyRetries: optionInteger(
      options.busyRetries,
      DEFAULT_BUSY_RETRIES,
      "busyRetries",
    ),
    retryJitterMs: optionInteger(
      options.retryJitterMs,
      DEFAULT_RETRY_JITTER_MS,
      "retryJitterMs",
    ),
    metadataNow: options.metadataNow ?? Date.now,
  };
}

function resolveLocalPath(input: string): string {
  if (
    input === "" ||
    input === ":memory:" ||
    input.startsWith("file:") ||
    input.includes("\0")
  ) {
    throw new Error("SQLite store requires a local file path");
  }
  return resolve(input);
}

function checkExistingPath(path: string): void {
  if (!existsSync(path)) return;
  const stat = statSync(path);
  if (!stat.isFile()) {
    throw new Error("SQLite store path must be a regular file");
  }
  if ((stat.mode & 0o200) === 0) {
    throw new Error("SQLite store file is not owner-writable");
  }
  accessSync(path, constants.R_OK | constants.W_OK);
}

function safeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${name} must be a safe integer`);
  }
}

function positiveInteger(value: number, name: string): void {
  safeInteger(value, name);
  if (value <= 0) throw new Error(`${name} must be positive`);
}

function canonicalAmount(value: bigint, name: string): string {
  if (value < 0n) throw new Error(`${name} must be non-negative`);
  return value.toString(10);
}

function parseAmount(value: unknown): bigint {
  if (
    typeof value !== "string" ||
    !/^(0|[1-9]\d*)$/.test(value)
  ) {
    throw new Error("invalid canonical amount in SQLite store");
  }
  return BigInt(value);
}

function requiredString(row: SqliteRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string") {
    throw new Error(`invalid ${key} in SQLite store`);
  }
  return value;
}

function optionalString(
  row: SqliteRow,
  key: string,
): string | undefined {
  const value = row[key];
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error(`invalid ${key} in SQLite store`);
  }
  return value;
}

function requiredInteger(row: SqliteRow, key: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`invalid ${key} in SQLite store`);
  }
  return value;
}

function optionalInteger(
  row: SqliteRow,
  key: string,
): number | undefined {
  const value = row[key];
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`invalid ${key} in SQLite store`);
  }
  return value;
}

function reservationStatus(value: unknown): ReservationStatus {
  if (
    typeof value !== "string" ||
    ![
      "reserved",
      "signed",
      "submitted",
      "settled",
      "unknown",
      "expired",
      "released",
    ].includes(value)
  ) {
    throw new Error("invalid reservation status in SQLite store");
  }
  return value as ReservationStatus;
}

function authorizationFromRow(
  row: SqliteRow,
): SignedAuthorizationReference | undefined {
  const network = optionalString(row, "network");
  const asset = optionalString(row, "asset");
  const from = optionalString(row, "payer");
  const nonce = optionalString(row, "authorization_nonce");
  const validBefore = optionalInteger(row, "valid_before_s");
  const values = [network, asset, from, nonce, validBefore];
  if (values.every((value) => value === undefined)) return undefined;
  if (
    network === undefined ||
    asset === undefined ||
    from === undefined ||
    nonce === undefined ||
    validBefore === undefined
  ) {
    throw new Error("partial authorization reference in SQLite store");
  }
  return { network, asset, from, nonce, validBefore };
}

function rowToReservation(row: SqliteRow): Reservation {
  const settledAt = optionalInteger(row, "settled_at_ms");
  const authorization = authorizationFromRow(row);
  return {
    id: requiredString(row, "id"),
    principalId: requiredString(row, "principal_id"),
    mandateId: requiredString(row, "mandate_id"),
    amount: parseAmount(row["amount_atomic"]),
    status: reservationStatus(row["status"]),
    payTo: requiredString(row, "pay_to"),
    reservedAt: requiredInteger(row, "reserved_at_ms"),
    safeReleaseAt: requiredInteger(row, "safe_release_at_ms"),
    recoveryReleaseAt: requiredInteger(
      row,
      "recovery_release_at_ms",
    ),
    windowMs: requiredInteger(row, "window_ms"),
    ...(settledAt !== undefined ? { settledAt } : {}),
    ...(authorization !== undefined ? { authorization } : {}),
  };
}

function changes(result: { changes: number | bigint }): number {
  const value =
    typeof result.changes === "bigint"
      ? Number(result.changes)
      : result.changes;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("invalid SQLite change count");
  }
  return value;
}

function isBusyError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes("database is locked") ||
    message.includes("database is busy")
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, ms);
  });
}

function validateAuthorization(
  authorization: SignedAuthorizationReference | undefined,
): void {
  if (authorization === undefined) return;
  for (const [name, value] of [
    ["network", authorization.network],
    ["asset", authorization.asset],
    ["from", authorization.from],
    ["nonce", authorization.nonce],
  ] as const) {
    if (value === "") throw new Error(`authorization ${name} is empty`);
  }
  safeInteger(authorization.validBefore, "authorization validBefore");
}

/**
 * SQLite AtomicStore for one-host proxy state. Calls stay transactional across
 * independent connections. Proxy lifecycle recovery still supports one active
 * process per database.
 */
export class SqliteAtomicStore implements AtomicStore {
  private closed = false;
  private poisoned?: Error;

  private constructor(
    private readonly db: DatabaseSync,
    readonly path: string,
    private readonly options: ResolvedOptions,
  ) {}

  static async open(
    path: string,
    options: SqliteStoreOptions = {},
  ): Promise<SqliteAtomicStore> {
    const resolvedPath = resolveLocalPath(path);
    const resolvedOptions = resolveOptions(options);
    checkExistingPath(resolvedPath);

    const db = new DatabaseSync(resolvedPath, {
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
      allowExtension: false,
    });
    const store = new SqliteAtomicStore(
      db,
      resolvedPath,
      resolvedOptions,
    );
    try {
      chmodSync(resolvedPath, 0o600);
      db.exec(`PRAGMA busy_timeout = ${resolvedOptions.busyTimeoutMs}`);
      db.exec("PRAGMA foreign_keys = ON");
      db.exec("PRAGMA synchronous = FULL");
      const journal = db
        .prepare("PRAGMA journal_mode = WAL")
        .get() as SqliteRow | undefined;
      if (
        journal === undefined ||
        String(journal["journal_mode"]).toLowerCase() !== "wal"
      ) {
        throw new Error("SQLite WAL mode unavailable");
      }
      await store.transaction("EXCLUSIVE", () => {
        migrateSchema(db, resolvedOptions.metadataNow());
      });
      const check = db.prepare("PRAGMA quick_check").get() as
        | SqliteRow
        | undefined;
      if (
        check === undefined ||
        !Object.values(check).some((value) => value === "ok")
      ) {
        throw new Error("SQLite integrity check failed");
      }
      return store;
    } catch (error) {
      try {
        db.close();
      } catch {
        // Opening already failed. Preserve first failure.
      }
      store.closed = true;
      throw error;
    }
  }

  private assertUsable(): void {
    if (this.closed) throw new Error("SQLite store is closed");
    if (this.poisoned !== undefined) throw this.poisoned;
  }

  private async transaction<T>(
    kind: "IMMEDIATE" | "EXCLUSIVE",
    operation: () => T,
  ): Promise<T> {
    this.assertUsable();
    for (let attempt = 0; ; attempt++) {
      try {
        this.db.exec(`BEGIN ${kind}`);
      } catch (error) {
        if (
          !isBusyError(error) ||
          attempt >= this.options.busyRetries
        ) {
          throw error;
        }
        const jitter =
          this.options.retryJitterMs === 0
            ? 0
            : Math.floor(
                Math.random() * (this.options.retryJitterMs + 1),
              );
        await delay(jitter);
        continue;
      }
      try {
        const result = operation();
        this.db.exec("COMMIT");
        return result;
      } catch (error) {
        try {
          this.db.exec("ROLLBACK");
        } catch (rollbackError) {
          this.poisoned = new Error(
            `SQLite rollback failed: ${
              rollbackError instanceof Error
                ? rollbackError.message
                : String(rollbackError)
            }`,
          );
        }
        throw error;
      }
    }
  }

  private expireEligible(
    now: number,
    principalId?: string,
  ): number {
    const principalClause =
      principalId === undefined ? "" : " AND principal_id = ?";
    const reservedStatement = this.db.prepare(
      `UPDATE reservations
       SET status = 'expired', updated_at_ms = MAX(updated_at_ms, ?)
       WHERE status = 'reserved' AND safe_release_at_ms <= ?${principalClause}`,
    );
    const reserved = changes(
      principalId === undefined
        ? reservedStatement.run(now, now)
        : reservedStatement.run(now, now, principalId),
    );
    const uncertainStatement = this.db.prepare(
      `UPDATE reservations
       SET status = 'expired', updated_at_ms = MAX(updated_at_ms, ?)
       WHERE status IN ('signed', 'submitted', 'unknown')
         AND recovery_release_at_ms <= ?${principalClause}`,
    );
    const uncertain = changes(
      principalId === undefined
        ? uncertainStatement.run(now, now)
        : uncertainStatement.run(now, now, principalId),
    );
    return reserved + uncertain;
  }

  /**
   * Extend uncertain rows before expiry. Current policy window can grow across
   * restart; old deadlines cannot erase spend still attributable under the new
   * window.
   */
  private extendUncertainRecovery(
    now: number,
    requestedWindowMs: number,
    principalId?: string,
  ): void {
    const principalClause =
      principalId === undefined ? "" : " AND principal_id = ?";
    const statement = this.db.prepare(
      `UPDATE reservations
       SET recovery_release_at_ms = MAX(
             recovery_release_at_ms,
             safe_release_at_ms + MAX(window_ms, ?)
           ),
           updated_at_ms = MAX(updated_at_ms, ?)
       WHERE status IN ('signed', 'submitted', 'unknown')${principalClause}`,
    );
    if (principalId === undefined) {
      statement.run(requestedWindowMs, now);
    } else {
      statement.run(requestedWindowMs, now, principalId);
    }
  }

  private accountingRows(
    principalId: string,
    mandateId: string | null,
  ): SqliteRow[] {
    if (mandateId === null) {
      return this.db
        .prepare(
          `SELECT amount_atomic, status, settled_at_ms, window_ms
           FROM reservations
           WHERE principal_id = ?
             AND status IN (
               'reserved',
               'signed',
               'submitted',
               'unknown',
               'settled'
             )`,
        )
        .all(principalId);
    }
    return this.db
      .prepare(
        `SELECT amount_atomic, status, settled_at_ms, window_ms
         FROM reservations
         WHERE principal_id = ? AND mandate_id = ?
           AND status IN (
             'reserved',
             'signed',
             'submitted',
             'unknown',
             'settled'
           )`,
      )
      .all(principalId, mandateId);
  }

  private committed(
    principalId: string,
    mandateId: string | null,
    now: number,
    requestedWindowMs: number,
  ): bigint {
    let total = 0n;
    for (const row of this.accountingRows(principalId, mandateId)) {
      const status = reservationStatus(row["status"]);
      const amount = parseAmount(row["amount_atomic"]);
      if (PENDING_STATUSES.includes(status)) {
        total += amount;
        continue;
      }
      if (status !== "settled") continue;
      const settledAt = requiredInteger(row, "settled_at_ms");
      const rowWindowMs = requiredInteger(row, "window_ms");
      if (
        settledAt >
        now - Math.max(rowWindowMs, requestedWindowMs)
      ) {
        total += amount;
      }
    }
    return total;
  }

  async tryReserve(req: ReserveRequest): Promise<ReserveResult> {
    safeInteger(req.now, "now");
    positiveInteger(req.windowMs, "windowMs");
    safeInteger(req.safeReleaseAt, "safeReleaseAt");
    safeInteger(req.recoveryReleaseAt, "recoveryReleaseAt");
    if (
      req.recoveryReleaseAt <
      req.safeReleaseAt + req.windowMs
    ) {
      throw new Error(
        "recoveryReleaseAt must cover safeReleaseAt plus windowMs",
      );
    }
    canonicalAmount(req.amount, "amount");
    canonicalAmount(req.cap, "cap");
    if (req.aggregateCap !== undefined) {
      canonicalAmount(req.aggregateCap, "aggregateCap");
    }
    validateAuthorization(req.authorization);

    return this.transaction("IMMEDIATE", () => {
      this.extendUncertainRecovery(req.now, req.windowMs, req.principalId);
      this.expireEligible(req.now, req.principalId);

      if (req.perPayeeReservationLimit !== undefined) {
        positiveInteger(
          req.perPayeeReservationLimit,
          "perPayeeReservationLimit",
        );
        const row = this.db
          .prepare(
            `SELECT COUNT(*) AS pending_count
             FROM reservations
             WHERE principal_id = ? AND pay_to = ?
               AND status IN (
                 'reserved',
                 'signed',
                 'submitted',
                 'unknown'
               )`,
          )
          .get(req.principalId, req.payTo) as SqliteRow | undefined;
        const pending =
          row === undefined
            ? 0
            : requiredInteger(row, "pending_count");
        if (pending >= req.perPayeeReservationLimit) {
          return {
            ok: false,
            reason: "per_payee_limit",
            committed: this.committed(
              req.principalId,
              req.mandateId,
              req.now,
              req.windowMs,
            ),
            cap: req.cap,
          };
        }
      }

      const committedMandate = this.committed(
        req.principalId,
        req.mandateId,
        req.now,
        req.windowMs,
      );
      if (committedMandate + req.amount > req.cap) {
        return {
          ok: false,
          reason: "cap_exceeded",
          committed: committedMandate,
          cap: req.cap,
        };
      }

      if (req.aggregateCap !== undefined) {
        const committedPrincipal = this.committed(
          req.principalId,
          null,
          req.now,
          req.windowMs,
        );
        if (
          committedPrincipal + req.amount >
          req.aggregateCap
        ) {
          return {
            ok: false,
            reason: "aggregate_cap_exceeded",
            committed: committedPrincipal,
            cap: req.aggregateCap,
          };
        }
      }

      const authorization = req.authorization;
      const id = randomUUID();
      this.db
        .prepare(
          `INSERT INTO reservations (
             id,
             principal_id,
             mandate_id,
             amount_atomic,
             pay_to,
             status,
             reserved_at_ms,
             settled_at_ms,
             safe_release_at_ms,
             recovery_release_at_ms,
             window_ms,
             network,
             asset,
             payer,
             authorization_nonce,
             valid_before_s,
             settlement_tx,
             updated_at_ms
           ) VALUES (
             ?, ?, ?, ?, ?, 'reserved', ?, NULL, ?, ?, ?,
             ?, ?, ?, ?, ?, NULL, ?
           )`,
        )
        .run(
          id,
          req.principalId,
          req.mandateId,
          canonicalAmount(req.amount, "amount"),
          req.payTo,
          req.now,
          req.safeReleaseAt,
          req.recoveryReleaseAt,
          req.windowMs,
          authorization?.network ?? null,
          authorization?.asset ?? null,
          authorization?.from ?? null,
          authorization?.nonce ?? null,
          authorization?.validBefore ?? null,
          req.now,
        );
      return {
        ok: true,
        reservationId: id,
        committed: committedMandate + req.amount,
      };
    });
  }

  async transition(
    reservationId: string,
    from: ReservationStatus,
    to: ReservationStatus,
    opts?: TransitionOptions,
  ): Promise<boolean> {
    if (to === "settled" && opts?.settledAt === undefined) {
      throw new Error("transition to 'settled' requires opts.settledAt");
    }
    if (opts?.authorization !== undefined && to !== "signed") {
      throw new Error(
        "authorization reference requires transition to 'signed'",
      );
    }
    if (opts?.now !== undefined) safeInteger(opts.now, "transition now");
    if (opts?.settledAt !== undefined) {
      safeInteger(opts.settledAt, "settledAt");
    }
    if (opts?.safeReleaseAt !== undefined) {
      safeInteger(opts.safeReleaseAt, "safeReleaseAt");
    }
    validateAuthorization(opts?.authorization);

    return this.transaction("IMMEDIATE", () => {
      const authorization = opts?.authorization;
      const result = this.db
        .prepare(
          `UPDATE reservations
           SET
             status = ?,
             settled_at_ms = CASE
               WHEN ? = 'settled' THEN ?
               ELSE settled_at_ms
             END,
             safe_release_at_ms = MAX(
               safe_release_at_ms,
               COALESCE(?, safe_release_at_ms)
             ),
             recovery_release_at_ms = MAX(
               recovery_release_at_ms,
               CASE
                 WHEN ? IS NULL THEN recovery_release_at_ms
                 ELSE ? + window_ms
               END
             ),
             network = COALESCE(?, network),
             asset = COALESCE(?, asset),
             payer = COALESCE(?, payer),
             authorization_nonce = COALESCE(
               ?,
               authorization_nonce
             ),
             valid_before_s = COALESCE(?, valid_before_s),
             updated_at_ms = MAX(
               updated_at_ms,
               COALESCE(?, updated_at_ms)
             )
           WHERE id = ? AND status = ?`,
        )
        .run(
          to,
          to,
          opts?.settledAt ?? null,
          opts?.safeReleaseAt ?? null,
          opts?.safeReleaseAt ?? null,
          opts?.safeReleaseAt ?? null,
          authorization?.network ?? null,
          authorization?.asset ?? null,
          authorization?.from ?? null,
          authorization?.nonce ?? null,
          authorization?.validBefore ?? null,
          opts?.now ?? null,
          reservationId,
          from,
        );
      return changes(result) === 1;
    });
  }

  async putIfAbsent(
    dedupKey: string,
    ttlMs: number,
    now: number,
  ): Promise<boolean> {
    safeInteger(ttlMs, "ttlMs");
    if (ttlMs < 0) throw new Error("ttlMs must be non-negative");
    safeInteger(now, "now");
    const expiresAt = now + ttlMs;
    safeInteger(expiresAt, "dedup expiry");
    const digest = createHash("sha256").update(dedupKey).digest();

    return this.transaction("IMMEDIATE", () => {
      this.db
        .prepare(
          `DELETE FROM dedup
           WHERE key_digest = ? AND expires_at_ms <= ?`,
        )
        .run(digest, now);
      return (
        changes(
          this.db
            .prepare(
              `INSERT OR IGNORE INTO dedup (
                 key_digest,
                 expires_at_ms
               ) VALUES (?, ?)`,
            )
            .run(digest, expiresAt),
        ) === 1
      );
    });
  }

  async removeDedup(dedupKey: string): Promise<void> {
    const digest = createHash("sha256").update(dedupKey).digest();
    await this.transaction("IMMEDIATE", () => {
      this.db
        .prepare("DELETE FROM dedup WHERE key_digest = ?")
        .run(digest);
    });
  }

  async releaseExpired(
    now: number,
    requestedWindowMs: number,
  ): Promise<number> {
    safeInteger(now, "now");
    positiveInteger(requestedWindowMs, "requestedWindowMs");
    return this.transaction("IMMEDIATE", () => {
      this.extendUncertainRecovery(now, requestedWindowMs);
      return this.expireEligible(now);
    });
  }

  async recoverAfterRestart(
    now: number,
    requestedWindowMs: number,
  ): Promise<RecoveryResult> {
    safeInteger(now, "now");
    positiveInteger(requestedWindowMs, "requestedWindowMs");
    return this.transaction("IMMEDIATE", () => {
      const markedUnknown = changes(
        this.db
          .prepare(
            `UPDATE reservations
             SET status = 'unknown',
                 updated_at_ms = MAX(updated_at_ms, ?)
             WHERE status IN ('reserved', 'signed', 'submitted')`,
          )
          .run(now),
      );
      this.extendUncertainRecovery(now, requestedWindowMs);
      const expired = changes(
        this.db
          .prepare(
            `UPDATE reservations
             SET status = 'expired',
                 updated_at_ms = MAX(updated_at_ms, ?)
             WHERE status = 'unknown'
               AND recovery_release_at_ms <= ?`,
          )
          .run(now, now),
      );
      return { markedUnknown, expired };
    });
  }

  async get(
    reservationId: string,
  ): Promise<Reservation | undefined> {
    this.assertUsable();
    const row = this.db
      .prepare(
        `SELECT
           id,
           principal_id,
           mandate_id,
           amount_atomic,
           pay_to,
           status,
           reserved_at_ms,
           settled_at_ms,
           safe_release_at_ms,
           recovery_release_at_ms,
           window_ms,
           network,
           asset,
           payer,
           authorization_nonce,
           valid_before_s
         FROM reservations
         WHERE id = ?`,
      )
      .get(reservationId) as SqliteRow | undefined;
    return row === undefined ? undefined : rowToReservation(row);
  }

  async committedAmount(
    principalId: string,
    mandateId: string,
    now: number,
    windowMs: number,
  ): Promise<bigint> {
    this.assertUsable();
    safeInteger(now, "now");
    positiveInteger(windowMs, "windowMs");
    return this.committed(
      principalId,
      mandateId,
      now,
      windowMs,
    );
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    let checkpointError: unknown;
    try {
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch (error) {
      checkpointError = error;
    }
    this.db.close();
    if (checkpointError !== undefined) {
      throw checkpointError instanceof Error
        ? checkpointError
        : new Error("SQLite checkpoint failed");
    }
  }
}

export async function openSqliteStore(
  path: string,
  options: SqliteStoreOptions = {},
): Promise<SqliteAtomicStore> {
  return SqliteAtomicStore.open(path, options);
}
