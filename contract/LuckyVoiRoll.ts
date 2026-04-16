import { Contract } from '@algorandfoundation/tealscript';

const UNDER_7 = 0;
const SEVEN   = 1;
const OVER_7  = 2;

const MIN_BALANCE_RESERVE: uint64 = 1_000_000;  // 1 VOI — kept in app account at all times
const REVEAL_DELAY:  uint64 = 3;                 // min blocks after commit before reveal is valid
const REVEAL_WINDOW: uint64 = 100;               // blocks of reveal window before commit expires
const MAX_BET: uint64 = 100_000_000_000;         // 100 000 VOI hard cap — keeps bet*4 safe from overflow

export class LuckyVoiRoll extends Contract {
  // ── Global state (8 × uint64 + 2 × Address) ──────────────────────
  ow = GlobalStateKey<Address>({ key: 'ow' });   // owner
  po = GlobalStateKey<Address>({ key: 'po' });   // pending owner (two-step transfer)
  pa = GlobalStateKey<uint64>({ key: 'pa' });    // paused flag  (1 = paused)
  hb = GlobalStateKey<uint64>({ key: 'hb' });    // house balance (µVOI)
  mn = GlobalStateKey<uint64>({ key: 'mn' });    // minimum bet (µVOI)
  mx = GlobalStateKey<uint64>({ key: 'mx' });    // maximum bet (µVOI)
  tg = GlobalStateKey<uint64>({ key: 'tg' });    // total games completed
  tw = GlobalStateKey<uint64>({ key: 'tw' });    // total amount wagered
  tp = GlobalStateKey<uint64>({ key: 'tp' });    // total payouts sent
  nc = GlobalStateKey<uint64>({ key: 'nc' });    // total commits (nonce)

  // ── Local state (5 × uint64 + 1 × bytes) ─────────────────────────
  pg = LocalStateKey<uint64>({ key: 'pg' });     // player game count
  pw = LocalStateKey<uint64>({ key: 'pw' });     // player total winnings
  ch = LocalStateKey<bytes>({ key: 'ch' });      // commit hash (sha256, 32 bytes)
  cr = LocalStateKey<uint64>({ key: 'cr' });     // commit round (0 = none pending)
  cb = LocalStateKey<uint64>({ key: 'cb' });     // commit bet amount
  ct = LocalStateKey<uint64>({ key: 'ct' });     // commit bet type

  // ── Lifecycle ─────────────────────────────────────────────────────

  createApplication(): void {
    this.ow.value = this.txn.sender;
    this.po.value = globals.zeroAddress;
    this.pa.value = 1;               // H-03: start paused — owner must call unpause() after fundHouse()
    this.mn.value = 1_000_000;       // 1 VOI
    this.mx.value = 1_000_000_000;   // 1 000 VOI
    this.hb.value = 0;
    this.tg.value = 0;
    this.tw.value = 0;
    this.tp.value = 0;
    this.nc.value = 0;
  }

  optIn(): void {
    this.pg(this.txn.sender).value = 0;
    this.pw(this.txn.sender).value = 0;
    this.cr(this.txn.sender).value = 0;
    this.cb(this.txn.sender).value = 0;
    this.ct(this.txn.sender).value = 0;
  }

  // ── House management ──────────────────────────────────────────────

  fundHouse(payment: PayTxn): void {
    assert(this.txn.sender === this.ow.value, 'Not owner');
    verifyPayTxn(payment, { receiver: this.app.address, sender: this.txn.sender });
    this.hb.value = this.hb.value + payment.amount;
  }

  withdraw(amount: uint64): void {
    assert(this.txn.sender === this.ow.value, 'Not owner');
    assert(amount <= this.hb.value, 'Amount exceeds balance');
    // H-01: use addition form to avoid subtraction underflow risk
    const reserve = this.mx.value * 4;
    assert(this.hb.value >= amount + reserve, 'Reserve too low');
    this.hb.value = this.hb.value - amount;
    sendPayment({ receiver: this.ow.value, amount: amount, note: 'LuckyVoiRoll withdrawal' });
  }

