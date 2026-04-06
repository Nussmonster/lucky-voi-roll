import { Contract } from '@algorandfoundation/tealscript';

const UNDER_7 = 0;
const SEVEN   = 1;
const OVER_7  = 2;
const MIN_BALANCE_RESERVE: uint64 = 1_000_000;

export class LuckyVoiRoll extends Contract {
  ow = GlobalStateKey<Address>({ key: 'ow' });
  po = GlobalStateKey<Address>({ key: 'po' });
  pa = GlobalStateKey<uint64>({ key: 'pa' });
  hb = GlobalStateKey<uint64>({ key: 'hb' });
  mn = GlobalStateKey<uint64>({ key: 'mn' });
  mx = GlobalStateKey<uint64>({ key: 'mx' });
  tg = GlobalStateKey<uint64>({ key: 'tg' });
  tw = GlobalStateKey<uint64>({ key: 'tw' });
  tp = GlobalStateKey<uint64>({ key: 'tp' });
  nc = GlobalStateKey<uint64>({ key: 'nc' });
  pg = LocalStateKey<uint64>({ key: 'pg' });
  pw = LocalStateKey<uint64>({ key: 'pw' });

  createApplication(): void {
    this.ow.value = this.txn.sender;
    this.po.value = globals.zeroAddress;
    this.pa.value = 0;
    this.mn.value = 1_000_000;
    this.mx.value = 1_000_000_000;
    this.hb.value = 0;
    this.tg.value = 0;
    this.tw.value = 0;
    this.tp.value = 0;
    this.nc.value = 0;
  }

  optIn(): void {
    this.pg(this.txn.sender).value = 0;
    this.pw(this.txn.sender).value = 0;
  }

  fundHouse(payment: PayTxn): void {
    assert(this.txn.sender === this.ow.value, 'Not owner');
    verifyPayTxn(payment, { receiver: this.app.address, sender: this.txn.sender });
    this.hb.value = this.hb.value + payment.amount;
  }

  roll(payment: PayTxn, betType: uint64): void {
    verifyPayTxn(payment, { receiver: this.app.address, sender: this.txn.sender });
    assert(this.pa.value === 0, 'Contract is paused');
    assert(betType === 0 || betType === 1 || betType === 2, 'Invalid bet type');
    const bet = payment.amount;
    assert(bet >= this.mn.value, 'Bet too small');
    assert(bet <= this.mx.value, 'Bet too large');
    this.hb.value = this.hb.value + bet;
    this.tw.value = this.tw.value + bet;
    const maxPayout = bet * 4;
    assert(this.hb.value >= maxPayout + MIN_BALANCE_RESERVE, 'House funds insufficient');
    this.nc.value = this.nc.value + 1;
    const seed1 = sha256(concat(concat(concat(blocks[this.txn.firstValid - 1].seed, this.txn.txID), this.txn.sender), itob(this.nc.value)));
    const seed2 = sha256(concat(concat(seed1, itob(this.tg.value)), itob(bet)));
    const die1  = (btoi(extract3(seed1, 0, 8)) % 6) + 1;
    const die2  = (btoi(extract3(seed2, 0, 8)) % 6) + 1;
    const total = die1 + die2;
    let won:    uint64 = 0;
    let payout: uint64 = 0;
    if (betType === UNDER_7 && total < 7)  { won = 1; payout = bet * 2; }
    else if (betType === SEVEN && total === 7) { won = 1; payout = bet * 4; }
    else if (betType === OVER_7 && total > 7)  { won = 1; payout = bet * 2; }
    this.tg.value = this.tg.value + 1;
    if (won) { this.hb.value = this.hb.value - payout; this.tp.value = this.tp.value + payout; }
    if (this.pg(this.txn.sender).exists) {
      this.pg(this.txn.sender).value = this.pg(this.txn.sender).value + 1;
      if (won) { this.pw(this.txn.sender).value = this.pw(this.txn.sender).value + payout; }
    }
    log(concat(concat(concat(concat(concat(concat('LVR:', itob(die1)), itob(die2)), itob(total)), itob(betType)), itob(won)), itob(payout)));
    if (won) { sendPayment({ receiver: this.txn.sender, amount: payout, note: 'LuckyVoiRoll payout' }); }
  }

  withdraw(amount: uint64): void {
    assert(this.txn.sender === this.ow.value, 'Not owner');
    assert(amount <= this.hb.value, 'Amount exceeds balance');
    const reserve = this.mx.value * 4;
    assert(this.hb.value - amount >= reserve, 'Reserve too low');
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

  pause():   void { assert(this.txn.sender === this.ow.value, 'Not owner'); this.pa.value = 1; }
  unpause(): void { assert(this.txn.sender === this.ow.value, 'Not owner'); this.pa.value = 0; }

  setBetLimits(newMin: uint64, newMax: uint64): void {
    assert(this.txn.sender === this.ow.value, 'Not owner');
    assert(newMin > 0 && newMax >= newMin, 'Invalid limits');
    assert(newMax * 4 <= this.hb.value, 'maxBet reserve would exceed house pool');
    this.mn.value = newMin;
    this.mx.value = newMax;
  }

  transferOwnership(newOwner: Address): void {
    assert(this.txn.sender === this.ow.value, 'Not owner');
    assert(newOwner !== globals.zeroAddress, 'Zero address');
    this.po.value = newOwner;
  }

  acceptOwnership(): void {
    assert(this.po.value !== globals.zeroAddress, 'No pending transfer');
    assert(this.txn.sender === this.po.value, 'Not pending owner');
    this.ow.value = this.po.value;
    this.po.value = globals.zeroAddress;
  }
}
