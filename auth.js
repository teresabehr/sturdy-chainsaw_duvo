/**
 * auth.js — Per-store API key management with weekly rotation support
 *
 * ── Rotation model ────────────────────────────────────────────────────────────
 *
 *   Keys rotate every Monday at 10:00 UTC.  Korral IT deploys the next key to
 *   .env at least one hour before the rotation time.
 *
 *   A 10-minute overlap window:
 *     NEXT_VALID_FROM = EXPIRES − 10 minutes
 *
 *   getApiKey() behaviour:
 *
 *     t < EXPIRES − 10min   →  return CURRENT key   (normal path)
 *
 *     EXPIRES − 10min ≤ t < EXPIRES  (overlap window)
 *       NEXT deployed        →  return NEXT key proactively
 *                               (new requests use the fresh key; any in-flight
 *                               request that already sent CURRENT completes
 *                               normally — StoreLink honours both keys during
 *                               the overlap)
 *       NEXT not yet deployed →  return CURRENT + log ERROR warning to IT
 *
 *     t ≥ EXPIRES
 *       NEXT valid           →  return NEXT key
 *       NEXT missing/invalid →  throw KeyExpiredError (hard failure)
 *
 * ── .env block per store ──────────────────────────────────────────────────────
 *
 *   STORELINK_KEY_STR_047_CURRENT=sk_live_STR047_<random>
 *   STORELINK_KEY_STR_047_EXPIRES=2027-06-07T10:00:00Z
 *   # Deploy these the week before rotation:
 *   STORELINK_KEY_STR_047_NEXT=sk_live_STR047_<new-random>
 *   STORELINK_KEY_STR_047_NEXT_VALID_FROM=2027-06-07T09:50:00Z
 *
 *   Store ID hyphens become underscores in var names: STR-047 → STR_047
 */

import fs   from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { fdeLog } from "./logger.js";

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const OVERLAP_MS = 10 * 60 * 1000; // 10 minutes

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export class StoreCredentialNotFoundError extends Error {
  constructor(storeId) {
    super(
      `No credentials configured for store ${storeId}. ` +
      `This store is not registered in the credential store. ` +
      `Contact IT to provision an API key before retrying.`
    );
    this.name    = "StoreCredentialNotFoundError";
    this.code    = "STORE_NOT_FOUND";
    this.storeId = storeId;
  }
}

export class KeyExpiredError extends Error {
  constructor(storeId, expiresAt) {
    super(
      `API key for store ${storeId} expired at ${expiresAt?.toISOString() ?? "unknown"} ` +
      `and no next key is deployed. Contact IT immediately — this store is inaccessible.`
    );
    this.name      = "KeyExpiredError";
    this.code      = "KEY_EXPIRED";
    this.storeId   = storeId;
    this.expiresAt = expiresAt;
  }
}

// ---------------------------------------------------------------------------
// .env file loader  (no external dependency — avoids adding dotenv to prod)
// ---------------------------------------------------------------------------

function loadDotEnv() {
  const envPath = path.join(__dirname, ".env");
  try {
    const content = fs.readFileSync(envPath, "utf8");
    for (const raw of content.split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eqIdx = line.indexOf("=");
      if (eqIdx < 0) continue;
      const key = line.slice(0, eqIdx).trim();
      const val = line.slice(eqIdx + 1).trim();
      // Real environment variables take precedence over .env
      if (!(key in process.env)) process.env[key] = val;
    }
  } catch (err) {
    if (err.code !== "ENOENT") {
      fdeLog.error("auth:loadDotEnv", `Failed to read .env: ${err.message}`);
    }
    // ENOENT is expected in production — credentials come from the real env
  }
}

// ---------------------------------------------------------------------------
// Credential map builder
// ---------------------------------------------------------------------------

/**
 * Scans process.env for STORELINK_KEY_*_CURRENT vars to discover known stores,
 * then reads the full credential block for each.
 *
 * Returns:
 *   {
 *     'STR-047': {
 *       current:  { key: string, expires_at: Date },
 *       next:     { key: string, valid_from: Date } | null,
 *     },
 *     ...
 *   }
 */
