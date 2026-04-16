// scripts/deploy.mjs  (v1.2 — post-audit patch)
// C-01/H-03 fix: contract now starts paused; script calls unpause() after fundHouse().
// M-01 fix: corrected default global-int fallback from 9 → 8.
// M-02 fix: validate HOUSE_SEED_VOI range before use.
// M-03 fix: confirm group transactions using the last tx ID.
// L-01 fix: wrap mnemonicToSecretKey in try/catch for clear error messages.
// Local state schema updated: 5 local ints + 1 local byte slice (commit-reveal state).

import algosdk from 'algosdk';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const NETWORKS = {
  testnet: {
    algodUrl:  'https://testnet-api.voi.nodly.io',
    algodPort: 443,
    genesisId: 'voitest-v1',
    name:      'Voi Testnet',
  },
  mainnet: {
    algodUrl:  'https://mainnet-api.voi.nodly.io',
    algodPort: 443,
    genesisId: 'voimain-v1.0',
    name:      'Voi Mainnet',
  },
};

// M-02: validate HOUSE_SEED_VOI before converting to BigInt
const MIN_SEED_VOI = 10;
const MAX_SEED_VOI = 10_000;

const rawSeedVoi = process.env.HOUSE_SEED_VOI ? Number(process.env.HOUSE_SEED_VOI) : 100;
if (isNaN(rawSeedVoi) || rawSeedVoi < MIN_SEED_VOI || rawSeedVoi > MAX_SEED_VOI) {
  console.error(
    `Invalid HOUSE_SEED_VOI: "${process.env.HOUSE_SEED_VOI}". ` +
    `Must be a number between ${MIN_SEED_VOI} and ${MAX_SEED_VOI} VOI.`,
  );
  process.exit(1);
}
const HOUSE_SEED_MICRO_VOI = BigInt(Math.round(rawSeedVoi * 1_000_000));

