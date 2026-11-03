# Slush acceptance test

One real run of the whole journey on Sui Mainnet, with a real Slush wallet and a real agent: connect, approve, pay, remember, refuse. You approve every payment yourself. Expect to spend 0.002 SUI plus network fees (about 0.005 SUI in all).

## Before you start

- Chrome with the **Slush** extension. Use a separate Slush account holding about **0.01 SUI**, set to **Mainnet**.
- Edith running locally on Mainnet: `npm run build && npm start`, then open **http://localhost:4030/app** (exactly this address).
- A terminal in the project folder for the agent.

## The run

| # | Do | Expect |
|---|---|---|
| 1 | Open the app, **Connect wallet**, choose **Slush**, approve the connection | Slush is listed as *Detected*. Slush asks you to connect, then to sign a message that says it does not move funds or let Edith spend |
| 2 | Sign the message | Overview: *Set up Edith in three steps*, step 1 done, your address and balance in the header |
| 3 | **Agents** → name it `Acceptance agent` → **Create agent key** → **Copy** | The key is shown once, starting `ek_` |
| 4 | **Limits** → **Confirm these limits** (0.005 per payment, 0.02 per 24 hours) | Overview now says *Edith is on watch* |
| 5 | Terminal: `EDITH_AGENT_KEY=<key> npm run agent -- "http://localhost:4030/demo/quote?ticker=SUI"` | The agent prints `awaiting 0.001 SUI` and a review link, then waits |
| 6 | Within 5 seconds the app shows it under *Waiting for your approval*. **Review** → **Approve in wallet** | Slush shows one transfer of **0.001 SUI** to the Quote Desk address. Approve it |
| 7 | Watch the dialog | Check, send, confirm on Sui, judge, save to Walrus Memory, then **PAID.** Saving to Walrus can take up to a minute. The agent prints `PAID 0.001 SUI, useful answer` with the transaction and memory id |
| 8 | Agent: same command with `ticker=ZZZ`, then approve it the same way | **REMEMBERED.** *Paid for nothing.* The agent prints `worthless answer` |
| 9 | Agent: `ticker=ZZZ` again | The agent prints `REFUSED by Edith (memory)` at once. **No** wallet prompt. Overview → *What Edith has learned* shows it under *Refuses* |
| 10 | Agent: `ticker=WAL`, then **Decline** it in the app | The agent prints `CANCELLED`. Nothing paid |
| 11 | Agent: `ticker=BTC`, **Approve in wallet**, then **Reject** in Slush | *You declined in your wallet. Nothing was paid.* The request stays reviewable; decline it afterwards |
| 12 | **Agents** → **Disconnect** the agent, run the agent again | The agent prints `error 401` |

## Check the evidence

```bash
node --env-file=.env scripts/verify-evidence.mjs <your Slush address>
```

Every line should say **PASS**: each payment succeeded on Sui, came from your wallet and credited the provider in native SUI, Walrus Memory returns each outcome with the same transaction, and the refusal cites a paid failure that is on chain. Also open the Suiscan and Walruscan links from **Activity**.

## If something fails

Note the step, copy what the app and the agent printed, and run the evidence check anyway. Nothing in this run can pay more than your limits allow, and every payment needs your approval in Slush.
