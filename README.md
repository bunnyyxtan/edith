# Edith

Edith is a non-custodial payment intelligence and memory layer for AI agents. It checks every paid API request against your spending limits and against what it remembers from earlier paid calls, so your agent never pays twice for the same mistake.

Agents that pay per request have a quiet failure mode: an endpoint takes the payment and returns an empty body, an error, or junk. A stateless agent pays for the same bad request again in its next session. Edith writes every paid outcome to Walrus Memory, confirms every payment on Sui through Tatum, and reads that memory before it lets a payment happen.

Built for the Tatum x Walrus [Total Recall](https://tatum.io/hackathon/total-recall) hackathon.

## Use it

1. **Connect your wallet.** Slush or any Wallet Standard wallet. You sign one message to prove the address is yours; it moves nothing and grants nothing.
2. **Connect an agent.** On Agents, name it and get its key (shown once). The agent calls Edith's API with that key. It can ask; it can never pay.
3. **Set your protection.** Confirm or change the most Edith may spend per payment and per 24 hours.
4. **Edith is on watch.** Your agent sends Edith the paid URLs it wants. Edith refuses at once what memory or your limits rule out, and puts the rest in your approvals. You review, your wallet signs, Edith verifies on Sui and remembers the outcome in Walrus Memory. The agent reads the answer.
5. **Monitor.** Overview shows what waits for you, recent decisions and what Edith has learned. Activity shows every decision, who asked, and the proof.

```bash
# your agent
curl -X POST "$EDITH/v1/requests" -H "authorization: Bearer $EDITH_AGENT_KEY" \
  -H "content-type: application/json" -d '{"url":"https://api.example.com/v1/data"}'
# -> {"id":"…","state":"awaiting","approval":{"review":"https://…/app?review=…"}}  or  "blocked" with the reason
curl "$EDITH/v1/requests/<id>" -H "authorization: Bearer $EDITH_AGENT_KEY"
# -> {"state":"paid","body":"…","digest":"…"} once you approved it
```

An agent's request waits up to 24 hours for approval; if its 4-minute quote has run out, Edith fetches a fresh price (and re-checks memory and limits) when you open it.

## Try the guided demo

Without an agent, open Demo in the app and follow the three steps:

1. **Pay for a quote that works.** A real 0.001 SUI payment, signed by your wallet, for a live SUI price.
2. **Pay for one that returns nothing.** The demo provider takes 0.001 SUI and answers with `{}`. Edith confirms the payment on Sui, judges the answer worthless, and saves that to your Walrus Memory.
3. **Ask for it again.** Edith recalls the paid failure and refuses before contacting the provider. The screen sets what an agent without memory would do (pay again) next to what Edith did (pay nothing), with the earlier Sui transaction and the Walrus blob as evidence.

No terminal, no private keys, no shared wallet. The guide costs 0.002 SUI plus network fees, paid from your own wallet.

## How a payment works

```
you / your agent        Edith                         provider                  Sui (Tatum gRPC)
  |-- ask about URL --->| recall memory (Walrus)          |                          |
  |                     | check your limits               |                          |
  |                     |-- GET ------------------------->|                          |
  |                     |<-- 402 + signed quote ----------|                          |
  |<-- quote + reason --|                                 |                          |
  |-- wallet signs the exact transfer (not sent) -------->|                          |
  |                     | simulate: exact amount, payee, sender ------------------->|
  |                     |-- retry with signed transfer -->|-- execute, confirm ----->|
  |                     |<-- answer ----------------------|                          |
  |                     | verify on Sui independently --------------------------->|
  |                     | judge answer, remember outcome (Walrus)                    |
  |<-- outcome + proof -|                                 |                          |
```

1. **Recall.** Edith loads every remembered paid outcome for the endpoint from your own Walrus Memory namespace. Known-bad requests are refused before the provider is contacted.
2. **Decide.** A pure policy (`src/policy.mjs`) turns that history into pay or refuse; your limits are checked next.
3. **Approve.** Your wallet signs the exact SUI transfer the quote asks for. Edith never sees a key.
4. **Check and send.** Edith simulates the signed transfer and sends it only if it pays exactly the quoted amount, to the quoted payee, from your signed-in account. The provider settles it on Sui.
5. **Verify.** Edith confirms through Tatum what actually reached the provider, whatever the provider says.
6. **Remember.** The outcome, worth it or not, is written to Walrus Memory and cited in later decisions.

Sui payments are final. Edith does not recover money; it stops the loss from repeating.

## What Edith learns

| Memory says | Decision |
|---|---|
| This exact request paid and returned junk or a 4xx | Refuse it until a later success clears it |
| This exact request hit a 5xx or 429 | Refuse for 15 minutes, then allow one retry |
| Most distinct requests on this endpoint failed (at least 3) | Refuse unseen requests on the endpoint |
| The price is over 2x the best price that paid off before | Refuse the price |

Memory can only make Edith refuse. It never raises a limit or approves a payment.

## Security model

| Concern | How Edith handles it |
|---|---|
| Custody | None. The person's wallet signs each transfer; the server holds no user key and no spending key. |
| Sign-in | Sign-In-with-Sui style message (domain, address, nonce, expiry), verified server side, including zkLogin and passkey wallets. Each message works once. Signing in grants no spending power. |
| Sessions | HMAC-sealed, `HttpOnly`, `SameSite=Strict`, `Secure` on https, 7 days. |
| Agent keys | `ek_<owner>.<id>.<secret>`; only a SHA-256 of the secret is stored, compared in constant time. A key reaches only `/v1/*`, sees only its own requests, cannot pay, and stops working the moment it is disconnected. The session cookie is not accepted on `/v1/*`, and an agent key is not accepted on `/api/*`. |
| Isolation | Activity and limits are stored per address; Walrus Memory uses a namespace per address. One wallet's memory never steers another's payments. Quotes are bound to the wallet that asked. |
| Spending limits | Per payment and per 24 hours, checked before a quote is shown and again, atomically, before a signed transfer is sent. Hard ceiling 0.01 SUI per call. |
| Wrong transfer | Simulated before sending: a transfer for a different amount, payee or sender is never submitted. |
| Replay | Quotes are HMAC-signed, bound to resource, amount, payee and network, and expire in 5 minutes. Providers keep a persistent ledger of settled transactions and reject transfers older than the quote. |
| Double submit | A quote is claimed synchronously before any await; a second submit gets 409. |
| Uncertain settlement | If the provider never answers, Edith checks Sui. Unconfirmed payments are marked uncertain, count against limits, and can be re-checked; a payment that landed unanswered is remembered as a failure. A settlement interrupted by a restart shows as uncertain, not lost. |
| SSRF | Provider URLs resolving to private, loopback or link-local ranges are refused; redirects are not followed; requests time out. |
| Browser | Strict CSP, same-origin JSON-only API, per-IP and per-wallet rate limits, no HTML built from data. |

## Production-ready and demo-only

| Production-ready | Demo-only or limited |
|---|---|
| Wallet sign-in, sessions, per-wallet isolation | Quote Desk, the bundled paid API at `/demo`, exists to be paid and to fail on purpose (`ZZZ`, `FLAKY`, `GONE`) |
| Signed-transfer payments with simulation, replay protection and limits | Activity and limits live in JSON files on one instance (`ponytail:` marked); move to a database to scale out |
| Independent Tatum verification and Walrus Memory per wallet | Rate limits are in memory on one instance |
| Uncertain-payment recovery and re-check | DNS rebinding between check and fetch is not covered (documented in `src/net.mjs`) |
| Agent keys and the agent API, with owner approval for every payment | Approvals need the owner to open the app (it polls every 5 seconds); there are no push or email notifications yet |
| Automated tests over the full journey, agents included | Live quotes are held in memory on one instance; after a restart, agent requests re-quote on review |
| | Delegated, capped spending without per-payment approval is not built: every payment needs the wallet's signature |

The x402 shape is followed, but the protocol is not wire-compatible with an x402 facilitator.

## Running it

Requires Node.js 24 or later.

```bash
npm install
cp .env.example .env    # Tatum API key, Walrus Memory credentials, SESSION_SECRET, PUBLIC_ORIGIN
npm run setup:wallets   # creates the demo provider's receiving address
npm run check           # verifies Tatum and Walrus Memory connectivity
npm run build           # builds the site and app into web/dist
npm start               # site, app, API and demo provider on PORT (4030)
```

Deploying: serve behind https, set `PUBLIC_ORIGIN` to the public address, `SESSION_SECRET` and `SERVER_CHALLENGE_SECRET` to long random values, `HOST=0.0.0.0` and `TRUST_PROXY=1` behind a reverse proxy, and keep `DATA_DIR` on persistent storage. `ALLOW_PRIVATE_PROVIDERS` stays off.

The command-line agent (`npm run agent -- <url>`) is a developer tool that pays from its own `AGENT_SUI_PRIVATE_KEY`. The web app never uses it.

## Tests and QA

```bash
npm test      # offline: protocol, paywall, Sui settlement, Edith end to end, API, auth, isolation, limits, SSRF, store
npm run qa    # local harness on :4031: the real app over a fake chain and MemWalMock, with a test wallet
```

Against a running Edith on the real network, `scripts/mainnet-check.mjs` exercises the public API end to end:

```bash
node --env-file=.env scripts/mainnet-check.mjs          # moves no funds: throwaway wallets, real Tatum and Walrus
node --env-file=.env scripts/mainnet-check.mjs --slow   # adds the expired-quote check (about 4.5 minutes)
EDITH_SMOKE_KEY=suiprivkey... node --env-file=.env scripts/mainnet-check.mjs --pay
# also spends real SUI from that separate wallet: two 0.001 SUI demo payments plus gas
```

The QA harness never touches a real chain. Load `/qa/wallet.js` into the app page to register its test wallet; `window.qaDecline(true)` makes it refuse like a person pressing Reject.

## Mainnet run (command-line agent)

An earlier run of the command-line agent on mainnet. Each line is a separate process; everything it knew came from Walrus Memory.

| Request | Memory before | Decision | Outcome | Transaction |
|---|---|---|---|---|
| `ZZZ` | paid, empty body | Skip, known junk | No payment | none |
| `BTC` | 5xx 19 min earlier | Pay, cooldown over | Quote returned | [Fks2tvHc...](https://suiscan.xyz/mainnet/tx/Fks2tvHcn2jRFzaefc1sffG8nLHeM7j73ZRFFV8NW53h) |
| `GONE` | nothing | Pay | 410, remembered | [6HT3v8KF...](https://suiscan.xyz/mainnet/tx/6HT3v8KFpmwPig2UpP48C13NHd9GtXTZXnRwrLYvSZ36) |
| `GONE` | 410 | Skip, known rejection | No payment | none |
| `FLAKY` | 5xx 42 min earlier | Pay, cooldown over | 502, remembered | [2BHnw9M1...](https://suiscan.xyz/mainnet/tx/2BHnw9M1ygZZAZK8irq1yU6UC3apvwCZMztiCh97M1tX) |
| `SUI` | succeeded before | Pay, known good | Quote returned | [Bmd7dz9n...](https://suiscan.xyz/mainnet/tx/Bmd7dz9nyWZHCFifDNM9DqfV5YWRSur9dGb1wGygvwuy) |

## Tatum and Walrus

| Integration | Where | Purpose |
|---|---|---|
| Tatum Sui gRPC gateway | `src/sui.mjs` | Simulate signed transfers, settle them, verify credits from balance changes, read balances, verify zkLogin sign-ins |
| Walrus Memory (`@mysten-incubation/memwal`) | `src/memory.mjs` | One namespace per wallet: every paid outcome and refusal, recalled before each payment |

Tatum serves Sui over native gRPC; the `@mysten/sui` client defaults to gRPC-web, so Edith passes a native transport with the Tatum key as `x-api-key`.

## Project layout

```
src/api.mjs        web API and agent API: sign-in, agents, limits, requests, approvals, payments, memory
src/edith.mjs      plan (recall, judge, quote, limits) and settle (check, send, verify, remember)
src/policy.mjs     pure pay-or-refuse policy over remembered outcomes
src/auth.mjs       wallet sign-in messages and sealed sessions
src/agents.mjs     agent keys: issue, verify, revoke
src/store.mjs      per-wallet limits and activity
src/net.mjs        provider fetching with SSRF guard
src/payment.mjs    quotes, challenges and the signed-transfer header
src/paywall.mjs    provider side: settle once, replay ledger
src/server.mjs     Quote Desk, the demo paid API
src/sui.mjs        Tatum gRPC client, settlement, simulation, verification
src/memory.mjs     Walrus Memory records
web/               site and app (Vite, no framework)
scripts/           wallet setup, integration check, QA harness
test/              offline test suite
```

## License

[MIT](LICENSE)