async function main() {
  const netArg = process.argv[2] ?? 'testnet';
  const net    = NETWORKS[netArg];
  if (!net) { console.error(`Unknown network: ${netArg}`); process.exit(1); }

  // L-01: clear error on bad mnemonic
  const mnemonic = process.env.DEPLOYER_MNEMONIC;
  if (!mnemonic) { console.error('Set DEPLOYER_MNEMONIC in .env'); process.exit(1); }
  let account;
  try {
    account = algosdk.mnemonicToSecretKey(mnemonic);
  } catch (err) {
    console.error('Invalid DEPLOYER_MNEMONIC:', err.message);
    process.exit(1);
  }

  const algod = new algosdk.Algodv2('', net.algodUrl, net.algodPort);

  // ── Load TEAL ────────────────────────────────────────────────────
  const artifactsDir = path.join(__dirname, '..', 'artifacts');
  const approvalPath = path.join(artifactsDir, 'LuckyVoiRoll.approval.teal');
  const clearPath    = path.join(artifactsDir, 'LuckyVoiRoll.clear.teal');
  const arc32Path    = path.join(artifactsDir, 'LuckyVoiRoll.arc32.json');

  if (!fs.existsSync(approvalPath)) {
    console.error('TEAL not found. Run: npm run compile');
    process.exit(1);
  }

  const approvalSource = fs.readFileSync(approvalPath, 'utf8');
  const clearSource    = fs.readFileSync(clearPath, 'utf8');

  // M-01: corrected defaults — 8 global ints (was 9), 2 byte slices (ow/po addresses)
  // New commit-reveal local state: 5 local ints (pg pw cr cb ct) + 1 byte slice (ch)
  let numGlobalInts       = 8;
  let numGlobalByteSlices = 2;
  let numLocalInts        = 5;
  let numLocalByteSlices  = 1;

  if (fs.existsSync(arc32Path)) {
    const arc32 = JSON.parse(fs.readFileSync(arc32Path, 'utf8'));
    const gs = arc32?.state?.global ?? {};
    const ls = arc32?.state?.local  ?? {};
    numGlobalInts       = gs.num_uints       ?? numGlobalInts;
    numGlobalByteSlices = gs.num_byte_slices ?? numGlobalByteSlices;
    numLocalInts        = ls.num_uints       ?? numLocalInts;
    numLocalByteSlices  = ls.num_byte_slices ?? numLocalByteSlices;
    console.log(`Schema from ARC-32: global ${numGlobalInts}i/${numGlobalByteSlices}b, local ${numLocalInts}i/${numLocalByteSlices}b`);
  } else {
    console.warn('ARC-32 not found — using default schema counts. Run compile first.');
  }

  console.log(`\n🎲 Lucky Voi Roll — Deploying to ${net.name}`);
  console.log('─'.repeat(48));
  console.log('Deployer:', account.addr);

  const info    = await algod.accountInformation(account.addr).do();
  const balance = BigInt(info.amount);
  console.log('Balance: ', (Number(balance) / 1e6).toFixed(3), 'VOI');
  console.log('Seed:    ', (Number(HOUSE_SEED_MICRO_VOI) / 1e6), 'VOI');

  if (balance < HOUSE_SEED_MICRO_VOI + 2_000_000n) {
    console.error('Insufficient balance. Need seed + ~2 VOI for fees + min balance.');
    process.exit(1);
  }

  // ── Compile TEAL ─────────────────────────────────────────────────
  const compiled = await Promise.all([
    algod.compile(approvalSource).do(),
    algod.compile(clearSource).do(),
  ]);
  const approvalProgram = new Uint8Array(Buffer.from(compiled[0].result, 'base64'));
  const clearProgram    = new Uint8Array(Buffer.from(compiled[1].result, 'base64'));

  // ── Create application ────────────────────────────────────────────
  // Contract starts paused (pa=1). We call unpause() after fundHouse().
  const params    = await algod.getTransactionParams().do();
  const createTxn = algosdk.makeApplicationCreateTxnFromObject({
    sender:              account.addr,
    suggestedParams:     params,
    onComplete:          algosdk.OnApplicationComplete.NoOpOC,
    approvalProgram,
    clearProgram,
    numGlobalByteSlices,
    numGlobalInts,
    numLocalByteSlices,
    numLocalInts,
  });

  const { txid } = await algod.sendRawTransaction(createTxn.signTxn(account.sk)).do();
  console.log('\nCreation tx:', txid);
  const createResult = await algosdk.waitForConfirmation(algod, txid, 5);
  const appId        = Number(createResult['application-index']);
  const appAddress   = algosdk.getApplicationAddress(appId);
  console.log('✅ App created — ID:', appId, '| Address:', appAddress);

  // ── Fund the app account ──────────────────────────────────────────
  // AVM minimum balance for this app (approximate):
  //   100_000 base
  // + 8 global ints    × 28_500 = 228_000
  // + 2 global bslices × 50_000 = 100_000
  // Total ≈ 428_000 µVOI; use 600_000 for safety
  const MIN_BALANCE_BUFFER = 600_000n;
  const totalFund = HOUSE_SEED_MICRO_VOI + MIN_BALANCE_BUFFER;

  const p2      = await algod.getTransactionParams().do();
  const fundTxn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender:          account.addr,
    receiver:        appAddress,
    amount:          totalFund,
    suggestedParams: p2,
    note:            new TextEncoder().encode('LVR initial fund'),
  });
  const { txid: ftxid } = await algod.sendRawTransaction(fundTxn.signTxn(account.sk)).do();
  await algosdk.waitForConfirmation(algod, ftxid, 5);
  console.log('✅ App funded:', (Number(totalFund) / 1e6).toFixed(3), 'VOI →', appAddress);

  // ── Call fundHouse() to credit HOUSE_SEED to houseBalance ────────
  const p3 = await algod.getTransactionParams().do();

  const housePayTxn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender:          account.addr,
    receiver:        appAddress,
    amount:          HOUSE_SEED_MICRO_VOI,
    suggestedParams: { ...p3 },
    note:            new TextEncoder().encode('LVR house seed'),
  });

  const fundSelector = algosdk.ABIMethod.fromSignature('fundHouse(pay)void').getSelector();
  const fundCallTxn  = algosdk.makeApplicationCallTxnFromObject({
    sender:          account.addr,
    appIndex:        appId,
    onComplete:      algosdk.OnApplicationComplete.NoOpOC,
    appArgs:         [fundSelector],
    suggestedParams: { ...p3, fee: 1000, flatFee: true },
  });

  algosdk.assignGroupID([housePayTxn, fundCallTxn]);
  const signedFundGroup = [
    housePayTxn.signTxn(account.sk),
    fundCallTxn.signTxn(account.sk),
  ];

  await algod.sendRawTransaction(signedFundGroup).do();
  // M-03: confirm using last tx in the group (atomic — confirming any tx confirms all)
  const lastFundTxid = algosdk.decodeSignedTransaction(signedFundGroup[signedFundGroup.length - 1]).txn.txID();
  await algosdk.waitForConfirmation(algod, lastFundTxid, 5);
  console.log('✅ House pool seeded:', (Number(HOUSE_SEED_MICRO_VOI) / 1e6), 'VOI');

  // ── H-03: unpause the contract now that it is funded ─────────────
  const p4 = await algod.getTransactionParams().do();
  const unpauseSelector = algosdk.ABIMethod.fromSignature('unpause()void').getSelector();
  const unpauseTxn = algosdk.makeApplicationCallTxnFromObject({
    sender:          account.addr,
    appIndex:        appId,
    onComplete:      algosdk.OnApplicationComplete.NoOpOC,
    appArgs:         [unpauseSelector],
    suggestedParams: { ...p4, fee: 1000, flatFee: true },
  });
  const { txid: utxid } = await algod.sendRawTransaction(unpauseTxn.signTxn(account.sk)).do();
  await algosdk.waitForConfirmation(algod, utxid, 5);
  console.log('✅ Contract unpaused — open for betting');

  // ── Save deployment info ──────────────────────────────────────────
  const deployInfo = {
    network:     netArg,
    appId,
    appAddress,
    deployer:    account.addr,
    deployedAt:  new Date().toISOString(),
  };
  fs.mkdirSync(artifactsDir, { recursive: true });
  fs.writeFileSync(
    path.join(artifactsDir, `deployment.${netArg}.json`),
    JSON.stringify(deployInfo, null, 2),
  );

  console.log('\n' + '─'.repeat(48));
  console.log('🎲 Live on', net.name);
  console.log('   App ID:    ', appId);
  console.log('   App Addr:  ', appAddress);
  console.log('\n📋 Next: set APP_ID =', appId, 'in frontend/index.html\n');
}

main().catch(e => { console.error(e); process.exit(1); });
