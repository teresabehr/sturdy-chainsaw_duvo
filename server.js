#!/usr/bin/env node
/**
 * storelink-mcp  —  Store Buyer Agent MCP Server
 *
 * Exposes exactly four tools that map to the three buyer workflows:
 *
 *   1. get_inventory_snapshot   — on-hand + intraday sales velocity  (check on-hand vs POS)
 *   2. forecast_stockout        — will this store run out today?       (predict empties)
 *   3. raise_replenishment      — create a replenishment order         (trigger restock)
 *   4. get_order_status         — check an order raised earlier        (follow-up)
 *
 * Intentionally NOT exposed as tools:
 *   • GET /v1/stores              — agent doesn't need to enumerate stores; store_id
 *                                   comes from the buyer's context / task input
 *   • GET /v1/stores/{id}         — store metadata isn't part of any buyer decision
 *   • GET /v1/skus/{sku}          — SKU name/category is nice-to-have but not decision-
 *                                   critical; if needed, surface it inside snapshot
 *   • GET /v1/suppliers/{id}      — lead-time detail is baked into the order response
 *   • Raw POS endpoint            — exposed only via the snapshot/forecast tools, which
 *                                   pre-compute velocity so the agent doesn't have to
 */

import { McpServer }       from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z }               from "zod";

import {
  getInventory,
  getPOSTransactions,
  createReplenishmentOrder,
  getReplenishmentOrder,
  RequestAuthError,
  OrderAuthError,
  StoreCredentialNotFoundError,
} from "./storelink-client.js";

import {
  computeVelocity,
  blendedVelocity,
  forecastStockout,
  isUrgent,
  suggestQuantity,
} from "./inventory-math.js";

import { fdeLog, buyerAudit } from "./logger.js";
import { KeyExpiredError }     from "./auth.js";

// ---------------------------------------------------------------------------
// Auth error → agent-readable response
//
// Tools return structured error objects rather than throwing so the agent can
// reason about what to do next.  The three error shapes below map to the three
// failure modes described in the auth design:
//
//   STORE_NOT_FOUND   — unknown store, nothing to retry; contact IT
//   REQUEST_AUTH_FAIL — query endpoint failed auth after retry; contact IT
//   ORDER_AUTH_FAIL   — ordering endpoint failed auth; RESTART PROCESS
// ---------------------------------------------------------------------------

function agentAuthError(err, context) {
  fdeLog.error("server:authError", err.message, {
    error_type: err.name, store_id: err.storeId ?? context?.store_id, ...context,
  });

  if (err instanceof OrderAuthError) {
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          error:         "ORDER_AUTH_FAILURE",
          store_id:      err.storeId,
          endpoint:      err.endpoint,
          message:       err.message,
          action:        "restart_process",
          instructions: [
            "1. Stop — do NOT call raise_replenishment again in this session.",
            "2. Confirm with IT whether the order was processed on the StoreLink side.",
            "3. Once IT has confirmed the key and cleared any partial order, restart",
            "   from get_inventory_snapshot with a fresh session.",
          ],
        }, null, 2),
      }],
    };
  }

  if (err instanceof StoreCredentialNotFoundError || err instanceof KeyExpiredError) {
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          error:    err.code,   // STORE_NOT_FOUND or KEY_EXPIRED
          store_id: err.storeId,
          message:  err.message,
          action:   "contact_it_support",
        }, null, 2),
      }],
    };
  }

  if (err instanceof RequestAuthError) {
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          error:    "REQUEST_AUTH_FAILURE",
          store_id: err.storeId,
          endpoint: err.endpoint,
          message:  err.message,
          action:   "contact_it_support",
          note:     "The query was not completed. Data was not retrieved. Safe to retry after IT resolves the key.",
        }, null, 2),
      }],
    };
  }

  return null; // not an auth error — let caller rethrow
}

// ---------------------------------------------------------------------------
// Session-scoped snapshot cache
// Populated by get_inventory_snapshot so raise_replenishment can record
// on_hand_before in the buyer audit without an extra API round-trip.
// Key: "store_id:sku"  Value: on_hand integer
// ---------------------------------------------------------------------------
const snapshotCache = new Map();

// ---------------------------------------------------------------------------
// Server bootstrap
// ---------------------------------------------------------------------------

const server = new McpServer({
  name:    "storelink-buyer",
  version: "1.0.0",
});

// ---------------------------------------------------------------------------
// Tool 1 — get_inventory_snapshot
//
// Purpose:  Answer "how much do we have and how fast is it moving?"
// Returns:  on-hand units + a pre-computed intraday velocity so the agent
//           never has to do arithmetic.  A concise `status` string lets the
//           agent surface a human-readable answer without further reasoning.
// ---------------------------------------------------------------------------

