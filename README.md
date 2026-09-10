# l2-escape-bench

Measurement harness for the paper *"Escape Hatches in the Wild: Measuring the Real
Censorship-Resistance of Ethereum Layer-2 Rollups."* It measures the gap between what a
rollup promises about forced inclusion and what invoking that promise actually costs a
user in latency, fees, waiting, and manual steps — across Arbitrum Nitro (delayed inbox
plus a user-invoked `forceInclusion`) and the OP Stack (portal deposits, included
automatically by derivation). The full research design is in
[`docs/BLUEPRINT.md`](docs/BLUEPRINT.md); the build queue is in
[`IMPLEMENTATION.md`](IMPLEMENTATION.md). This is research code: measurement integrity and
provenance outrank everything else, and every protocol parameter is read from chain at
runtime rather than hardcoded.

```bash
npm run verify                                        # connectivity + live params + unverified report
npm run typecheck                                     # tsc --noEmit  (run after every task)
npm run run -- --experiment B --chain arb-sepolia --n 25
npm run export -- --out data/export.csv
npm run index-mainnet -- --chain arbitrum-one --from 25449045 --to 25949044   # read-only mainnet history
```

Copy `.env.example` to `.env` and fill in the RPC URLs before running anything.

## Mainnet indexing (read-only)

`npm run index-mainnet` reads mainnet history and classifies it per BLUEPRINT §12. It never
signs or sends anything and loads no account.

The block range is **mandatory and recorded**. A Class A count is not a rate without the
window it was counted over, and §12 asks for a binomial CI, which needs that denominator to
exist as data — so every scan writes a `mainnet_scans` row with its exact range, the RPC
host (never the URL, so no API key reaches the dataset), whether it completed, and any
coverage gaps.

```bash
npm run index-mainnet -- --chain arbitrum-one --from N --to M   # or --last 500000
npm run index-mainnet -- --chain op-mainnet   --last 10000
python analysis/mainnet.py --db data/bench.sqlite                # counts, CI, batch sizes
```

Useful flags: `--skip-messages` (SequencerInbox only — Class A lives entirely there, and it
halves the requests), `--all-kinds` (index every delayed-message kind, not just kind 3
`L2_MSG`), `--chunk` / `--throttle-ms`.

### Picking an RPC — this is the hard part

`RPC_ETH_MAINNET` needs two things at once that most free endpoints will not give together:
**archive logs** and a **wide `eth_getLogs` range**. Measured 2026-09-11:

| Endpoint | Archive depth | Max `getLogs` span |
|---|---|---|
| `ethereum-rpc.publicnode.com` | gated — recent blocks only | wide |
| Alchemy free tier | yes | **10 blocks** |
| `eth.drpc.org` | yes | 10,000 (2,000 is comfortable; 10,000 times out) |

Pointing this at a testnet endpoint is refused outright: it would return an empty result set
that looks exactly like the finding the study is trying to establish. The CLI checks
`eth_chainId == 1` before scanning.

**Run one scan at a time.** Several concurrent scans share the endpoint's rate limit and each
one slows down — an easy mistake to make, and an easy one to misread as the provider
throttling. `npm`/`tsx` spawn a bare `node`, so `pkill -f index-mainnet` does **not** match a
running scan; kill it by PID.

## Funding

Which network the experiment wallet needs funds on depends on the **path**, not just the
chain. A and B are experiment types, and both are defined for several chains.

| Campaign | Needs funds on | Why |
|---|---|---|
| `A --chain op-sepolia` | OP Sepolia only | `submitNormal` sends via `cfg.rpcEnv`; there is no L1 transaction on the normal path |
| `A --chain arb-sepolia` | Arbitrum Sepolia only | same code path |
| `B --chain op-sepolia` | Ethereum Sepolia only — **gas + `msg.value`** | `depositTransaction` carries `value: tx.valueWei`; the deposit's L2 gas is prepaid by burning L1 gas and its value is minted on L2, so no OP Sepolia balance is needed |
| `B --chain arb-sepolia` | **Both** — Ethereum Sepolia *and* Arbitrum Sepolia | Ethereum Sepolia pays `sendL2Message` gas (the L1 call carries no value); Arbitrum Sepolia pays `value + gas` when the signed L2 transaction inside the delayed message executes |
| `--chain base-sepolia` | nothing | the adapter refuses to construct while its sequencing window is UNVERIFIED |

The Arbitrum forced case is the one worth getting right. With an empty Arbitrum Sepolia
balance the message queues normally, reaches S4, and then **fails on execution** — which
looks like the sequencer declining to include it. That is a false censorship signal
produced entirely by an unfunded wallet.

`npm run run` refuses to submit anything until the balances are there, reporting the
network, address, purpose, current balance and required minimum for each. Minimums are
derived from the campaign's own `gasLimit` and `valueWei` plus live fee data, **scaled to
the number of runs still pending** — so `--n 25` demands funds for 25 submissions, while a
campaign resumed with 23 of 25 already done asks only for the remaining 2. Both the
per-run figure and the campaign total are shown, since either can be the one that is
short. The safety margin on top is stated separately. The preflight is skipped under
`--dry-run`.

To check the wallet without arming a campaign:

```bash
npm run run -- --experiment B --chain arb-sepolia --n 25 --check-only
```

This prints the requirements table and exits non-zero if any network is short. It creates
no experiment row, claims no idempotency key, and sends nothing.

**Never fund a well-known test key.** The Hardhat/Anvil default accounts have published
private keys, and sweeper bots empty them within seconds of a balance appearing. A real
campaign refuses to run from one — under `--check-only` as well as on the real send path,
so the refusal arrives before you fund anything rather than after. Generate a fresh
testnet-only key for `PRIVATE_KEY`. (The public fixtures inside the harness are fine: they
sign for shape and size and never send.)
