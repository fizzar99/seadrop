/**
 * seadrop.js — SeaDrop contract constants, ABIs, and on-chain discovery helpers.
 * Target: Base mainnet.
 */
const { Contract, keccak256, toUtf8Bytes } = require('ethers');

// ── SeaDrop contract address (same on Base as Ethereum mainnet) ──
const SEADROP_ADDRESS = '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5';

// ── Minimal SeaDrop ABI — inline tuples for ethers.js compatibility ──
const SEADROP_ABI = [
  // Mint functions
  'function mintPublic(address nftContract, address feeRecipient, address minterIfNotPayer, uint256 quantity) payable',
  'function mintAllowList(address nftContract, address feeRecipient, address minterIfNotPayer, uint256 quantity, uint256 mintParamsIndex, bytes32[] calldata proof, bytes32 leaf) payable',
  'function mintSigned(address nftContract, address feeRecipient, address minterIfNotPayer, uint256 quantity, (uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,bytes32) calldata mintParams, uint256 salt, bytes calldata signature) payable',
  // Views
  'function getPublicDrop(address nftContract) view returns ((uint80,uint48,uint48,uint16,uint16,uint8))',
  'function getAllowList(address nftContract) view returns ((bytes32,uint256,uint256))',
  'function getAllowedFeeRecipients(address nftContract) view returns (address[] memory)',
  'function getSigners(address nftContract) view returns (address[] memory)',
  'function getPayers(address nftContract) view returns (address[] memory)',
  'function getCreatorPayoutAddress(address nftContract) view returns (address)',
  'function getMintStats(address nftContract) view returns ((uint256,uint256,uint256))',
];

// ── Minimal NFT ABI for SeaDrop-enabled ERC721A ─────────────────
const NFT_ABI = [
  'function mintSeaDrop(address minter, uint256 quantity)',
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function totalSupply() view returns (uint256)',
  'function maxSupply() view returns (uint256)',
  'function getMintStats(address minter) view returns (uint256 minterNumMinted, uint256 currentTotalSupply, uint256 maxSupply)',
  'function baseURI() view returns (string)',
  'function owner() view returns (address)',
  'function supportsInterface(bytes4 interfaceId) view returns (bool)',
  'function tokenURI(uint256 tokenId) view returns (string)',
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
];

// ── Function selectors ───────────────────────────────────────────
const SELECTORS = {
  mintPublic: keccak256(toUtf8Bytes('mintPublic(address,address,address,uint256)')).slice(0, 10),
  mintSeaDrop: keccak256(toUtf8Bytes('mintSeaDrop(address,uint256)')).slice(0, 10),
  getPublicDrop: keccak256(toUtf8Bytes('getPublicDrop(address)')).slice(0, 10),
};

// ── Drop discovery helper ────────────────────────────────────────
/**
 * Auto-detect drop parameters from on-chain SeaDrop config.
 * @param {Contract} seadropContract
 * @param {string} nftAddress
 */
async function discoverDropConfig(seadropContract, nftAddress) {
  const nftAddrLower = nftAddress.toLowerCase();

  let publicDrop = null;
  try {
    publicDrop = await seadropContract.getPublicDrop(nftAddrLower);
  } catch (err) {
    throw new Error(`No public drop configured for ${nftAddrLower}: ${err.message}`);
  }

  // getPublicDrop returns: (uint80 mintPrice, uint48 startTime, uint48 endTime, uint16 maxPerWallet, uint16 feeBps, uint8 restrictFeeRecipients)
  const mintPrice = publicDrop[0] ?? 0n;
  const startTime = Number(publicDrop[1] ?? 0);
  const endTime = Number(publicDrop[2] ?? 0);
  const maxPerWallet = Number(publicDrop[3] ?? 0);
  const feeBps = Number(publicDrop[4] ?? 0);

  // Get NFT mint stats
  let totalSupply = 0n;
  let minted = 0n;
  try {
    const stats = await seadropContract.getMintStats(nftAddrLower);
    minted = stats[0] ?? 0n;
    totalSupply = stats[1] ?? 0n;
  } catch (e) {
    // getMintStats may not exist or revert
  }

  // Total cost = mintPrice + fee (fee is mintPrice * feeBps / 10000)
  const feeAmount = (BigInt(mintPrice) * BigInt(feeBps)) / 10000n;
  const totalCost = BigInt(mintPrice) + feeAmount;

  const nowSec = Date.now() / 1000;

  return {
    nftAddress: nftAddrLower,
    mintPrice,
    startTime,
    endTime,
    maxPerWallet,
    feeBps,
    totalCost,
    totalSupply,
    minted,
    isActive: nowSec >= startTime && nowSec <= endTime,
    isUpcoming: nowSec < startTime,
    isEnded: nowSec > endTime,
  };
}

// ── Gas helpers ──────────────────────────────────────────────────
async function getAggressiveGas(provider, multiplier = 1.5, priorityFeeGwei = 2n) {
  const feeData = await provider.getFeeData();
  const baseFee = feeData.maxFeePerGas ?? feeData.gasPrice ?? 0n;

  const maxFeePerGas = (baseFee * BigInt(Math.round(multiplier * 100))) / 100n;
  const maxPriorityFeePerGas = priorityFeeGwei * 1000000000n;
  const finalMaxFee = maxFeePerGas > maxPriorityFeePerGas ? maxFeePerGas : maxPriorityFeePerGas + baseFee;

  return {
    maxFeePerGas: finalMaxFee,
    maxPriorityFeePerGas,
    gasLimit: 250000,
  };
}

module.exports = {
  SEADROP_ADDRESS,
  SEADROP_ABI,
  NFT_ABI,
  SELECTORS,
  discoverDropConfig,
  getAggressiveGas,
};
