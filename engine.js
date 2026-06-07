/**
 * engine.js — FCFS Minting Engine
 * Queue a drop → monitor on-chain T-0 → all wallets fire simultaneously.
 */
const fs = require('fs');
const path = require('path');
const { JsonRpcProvider } = require('ethers');
const DropQueue = require('./queue');
const ParallelMinter = require('./minter');
const { SEADROP_ADDRESS, SEADROP_ABI } = require('./seadrop');

class MintEngine {
  constructor({
    rpcUrl,
    privateKeys,
    gasMultiplier = 1.5,
    priorityFeeGwei = 2,
    queueFile = './drops.json',
    logFile = './mint-log.jsonl',
    pollIntervalMs = 500,
    preTriggerOffsetMs = 500,
    jitterMsMax = 500,
  }) {
    this.provider = new JsonRpcProvider(rpcUrl);
    this.minter = new ParallelMinter({
      rpcUrl,
      privateKeys,
      gasMultiplier,
      priorityFeeGwei,
    });
    this.queue = new DropQueue(queueFile);
    this.logFile = path.resolve(logFile);
    this.pollIntervalMs = pollIntervalMs;
    this.preTriggerOffsetMs = preTriggerOffsetMs;
    this.jitterMsMax = jitterMsMax;
    this.isMonitoring = false;
    this.monitorInterval = null;
  }

  log(event, data = {}) {
    const entry = JSON.stringify({
      ts: new Date().toISOString(),
      event,
      ...data,
    });
    fs.appendFileSync(this.logFile, entry + '\n');
    console.log(`[LOG] ${event}`, data);
  }

  /**
   * Add a drop to the queue.
   */
  addDrop({ contract, startTimeISO, notes = '' }) {
    const drop = this.queue.add({
      contract,
      mintTimeISO: startTimeISO,
      notes,
    });
    this.log('drop_queued', { id: drop.id, contract, startTime: startTimeISO });
    return drop;
  }

  /**
   * Remove a drop by ID.
   */
  removeDrop(id) {
    const ok = this.queue.remove(id);
    this.log('drop_removed', { id, ok });
    return ok;
  }

  /**
   * List all drops.
   */
  listDrops() {
    return this.queue.list();
  }

  /**
   * Auto-discover drop start time from on-chain data.
   */
  async discoverDrop(contract) {
    try {
      const config = await this.minter.discover(contract);
      return config;
    } catch (err) {
      throw new Error(`Discovery failed for ${contract}: ${err.message}`);
    }
  }

  /**
   * Start monitoring queued drops. When T-0 approaches, fire all wallets.
   */
  start() {
    if (this.isMonitoring) {
      console.log('[ENGINE] Already monitoring');
      return;
    }
    this.isMonitoring = true;
    console.log('[ENGINE] Monitoring started');
    this.log('monitoring_started');

    this.monitorInterval = setInterval(() => this._tick(), this.pollIntervalMs);
  }

  stop() {
    this.isMonitoring = false;
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
    }
    console.log('[ENGINE] Monitoring stopped');
    this.log('monitoring_stopped');
  }

  async _tick() {
    const pending = this.queue.getPending();
    if (pending.length === 0) return;

    const now = Date.now();

    for (const drop of pending) {
      try {
        // Auto-discover if start time not set
        if (!drop.mintTime || drop.mintTime === 0) {
          const config = await this.discoverDrop(drop.contract);
          drop.mintTime = config.startTime * 1000;
          this.queue._save();
          this.log('drop_discovered', { id: drop.id, startTime: config.startTime });
        }

        const timeUntilDrop = drop.mintTime - now;

        // If drop is in the future but within pre-trigger window
        if (timeUntilDrop > 0 && timeUntilDrop <= this.preTriggerOffsetMs) {
          console.log(`[ENGINE] Drop ${drop.id} approaching T-0 in ${timeUntilDrop}ms`);
          this.log('drop_approaching', { id: drop.id, timeUntilDrop });
          continue;
        }

        // If drop time has passed
        if (timeUntilDrop <= 0) {
          this._fireDrop(drop);
        }
      } catch (err) {
        console.error(`[ENGINE] Error processing drop ${drop.id}:`, err.message);
        this.log('drop_error', { id: drop.id, error: err.message });
      }
    }

    // Prune expired
    this.queue.pruneExpired();
  }

  async _fireDrop(drop) {
    this.queue.updateStatus(drop.id, 'monitoring');
    console.log(`\n[ENGINE] 🔥 FIRING DROP ${drop.id}`);
    console.log(`  Contract: ${drop.contract}`);
    console.log(`  T-0: ${new Date(drop.mintTime).toISOString()}`);
    this.log('drop_firing', { id: drop.id, contract: drop.contract });

    try {
      // Discover latest config
      const config = await this.minter.discover(drop.contract);
      console.log(`  Mint price: ${Number(config.mintPrice) / 1e18} ETH | Max/wallet: ${config.maxPerWallet}`);

      // Pre-flight
      const preflight = await this.minter.preflight(config, 1);
      if (!preflight.ok) {
        console.warn(`[ENGINE] Pre-flight warnings:`);
        preflight.issues.forEach(i => console.warn(`  ! ${i}`));
      }

      // FIRE — all wallets simultaneously
      const results = await this.minter.fire(config, 1);

      // Update queue
      this.queue.updateStatus(drop.id, 'fired', results.results);
      this.log('drop_complete', {
        id: drop.id,
        broadcastTime: results.broadcastTime,
        successful: results.successful,
        reverted: results.reverted,
        failed: results.failed,
      });

      console.log(`\n[ENGINE] Drop ${drop.id} complete. ${results.successful} success, ${results.reverted} reverted, ${results.failed} failed.`);
    } catch (err) {
      console.error(`[ENGINE] Fire failed for drop ${drop.id}:`, err.message);
      this.queue.updateStatus(drop.id, 'failed');
      this.log('drop_failed', { id: drop.id, error: err.message });
    }
  }

  /**
   * Fire a drop immediately (manual trigger).
   */
  async fireNow(contract) {
    const config = await this.minter.discover(contract);
    console.log(`[ENGINE] Manual fire for ${contract}`);
    return this.minter.fire(config, 1);
  }
}