function buildCredentialMap() {
  const PREFIX  = "STORELINK_KEY_";
  const CURRENT_SUFFIX = "_CURRENT";
  const map = {};

  // Discover stores by looking for *_CURRENT vars
  for (const envKey of Object.keys(process.env)) {
    if (!envKey.startsWith(PREFIX) || !envKey.endsWith(CURRENT_SUFFIX)) continue;

    // e.g. STORELINK_KEY_STR_047_CURRENT  →  infix = STR_047
    const infix   = envKey.slice(PREFIX.length, -CURRENT_SUFFIX.length);
    const storeId = infix.replace(/_/g, "-");   // STR_047 → STR-047
    const base    = `${PREFIX}${infix}`;

    const currentKey  = process.env[`${base}_CURRENT`];
    const expiresStr  = process.env[`${base}_EXPIRES`];
    const nextKey     = process.env[`${base}_NEXT`];
    const validFromStr = process.env[`${base}_NEXT_VALID_FROM`];

    if (!currentKey || !expiresStr) {
      fdeLog.error(
        "auth:buildCredentialMap",
        `Incomplete credentials for ${storeId}: both _CURRENT and _EXPIRES are required`,
        { storeId, missing: [!currentKey && "_CURRENT", !expiresStr && "_EXPIRES"].filter(Boolean) }
      );
      continue;
    }

    map[storeId] = {
      current: { key: currentKey, expires_at: new Date(expiresStr) },
      next: (nextKey && validFromStr)
        ? { key: nextKey, valid_from: new Date(validFromStr) }
        : null,
    };
  }

  return map;
}

// ---------------------------------------------------------------------------
// Module initialisation — runs once at import time
// ---------------------------------------------------------------------------

loadDotEnv();
const credentials = buildCredentialMap();

const knownStores = Object.keys(credentials);
if (knownStores.length === 0) {
  fdeLog.error("auth:init", "No store credentials found in environment. Check .env or deployment config.");
} else {
  fdeLog.verbose("auth:init", `Loaded credentials for ${knownStores.length} store(s)`, { stores: knownStores });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns the API key to use for a request to the given store.
 *
 * Applies the rotation overlap logic described in the module docstring.
 * Throws StoreCredentialNotFoundError or KeyExpiredError on hard failures.
 *
 * @returns {{ key: string, source: 'current'|'next', nearExpiry: boolean }}
 */
export function getApiKey(storeId) {
  const cred = credentials[storeId];

  if (!cred) {
    fdeLog.error("auth:getApiKey", "Store not found in credential store", { storeId, known_stores: knownStores });
    throw new StoreCredentialNotFoundError(storeId);
  }

  const now      = Date.now();
  const { current, next } = cred;
  const expiresMs = current.expires_at.getTime();

  // ── Fully expired ──────────────────────────────────────────────────────────
  if (now >= expiresMs) {
    if (next?.key && now >= next.valid_from?.getTime()) {
      fdeLog.error(
        "auth:getApiKey",
        "Current key has expired — falling back to next key (IT should have rotated CURRENT by now)",
        { storeId, expired_at: current.expires_at }
      );
      return { key: next.key, source: "next", nearExpiry: false };
    }
    fdeLog.error("auth:getApiKey", "Current key expired and no valid next key deployed", {
      storeId,
      expired_at: current.expires_at,
      next_key_present: !!next?.key,
    });
    throw new KeyExpiredError(storeId, current.expires_at);
  }

  // ── Within overlap window: proactively switch to next key ─────────────────
  if (now >= expiresMs - OVERLAP_MS) {
    if (next?.key && next.valid_from && now >= next.valid_from.getTime()) {
      fdeLog.verbose(
        "auth:getApiKey",
        "Within rotation overlap window — switching to next key proactively",
        {
          storeId,
          ms_until_current_expires: expiresMs - now,
          current_expires_at: current.expires_at,
        }
      );
      return { key: next.key, source: "next", nearExpiry: true };
    }

    // Near expiry but no next key ready — warn loudly, keep using current
    fdeLog.error(
      "auth:getApiKey",
      "⚠ KEY EXPIRES IN <10 MINUTES AND NO NEXT KEY IS DEPLOYED — contact IT immediately",
      {
        storeId,
        expires_at: current.expires_at,
        ms_until_expiry: expiresMs - now,
        action_required: "IT must deploy NEXT key before expiry",
      }
    );
    return { key: current.key, source: "current", nearExpiry: true, warning: "near_expiry_no_next_key" };
  }

  // ── Normal path ────────────────────────────────────────────────────────────
  return { key: current.key, source: "current", nearExpiry: false };
}

/**
 * Forces use of the NEXT key, bypassing timing checks.
 * Used exclusively by the 401 retry path in storelink-client.js:
 * if a request got a 401, the current key may have just been rotated on the
 * server side, so we try the next key once before giving up.
 *
 * Returns the next key string, or null if none is deployed.
 */
export function forceNextKey(storeId) {
  const cred = credentials[storeId];
  if (!cred) return null; // caller will throw StoreCredentialNotFoundError separately

  if (!cred.next?.key) {
    fdeLog.error("auth:forceNextKey", "Got 401 but no next key is available for retry", {
      storeId,
      hint: "IT may need to deploy the next key ahead of schedule",
    });
    return null;
  }

  fdeLog.verbose("auth:forceNextKey", "Forcing next key for 401 retry", { storeId });
  return cred.next.key;
}
