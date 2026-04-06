// scripts/deploy.mjs  (v1.1 — post-audit patch)
// H-02 fix: single funding path, no double-fund, no spurious createApplication call.
// M-01 fix: reads schema from ARC-32 artifact instead of hardcoding slot counts.

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

const HOUSE_SEED_MICRO_VOI = BigInt(
  process.env.HOUSE_SEED_VOI
    ? Math.round(Number(process.env.HOUSE_SEED_VOI) * 1_000_000)
    : 100_000_000   // 100 VOI default
);

async function main() {
  const netArg = process.argv[2] ?? 'testnet';
  const net    = NETWORKS[netArg];
  if (!net) { console.error(`Unknown network: ${netArg}`); process.exit(1); }

  const mnemonic = process.env.DEPLOYER_MNEMONIC;
  if (!mnemonic) { console.error('Set DEPLOYER_MNEMONIC in .env'); process.exit(1); }

  const account = algosdk.mnemonicToSecretKey(mnemonic);
  const algod   = new algosdk.Algodv2('', net.algodUrl, net.algodPort);

  // ── Load TEAL ────────────────────────────────────────────────────
  const artifactsDir  = path.join(__dirname, '..', 'artifacts');
  const approvalPath  = path.join(artifactsDir, 'LuckyVoiRoll.approval.teal');
  const clearPath     = path.join(artifactsDir, 'LuckyVoiRoll.clear.teal');
  const arc32Path     = path.join(artifactsDir, 'LuckyVoiRoll.arc32.json');

  if (!fs.existsSync(approvalPath)) {
    console.error('TEAL not found. Run: npm run compile'); process.exit(1);
  }

  const approvalSource = fs.readFileSync(approvalPath, 'utf8');
  const clearSource    = fs.readFileSync(clearPath, 'utf8');

  // M-01: read schema from ARC-32 artifact, not hardcoded values
  let numGlobalInts = 9, numGlobalByteSlices = 2; // safe defaults (owner + pendingOwner)
  if (fs.existsSync(arc32Path)) {
    const arc32 = JSON.parse(fs.readFileSync(arc32Path, 'utf8'));
    const gs    = arc32?.state?.global ?? {};
    numGlobalInts       = gs.num_uints ?? numGlobalInts;
    numGlobalByteSlices = gs.num_byte_slices ?? numGlobalByteSlices;
    console.log(`Schema from ARC-32: ${numGlobalInts} ints, ${numGlobalByteSlices} byte slices`);
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

  // ── Compile TEAL ──────────────────────────────────────────────────
  const compiled = await Promise.all([
    algod.compile(approvalSource).do(),
    algod.compile(clearSource).do(),
  ]);
  const approvalProgram = new Uint8Array(Buffer.from(compiled[0].result, 'base64'));
  const clearProgram    = new Uint8Array(Buffer.from(compiled[1].result, 'base64'));

  // ── Create application ────────────────────────────────────────────
  // H-02 fix: creation transaction initialises state via createApplication()
  // automatically — no separate init call needed.
  const params    = await algod.getTransactionParams().do();
  const createTxn = algosdk.makeApplicationCreateTxnFromObject({
    sender:              account.addr,
    suggestedParams:     params,
    onComplete:          algosdk.OnApplicationComplete.NoOpOC,
    approvalProgram,
    clearProgram,
    numGlobalByteSlices,
    numGlobalInts,
    numLocalByteSlices: 0,
    numLocalInts:       2,  // pg (playerGames) + pw (playerWon)
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
  // + numGlobalInts    × 28_500  = ~9 × 28_500 = 256_500
  // + numGlobalBSlices × 50_000  = ~2 × 50_000 = 100_000
  // Total ≈ 456_500 µVOI, round up to 600_000 for safety
  const MIN_BALANCE_BUFFER = 600_000n;
  const totalFund = HOUSE_SEED_MICRO_VOI + MIN_BALANCE_BUFFER;

  const p2 = await algod.getTransactionParams().do();
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

  // ── Call fundHouse() to credit HOUSE_SEED to houseBalance ─────────
  // H-02 fix: use the fundHouse() method (grouped PayTxn + AppCall)
  // rather than a separate createApplication() init call.
  const p3 = await algod.getTransactionParams().do();

  const housePayTxn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender:          account.addr,
    receiver:        appAddress,
    amount:          HOUSE_SEED_MICRO_VOI,
    suggestedParams: { ...p3 },
    note:            new TextEncoder().encode('LVR house seed'),
  });

  // ABI selector for fundHouse(pay)void
  const fundSelector = algosdk.ABIMethod.fromSignature('fundHouse(pay)void').getSelector();
  const fundCallTxn  = algosdk.makeApplicationCallTxnFromObject({
    sender:          account.addr,
    appIndex:        appId,
    onComplete:      algosdk.OnApplicationComplete.NoOpOC,
    appArgs:         [fundSelector],
    suggestedParams: { ...p3, fee: 1000, flatFee: true },
  });

  algosdk.assignGroupID([housePayTxn, fundCallTxn]);
  const signedGroup = [
    housePayTxn.signTxn(account.sk),
    fundCallTxn.signTxn(account.sk),
  ];
  const { txid: htxid } = await algod.sendRawTransaction(signedGroup).do();
  await algosdk.waitForConfirmation(algod, htxid, 5);
  console.log('✅ House pool seeded:', (Number(HOUSE_SEED_MICRO_VOI) / 1e6), 'VOI');

  // ── Save ──────────────────────────────────────────────────────────
  const info2 = { network: netArg, appId, appAddress, deployer: account.addr, deployedAt: new Date().toISOString() };
  fs.mkdirSync(artifactsDir, { recursive: true });
  fs.writeFileSync(path.join(artifactsDir, `deployment.${netArg}.json`), JSON.stringify(info2, null, 2));

  console.log('\n─'.repeat(48));
  console.log('🎲 Live on', net.name);
  console.log('   App ID:    ', appId);
  console.log('   App Addr:  ', appAddress);
  console.log('\n📋 Next: set APP_ID =', appId, 'in frontend/index.html\n');
}

main().catch(e => { console.error(e); process.exit(1); });