  emergencyWithdraw(): void {
    assert(this.txn.sender === this.ow.value, 'Not owner');
    assert(this.pa.value === 1, 'Must pause first');
    assert(this.hb.value > 0, 'Nothing to withdraw');
    const amount = this.hb.value;
    this.hb.value = 0;
    sendPayment({ receiver: this.ow.value, amount: amount, note: 'LuckyVoiRoll emergency withdrawal' });
  }

  pause(): void {
    assert(this.txn.sender === this.ow.value, 'Not owner');
    this.pa.value = 1;
    log('PAUSE');  // L-04: emit log for off-chain monitoring
  }

  unpause(): void {
    assert(this.txn.sender === this.ow.value, 'Not owner');
    this.pa.value = 0;
    log('UNPAUSE');
  }

  setBetLimits(newMin: uint64, newMax: uint64): void {
    assert(this.txn.sender === this.ow.value, 'Not owner');
    assert(newMin > 0 && newMax >= newMin, 'Invalid limits');
    // H-02: hard cap prevents newMax*4 from overflowing uint64 in withdraw() / commit()
    assert(newMax <= MAX_BET, 'newMax exceeds hard cap');
    assert(newMax * 4 <= this.hb.value, 'maxBet reserve would exceed house pool');
    this.mn.value = newMin;
    this.mx.value = newMax;
  }

  // ── Ownership ─────────────────────────────────────────────────────

  transferOwnership(newOwner: Address): void {
    assert(this.txn.sender === this.ow.value, 'Not owner');
    assert(newOwner !== globals.zeroAddress, 'Zero address');
    this.po.value = newOwner;
  }

  acceptOwnership(): void {
    assert(this.po.value !== globals.zeroAddress, 'No pending transfer');
    assert(this.txn.sender === this.po.value, 'Not pending owner');
    this.ow.value = this.txn.sender;   // L-03: use txn.sender (already verified == po)
    this.po.value = globals.zeroAddress;
  }

  // ── Game: commit-reveal ───────────────────────────────────────────
  //
  // C-01 FIX: two-phase design prevents outcome prediction.
  //
  // Phase 1 — commit(payment, betType, commitHash)
  //   Player pays the bet and submits sha256(itob(betType) || secret).
  //   The block seed used for randomness does NOT yet exist at this point.
  //
  // Phase 2 — reveal(secret)
  //   Called REVEAL_DELAY..REVEAL_DELAY+REVEAL_WINDOW blocks later.
  //   Dice are seeded from blocks[commitRound + REVEAL_DELAY - 1].seed —
  //   a block that was finalised AFTER the commit, making the outcome
  //   impossible to predict at commit time.
  //
  // If the player never reveals, the bet is forfeited to the house.
  // Call clearExpiredCommit() to reset local state so a new bet can be placed.

  commit(payment: PayTxn, betType: uint64, commitHash: bytes): void {
    verifyPayTxn(payment, { receiver: this.app.address, sender: this.txn.sender });
    assert(this.pa.value === 0, 'Contract is paused');
    assert(betType === UNDER_7 || betType === SEVEN || betType === OVER_7, 'Invalid bet type');
    assert(this.cr(this.txn.sender).value === 0, 'Pending commit — reveal or clear first');

    const bet = payment.amount;
    assert(bet >= this.mn.value, 'Bet too small');
    assert(bet <= this.mx.value, 'Bet too large');
    // H-04: belt-and-suspenders cap so bet*4 is always safe even if mx guard is bypassed
    assert(bet <= MAX_BET, 'Bet exceeds hard cap');

    // Reserve check: house must be able to cover max possible payout + AVM minimum balance
    const maxPayout = bet * 4;
    assert(this.hb.value >= maxPayout + MIN_BALANCE_RESERVE, 'House funds insufficient');

    this.hb.value = this.hb.value + bet;
    this.tw.value = this.tw.value + bet;
    this.nc.value = this.nc.value + 1;

    this.cr(this.txn.sender).value = this.txn.firstValid;
    this.cb(this.txn.sender).value = bet;
    this.ct(this.txn.sender).value = betType;
    this.ch(this.txn.sender).value = commitHash;
  }

