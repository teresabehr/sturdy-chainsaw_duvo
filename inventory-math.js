/**
 * inventory-math.js
 *
 * Pure functions for turning raw POS data into actionable velocity and
 * stockout forecasts.  No I/O — easy to unit-test.
 */

/**
 * Computes sales velocity from a list of POS transactions.
 *
 * @param {Array<{sold_at: string, quantity_sold: number}>} transactions
 * @param {Date} windowStart
 * @param {Date} windowEnd
 * @returns {{ units_sold: number, window_hours: number, units_per_hour: number }}
 */
export function computeVelocity(transactions, windowStart, windowEnd) {
  const windowMs    = windowEnd - windowStart;
  const windowHours = windowMs / 3_600_000;

  const unitsSold = transactions
    .filter(t => {
      const ts = new Date(t.sold_at);
      return ts >= windowStart && ts <= windowEnd;
    })
    .reduce((sum, t) => sum + t.quantity_sold, 0);

  return {
    units_sold:    unitsSold,
    window_hours:  Math.round(windowHours * 10) / 10,
    units_per_hour: windowHours > 0
      ? Math.round((unitsSold / windowHours) * 100) / 100
      : 0,
  };
}

/**
 * Blends a recent (intraday) velocity and a historical (7-day) velocity
 * using a weighted average.  Recent signal gets more weight, but history
 * damps out noise when the window is short.
 *
 * @param {number} recentRate   units/hour from last ~4 h
 * @param {number} historicRate units/hour from last 7 days
 * @param {number} recentWeight 0–1, default 0.7
 */
export function blendedVelocity(recentRate, historicRate, recentWeight = 0.7) {
  return Math.round(
    (recentRate * recentWeight + historicRate * (1 - recentWeight)) * 100
  ) / 100;
}

/**
 * Forecasts how many hours of stock remain given on-hand and a velocity.
 *
 * @param {number} onHand           current unit count
 * @param {number} unitsPerHour     blended velocity
 * @returns {{ hours_of_stock: number|null, stockout_at: string|null }}
 *   hours_of_stock is null when velocity is zero (no sales → no prediction).
 *   stockout_at is an ISO timestamp.
 */
export function forecastStockout(onHand, unitsPerHour) {
  if (unitsPerHour <= 0) {
    return { hours_of_stock: null, stockout_at: null };
  }

  const hoursOfStock = Math.round((onHand / unitsPerHour) * 10) / 10;
  const stockoutAt   = new Date(Date.now() + hoursOfStock * 3_600_000).toISOString();

  return { hours_of_stock: hoursOfStock, stockout_at: stockoutAt };
}

/**
 * Decides whether the situation calls for an urgent replenishment.
 *
 * "Urgent" = predicted stockout within the next 6 hours  (configurable via
 * REPLENISHMENT_HORIZON_HOURS env var so buyers can tune it per category).
 */
export function isUrgent(hoursOfStock) {
  if (hoursOfStock === null) return false;
  const horizonHours = parseFloat(process.env.REPLENISHMENT_HORIZON_HOURS ?? "6");
  return hoursOfStock < horizonHours;
}

/**
 * Suggests a replenishment quantity: enough to cover `coverDays` days at the
 * blended velocity, rounded up to the nearest case-pack size if provided.
 *
 * @param {number} unitsPerHour
 * @param {number} coverDays     default 2 (cover next 2 days)
 * @param {number} casePackSize  default 1 (no rounding)
 */
export function suggestQuantity(unitsPerHour, coverDays = 2, casePackSize = 1) {
  const raw     = Math.ceil(unitsPerHour * 24 * coverDays);
  const rounded = Math.ceil(raw / casePackSize) * casePackSize;
  return Math.max(rounded, casePackSize);
}
