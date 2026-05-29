Step 1: 
As a buyer in a large retailer, you have access to an internal system called StoreLink to replenish inventory as necessary. Build an MCP server that exposes the minimum set of tools an agent needs to do a store buyer's job. Stubbing the StoreLink calls is fine — the integration plumbing isn't what we're testing. What we're testing is the agent-facing surface: which tools you expose, what you choose not to expose, what shapes you return, and how you name things. The buyer typically perfoms the following tasks: 

* checking on-hand vs. POS
* deciding whether a store is going to be empty by afternoon
* raising replenishment orders

Available endpoints: 
GET   /v1/stores                                       List stores
GET   /v1/stores/{store_id}                            Store details
GET   /v1/stores/{store_id}/inventory?sku={sku}        Current on-hand for a SKU
GET   /v1/stores/{store_id}/pos?sku={sku}&since=...    Recent POS transactions for a SKU
POST  /v1/stores/{store_id}/replenishment              Raise a replenishment order
GET   /v1/stores/{store_id}/replenishment/{order_id}   Order status
GET   /v1/skus/{sku}                                   SKU details (name, category, supplier)
GET   /v1/suppliers/{supplier_id}                      Supplier details (incl. lead time)

Tasks that agent needs to cover:

* checking on-hand vs. POS
  * GET   /v1/stores/{store_id}/inventory?sku={sku}        Current on-hand for a SKU
    * to check available inventory on-hand for a product
  * GET   /v1/stores/{store_id}/pos?sku={sku}&since=...    Recent POS transactions for a SKU
    * use to check if inventory is diminishing fast or slowly
    * depending on available time limits -- long-term or short-term forecasting
    * deciding whether a store is going to be empty by afternoon
      * use results from inventory + rate of sale / POS transactions over time (last few hours, last few days) to determine whether inventory is moving slowly or quickly, and based on that, how much longer the available items are likely to last
      * make a likely prediction based on both recent data and historical (trends over the last 7 days)
* raising replenishment orders
  * POST  /v1/stores/{store_id}/replenishment              Raise a replenishment order
    * if the prediction is that we are likely to run out by afternoon: raise replenishment order for that product
  * GET   /v1/stores/{store_id}/replenishment/{order_id}   Order status
  
  Out of scope: (assumption: each product has one supplier? If multiple available)
  * *potentially* assuming more than one supplier is available for a product: optimize by supplier quantity and lead time
    * GET   /v1/skus/{sku}                                   SKU details (name, category, supplier)
    * GET   /v1/suppliers/{supplier_id}                      Supplier details (incl. lead time)


Step 3: 
Add observability. Two people will read your traces: an FDE debugging at 11pm when something is broken, and a Korral category buyer reading the audit log the next morning trying to understand what the agent did on their behalf. Decide what each of them needs and ship it.

FDE debugging what is broken:

* add traces for each API endpoint: what did we call, what was the response code, what was the error message (if there was one), and was the data not empty?
  * Example: if using GET   /v1/stores/{store_id}/inventory?sku={sku}   , we should see a number of items in the returned JSON (consisting of [minimum] SKU, product_name, number_in_stock)
  * Decision/choice: use different log levels -- normally use ERROR logs, which only log errors, and only include successful responses in log level VERBOSE
* agent decisions and agent tool calls -- which tools did the agent call and when

Buyer: 
* aggregating logs for the buyer into an overview table of what was ordered, when it was ordered, and conditions under which it was ordered
  * Order table: SKU, how many items were there before ordering, did the agent order, if yes how many, how many items after ordering, lead time
  
  (secondary, out of scope)
  * Inventory at delivery: SKU, how many items available at delivery time, how many items sold in the interim, how many items delivered


Step 4: 
StoreLink uses a per-store API key, rotated weekly by Korral's IT. Your server needs to handle this. Implement secret loading and a story for what happens when (a) a key rotates while a request is in flight, and (b) the agent asks for a store your server doesn't have credentials for. Both should fail safely and informatively — Korral's IT will judge you on both.

