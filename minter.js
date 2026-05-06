/**
 * minter.js — Parallel FCFS minter. All wallets fire simultaneously at T-0.
 */
const { Contract, Wallet, JsonRpcProvider, keccak256, toUtf8Bytes } = require('ethers');
const { SEADROP_ADDRESS, SEADROP_ABI, discoverDropConfig, getAggressiveGas } = require('./seadrop');

class ParallelMinter {
  constructor({ rpcUrl, privateKeys, gasMultiplier = 1.5, priorityFeeGwei = 2 }) {
    this.provider = new JsonRpcProvider(rpcUrl);
    this.wallets = privateKeys.map(k => new Wallet(k.trim(), this.provider));
    this.seadrop = new Contract(SEADROP_ADDRESS, SEADROP_ABI, this.provider);
    this.gasMultiplier = gasMultiplier;
    this.priorityFeeGwei = priorityFeeGwei;
  }

  /**
   * Discover drop config from on-chain data.
   */
  async discover(nftAddress) {
    return discoverDropConfig(this.seadrop, nftAddress);
  }

  /**
   * Get allowed fee recipients for a drop. Returns the first one.
   */
  async getFeeRecipient(nftAddress) {
    try {
      const recipients = await this.seadrop.getAllowedFeeRecipients(nftAddress);
      if (recipients && recipients.length > 0) {
        return recipients[0];
      }
    } catch (e) {
      // Fallback: try getting creator payout address
    }
    try {
      const creator = await this.seadrop.getCreatorPayoutAddress(nftAddress);
      if (creator && creator !== '0x0000000000000000000000000000000000000000') {
        return creator;
      }
    } catch (e) {}
    // Last resort: use NFT contract owner
    try {
      const nft = new Contract(nftAddress, ['function owner() view returns (address)'], this.provider);
      return await nft.owner();
    } catch (e) {
      throw new Error('Could not determine fee recipient. Set FEE_RECIPIENT in .env');
    }
  }

