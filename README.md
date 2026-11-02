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

1. **Recall.** Before paying, the agent queries Walrus Memory for failures on the same request. Semantic recall narrows the candidates; the decision requires an exact match on method, path, sorted query and network, so one bad ticker never blocks a good one.
2. **Pay.** The API answers `402 Payment Required` with x402-style terms (`payTo`, amount, asset, network). The agent enforces a per-call spend cap and a network check, then pays with a SUI transfer.
3. **Verify.** The API verifies the transaction through Tatum's Sui gateway: the transfer must have succeeded and credited `payTo` with at least the price. Each digest is accepted once.
4. **Judge and remember.** The agent validates the response. If it paid and got nothing usable, it writes a failure record (request, network, amount, digest, reason) to Walrus Memory.

Settled Sui payments cannot be reversed. Edith does not recover money; it stops the loss from repeating.

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

The demo API returns real quotes for `SUI`, `WAL` and `BTC`. `ZZZ` takes payment and returns an empty body; `FLAKY` takes payment and returns `502`.

## Mainnet run

| Request | Result | Transaction |
|---|---|---|
| `ticker=SUI` | Paid, quote returned | [H9oQdHwA...](https://suiscan.xyz/mainnet/tx/H9oQdHwAc1NLF8nY5pa1FgVz6RgfSm56ZN1YXCHnJfzd) |
| `ticker=ZZZ` | Paid, empty body, failure remembered | [GXTajvsC...](https://suiscan.xyz/mainnet/tx/GXTajvsC1XrEWDJ8ZRDUeGfxQihmEAqUvpgbYRDY3An5) |
| `ticker=ZZZ` (new process) | Failure recalled, payment skipped | none |
| `ticker=FLAKY` | Paid, HTTP 502, failure remembered | [GSwxDzS6...](https://suiscan.xyz/mainnet/tx/GSwxDzS6faeEU3XFHLp5Pu1eUap1uvWQKXstyWMccsRi) |

## Project layout

```
src/agent.mjs                  paying agent with memory-backed skip decision
src/server.mjs                 demo paid API (x402-style 402 flow)
src/sui.mjs                    Tatum gRPC client and payment verification
src/memory.mjs                 Walrus Memory records and failure lookup
scripts/setup-wallets.mjs      wallet creation and devnet funding
scripts/check-integrations.mjs read-only Tatum and Walrus health check
test/memory.test.mjs           offline tests using MemWalMock
```

## Limitations

- The demo API keeps used digests in memory, so replay protection resets on restart.
- A payment is not yet bound to a specific request; any verified transfer of the right amount unlocks one call.
- The payment flow follows the x402 shape but is not wire-compatible with an x402 facilitator.

## License

[MIT](LICENSE)
