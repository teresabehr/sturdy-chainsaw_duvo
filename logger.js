/**
 * logger.js — Observability for two audiences
 *
 * FDE log  (fde.log)
 *   Written to disk on every server run (append mode).
 *   Two effective levels, controlled by the LOG_LEVEL env var:
 *
 *     LOG_LEVEL=error   (default)
 *       • [ERROR] lines only  — failed API calls, uncaught exceptions
 *       • [TOOL]  lines always— every agent tool invocation + duration
 *         (so an FDE can reconstruct what the agent did even when nothing errored)
 *
 *     LOG_LEVEL=verbose
 *       • Everything above, plus:
 *       • [VERBOSE] lines — successful API responses with key fields
 *
 * Buyer audit log  (buyer-audit.log)
 *   One NDJSON line per replenishment decision — parseable directly by any BI tool.
 *   Schema per line:
 *     ts                   ISO-8601 wall-clock time the order was raised
 *     store_id             StoreLink store identifier
 *     sku                  Stock-keeping unit code
 *     on_hand_before       Units on shelf when the agent made its decision
 *     ordered              true | false
 *     qty_ordered          Units ordered (0 if ordered=false)
 *     on_hand_projected    on_hand_before + qty_ordered (arrival projection)
 *     order_id             StoreLink order ID (null if ordered=false)
 *     estimated_arrival    ISO-8601 projected delivery time (null if ordered=false)
 *     lead_time_hrs        Decimal hours from order creation to estimated arrival
 *     trigger_reason       Free-text justification logged with the order
 */

import fs   from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const LOG_LEVEL  = (process.env.LOG_LEVEL ?? "error").toLowerCase();
const IS_VERBOSE = LOG_LEVEL === "verbose";

// LOG_DIR lets operators redirect logs to a mounted volume in Docker.
// Defaults to the directory containing this file (dev / bare-metal default).
const LOG_DIR = process.env.LOG_DIR ?? __dirname;
fs.mkdirSync(LOG_DIR, { recursive: true }); // ensure directory exists

// Append-mode so logs survive server restarts without overwriting history
const fdeStream   = fs.createWriteStream(path.join(LOG_DIR, "fde.log"),         { flags: "a" });
const buyerStream = fs.createWriteStream(path.join(LOG_DIR, "buyer-audit.log"),  { flags: "a" });

// ---------------------------------------------------------------------------
// Internal formatter
// ---------------------------------------------------------------------------

function writeFde(level, scope, message, data) {
  const ts      = new Date().toISOString();
  const dataStr = data != null ? "  " + JSON.stringify(data) : "";
  fdeStream.write(`[${ts}] [${level.padEnd(7)}] [${scope}] ${message}${dataStr}\n`);
}

// ---------------------------------------------------------------------------
// FDE logger — exported for use in storelink-client.js and server.js
// ---------------------------------------------------------------------------

export const fdeLog = {
  /**
   * Always written regardless of LOG_LEVEL.
   * Use for: failed API calls, thrown exceptions, unexpected empty responses.
   */
  error(scope, message, data) {
    writeFde("ERROR", scope, message, data);
  },

  /**
   * Only written when LOG_LEVEL=verbose.
   * Use for: successful API responses, field-level data shape confirmation.
   */
  verbose(scope, message, data) {
    if (IS_VERBOSE) writeFde("VERBOSE", scope, message, data);
  },

  /**
   * Always written regardless of LOG_LEVEL.
   * Use for: agent tool invocations and completions — lets an FDE reconstruct
   * the agent's decision sequence even when no API errors occurred.
   */
  tool(scope, message, data) {
    writeFde("TOOL  ", scope, message, data);
  },
};

// ---------------------------------------------------------------------------
// Buyer audit — one NDJSON line per replenishment event
// ---------------------------------------------------------------------------

/**
 * Write one structured line to buyer-audit.log.
 * @param {object} record  See schema in module docstring above.
 */
export function buyerAudit(record) {
  buyerStream.write(JSON.stringify({ ts: new Date().toISOString(), ...record }) + "\n");
}
