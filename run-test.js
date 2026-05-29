/**
 * run-test.js  —  Replays the SKU-8847291 test case directly against the
 * tool logic, bypassing the MCP transport layer.  Used to generate sample
 * log output after code changes without requiring a server restart.
 *
 * Usage:  node run-test.js
 *         LOG_LEVEL=verbose node run-test.js
 */

import {
  getInventory,
  getPOSTransactions,
  createReplenishmentOrder,
} from "./storelink-client.js";

import {
  computeVelocity,
  blendedVelocity,
  forecastStockout,
  isUrgent,
  suggestQuantity,
} from "./inventory-math.js";

import { fdeLog, buyerAudit } from "./logger.js";

const STORES = ["STR-047", "STR-102"];
const SKU    = "SKU-8847291";
const GAP_THRESHOLD = 6;

for (const store_id of STORES) {

  // ── Tool 1: get_inventory_snapshot ────────────────────────────────────────
  {
    const t0    = Date.now();
    const scope = "tool:get_inventory_snapshot";
    fdeLog.tool(scope, "called", { store_id, sku: SKU });

    const now        = new Date();
    const fourHrsAgo = new Date(now - 4 * 3_600_000);

    const [inventoryRaw, posRaw] = await Promise.all([
      getInventory(store_id, SKU),
      getPOSTransactions(store_id, SKU, fourHrsAgo.toISOString()),
    ]);

    const velocity = computeVelocity(posRaw.transactions, fourHrsAgo, now);

    let status;
    if (velocity.units_per_hour === 0) {
      status = "no sales recorded in the last 4 hours";
    } else {
      const hrsLeft = inventoryRaw.on_hand / velocity.units_per_hour;
      if (hrsLeft < 4)      status = "critically low — likely empty within 4 hours";
      else if (hrsLeft < 8) status = "low — monitor closely";
      else                  status = "adequate";
    }

    fdeLog.tool(scope, `completed in ${Date.now() - t0}ms`, {
      store_id, sku: SKU, on_hand: inventoryRaw.on_hand, status,
    });

    // ── Tool 2: forecast_stockout ──────────────────────────────────────────
    const t1     = Date.now();
    const scope2 = "tool:forecast_stockout";
    fdeLog.tool(scope2, "called", { store_id, sku: SKU, on_hand: inventoryRaw.on_hand });

    const sevenDays = new Date(now - 7 * 24 * 3_600_000);

    const [recentPos, historicPos] = await Promise.all([
      getPOSTransactions(store_id, SKU, fourHrsAgo.toISOString()),
      getPOSTransactions(store_id, SKU, sevenDays.toISOString()),
    ]);

    const recentVel   = computeVelocity(recentPos.transactions,   fourHrsAgo, now);
    const historicVel = computeVelocity(historicPos.transactions, sevenDays,  now);
    const blended     = blendedVelocity(recentVel.units_per_hour, historicVel.units_per_hour);

    const { hours_of_stock, stockout_at } = forecastStockout(inventoryRaw.on_hand, blended);
    const urgent    = isUrgent(hours_of_stock);
    const suggested = urgent ? suggestQuantity(blended) : null;

    fdeLog.tool(scope2, `completed in ${Date.now() - t1}ms`, {
      store_id, sku: SKU, hours_of_stock, stockout_at,
      replenishment_recommended: urgent,
      ...(urgent && { suggested_order_quantity: suggested }),
    });

    // ── Gap check & conditional Tool 3: raise_replenishment ───────────────
    const sold24h      = recentVel.units_per_hour * 24;
    const gap          = sold24h - inventoryRaw.on_hand;
    const shouldOrder  = gap > GAP_THRESHOLD;

    if (shouldOrder) {
      const qty    = Math.round(gap);
      const reason =
        `24h POS gap of ${qty} units (${Math.round(sold24h)} sold vs. ` +
        `${inventoryRaw.on_hand} on-hand) exceeds ${GAP_THRESHOLD}-unit threshold. ` +
        `Blended velocity ${blended} u/hr projects stockout by ${stockout_at}.`;

      const t2     = Date.now();
      const scope3 = "tool:raise_replenishment";
      fdeLog.tool(scope3, "called", { store_id, sku: SKU, quantity: qty, reason });

      const order = await createReplenishmentOrder(store_id, { sku: SKU, quantity: qty, reason });

      const lead_time_hrs = order.estimated_arrival && order.created_at
        ? +((new Date(order.estimated_arrival) - new Date(order.created_at)) / 3_600_000).toFixed(2)
        : null;

      fdeLog.tool(scope3, `completed in ${Date.now() - t2}ms`, {
        store_id, sku: SKU, order_id: order.order_id,
        quantity_ordered: order.quantity, status: order.status,
      });

      buyerAudit({
        store_id,
        sku:               SKU,
        on_hand_before:    inventoryRaw.on_hand,
        ordered:           true,
        qty_ordered:       order.quantity,
        on_hand_projected: inventoryRaw.on_hand + order.quantity,
        order_id:          order.order_id,
        estimated_arrival: order.estimated_arrival,
        lead_time_hrs,
        trigger_reason:    reason,
      });
    } else {
      // No order — still write a buyer audit row so the log is complete
      buyerAudit({
        store_id,
        sku:               SKU,
        on_hand_before:    inventoryRaw.on_hand,
        ordered:           false,
        qty_ordered:       0,
        on_hand_projected: inventoryRaw.on_hand,
        order_id:          null,
        estimated_arrival: null,
        lead_time_hrs:     null,
        trigger_reason:    `Gap of ${(sold24h - inventoryRaw.on_hand).toFixed(1)} units does not exceed threshold of ${GAP_THRESHOLD}`,
      });
    }
  }
}

console.log("Test run complete. Check fde.log and buyer-audit.log.");
