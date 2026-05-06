# SeaDrop FCFS Mint Engine

> First-come-first-served NFT minting engine for SeaDrop-enabled collections on Base and Ethereum mainnet. Queue a drop, and all your wallets fire simultaneously at T-0.

## Features

- **Auto-discovery** — Reads drop config (price, start time, max per wallet, fees) directly from on-chain SeaDrop data. No manual research needed.
- **Parallel broadcast** — Every wallet submits its transaction in the same `Promise.all()` for sub-100ms spread.
- **Aggressive gas** — Configurable EIP-1559 multiplier to outbid competitors in the first block.
- **Queue & monitor** — Add drops in advance, start the engine, and walk away. It fires automatically at T-0.
- **Pre-flight checks** — Verifies wallet balances, drop timing, and on-chain state before committing ETH.

## How It Works

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐     ┌─────────────┐
│  Your       │────▶│  SeaDrop     │────▶│  NFT        │────▶│  You own    │
│  Wallets    │     │  Contract    │     │  Contract   │     │  the NFTs   │
└─────────────┘     └──────────────┘     └─────────────┘     └─────────────┘
```

All wallets call `mintPublic()` on the SeaDrop contract at the same time. The fastest transaction wins the block.

## Engine Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                        ENGINE START                              │
│                   node cli.js start                              │
└──────────────────────────────┬──────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│  MONITORING LOOP  (every 500ms)                                  │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ 1. Scan all queued drops in drops.json                  │    │
│  │ 2. For each drop:                                       │    │
│  │    • If mintTime unknown → call discover() on-chain     │    │
│  │    • Calculate timeUntilDrop = mintTime - now           │    │
│  └─────────────────────────────────────────────────────────┘    │
└──────────────────────────────┬──────────────────────────────────┘
                               │
              ┌────────────────┼────────────────┐
              ▼                ▼                ▼
       ┌──────────┐    ┌──────────┐     ┌──────────┐
       │ > 500ms  │    │ 0-500ms  │     │  <= 0    │
       │  (far)   │    │ (near)   │     │ (T-0)    │
       └────┬─────┘    └────┬─────┘     └────┬─────┘
            │               │                │
            ▼               ▼                ▼
       ┌──────────┐   ┌──────────┐    ┌──────────────────────────┐
       │ WAIT     │   │  LOG     │    │      _fireDrop()         │
       │          │   │"approach-│    │                          │
       │ Do       │   │ ing T-0" │    │  ┌────────────────────┐  │
       │ nothing  │   │          │    │  │ 1. Status →        │  │
       │          │   │ Prepare  │    │  │    monitoring      │  │
       │ Next     │   │ gas      │    │  ├────────────────────┤  │
       │ tick...  │   │ params   │    │  │ 2. Re-discover     │  │
       └──────────┘   └──────────┘    │  │    on-chain        │  │
                                       │  │    (last-minute    │  │
                                       │  │     changes)       │  │
                                       │  ├────────────────────┤  │
                                       │  │ 3. Pre-flight      │  │
                                       │  │    balance check   │  │
                                       │  ├────────────────────┤  │
                                       │  │ 4. ALL WALLETS     │  │
                                       │  │    FIRE SIMULTANEOUS│  │
                                       │  │    (Promise.all)   │  │
                                       │  ├────────────────────┤  │
                                       │  │ 5. Status → fired  │  │
                                       │  │    Save results    │  │
                                       │  └────────────────────┘  │
                                       └──────────────────────────┘
                                                               │
                                                               ▼
                                               ┌───────────────────────┐
                                               │   LOG & REPORT        │
                                               │  • successful: N      │
                                               │  • reverted:  N       │
                                               │  • failed:    N       │
                                               └───────────────────────┘
```

**Status Lifecycle:** `queued` → `monitoring` → `fired` | `failed` | `expired`

## Quick Start

### 1. Clone & Install

```bash
git clone https://github.com/fizzar99/seadrop.git
cd seadrop
npm install
```

### 2. Configure

```bash
cp .env.example .env
nano .env
```

Fill in your values:

```env
# ── RPC ──
RPC_URL=https://mainnet.base.org

# ── Wallets ──
# Comma-separated private keys with 0x prefix
PRIVATE_KEYS=0xabc123...,0xdef456...

# ── Gas Warfare ──
GAS_MULTIPLIER=1.5
PRIORITY_FEE_GWEI=2

# ── Engine Timing ──
POLL_INTERVAL_MS=500
PRE_TRIGGER_OFFSET_MS=500

# ── Storage ──
QUEUE_FILE=./drops.json
LOG_FILE=./mint-log.jsonl
```

### 3. Discover a Drop

```bash
node cli.js discover 0x35a06ee03e7785dae88d4a5cf5ad0b32505eb2df
```

### 4. Queue the Drop

```bash
# Auto-discover start time from chain
node cli.js add 0x35a06ee03e7785dae88d4a5cf5ad0b32505eb2df auto "Something Arts FCFS"

# Or specify exact time manually
node cli.js add 0x35a06ee03e7785dae88d4a5cf5ad0b32505eb2df 2026-05-06T15:00:00Z "Something Arts FCFS"
```

### 5. Start the Engine

```bash
node cli.js start
```

The engine polls every 500ms. When T-0 hits, all wallets fire automatically.

## CLI Commands

| Command | Description |
|---------|-------------|
| `node cli.js discover <contract>` | Read drop config from on-chain SeaDrop |
| `node cli.js add <contract> <time> [notes]` | Queue a drop. Use `auto` for on-chain time |
| `node cli.js list` | Show all queued drops |
| `node cli.js remove <id>` | Remove a drop by ID |
| `node cli.js start` | Start monitoring & auto-fire at T-0 |
| `node cli.js fire <contract>` | **Immediate fire** — no queue, no wait |
| `node cli.js preflight <contract>` | Check wallets & drop state before firing |

## Architecture

| File | Purpose |
|------|---------|
| `seadrop.js` | SeaDrop ABI, constants, on-chain discovery helpers |
| `minter.js` | Parallel wallet execution — simultaneous broadcast |
| `engine.js` | Core engine: queue, monitor, trigger, logging |
| `queue.js` | Drop queue persistence (JSON file) |
| `cli.js` | Command-line interface |
| `test-discovery.js` | Standalone discovery test (no private keys needed) |

## Gas Warfare

The engine uses EIP-1559 with configurable aggression:

```
maxFeePerGas     = baseFee × GAS_MULTIPLIER
maxPriorityFee   = PRIORITY_FEE_GWEI gwei
```

Default `1.5x` multiplier means you pay 50% above the current base fee to front-run other minters.

## Drop Discovery Example

```bash
$ node test-discovery.js

SeaDrop:   0x00005EA00Ac477B1030CE78506496e8C2dE24bf5
NFT proxy: 0x35a06ee03e7785dae88d4a5cf5ad0b32505eb2df

✓ Discovery successful!

Drop config:
  NFT address:     0x35a06ee03e7785dae88d4a5cf5ad0b32505eb2df
  Mint price:      0.001 ETH
  Total cost:      0.0011 ETH
  Start time:      2026-05-06T15:00:03.000Z
  End time:        2026-05-06T17:00:03.000Z
  Max per wallet:  1
  Fee bps:         1000 (10%)
  Total supply:    0
  Minted:          0
  Is active:       false
  Is upcoming:     true

⏳ Drop starts in 364 minutes
```

## On-Chain Findings (Something Arts)

| Parameter | Value |
|-----------|-------|
| Collection | Something Arts by Amber Wilfred |
| Symbol | Something Art |
| Contract | `0x35a06ee03e7785dae88d4a5cf5ad0b32505eb2df` (EIP-1167 proxy) |
| Implementation | `0x09a26fc8fcef18192e267d7a6da9dfb4be81dd6a` |
| SeaDrop | `0x00005EA00Ac477B1030CE78506496e8C2dE24bf5` |
| Mint function | `mintPublic(address,address,address,uint256)` on SeaDrop |
| Mint price | 0.001 ETH |
| Platform fee | 10% (1000 bps) |
| Total per mint | 0.0011 ETH |
| Max per wallet | 1 |
| Max supply | 150 |
| Current supply | 0 / 150 |

## Security

- **Never commit `.env`** — it's in `.gitignore`. Your private keys stay local.
- **Use burner wallets** — Dedicate wallets with just enough ETH for the drop + gas.
- **Verify before firing** — Use `discover` and `preflight` to confirm drop details.

## License

MIT