server.tool(
  "get_inventory_snapshot",
  `Returns current on-hand stock and intraday sales velocity for one SKU in one store.
Use this as the first step before deciding whether to forecast a stockout or raise a replenishment order.`,
  {
    store_id: z.string().describe("StoreLink store identifier, e.g. 'STR-042'"),
    sku:      z.string().describe("Stock-keeping unit code, e.g. 'SKU-8821'"),
  },
  async ({ store_id, sku }) => {
    const t0  = Date.now();
    const scope = "tool:get_inventory_snapshot";
    fdeLog.tool(scope, "called", { store_id, sku });

    try {
      const now        = new Date();
      const fourHrsAgo = new Date(now - 4 * 3_600_000);

      // Fetch in parallel — fail fast if either call errors
      const [inventoryRaw, posRaw] = await Promise.all([
        getInventory(store_id, sku),
        getPOSTransactions(store_id, sku, fourHrsAgo.toISOString()),
      ]);

      const velocity = computeVelocity(posRaw.transactions, fourHrsAgo, now);

      // Cache on_hand for use in raise_replenishment's buyer audit row
      snapshotCache.set(`${store_id}:${sku}`, inventoryRaw.on_hand);

      // Derive a plain-language status for quick agent reasoning
      let status;
      if (velocity.units_per_hour === 0) {
        status = "no sales recorded in the last 4 hours";
      } else {
        const hrsLeft = inventoryRaw.on_hand / velocity.units_per_hour;
        if (hrsLeft < 4)       status = "critically low — likely empty within 4 hours";
        else if (hrsLeft < 8)  status = "low — monitor closely";
        else                   status = "adequate";
      }

      const result = {
        store_id:        inventoryRaw.store_id,
        sku,
        on_hand:         inventoryRaw.on_hand,
        unit:            inventoryRaw.unit,
        inventory_as_of: inventoryRaw.last_updated,
        intraday_velocity: {
          window_hours:   velocity.window_hours,
          units_sold:     velocity.units_sold,
          units_per_hour: velocity.units_per_hour,
        },
        status,
      };

      fdeLog.tool(scope, `completed in ${Date.now() - t0}ms`, {
        store_id, sku, on_hand: inventoryRaw.on_hand, status,
      });

      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };

    } catch (err) {
      const authResponse = agentAuthError(err, { store_id, sku });
      if (authResponse) return authResponse;
      fdeLog.error(scope, `failed after ${Date.now() - t0}ms — ${err.message}`, { store_id, sku });
      throw err;
    }
  }
);

// ---------------------------------------------------------------------------
// Tool 2 — forecast_stockout
//
// Purpose:  Answer "will we run out by this afternoon / within N hours?"
// Design:   Pulls *two* POS windows (last 4 h for recency, last 7 days for
//           history), blends them, and returns a structured forecast with an
//           explicit `replenishment_recommended` boolean so the agent can
//           branch without further reasoning.
// ---------------------------------------------------------------------------

server.tool(
  "forecast_stockout",
  `Predicts whether a SKU will run out of stock within the next several hours.
Combines today's intraday sales rate with a 7-day historical baseline for accuracy.
Returns a structured forecast including estimated stockout time and whether
replenishment is recommended. Always call get_inventory_snapshot first, or
pass on_hand directly if you already have it.`,
  {
    store_id: z.string().describe("StoreLink store identifier"),
    sku:      z.string().describe("Stock-keeping unit code"),
    on_hand:  z.number().int().nonnegative()
      .describe("Current on-hand units. Obtain from get_inventory_snapshot if unknown."),
  },
  async ({ store_id, sku, on_hand }) => {
    const t0    = Date.now();
    const scope = "tool:forecast_stockout";
    fdeLog.tool(scope, "called", { store_id, sku, on_hand });

    try {
      const now        = new Date();
      const fourHrsAgo = new Date(now - 4  * 3_600_000);
      const sevenDays  = new Date(now - 7  * 24 * 3_600_000);

      // Fetch both windows in parallel
      const [recentPos, historicPos] = await Promise.all([
        getPOSTransactions(store_id, sku, fourHrsAgo.toISOString()),
        getPOSTransactions(store_id, sku, sevenDays.toISOString()),
      ]);

      const recentVel   = computeVelocity(recentPos.transactions,   fourHrsAgo, now);
      const historicVel = computeVelocity(historicPos.transactions, sevenDays,  now);
      const blended     = blendedVelocity(recentVel.units_per_hour, historicVel.units_per_hour);

      const { hours_of_stock, stockout_at } = forecastStockout(on_hand, blended);
      const urgent    = isUrgent(hours_of_stock);
      const suggested = urgent ? suggestQuantity(blended) : null;

      const result = {
        store_id,
        sku,
        on_hand,
        forecast: {
          recent_velocity_units_per_hour:   recentVel.units_per_hour,
          historic_velocity_units_per_hour: historicVel.units_per_hour,
          blended_velocity_units_per_hour:  blended,
          hours_of_stock,
          stockout_at,
        },
        replenishment_recommended: urgent,
        // Only present when action is needed — keeps the success path clean
        ...(urgent && {
          suggested_order_quantity: suggested,
          recommendation:
            `Stock is forecast to run out at ${stockout_at}. ` +
            `Raising a replenishment order for ${suggested} units is recommended.`,
        }),
      };

      fdeLog.tool(scope, `completed in ${Date.now() - t0}ms`, {
        store_id, sku, hours_of_stock, stockout_at,
        replenishment_recommended: urgent,
        ...(urgent && { suggested_order_quantity: suggested }),
      });

      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };

    } catch (err) {
      const authResponse = agentAuthError(err, { store_id, sku, on_hand });
      if (authResponse) return authResponse;
      fdeLog.error(scope, `failed after ${Date.now() - t0}ms — ${err.message}`, { store_id, sku, on_hand });
      throw err;
    }
  }
);

