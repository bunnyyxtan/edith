# Edith

Edith is an AI agent that pays for API calls and remembers which paid calls were not worth it.

Agents that pay per request have a quiet failure mode: an endpoint takes the payment and returns an empty body, an error, or junk. A stateless agent will pay for the same bad request again in its next session. Edith records each bad paid call in Walrus Memory and checks that memory before it pays, so a mistake costs money once.

Built for the Tatum x Walrus [Total Recall](https://tatum.io/hackathon/total-recall) hackathon.

## How it works

```
agent                         paid API                      Sui (via Tatum gRPC)
  |  recall past failures          |                                 |
  |  (Walrus Memory)               |                                 |
  |-- GET /quote?ticker=ZZZ ------>|                                 |
  |<-- 402 + payment terms --------|                                 |
  |-- transfer 0.001 SUI ----------------------------------------->|
  |-- retry with tx digest ------->|-- verify transfer ------------>|
  |<-- 200 {} (useless) -----------|                                 |
  |  remember failure                                                |
  |  (Walrus Memory)                                                 |
```

On the next run, in a fresh process, the recall finds that failure and the agent declines to pay.

1. **Recall.** Before paying, the agent loads every remembered paid outcome for the endpoint (same provider and network) from Walrus Memory. Semantic recall finds candidates; exact fields decide.
2. **Decide.** A pure policy (`src/policy.mjs`) turns that history into pay or skip, before the provider is contacted when possible and again once the price is known.
3. **Pay.** The API answers `402 Payment Required` with x402-style terms and a signed challenge. The agent validates the terms, enforces a per-call spend cap, pays with a SUI transfer, and signs a proof binding the challenge to the transaction.
4. **Verify.** The API checks the challenge and proof, then confirms through Tatum's Sui gateway that the transfer succeeded, credited the payee, and was sent by the proof's signer.
5. **Judge and remember.** The agent classifies the response and writes the outcome, success or failure, to Walrus Memory.

Settled Sui payments cannot be reversed. Edith does not recover money; it stops the loss from repeating.

## What Edith learns

| Memory says | Decision |
|---|---|
| This exact request paid and returned junk or a 4xx | Skip it, permanently, until a later success clears it |
| This exact request hit a 5xx or 429 | Skip it for 15 minutes, then retry once |
| Most distinct requests on this endpoint failed (at least 3) | Skip unseen requests on the endpoint; requests that last succeeded stay payable |
| The quoted price is over 2x the best price that previously paid off | Refuse the price |

Reliability counts each distinct request's latest outcome, so retrying one flaky request does not condemn its endpoint.

## Payment security

| Threat | Defence |
|---|---|
| Someone redeems a digest they saw on chain | The proof must be signed by the transaction's sender |
| A payment is reused for another request | The challenge binds resource, amount, payee and network, and is HMAC-signed |
| An old payment is reused for a new challenge | Payments older than the challenge are rejected; challenges expire after 5 minutes |
| The same digest is redeemed twice, including concurrently | Digests are reserved before any await and persisted to disk once redeemed |
| The verifier is rate-limited after the agent paid | Lookups retry with backoff; outages return 503 with `Retry-After` and the agent retries the same proof |
| A provider quotes an unsafe price, asset or network | The agent validates terms against a spend cap, SUI only, and its own network |

## Tatum and Walrus

| Integration | Where | Purpose |
|---|---|---|
| Tatum Sui gRPC gateway (`sui-<network>-grpc.gateway.tatum.io`) | `src/sui.mjs` | Execute agent payments, verify payments server-side from transaction balance changes |
| Walrus Memory SDK (`@mysten-incubation/memwal`) | `src/memory.mjs` | Persist failure and avoided-payment records on Walrus Mainnet, recall them across sessions |

Sui has deprecated JSON-RPC, and Tatum serves Sui over native gRPC. The `@mysten/sui` gRPC client defaults to gRPC-web, so Edith passes a native transport (`@protobuf-ts/grpc-transport`) with the Tatum API key as `x-api-key` metadata.

## Quick start

Requires Node.js 24 or later.

```bash
npm install
cp .env.example .env    # add TATUM_API_KEY and Walrus Memory credentials
npm run setup:wallets   # creates agent and API wallets; funds the agent on devnet
npm run check           # verifies Tatum and Walrus Memory connectivity
```

On testnet or mainnet, fund the printed agent address before continuing.

```bash
npm run server                                                  # paid API on :4020
npm run agent -- "http://localhost:4020/quote?ticker=SUI"       # pays, gets a quote
npm run agent -- "http://localhost:4020/quote?ticker=ZZZ"       # pays, gets junk, remembers
npm run agent -- "http://localhost:4020/quote?ticker=ZZZ"       # recalls, does not pay
```

The demo API returns real quotes for `SUI`, `WAL` and `BTC`. `ZZZ` takes payment and returns an empty body, `FLAKY` returns `502`, `GONE` returns `410`, and unknown tickers return `404`.

Set `SERVER_CHALLENGE_SECRET` to keep challenges valid across API restarts; otherwise a random secret is generated per process.

## Tests

```bash
npm test
```

The suite runs offline: the payment protocol, the paywall (replay, concurrency, stolen digests, expiry, outages) over real Ed25519 signatures, the decision policy, Tatum lookup handling with a stubbed client, and memory records against the SDK's `MemWalMock`.

## Mainnet run

Each line is a separate agent process; everything it knows comes from Walrus Memory.

| Request | Memory before | Decision | Outcome | Transaction |
|---|---|---|---|---|
| `ZZZ` | paid, empty body | Skip, known junk | No payment | none |
| `BTC` | 5xx 19 min earlier | Pay, cooldown over | Quote returned | [Fks2tvHc...](https://suiscan.xyz/mainnet/tx/Fks2tvHcn2jRFzaefc1sffG8nLHeM7j73ZRFFV8NW53h) |
| `GONE` | nothing | Pay | 410, remembered | [6HT3v8KF...](https://suiscan.xyz/mainnet/tx/6HT3v8KFpmwPig2UpP48C13NHd9GtXTZXnRwrLYvSZ36) |
| `GONE` | 410 | Skip, known rejection | No payment | none |
| `FLAKY` | 5xx 42 min earlier | Pay, cooldown over | 502, remembered | [2BHnw9M1...](https://suiscan.xyz/mainnet/tx/2BHnw9M1ygZZAZK8irq1yU6UC3apvwCZMztiCh97M1tX) |
| `FLAKY` | 502 just now | Skip, cooling down | No payment | none |
| `QQQ`, `XXX`, `YYY` | nothing | Pay | 404 each, remembered | [6gos5Lsr...](https://suiscan.xyz/mainnet/tx/6gos5LsrCbtm8oXgzE8RbmvPmapdL46T6HrdbXZAyiNm) |
| `NEW` | 5 of 9 requests on `/quote` broken | Skip, endpoint unreliable | No payment | none |
| `SUI` | succeeded before | Pay, known good | Quote returned | [Bmd7dz9n...](https://suiscan.xyz/mainnet/tx/Bmd7dz9nyWZHCFifDNM9DqfV5YWRSur9dGb1wGygvwuy) |

## Project layout

```
src/agent.mjs                  paying agent: recall, decide, pay, prove, judge, remember
src/policy.mjs                 pure pay-or-skip policy over remembered outcomes
src/payment.mjs                challenge, payer proof and 402 terms validation
src/paywall.mjs                server-side redemption and replay ledger
src/server.mjs                 demo paid API
src/sui.mjs                    Tatum gRPC client and payment lookup
src/memory.mjs                 Walrus Memory outcome records
scripts/setup-wallets.mjs      wallet creation and devnet funding
scripts/check-integrations.mjs read-only Tatum and Walrus health check
test/                          offline test suite
```

## Limitations

- The payment flow follows the x402 shape but is not wire-compatible with an x402 facilitator.
- History is recalled per endpoint with a ceiling of 100 records; long-lived endpoints would need periodic summarization.
- The replay ledger is a local file, suitable for a single API instance.

## License

[MIT](LICENSE)
