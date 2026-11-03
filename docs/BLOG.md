# Edith: an agent that never pays twice for the same mistake

*Draft for the Total Recall submission. Built with Walrus Memory on Mainnet and Tatum's Sui RPC.*

## The problem

AI agents can pay for things now. An agent finds a paid API, gets an HTTP 402 with a price, pays a little SUI and gets an answer. The quiet failure is what happens when the answer is worthless: an empty body, an error, junk. The agent paid, nothing noticed, and in its next session, with a blank slate, it pays for the same thing again.

## What Edith does

Edith sits between your agents and the APIs they pay for, and it remembers.

- You connect your own Sui wallet. Edith never holds a key.
- You connect an agent. It gets its own Edith key, which can ask about paid requests but can never pay.
- You set limits: the most per payment, the most per 24 hours.
- When your agent wants a paid URL, Edith checks what it remembers about that request and endpoint, checks your limits, and either refuses at once or asks you to approve. You approve in your wallet. Edith checks the signed transfer, the provider settles it, Edith verifies on Sui what actually arrived, judges the answer, and remembers the outcome.

The next time any of your agents asks for the same thing, Edith already knows how it went.

## How it uses Walrus Memory

Every paid outcome becomes a memory in Walrus Memory on Mainnet, in a namespace that belongs to the paying wallet: what was asked, at which provider, what it cost, the Sui transaction, and whether it was worth it. Before every payment Edith recalls the outcomes for that endpoint and decides:

- a request that paid and returned junk is refused from then on, before the provider is even contacted;
- a request that hit a temporary error waits 15 minutes before one retry;
- an endpoint where most requests failed is distrusted;
- a price far above what paid off before is refused.

Memory can only make Edith say no. It never raises a limit or approves a payment.

## How it uses Tatum

Edith talks to Sui through Tatum's gRPC gateway (Sui has moved to gRPC; Edith uses a native transport with the Tatum key). Tatum is used to:

- simulate each signed transfer before it is sent, so a transfer for the wrong amount, payee, sender or coin never leaves;
- settle the payment and confirm what reached the provider, in native SUI, from the transaction's balance changes;
- read wallet balances, and verify zkLogin wallets' sign-in signatures.

## How it learned, on Mainnet

On 3 November 2026 we ran the whole journey with a Slush wallet and a real agent:

1. The agent asked for a SUI price quote. Edith had no memory of it and asked for approval; we approved in Slush. Paid 0.001 SUI, useful answer, remembered as a success. ([tx](https://suiscan.xyz/mainnet/tx/x9Er8C5Lv7xZF1e5zhesMisWFvC9Qc7ognf1qxAJ7ur))
2. The agent asked for a ZZZ quote. Approved, paid 0.001 SUI, and the provider answered `{}`. Edith judged it worthless and wrote that to Walrus Memory. ([tx](https://suiscan.xyz/mainnet/tx/CHn7z3JmjQF9GbFfrxuuHet7ADayz55Fcy9AHXoxp9b4), [memory](https://walruscan.com/mainnet/blob/pD3BkClaMcJop9tPYlsGI3WYATA6-HAmVR4LQfSKISk))
3. A fresh run of the agent asked for ZZZ again. Edith recalled the paid failure and refused before contacting the provider, citing the earlier transaction. No wallet prompt, nothing paid.

An independent verifier then re-checked every payment on Sui through Tatum and every outcome in Walrus Memory: all verified. The full record is in the repository's `docs/EVIDENCE.md`.

## Built to be trusted with money

- Non-custodial: the wallet signs every payment; agent keys can only ask.
- Every signed transfer is simulated and must pay exactly the quote, to the quoted payee, in native SUI.
- Quotes are signed, bound to the request and expire; each payment can be redeemed once.
- Limits are enforced on the server, before a price is shown and again before a payment is sent.
- Each wallet's memory, activity and agents are isolated.

## What's next

Notifications for approvals, capped spending an agent can use without asking each time, and more providers speaking x402 on Sui.

*Links: repository · demo · X/LinkedIn post (add before publishing).*