// ---------------------------------------------------------------------------
// Tool 3 — raise_replenishment
//
// Purpose:  Create a replenishment order in StoreLink.
// Design:   Requires an explicit `quantity` so the agent must consciously
//           choose how much to order (informed by forecast_stockout's
//           `suggested_order_quantity`).  Returns only the fields the agent
//           needs to confirm success and hand the order_id to get_order_status.
// ---------------------------------------------------------------------------

server.tool(
  "raise_replenishment",
  `Creates a replenishment order for a SKU at a store.
Use this after forecast_stockout indicates replenishment_recommended is true.
The suggested_order_quantity from forecast_stockout is a sensible default, but
the agent may adjust it based on business context (promotions, seasonality, etc.).`,
  {
    store_id: z.string().describe("StoreLink store identifier"),
    sku:      z.string().describe("Stock-keeping unit code"),
    quantity: z.number().int().positive()
      .describe("Number of units to order. Use forecast_stockout's suggested_order_quantity as a starting point."),
    reason:   z.string().optional()
      .describe("Optional free-text justification recorded on the order, e.g. 'Forecast stockout by 14:00'."),
  },
  async ({ store_id, sku, quantity, reason }) => {
    const t0    = Date.now();
    const scope = "tool:raise_replenishment";
    fdeLog.tool(scope, "called", { store_id, sku, quantity, reason });

    try {
      const order = await createReplenishmentOrder(store_id, {
        sku,
        quantity,
        ...(reason && { reason }),
      });

      const durationMs  = Date.now() - t0;
      const on_hand_before = snapshotCache.get(`${store_id}:${sku}`) ?? null;
      const lead_time_hrs  = order.estimated_arrival && order.created_at
        ? +((new Date(order.estimated_arrival) - new Date(order.created_at)) / 3_600_000).toFixed(2)
        : null;

      fdeLog.tool(scope, `completed in ${durationMs}ms`, {
        store_id, sku, order_id: order.order_id, quantity_ordered: order.quantity, status: order.status,
      });

      // Buyer audit — one row per order event
      buyerAudit({
        store_id,
        sku,
        on_hand_before,
        ordered:              true,
        qty_ordered:          order.quantity,
        on_hand_projected:    on_hand_before != null ? on_hand_before + order.quantity : null,
        order_id:             order.order_id,
        estimated_arrival:    order.estimated_arrival,
        lead_time_hrs,
        trigger_reason:       reason ?? null,
      });

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            order_id:          order.order_id,
            store_id:          order.store_id,
            sku:               order.sku,
            quantity_ordered:  order.quantity,
            status:            order.status,
            estimated_arrival: order.estimated_arrival,
            created_at:        order.created_at,
          }, null, 2),
        }],
      };

    } catch (err) {
      const authResponse = agentAuthError(err, { store_id, sku, quantity });
      if (authResponse) return authResponse;
      fdeLog.error(scope, `failed after ${Date.now() - t0}ms — ${err.message}`, { store_id, sku, quantity });
      throw err;
    }
  }
);

// ---------------------------------------------------------------------------
// Tool 4 — get_order_status
//
// Purpose:  Check on an order raised in this session (or earlier).
// Design:   Simple wrapper; kept separate from raise_replenishment so the
//           agent can poll without re-ordering.
// ---------------------------------------------------------------------------

server.tool(
  "get_order_status",
  `Retrieves the current status of a replenishment order previously raised via raise_replenishment.
Returns status (pending / confirmed / dispatched / delivered) and estimated arrival time.`,
  {
    store_id: z.string().describe("StoreLink store identifier"),
    order_id: z.string().describe("Order ID returned by raise_replenishment"),
  },
  async ({ store_id, order_id }) => {
    const t0    = Date.now();
    const scope = "tool:get_order_status";
    fdeLog.tool(scope, "called", { store_id, order_id });

    try {
      const order = await getReplenishmentOrder(store_id, order_id);

      fdeLog.tool(scope, `completed in ${Date.now() - t0}ms`, {
        store_id, order_id, status: order.status, estimated_arrival: order.estimated_arrival,
      });

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            order_id:          order.order_id,
            store_id:          order.store_id,
            status:            order.status,
            estimated_arrival: order.estimated_arrival,
            created_at:        order.created_at,
          }, null, 2),
        }],
      };

    } catch (err) {
      const authResponse = agentAuthError(err, { store_id, order_id });
      if (authResponse) return authResponse;
      fdeLog.error(scope, `failed after ${Date.now() - t0}ms — ${err.message}`, { store_id, order_id });
      throw err;
    }
  }
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
