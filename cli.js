#!/usr/bin/env node
/**
 * cli.js — Command-line interface for the OpenSea FCFS Mint Engine
 */
const { loadPrivateKeys } = require('./load-keys');
const MintEngine = require('./engine');

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
  console.error('❌ Missing RPC_URL or pk.txt');
  console.error('');
  console.error('Create a .env file:');
  console.error('  cp .env.example .env');
  console.error('  nano .env');
  process.exit(1);
}

const engine = new MintEngine(config);

const [, , cmd, ...args] = process.argv;

async function run() {
  switch (cmd) {
    case 'add': {
      const [contract, startTimeISO, notes = ''] = args;
      if (!contract || !startTimeISO) {
        console.log('Usage: node cli.js add <contract> <startTimeISO> [notes]');
        console.log('  startTimeISO: e.g. 2026-05-07T14:00:00Z');
        console.log('  (or "auto" to discover from chain)');
        process.exit(1);
      }
      let mintTime = startTimeISO;
      if (startTimeISO === 'auto') {
        const info = await engine.discoverDrop(contract);
        mintTime = new Date(info.startTime * 1000).toISOString();
        console.log(`Auto-discovered start time: ${mintTime}`);
      }
      const drop = engine.addDrop({ contract, startTimeISO: mintTime, notes });
      console.log('✅ Drop queued:', drop.id);
      break;
    }

    case 'discover': {
      const [contract] = args;
      if (!contract) {
        console.log('Usage: node cli.js discover <contract>');
        process.exit(1);
      }
      const info = await engine.discoverDrop(contract);
      console.log('🔍 Discovered drop config:');
      console.log('  NFT address:    ', info.nftAddress);
      console.log('  Mint price:     ', Number(info.mintPrice) / 1e18, 'ETH');
      console.log('  Total cost:     ', Number(info.totalCost) / 1e18, 'ETH');
      console.log('  Start time:     ', new Date(info.startTime * 1000).toISOString());
      console.log('  End time:       ', new Date(info.endTime * 1000).toISOString());
      console.log('  Max per wallet: ', info.maxPerWallet);
      console.log('  Fee bps:        ', info.feeBps, `(${info.feeBps / 100}%)`);
      console.log('  Is active:      ', info.isActive);
      console.log('  Is upcoming:    ', info.isUpcoming);

      const now = Math.floor(Date.now() / 1000);
      if (info.isUpcoming) {
        const waitMin = Math.ceil((info.startTime - now) / 60);
        console.log(`\n⏳ Drop starts in ${waitMin} minutes`);
      } else if (info.isActive) {
        console.log('\n🔥 DROP IS ACTIVE NOW');
      } else {
        console.log('\n❌ Drop has ended');
      }
      break;
    }

    case 'list': {
      const drops = engine.listDrops();
      if (drops.length === 0) {
        console.log('No drops queued.');
      } else {
        console.log('Queued drops:');
        console.log('─'.repeat(90));
        drops.forEach(d => {
          const time = new Date(d.mintTime).toISOString();
          console.log(`  ${d.id} | ${d.contract} | ${time} | ${d.status} | ${d.notes}`);
        });
      }
      break;
    }

    case 'remove': {
      const [id] = args;
      if (!id) {
        console.log('Usage: node cli.js remove <id>');
        process.exit(1);
      }
      const ok = engine.removeDrop(id);
      console.log(ok ? '✅ Removed.' : '❌ Drop not found.');
      break;
    }

    case 'fire': {
      const [contract] = args;
      if (!contract) {
        console.log('Usage: node cli.js fire <contract>');
        console.log('  ⚠️  This fires IMMEDIATELY. No queue, no wait.');
        process.exit(1);
      }
      console.log('🔥 Manual fire initiated...\n');
      const results = await engine.fireNow(contract);
      console.log(`\n📊 Results: ${results.successful} success, ${results.reverted} reverted, ${results.failed} failed`);
      break;
    }

    case 'preflight': {
      const [contract] = args;
      if (!contract) {
        console.log('Usage: node cli.js preflight <contract>');
        process.exit(1);
      }
      const config = await engine.discoverDrop(contract);
      const preflight = await engine.minter.preflight(config, 1);
      if (preflight.ok) {
        console.log('✅ All checks passed. Ready to fire.');
      } else {
        console.log('⚠️  Pre-flight warnings:');
        preflight.issues.forEach(i => console.log(`  • ${i}`));
      }
      break;
    }

    case 'start':
    default:
      console.log('🚀 Starting OpenSea FCFS Mint Engine...');
      console.log(`   RPC: ${config.rpcUrl}`);
      console.log(`   Wallets: ${config.privateKeys.length}`);
      console.log(`   Gas multiplier: ${config.gasMultiplier}x`);
      console.log(`   Poll interval: ${config.pollIntervalMs}ms`);
      console.log('');
      console.log('Press Ctrl+C to stop.\n');
      engine.start();

      process.on('SIGINT', () => {
        console.log('\n🛑 Stopping engine...');
        engine.stop();
        process.exit(0);
      });
      break;
  }
}

run().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
