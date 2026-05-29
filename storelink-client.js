/**
 * StoreLink API client — stubs that mirror the real endpoint shapes.
 * Replace the stub bodies with real fetch() calls when connecting to StoreLink.
 *
 * Base URL and auth token come from environment variables:
 *   STORELINK_BASE_URL  e.g. https://storelink.internal/v1
 *   Per-store keys are managed by auth.js (loaded from .env)
 *
 * Auth behaviour summary:
 *   • Every request fetches its key via getApiKey(storeId) — rotation-aware
 *   • GET endpoints retry once with forceNextKey() on 401 (key may have just rotated)
 *   • POST /replenishment never retries on auth failure — throws OrderAuthError
 *     so the caller can instruct the agent to restart the process rather than
 *     risk a duplicate order
 *   • 403 KEY_STORE_MISMATCH is never retried on any endpoint — it means a
 *     wrong key reached this store, which is a config/security issue, not a
 *     transient rotation timing issue
 */

import { fdeLog }                                        from "./logger.js";
import { getApiKey, forceNextKey, StoreCredentialNotFoundError } from "./auth.js";

export { StoreCredentialNotFoundError };   // re-export so server.js only needs one import

const BASE_URL = process.env.STORELINK_BASE_URL ?? "https://storelink.internal/v1";

// ---------------------------------------------------------------------------
// Auth error types
// ---------------------------------------------------------------------------

/**
 * Raised when a query (GET) endpoint returns a 401 or 403 and all retry
 * options have been exhausted.
 */
export class RequestAuthError extends Error {
  constructor({ storeId, endpoint, status, code, message }) {
    super(message ?? `Authentication failed for ${endpoint} (HTTP ${status})`);
    this.name     = "RequestAuthError";
    this.storeId  = storeId;
    this.endpoint = endpoint;
    this.status   = status;
    this.code     = code;
  }
}

/**
 * Raised when the ordering (POST) endpoint returns a 401 or 403.
 * This is a hard failure — the caller must not silently retry because the
 * order may have partially processed, and a retry risks a duplicate order.
 * The agent must restart the full replenishment workflow.
 */
export class OrderAuthError extends RequestAuthError {
  constructor(args) {
    super(args);
    this.name = "OrderAuthError";
  }
}

// ---------------------------------------------------------------------------
// Internal HTTP helpers
// ---------------------------------------------------------------------------

/**
 * Executes a GET against the given path using the provided API key.
 * Returns the parsed response body.
 * Throws a plain Error augmented with `.status` and `.code` on auth failure —
 * callers decide whether to retry.
 */
async function _get(apiPath, key) {
  // ── Real implementation (uncomment when wiring up StoreLink) ──────────────
  // const res = await fetch(`${BASE_URL}${apiPath}`, {
  //   headers: { Authorization: `Bearer ${key}` },
  // });
  // if (res.status === 401) {
  //   const err = new Error("Unauthorized");
  //   err.status = 401; err.code = "UNAUTHORIZED";
  //   throw err;
  // }
  // if (res.status === 403) {
  //   const body = await res.json().catch(() => ({}));
  //   const err = new Error(body.message ?? "Forbidden");
  //   err.status = 403; err.code = body.code ?? "FORBIDDEN"; err.storeId = body.store_id;
  //   throw err;
  // }
  // if (!res.ok) throw new Error(`StoreLink ${res.status}: ${await res.text()}`);
  // return res.json();

  _validateStubAuth(apiPath, key);
  return _stubGet(apiPath);
}

/**
 * Executes a POST against the given path using the provided API key.
 */
async function _post(apiPath, body, key) {
  // ── Real implementation ───────────────────────────────────────────────────
  // const res = await fetch(`${BASE_URL}${apiPath}`, {
  //   method: "POST",
  //   headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
  //   body: JSON.stringify(body),
  // });
  // if (res.status === 401) { ... }
  // if (res.status === 403) { ... }
  // if (!res.ok) throw new Error(`StoreLink ${res.status}: ${await res.text()}`);
  // return res.json();

  _validateStubAuth(apiPath, key);
  return _stubPost(apiPath, body);
}

// ---------------------------------------------------------------------------
// Auth-aware wrappers with retry / error shaping
// ---------------------------------------------------------------------------

/**
 * GET with single 401 retry using the next key.
 *
 * Retry is safe on GET: the request is read-only, so there is no risk of
 * duplicate side effects.  A 403 (wrong key for store) is not retried — it
 * indicates a configuration error, not a timing issue.
 */
