/**
 * test-discovery.js — Standalone test for drop discovery (no private keys needed).
 */
const { Contract, JsonRpcProvider } = require('ethers');
const { SEADROP_ADDRESS, SEADROP_ABI, discoverDropConfig } = require('./seadrop');

const RPC = 'https://mainnet.base.org';
const NFT_PROXY = '0x35a06ee03e7785dae88d4a5cf5ad0b32505eb2df';

async function main() {
  const provider = new JsonRpcProvider(RPC);
  const seadrop = new Contract(SEADROP_ADDRESS, SEADROP_ABI, provider);

  console.log('=== Testing drop discovery ===\n');
  console.log(`SeaDrop:   ${SEADROP_ADDRESS}`);
  console.log(`NFT proxy: ${NFT_PROXY}`);
  console.log('');

  try {
    const config = await discoverDropConfig(seadrop, NFT_PROXY);
    console.log('✓ Discovery successful!\n');
    console.log('Drop config:');
    console.log('  NFT address:    ', config.nftAddress);
    console.log('  Mint price:     ', Number(config.mintPrice) / 1e18, 'ETH');
    console.log('  Total cost:     ', Number(config.totalCost) / 1e18, 'ETH');
    console.log('  Start time:     ', new Date(config.startTime * 1000).toISOString());
    console.log('  End time:       ', new Date(config.endTime * 1000).toISOString());
    console.log('  Max per wallet: ', config.maxPerWallet);
    console.log('  Fee bps:        ', config.feeBps, `(${config.feeBps / 100}%)`);
    console.log('  Total supply:   ', Number(config.totalSupply));
    console.log('  Minted:         ', Number(config.minted));
    console.log('  Is active:      ', config.isActive);
    console.log('  Is upcoming:    ', config.isUpcoming);

    const now = Math.floor(Date.now() / 1000);
    if (config.isUpcoming) {
      const waitMin = Math.ceil((config.startTime - now) / 60);
      console.log(`\n⏳ Drop starts in ${waitMin} minutes`);
    } else if (config.isActive) {
      console.log('\n🔥 DROP IS ACTIVE NOW');
    } else {
      console.log('\n❌ Drop has ended');
    }
  } catch (err) {
    console.error('✗ Discovery failed:', err.message);
    process.exit(1);
  }
}

main();
