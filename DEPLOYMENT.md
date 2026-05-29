# Deployment Guide — storelink-mcp

This server is an MCP (Model Context Protocol) stdio server. It does **not** run as an HTTP service or listen on a network port. The MCP host (Claude Code) spawns it as a subprocess and communicates over stdin/stdout.

All dependencies are bundled inside the Docker image. **No internet access is required at runtime.**

---

## Requirements

| Requirement | Version |
|---|---|
| Docker | 20+ |
| API credentials | Provided by Korral IT (one key per store) |

---

## 1. Build the image

```bash
docker build -t storelink-mcp:1.0.0 .
```

The build is fully self-contained — `npm ci` runs inside Docker during the build stage. The final image does not contain package manager tooling or source maps.

To verify the build:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"0.0.1"}}}' \
  | docker run -i --rm --env-file .env storelink-mcp:1.0.0
```

Expected: a JSON response containing `"serverInfo":{"name":"storelink-buyer","version":"1.0.0"}`.

---

## 2. Configure credentials

Copy `.env.example` to `.env` and fill in the values provided by Korral IT:

```bash
cp .env.example .env
```

**`.env` format:**

```dotenv
# One block per store. Store ID hyphens become underscores in var names.

STORELINK_KEY_STR_047_CURRENT=sk_live_STR047_<key-from-IT>
STORELINK_KEY_STR_047_EXPIRES=2027-06-07T10:00:00Z

STORELINK_KEY_STR_102_CURRENT=sk_live_STR102_<key-from-IT>
STORELINK_KEY_STR_102_EXPIRES=2027-06-07T10:00:00Z
```

To add more stores, add a block following the same pattern. See `.env.example` for the full rotation fields (`_NEXT`, `_NEXT_VALID_FROM`).

> **Security:** `.env` is gitignored and must never be committed. In production, pass credentials as environment variables or Docker secrets rather than a file.

---

## 3. Wire into Claude Code

***************************************************************
NOTE TB: When checking through this, I saw that Claude built this to connect to Claude code, which contradicts the instructions to keep it self-contained in the customer's GCP environment. Given the provided time constraint, I did not fix this (also as I don't want Claude to break something while trying to fix it), but we can assume that where the instructions/DEPLOYMENT.md says to "wired this into Claude Code", we would replace that section with whatever the customer environment equivalent is (Vertex? something self-hosted?). 
***************************************************************

Add the server to Claude Code's MCP configuration. The command uses `docker run -i` — the `-i` flag is required to keep stdin open for the stdio transport.

**User-level config** (`~/.claude/claude_desktop_config.json` or via `claude mcp add`):

```json
{
  "mcpServers": {
    "storelink-buyer": {
      "command": "docker",
      "args": [
        "run", "--rm", "-i",
        "--env-file", "/absolute/path/to/storelink.env",
        "-v", "/var/log/storelink:/app/logs",
        "storelink-mcp:1.0.0"
      ]
    }
  }
}
```

Or via the CLI:

```bash
claude mcp add storelink-buyer \
  docker -- run --rm -i \
  --env-file /absolute/path/to/storelink.env \
  -v /var/log/storelink:/app/logs \
  storelink-mcp:1.0.0
```

> Restart Claude Code after adding the server. The tools `get_inventory_snapshot`, `forecast_stockout`, `raise_replenishment`, and `get_order_status` will be available in the next session.

---

## 4. Logs

The server writes two log files to `/app/logs` inside the container. Mount a host directory to persist them:

```bash
-v /var/log/storelink:/app/logs
```

| File | Audience | Format |
|---|---|---|
| `fde.log` | FDE / on-call engineer | Structured text, append-mode |
| `buyer-audit.log` | Category buyer / BI tools | NDJSON, one line per order event |

**Log verbosity** is controlled by the `LOG_LEVEL` environment variable:

| Value | What's logged |
|---|---|
| `error` (default) | Errors, auth failures, and all agent tool calls |
| `verbose` | Everything above + successful API responses with field-level detail |

```bash
-e LOG_LEVEL=verbose   # add to docker run args when debugging
```

---

## 5. Weekly key rotation (Korral IT)

Keys rotate every **Monday at 10:00 UTC**. The server handles a 10-minute overlap window automatically — no downtime required.

**IT checklist, the week before rotation:**

1. Generate new keys for all active stores.
2. In `.env`, uncomment and populate the `_NEXT` and `_NEXT_VALID_FROM` lines for each store:
   ```dotenv
   STORELINK_KEY_STR_047_NEXT=sk_live_STR047_<new-key>
   STORELINK_KEY_STR_047_NEXT_VALID_FROM=2027-06-07T09:50:00Z  # EXPIRES − 10 min
   ```
3. Redeploy (rebuild image or restart container with updated env file) — **at least 1 hour before** the rotation time.

**After rotation (Monday after 10:00 UTC):**

1. Promote `_NEXT` → `_CURRENT`, update `_EXPIRES` to the following Monday.
2. Remove the `_NEXT` and `_NEXT_VALID_FROM` lines.
3. Redeploy.

> If an active request gets a 401 (key rotated mid-flight on query endpoints), the server retries once with the next key automatically. If the **ordering endpoint** returns a 401 or 403, the server will **not** retry — it returns an error instructing the agent to restart the replenishment workflow to avoid duplicate orders. Check `fde.log` for a `CRITICAL` line with the full context.

---

## 6. Troubleshooting

**Server doesn't start / Claude can't connect**
- Confirm Docker is running: `docker info`
- Confirm the image exists: `docker images storelink-mcp`
- Run the smoke test in step 1 manually to isolate whether it's a Docker or config issue.

**`STORE_NOT_FOUND` error in Claude**
- The agent asked for a store whose credentials aren't in `.env`.
- Add the store's credential block to `.env` and redeploy.

**`KEY_STORE_MISMATCH` error in `fde.log`**
- The key deployed for a store belongs to a different store. Check the `.env` values — the key must contain the store ID fragment (e.g. `STR047` for store `STR-047`).

**`KEY_EXPIRED` error**
- The current key's `EXPIRES` timestamp has passed and no next key is deployed.
- Provide a valid key to IT immediately and redeploy.

**Logs not appearing on the host**
- Confirm the volume mount path exists and is writable on the host.
- Check `LOG_DIR` is not overridden to a different path.