async function apiGet(storeId, apiPath) {
  const endpoint = `GET ${apiPath.split("?")[0]}`;
  const scope    = `api:${endpoint}`;

  let keyInfo;
  try {
    keyInfo = getApiKey(storeId);
  } catch (err) {
    throw err; // StoreCredentialNotFoundError or KeyExpiredError — surface as-is
  }

  try {
    const result = await _get(apiPath, keyInfo.key);
    _logSuccess("GET", scope, apiPath, result);
    return result;
  } catch (err) {
    // ── 403: key-store mismatch — config error, never retry ─────────────────
    if (err.status === 403) {
      fdeLog.error(scope, "403 KEY_STORE_MISMATCH — key does not belong to this store", {
        storeId, endpoint, key_source: keyInfo.source,
        hint: "Verify .env — the key deployed for this store may be from a different store",
      });
      throw new RequestAuthError({
        storeId, endpoint, status: 403, code: "KEY_STORE_MISMATCH",
        message: `Key for store ${storeId} was rejected with 403 KEY_STORE_MISMATCH. ` +
                 `The deployed key may be for a different store. Contact IT.`,
      });
    }

    // ── 401: key may have just rotated — retry once with next key ────────────
    if (err.status === 401) {
      fdeLog.error(scope, "401 Unauthorized on first attempt — retrying with next key", {
        storeId, endpoint, key_source: keyInfo.source,
      });

      const nextKey = forceNextKey(storeId);
      if (nextKey) {
        try {
          const result = await _get(apiPath, nextKey);
          fdeLog.verbose(scope, "Retry with next key succeeded — key rotation detected", { storeId, endpoint });
          _logSuccess("GET", scope, apiPath, result);
          return result;
        } catch (retryErr) {
          fdeLog.error(scope, "401 Unauthorized on retry with next key — both keys rejected", {
            storeId, endpoint,
            hint: "Check with IT whether a new key has been deployed and the rotation window is correct",
          });
        }
      }

      throw new RequestAuthError({
        storeId, endpoint, status: 401, code: "AUTH_FAILED",
        message: `Authentication failed for ${endpoint} on store ${storeId} after rotation retry. ` +
                 `Both the current and next keys were rejected. Contact IT to verify key rotation.`,
      });
    }

    // ── Other error ──────────────────────────────────────────────────────────
    fdeLog.error(scope, `GET failed — ${err.message}`, {
      url: `${BASE_URL}${apiPath}`, status: err.status ?? "ERR", error: err.message,
    });
    throw err;
  }
}

/**
 * POST — hard failure on any auth error.
 *
 * Retrying an order silently risks duplicate replenishment orders.
 * The agent must be told to restart the full workflow after verifying
 * with IT that the first order was not processed.
 */