  /**
   * Fire all wallets simultaneously at the drop.
   * @param {Object} drop — drop config object
   * @param {number} quantity — how many to mint per wallet
   */
  async fire(drop, quantity = 1) {
    const { nftAddress, totalCost, mintPrice } = drop;
    const feeRecipient = await this.getFeeRecipient(nftAddress);
    const gasParams = await getAggressiveGas(this.provider, this.gasMultiplier, BigInt(this.priorityFeeGwei));

    console.log(`\n[MINTER] Fire sequence initiated`);
    console.log(`  Target: ${nftAddress}`);
    console.log(`  Wallets: ${this.wallets.length}`);
    console.log(`  Mint price: ${Number(mintPrice) / 1e18} ETH`);
    console.log(`  Total cost per wallet: ${Number(totalCost) / 1e18} ETH`);
    console.log(`  Gas multiplier: ${this.gasMultiplier}x`);
    console.log(`  Fee recipient: ${feeRecipient}`);
    console.log(`  Max fee: ${Number(gasParams.maxFeePerGas) / 1e9} gwei`);
    console.log(`  Priority fee: ${Number(gasParams.maxPriorityFeePerGas) / 1e9} gwei\n`);

    // ── Build all transactions ─────────────────────────────────
    const txs = this.wallets.map(wallet => {
      const data = this.seadrop.interface.encodeFunctionData('mintPublic', [
        nftAddress,
        feeRecipient,
        '0x0000000000000000000000000000000000000000', // minterIfNotPayer = address(0) for self-mint
        quantity,
      ]);

      return {
        to: SEADROP_ADDRESS,
        data,
        value: totalCost.toString(),
        gasLimit: gasParams.gasLimit,
        maxFeePerGas: gasParams.maxFeePerGas,
        maxPriorityFeePerGas: gasParams.maxPriorityFeePerGas,
        wallet,
      };
    });

    // ── Simultaneous broadcast ────────────────────────────────
    const broadcastStart = Date.now();
    const broadcastPromises = txs.map(async (tx) => {
      try {
        const signed = await tx.wallet.sendTransaction({
          to: tx.to,
          data: tx.data,
          value: tx.value,
          gasLimit: tx.gasLimit,
          maxFeePerGas: tx.maxFeePerGas,
          maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
        });

        return {
          wallet: tx.wallet.address,
          txHash: signed.hash,
          nonce: signed.nonce,
          status: 'broadcasted',
          error: null,
          broadcastedAt: Date.now(),
        };
      } catch (err) {
        return {
          wallet: tx.wallet.address,
          txHash: null,
          nonce: null,
          status: 'failed',
          error: err.message,
          broadcastedAt: Date.now(),
        };
      }
    });

    const results = await Promise.all(broadcastPromises);
    const broadcastTime = Date.now() - broadcastStart;

    const broadcasted = results.filter(r => r.status === 'broadcasted');
    const failed = results.filter(r => r.status === 'failed');

    console.log(`[MINTER] Broadcast complete in ${broadcastTime}ms`);
    console.log(`  Broadcasted: ${broadcasted.length}/${this.wallets.length}`);
    console.log(`  Failed: ${failed.length}/${this.wallets.length}`);

    failed.forEach(f => {
      console.log(`    ✗ ${f.wallet}: ${f.error}`);
    });
    broadcasted.forEach(b => {
      console.log(`    ✓ ${b.wallet} | nonce: ${b.nonce} | ${b.txHash}`);
    });

    // ── Wait for confirmations ────────────────────────────────
    console.log('\n[MINTER] Waiting for confirmations...');
    const confirmationPromises = broadcasted.map(async (b) => {
      try {
        const receipt = await this.provider.waitForTransaction(b.txHash, 1, 60000);
        return {
          ...b,
          status: receipt.status === 1 ? 'success' : 'reverted',
          gasUsed: receipt.gasUsed.toString(),
          blockNumber: receipt.blockNumber,
          effectiveGasPrice: receipt.effectiveGasPrice?.toString(),
          confirmedAt: Date.now(),
        };
      } catch (err) {
        return {
          ...b,
          status: 'timeout',
          error: err.message,
        };
      }
    });

    const confirmed = await Promise.all(confirmationPromises);
    const successful = confirmed.filter(c => c.status === 'success');
    const reverted = confirmed.filter(c => c.status === 'reverted');
    const timedOut = confirmed.filter(c => c.status === 'timeout');

    console.log(`\n[MINTER] Confirmation results:`);
    console.log(`  Success: ${successful.length}`);
    console.log(`  Reverted: ${reverted.length}`);
    console.log(`  Timeout: ${timedOut.length}`);

    successful.forEach(s => {
      console.log(`    ✓ ${s.wallet} | block ${s.blockNumber} | gas ${s.gasUsed} | ${s.txHash}`);
    });
    reverted.forEach(r => {
      console.log(`    ✗ ${r.wallet} | REVERTED | ${r.txHash}`);
    });
    timedOut.forEach(t => {
      console.log(`    ? ${t.wallet} | TIMEOUT | ${t.txHash}`);
    });

    return {
      broadcastTime,
      totalWallets: this.wallets.length,
      broadcasted: broadcasted.length,
      failed: failed.length,
      successful: successful.length,
      reverted: reverted.length,
      timedOut: timedOut.length,
      results: confirmed,
    };
  }

  /**
   * Pre-flight check: verify wallets have enough ETH, drop is active, etc.
   */
  async preflight(drop, quantity = 1) {
    const issues = [];
    const now = Math.floor(Date.now() / 1000);

    // Check drop timing
    if (drop.isUpcoming) {
      const waitSec = drop.startTime - now;
      issues.push(`Drop starts in ${waitSec}s (${new Date(drop.startTime * 1000).toISOString()})`);
    } else if (!drop.isActive) {
      issues.push(`Drop has ended (${new Date(drop.endTime * 1000).toISOString()})`);
    }

    // Check wallet balances
    for (const wallet of this.wallets) {
      const balance = await this.provider.getBalance(wallet.address);
      if (balance < drop.totalCost) {
        issues.push(`Insufficient balance: ${wallet.address} has ${Number(balance) / 1e18} ETH, needs ${Number(drop.totalCost) / 1e18} ETH`);
      }
    }

    // Check if already minted max
    try {
      for (const wallet of this.wallets) {
        const stats = await this.seadrop.getMintStats(drop.nftAddress, wallet.address).catch(() => null);
        if (stats && Number(stats.minterNumMinted ?? stats[0] ?? 0) >= drop.maxPerWallet) {
          issues.push(`Already minted max: ${wallet.address}`);
        }
      }
    } catch (e) {
      // getMintStats may not exist on all SeaDrop versions
    }

    return {
      ok: issues.length === 0,
      issues,
    };
  }
}

module.exports = ParallelMinter;
