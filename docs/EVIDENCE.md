# Mainnet acceptance evidence

Real run on Sui Mainnet on 3 November 2026, with a Slush browser wallet and agents connected through Edith's agent API. Every payment was approved by the wallet's owner in Slush. Verified afterwards, independently of the app, with `node --env-file=.env scripts/verify-evidence.mjs <wallet>`: **all evidence verified**.

- Wallet (payer): `0x46a11faac995ab4451b60b81e662c6993cc8f3fc05fda504f74db4c78b18f7cb`
- Provider (Quote Desk, payee): `0x234556cc16b90de70d8a2f3fe1959cd1eba994769c6ac5e2b0c4002ec2b9f904`
- Walrus Memory namespace: `edith-0x46a11faac995ab4451b60b81e662c6993cc8f3fc05fda504f74db4c78b18f7cb`

## What happened

| Time (UTC) | Agent | Request | Edith's decision | Sui transaction | Walrus Memory blob |
|---|---|---|---|---|---|
| 08:27:29 | test agent | `GET /demo/quote?ticker=SUI` | Approved and paid 0.001 SUI; useful answer, remembered as success | [`75FUrCA5xTnXL5CU7i576Y5D4CttEGtyoFbR8JpiPsEX`](https://suiscan.xyz/mainnet/tx/75FUrCA5xTnXL5CU7i576Y5D4CttEGtyoFbR8JpiPsEX) | [`honDNbf9C_G5TsT8_FK6wpUMOXVuhSEqWU1hx5X1vRs`](https://walruscan.com/mainnet/blob/honDNbf9C_G5TsT8_FK6wpUMOXVuhSEqWU1hx5X1vRs) |
| 08:35:49 | test agent 2 | `GET /demo/quote?ticker=SUI` | Approved and paid 0.001 SUI; useful answer, remembered as success | [`x9Er8C5Lv7xZF1e5zhesMisWFvC9Qc7ognf1qxAJ7ur`](https://suiscan.xyz/mainnet/tx/x9Er8C5Lv7xZF1e5zhesMisWFvC9Qc7ognf1qxAJ7ur) | [`vC9lF2bSgZ57U01FnAXODqpD30f0_9AdB1a-F0XFxyc`](https://walruscan.com/mainnet/blob/vC9lF2bSgZ57U01FnAXODqpD30f0_9AdB1a-F0XFxyc) |
| 08:36:44 | test agent 2 | `GET /demo/quote?ticker=ZZZ` | Approved and paid 0.001 SUI; the provider returned `{}`, remembered as failure | [`CHn7z3JmjQF9GbFfrxuuHet7ADayz55Fcy9AHXoxp9b4`](https://suiscan.xyz/mainnet/tx/CHn7z3JmjQF9GbFfrxuuHet7ADayz55Fcy9AHXoxp9b4) | [`pD3BkClaMcJop9tPYlsGI3WYATA6-HAmVR4LQfSKISk`](https://walruscan.com/mainnet/blob/pD3BkClaMcJop9tPYlsGI3WYATA6-HAmVR4LQfSKISk) |
| 08:42:52 | test agent 2, fresh run | `GET /demo/quote?ticker=ZZZ` | **Refused from memory** before contacting the provider, citing `CHn7z3Jm…`. No wallet prompt, nothing paid | none | |

The ZZZ request was approved five minutes after the agent asked, past its four-minute quote, so this run also exercised the fresh-price path on review.

## What the verifier checked

For each paid request, through Tatum's Sui gRPC gateway:

- the transaction succeeded,
- it was sent by the payer wallet above,
- it credited the provider at least the quoted amount in native SUI (coin type `0x2::sui::SUI`, normalized).

For each, through Walrus Memory in the wallet's own namespace: the outcome record exists with the same transaction digest and the same blob id the app shows. For the refusal: the paid failure it cites is on chain.

Each blob is also served by the public Walrus Mainnet aggregator (`https://aggregator.walrus-mainnet.walrus.space/v1/blobs/<id>`, HTTP 200; the content is encrypted by Walrus Memory).

```
0x46a11faac995ab4451b60b81e662c6993cc8f3fc05fda504f74db4c78b18f7cb on mainnet: 3 paid, 1 refused from memory

PASS  GET /demo/quote?ticker=ZZZ paid 0.001 SUI
PASS    remembered in Walrus Memory as failure
PASS  GET /demo/quote?ticker=SUI paid 0.001 SUI
PASS    remembered in Walrus Memory as success
PASS  GET /demo/quote?ticker=SUI paid 0.001 SUI
PASS    remembered in Walrus Memory as success
PASS  GET /demo/quote?ticker=ZZZ refused, citing a paid failure that is on chain

all evidence verified
```

## Memory on Mainnet

41 Walrus Memory records on Mainnet across Edith's namespaces at the time of writing: 37 from earlier command-line runs (namespace `edith`) and 4 from this run.