async function apiPost(storeId, apiPath, body) {
  const endpoint = `POST ${apiPath.split("?")[0]}`;
  const scope    = `api:${endpoint}`;

  let keyInfo;
  try {
    keyInfo = getApiKey(storeId);
  } catch (err) {
    throw err;
  }

  try {
    const result = await _post(apiPath, body, keyInfo.key);
    _logSuccess("POST", scope, apiPath, result);
    return result;
  } catch (err) {
    if (err.status === 401 || err.status === 403) {
      fdeLog.error(scope, `CRITICAL: auth failure on ordering endpoint — ${err.code ?? err.status}`, {
        storeId, endpoint, key_source: keyInfo.source, status: err.status,
        action: "Do NOT retry automatically — risk of duplicate order. Restart the process.",
      });
      throw new OrderAuthError({
        storeId, endpoint, status: err.status,
        code: err.status === 403 ? "KEY_STORE_MISMATCH" : "AUTH_FAILED",
        message:
          `Authentication failed on the ordering endpoint for store ${storeId} ` +
          `(${err.status === 403 ? "KEY_STORE_MISMATCH" : "Unauthorized"}). ` +
          `This is a CRITICAL failure — do NOT retry the order automatically. ` +
          `Restart the full replenishment workflow from get_inventory_snapshot.`,
      });
    }

    fdeLog.error(scope, `POST failed — ${err.message}`, {
      url: `${BASE_URL}${apiPath}`, status: err.status ?? "ERR", error: err.message, body,
    });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Success logger (shared by apiGet and apiPost)
// ---------------------------------------------------------------------------

function _logSuccess(method, scope, apiPath, result) {
  const isEmpty = result == null || Object.keys(result).length === 0;
  if (isEmpty) {
    fdeLog.error(scope, `${method} returned empty response`, { url: `${BASE_URL}${apiPath}` });
    return;
  }

  let summary;
  if (/\/inventory/.test(apiPath)) {
    summary = {
      status: 200, items_in_response: 1,
      sku:             result.sku          ?? "(missing)",
      product_name:    result.product_name ?? "(not in response)",
      number_in_stock: result.on_hand      ?? "(missing)",
    };
  } else if (/\/pos/.test(apiPath)) {
    summary = {
      status: 200,
      transaction_count: Array.isArray(result.transactions) ? result.transactions.length : 0,
      total_sold: result.total_sold, window_from: result.since, window_to: result.until,
    };
  } else if (/\/replenishment\/[^/]+$/.test(apiPath)) {
    summary = { status: 200, order_id: result.order_id, order_status: result.status, estimated_arrival: result.estimated_arrival };
  } else if (/\/replenishment$/.test(apiPath)) {
    summary = { status: 201, order_id: result.order_id, qty: result.quantity, order_status: result.status };
  } else {
    summary = { status: 200, items_in_response: Object.keys(result).length };
  }

  fdeLog.verbose(scope, `${method} OK`, summary);
}

// ---------------------------------------------------------------------------
// Public API surface
// ---------------------------------------------------------------------------

/** GET /v1/stores/{store_id}/inventory?sku={sku} */
export async function getInventory(storeId, sku) {
  return apiGet(storeId, `/stores/${storeId}/inventory?sku=${sku}`);
}

/** GET /v1/stores/{store_id}/pos?sku={sku}&since={iso} */
export async function getPOSTransactions(storeId, sku, sinceIso) {
  return apiGet(storeId, `/stores/${storeId}/pos?sku=${sku}&since=${sinceIso}`);
}

/** POST /v1/stores/{store_id}/replenishment */
export async function createReplenishmentOrder(storeId, payload) {
  return apiPost(storeId, `/stores/${storeId}/replenishment`, payload);
}

/** GET /v1/stores/{store_id}/replenishment/{order_id} */
export async function getReplenishmentOrder(storeId, orderId) {
  return apiGet(storeId, `/stores/${storeId}/replenishment/${orderId}`);
}

// ---------------------------------------------------------------------------
// Stubs  (delete everything below when wiring up the real StoreLink API)
// ---------------------------------------------------------------------------

/**
 * Validates that a key is present and matches the store being queried.
 *
 * Key format:  sk_live_<STOREID_NO_DASH>_<random>
 *   e.g. STR-047  →  key must contain  STR047  (case-insensitive)
 *
 * A mismatch means the wrong store's key reached this endpoint — a
 * configuration/security issue that should never self-heal via retry.
 */
function _validateStubAuth(apiPath, key) {
  if (!key) {
    const err = new Error("Missing Authorization header");
    err.status = 401; err.code = "UNAUTHORIZED";
    throw err;
  }

  const storeId = _extract(apiPath, "stores");
  if (storeId) {
    const expected = storeId.replace(/-/g, "").toUpperCase(); // STR-047 → STR047
    if (!key.toUpperCase().includes(expected)) {
      const err = new Error(
        `Key fragment does not match store ${storeId} ` +
        `(expected key to contain "${expected}")`
      );
      err.status = 403; err.code = "KEY_STORE_MISMATCH"; err.storeId = storeId;
      throw err;
    }
  }
}

function _stubGet(path) {
  if (/\/stores\/[^/]+\/inventory/.test(path)) {
    return {
      store_id: _extract(path, "stores"), sku: _qs(path, "sku"),
      on_hand: 142, unit: "each",
      last_updated: new Date(Date.now() - 8 * 60_000).toISOString(),
    };
  }
  if (/\/stores\/[^/]+\/pos/.test(path)) {
    const since = new Date(_qs(path, "since") || Date.now() - 86_400_000);
    const now   = new Date();
    const transactions = _fakeSales(since, now, 47);
    return {
      store_id: _extract(path, "stores"), sku: _qs(path, "sku"),
      since: since.toISOString(), until: now.toISOString(),
      transactions,
      total_sold: transactions.reduce((s, t) => s + t.quantity_sold, 0),
    };
  }
  if (/\/stores\/[^/]+\/replenishment\//.test(path)) {
    const orderId = path.split("/replenishment/")[1];
    return {
      order_id: orderId, store_id: _extract(path, "stores"),
      status: "confirmed",
      estimated_arrival: new Date(Date.now() + 4 * 3_600_000).toISOString(),
      created_at: new Date(Date.now() - 2 * 60_000).toISOString(),
    };
  }
  throw new Error(`Stub: unrecognised GET path: ${path}`);
}

function _stubPost(path, body) {
  if (/\/stores\/[^/]+\/replenishment$/.test(path)) {
    return {
      order_id: `ORD-${Date.now()}`, store_id: _extract(path, "stores"),
      sku: body.sku, quantity: body.quantity,
      status: "pending",
      created_at: new Date().toISOString(),
      estimated_arrival: new Date(Date.now() + 4 * 3_600_000).toISOString(),
    };
  }
  throw new Error(`Stub: unrecognised POST path: ${path}`);
}

function _extract(path, segment) {
  const parts = path.split("/");
  const idx   = parts.indexOf(segment);
  return idx >= 0 ? parts[idx + 1] : null;
}
function _qs(path, key) {
  const m = new RegExp(`[?&]${key}=([^&]*)`).exec(path);
  return m ? decodeURIComponent(m[1]) : null;
}
function _fakeSales(since, until, totalUnits) {
  const span  = until - since;
  const count = Math.floor(Math.random() * 8) + 5;
  const txns  = [];
  let remaining = totalUnits;
  for (let i = 0; i < count; i++) {
    const qty = i === count - 1 ? remaining : Math.max(1, Math.floor(Math.random() * (remaining / 2)));
    remaining -= qty;
    txns.push({ sold_at: new Date(since.getTime() + Math.random() * span).toISOString(), quantity_sold: qty });
    if (remaining <= 0) break;
  }
  return txns.sort((a, b) => a.sold_at.localeCompare(b.sold_at));
}