* need some kind of a credential store
  * for local testing: .env file
  * credentials include store ID and API key

* agents should be provided the key for "their" store(s), and should not need to directly query the key store -- the process to update them should happen via another deterministic service.

* if a key rotates while a request is in-flight
  * if the request has already authenticated, then it should be allowed to complete
  * maybe use credentials with a token generation so token is valid for the full duration
  * if that's not the case and we have static API keys -- if the request fails, check the API key again, add graceful handling
  * if we assume keys are replaced on a schedule, and always replaced weekly at the same time -- we can intentionally include an overlap period of ~ 10 minutes, and we can add a check when sending queries that the old API key is more than 10 minutes from expiration; if less than 10 minutes remains on the validity, then we can use the new API key
* Should it fail/something is not authenticated, then that information should be returned to the user/the agent, specifically which endpoint failed
  * if the query endpoint -- not that big a deal, raise an error for the logs and retry (ideally with the new key)
  * if the ordering endpoint fails -- raise an error and restart the process

* if a key is used that does not belong to that store id
  * return that information to the agent and raise an error for the logs/for human oversight


Step 5:
Write a short `DEPLOYMENT.md` and include a runnable artifact (Dockerfile or equivalent). Korral's IT has told you:

- StoreLink is not reachable from the public internet
- No customer data may leave Korral's GCP tenancy
- You will ship updates frequently after go-live

Cover: where this runs, how it gets there, how secrets are handled, who owns the pipeline (Duvo or Korral), how you ship a fix at 11pm if something breaks, and what you'd want to confirm with Korral's IT before day 1.

Where it runs: apparently GCP in a container environment 

Credential store and secrets handled in GCP (whatever their KeyVault equivalent)

with this design: no reason to send data outside the instance (possible exception: BI tool for buyer's)

We have access to a container registry in GCP where their app is pulling from, so we could ship the container image and they/we could pull the updated image in and restart the container with the fix 

Access rights -- what do we do, what do they do, do we push images directly, do they pull images, are they running single containers or clusters, what are their latency requirements, etc. Define shared responsibilities.



#############################
Final summary of what was built (from Claude, as not included in recording):
Dockerfile
Two-stage build:

deps stage — runs npm ci --omit=dev --ignore-scripts to produce a clean, reproducible node_modules. No npm tooling carries into the final image.
runtime stage — copies only the six source files the server needs, the pre-built modules from the deps stage, and nothing else. Runs as a dedicated non-root storelink user. No EXPOSE — this is a stdio server, not HTTP.
.dockerignore
Excludes .env, node_modules, *.log, .git, and run-test.js so none of those land in the build context or the image.

DEPLOYMENT.md
Six sections, each answering a specific operational question:

Build — single command + smoke test
Credentials — .env format, security note
Wire into Claude Code — exact docker run args including the critical -i flag for stdio, with both JSON config and CLI forms
Logs — volume mount path, file descriptions, LOG_LEVEL toggle
Key rotation — IT checklist with exact steps for the week before and week after rotation, and what happens when a 401 hits the ordering endpoint
Troubleshooting — the four error codes the auth layer produces, each with a one-line cause and fix
logger.js — LOG_DIR support
Logs now default to __dirname locally and pick up LOG_DIR=/app/logs inside Docker, so a -v mount works without any other config.

package.json — corrected start script
Was pointing at src/server.js (nonexistent); fixed to server.js.


#### When checking this, I saw that Claude built this to connect to Claude code, which contradicts the instructions to keep it self-contained in the customer's GCP environment. Given the provided time constraint, I did not fix this (also as I don't want Claude to break something while trying to fix it), but we can assume that where the instructions/DEPLOYMENT.md says to "wired this into Claude Code", we would replace that section with whatever the customer environment equivalent is (Vertex? something self-hosted?).