// ── CLI / Direct execution ───────────────────────────────────────
if (require.main === module) {
  const { loadPrivateKeys } = require('./load-keys');

  const config = {
    rpcUrl: process.env.RPC_URL,
    privateKeys: (process.env.PRIVATE_KEYS || '').split(',').map(k => k.trim()).filter(Boolean),
    gasMultiplier: parseFloat(process.env.GAS_MULTIPLIER || '1.5'),
    priorityFeeGwei: parseInt(process.env.PRIORITY_FEE_GWEI || '2'),
    queueFile: process.env.QUEUE_FILE || './drops.json',
    logFile: process.env.LOG_FILE || './mint-log.jsonl',
    pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || '500'),
    preTriggerOffsetMs: parseInt(process.env.PRE_TRIGGER_OFFSET_MS || '500'),
  };

  if (!config.rpcUrl || config.privateKeys.length === 0) {
    console.error('Missing RPC_URL or pk.txt');
    process.exit(1);
  }

  const engine = new MintEngine(config);

  // CLI args
  const [, , cmd, ...args] = process.argv;

  (async () => {
    switch (cmd) {
      case 'add': {
        const [contract, startTimeISO, notes = ''] = args;
        if (!contract || !startTimeISO) {
          console.log('Usage: node engine.js add <contract> <startTimeISO> [notes]');
          console.log('  startTimeISO: e.g. 2026-05-07T14:00:00Z');
          process.exit(1);
        }
        const drop = engine.addDrop({ contract, startTimeISO, notes });
        console.log('Drop queued:', drop.id);
        break;
      }

      case 'discover': {
        const [contract] = args;
        if (!contract) {
          console.log('Usage: node engine.js discover <contract>');
          process.exit(1);
        }
        const info = await engine.discoverDrop(contract);
        console.log('Discovered drop config:');
        console.log('  Mint price:', Number(info.mintPrice) / 1e18, 'ETH');
        console.log('  Start time:', new Date(info.startTime * 1000).toISOString());
        console.log('  End time:', new Date(info.endTime * 1000).toISOString());
        console.log('  Max per wallet:', info.maxPerWallet);
        console.log('  Fee bps:', info.feeBps);
        console.log('  Total cost:', Number(info.totalCost) / 1e18, 'ETH');
        console.log('  Active:', info.isActive);
        console.log('  Upcoming:', info.isUpcoming);
        break;
      }

      case 'list': {
        const drops = engine.listDrops();
        if (drops.length === 0) {
          console.log('No drops queued.');
        } else {
          console.log('Queued drops:');
          drops.forEach(d => {
            console.log(`  ${d.id} | ${d.contract} | ${d.mintTime} | ${d.status} | ${d.notes}`);
          });
        }
        break;
      }

      case 'remove': {
        const [id] = args;
        if (!id) {
          console.log('Usage: node engine.js remove <id>');
          process.exit(1);
        }
        const ok = engine.removeDrop(id);
        console.log(ok ? 'Removed.' : 'Drop not found.');
        break;
      }

      case 'fire': {
        const [contract] = args;
        if (!contract) {
          console.log('Usage: node engine.js fire <contract>');
          process.exit(1);
        }
        await engine.fireNow(contract);
        break;
      }

      case 'start':
      default:
        console.log('Starting engine... Press Ctrl+C to stop.');
        engine.start();
        process.on('SIGINT', () => {
          engine.stop();
          process.exit(0);
        });
        break;
    }
  })();
}

module.exports = MintEngine;
