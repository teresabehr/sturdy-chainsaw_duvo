# storelink-mcp

MCP server for the store buyer agent. Wraps StoreLink's REST API into four
purpose-built tools — one per buyer decision, not one per endpoint.

## Quick start

```bash
npm install
STORELINK_BASE_URL=https://storelink.internal/v1 \
STORELINK_API_KEY=your-key \
npm start
```

The server speaks MCP over stdio. Point your MCP host at `npm start` (or
`node src/server.js`) as the server command.

---

## Tools

| Tool | Covers buyer task |
|---|---|
| `get_inventory_snapshot` | Check on-hand vs. recent POS |
| `forecast_stockout` | Will we be empty by afternoon? |
| `raise_replenishment` | Place a restock order |
| `get_order_status` | Follow up on an order |

### `get_inventory_snapshot`

```
store_id  string   StoreLink store ID
sku       string   SKU code
```

Returns on-hand units and a pre-computed 4-hour intraday velocity
(`units_per_hour`), plus a plain-language `status` field. The agent can
branch on `status` without further maths.

### `forecast_stockout`

```
store_id  string   StoreLink store ID
sku       string   SKU code
on_hand   integer  Current unit count (from get_inventory_snapshot)
```

Fetches two POS windows (last 4 h + last 7 days), blends them 70/30
(recent-weighted), and projects a `stockout_at` timestamp.

Key output fields:
- `hours_of_stock` — how long current stock lasts at blended rate
- `stockout_at` — ISO timestamp of predicted zero-stock moment
- `replenishment_recommended` — boolean; true when stockout < 6 h away
- `suggested_order_quantity` — only present when action is needed

The 6-hour horizon is tunable via `REPLENISHMENT_HORIZON_HOURS` env var.

### `raise_replenishment`

```
store_id  string   StoreLink store ID
sku       string   SKU code
quantity  integer  Units to order (use suggested_order_quantity as default)
reason    string?  Optional justification recorded on the order
```

Returns `order_id`, `status`, and `estimated_arrival`. The agent should pass
`order_id` to `get_order_status` for follow-up.

### `get_order_status`

```
store_id  string   StoreLink store ID
order_id  string   ID from raise_replenishment
```

Returns `status` (pending / confirmed / dispatched / delivered) and
`estimated_arrival`.

---

## Design decisions

### Why four tools instead of eight endpoints?

The eight StoreLink endpoints are plumbing. The buyer makes three decisions:

1. **How much do I have, and how fast is it moving?** → `get_inventory_snapshot`
2. **Will I run out today?** → `forecast_stockout`
3. **Should I order more, and how much?** → `raise_replenishment` + `get_order_status`

Mapping endpoints 1:1 would force the agent to fetch, parse, and do arithmetic
across multiple round-trips for every decision. Pre-computing velocity and the
stockout forecast inside the tool means the agent reasons over answers, not
over raw numbers.

### What was deliberately left out

| Endpoint | Why excluded |
|---|---|
| `GET /v1/stores` | Store ID comes from the buyer's task context; the agent never needs to enumerate stores |
| `GET /v1/stores/{id}` | Store metadata (name, address) isn't part of any inventory decision |
| `GET /v1/skus/{sku}` | SKU name/category is display-only; not needed for on-hand, velocity, or ordering decisions |
| `GET /v1/suppliers/{id}` | Lead time is surfaced indirectly via `estimated_arrival` on the order — the agent needs the answer, not the raw data |
| Raw `GET /pos` | Exposed only through the two higher-level tools; direct access would require the agent to compute velocity itself every time |

### Blended velocity (70/30)

Purely recent data is noisy (a quiet morning looks like no demand). Purely
historical data misses today's promotions or weather. The 70 % recent /
30 % historic blend keeps the forecast responsive while damping spikes.
The weights are constants in `inventory-math.js` — easy to tune.

### `replenishment_recommended` boolean

The agent should never have to implement `hours < threshold` itself. Making the
decision explicit in the tool output keeps the agent's logic in natural language
("if replenishment_recommended, call raise_replenishment") rather than in
threshold arithmetic that might drift from the real business rule.

---

## Wiring up the real StoreLink API

All HTTP calls are in `src/storelink-client.js`. The stub functions at the
bottom of that file are clearly labelled. To connect to a real StoreLink
instance:

1. Replace each `_stubGet` / `_stubPost` branch with a real `fetch()` call.
2. Set `STORELINK_BASE_URL` and `STORELINK_API_KEY` in the environment.
3. The tool layer (`src/server.js`) and the maths layer (`src/inventory-math.js`)
   need no changes.

---

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `STORELINK_BASE_URL` | `https://storelink.internal/v1` | API base URL |
| `STORELINK_API_KEY` | `stub-key` | Bearer token |
| `REPLENISHMENT_HORIZON_HOURS` | `6` | Hours-to-stockout threshold for urgency flag |