  reveal(secret: bytes): void {
    const commitRound = this.cr(this.txn.sender).value;
    assert(commitRound > 0, 'No pending commit');

    const revealRound = commitRound + REVEAL_DELAY;
    assert(this.txn.firstValid >= revealRound, 'Too early to reveal');
    assert(this.txn.firstValid <= revealRound + REVEAL_WINDOW, 'Commit expired — call clearExpiredCommit');

    const bet     = this.cb(this.txn.sender).value;
    const betType = this.ct(this.txn.sender).value;

    // Verify the revealed secret matches the original commitment
    const expectedHash = sha256(concat(itob(betType), secret));
    assert(this.ch(this.txn.sender).value === expectedHash, 'Hash mismatch');

    // Clear commit state before any inner transactions (best-practice ordering)
    this.cr(this.txn.sender).value = 0;
    this.cb(this.txn.sender).value = 0;
    this.ct(this.txn.sender).value = 0;

    // C-02: revealRound = commitRound + REVEAL_DELAY >= 3, so index is always >= 2
    // Roll dice using a block seed that did not exist at commit time
    const seed1 = sha256(concat(blocks[revealRound - 1].seed, secret));
    const seed2 = sha256(concat(seed1, itob(bet)));
    const die1  = (btoi(extract3(seed1, 0, 8)) % 6) + 1;
    const die2  = (btoi(extract3(seed2, 0, 8)) % 6) + 1;
    const total = die1 + die2;

    let won:    uint64 = 0;
    let payout: uint64 = 0;
    if (betType === UNDER_7 && total < 7)        { won = 1; payout = bet * 2; }
    else if (betType === SEVEN  && total === 7)  { won = 1; payout = bet * 4; }
    else if (betType === OVER_7 && total > 7)    { won = 1; payout = bet * 2; }

    this.tg.value = this.tg.value + 1;
    if (won) {
      this.hb.value = this.hb.value - payout;
      this.tp.value = this.tp.value + payout;
    }
    if (this.pg(this.txn.sender).exists) {
      this.pg(this.txn.sender).value = this.pg(this.txn.sender).value + 1;
      if (won) { this.pw(this.txn.sender).value = this.pw(this.txn.sender).value + payout; }
    }

    log(concat(concat(concat(concat(concat(concat('LVR:', itob(die1)), itob(die2)), itob(total)), itob(betType)), itob(won)), itob(payout)));
    if (won) { sendPayment({ receiver: this.txn.sender, amount: payout, note: 'LuckyVoiRoll payout' }); }

    // M-04: circuit breaker — auto-pause when house can no longer cover a minimum-bet SEVEN payout
    if (this.hb.value < this.mn.value * 4 + MIN_BALANCE_RESERVE) {
      this.pa.value = 1;
    }
  }

  /**
   * Reset an expired (unrevealed) commit so the player can bet again.
   * The forfeited bet stays in hb — this only clears the local commit state.
   */
  clearExpiredCommit(): void {
    const commitRound = this.cr(this.txn.sender).value;
    assert(commitRound > 0, 'No pending commit');
    assert(
      this.txn.firstValid > commitRound + REVEAL_DELAY + REVEAL_WINDOW,
      'Commit has not yet expired',
    );
    this.cr(this.txn.sender).value = 0;
    this.cb(this.txn.sender).value = 0;
    this.ct(this.txn.sender).value = 0;
  }
}
