# Lucky Voi Roll

Two-dice commit-reveal betting game on the [Voi Network](https://voi.network/) (AVM-compatible).

## Project Layout

```
contract/LuckyVoiRoll.py   PyTeal smart contract (primary — used for deployment)
contract/LuckyVoiRoll.ts   TEALScript version (reference)
scripts/deploy.mjs         Deployment script (Node.js, algosdk v3)
index.html                 Browser frontend (single-file, algosdk v2 via CDN)
artifacts/                 Compiled TEAL + ARC-32 JSON (generated, not committed)
```

## Setup

Install Node.js dependencies:
```bash
npm install          # root — algosdk + dotenv for deploy script
cd contract && npm install  # tealscript + algosdk (TS contract compilation)
```

Install Python dependencies:
```bash
pip install pyteal==0.25.0 algosdk
```

## Common Commands

| Task | Command |
|------|---------|
| Compile PyTeal contract | `npm run compile` |
| Compile TS contract | `cd contract && npm run compile` |
| Deploy to Voi testnet | `npm run deploy:testnet` |
| Deploy to Voi mainnet | `npm run deploy:mainnet` |

## Contract Overview

**Bet types:** Under 7 (pays 2×), Lucky 7 (pays 4×), Over 7 (pays 2×)

**RNG:** commit-reveal scheme — player submits `sha256(secret)` with bet, then reveals secret after 2+ rounds. Dice derived from `sha256(Block(commitRound).seed || secret || nonce)` so neither player nor validator can manipulate outcomes.

**Key global state:** `ow` owner, `pa` paused, `hb` house balance, `mn`/`mx` bet limits, `tg` total games, `nc` nonce counter.

**Key local state:** `cr` commit round, `cb` commit bet, `ct` commit type, `ch` commitment hash.

## Deployment

Requires `.env` with `DEPLOYER_MNEMONIC` (and optionally `HOUSE_SEED_VOI`, default 100 VOI). The deploy script compiles TEAL on-chain, creates the app, funds the house pool, and patches `APP_ID` in `index.html` automatically.

## Networks

| Network | Algod URL |
|---------|-----------|
| Testnet | `https://testnet-api.voi.nodly.io` |
| Mainnet | `https://mainnet-api.voi.nodly.io` |
