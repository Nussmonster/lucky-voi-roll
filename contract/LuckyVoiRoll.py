"""
LuckyVoiRoll — PyTeal Smart Contract
Network: Voi (AVM-compatible)

Game mechanics:
  Two dice, three bet types:
    Under 7  (betType=0) → pays 2×  (sum 2–6)
    Lucky 7  (betType=1) → pays 4×  (sum = 7)
    Over 7   (betType=2) → pays 2×  (sum 8–12)

Global state keys (match original TEALScript contract exactly):
  ow  = owner address
  po  = pending owner (two-step transfer)
  pa  = paused flag (0/1)
  hb  = house balance (µVOI)
  mn  = min bet (µVOI)
  mx  = max bet (µVOI)
  tg  = total games played
  tw  = total wagered (µVOI)
  tp  = total paid out (µVOI)
  nc  = nonce counter

Local state keys:
  pg  = player games
  pw  = player won (µVOI)

Compile:
  pip install pyteal algosdk
  python contract/LuckyVoiRoll.py

Outputs:
  artifacts/LuckyVoiRoll.approval.teal
  artifacts/LuckyVoiRoll.clear.teal
  artifacts/LuckyVoiRoll.arc32.json
"""

import os, json
from pyteal import *

# ── Constants ────────────────────────────────────────────────────────────────
UNDER_7            = Int(0)
LUCKY_7            = Int(1)
OVER_7             = Int(2)
MIN_BALANCE_RESERVE = Int(1_000_000)     # 1 VOI
DEFAULT_MIN_BET    = Int(1_000_000)      # 1 VOI
DEFAULT_MAX_BET    = Int(1_000_000_000)  # 1,000 VOI
MAX_BET_CAP        = Int(10_000_000_000) # 10,000 VOI safety cap

# ── Global state keys ─────────────────────────────────────────────────────────
OW = Bytes("ow")   # owner address
PO = Bytes("po")   # pending owner
PA = Bytes("pa")   # paused
HB = Bytes("hb")   # house balance
MN = Bytes("mn")   # min bet
MX = Bytes("mx")   # max bet
TG = Bytes("tg")   # total games
TW = Bytes("tw")   # total wagered
TP = Bytes("tp")   # total paid out
NC = Bytes("nc")   # nonce

# ── Local state keys ──────────────────────────────────────────────────────────
PG = Bytes("pg")   # player games
PW = Bytes("pw")   # player won

# ── Helpers ───────────────────────────────────────────────────────────────────
def global_get(key):
    return App.globalGet(key)

def global_put(key, val):
    return App.globalPut(key, val)

def local_get(addr, key):
    return App.localGet(addr, key)

def local_put(addr, key, val):
    return App.localPut(addr, key, val)

def local_exists(addr, key):
    maybe = App.localGetEx(addr, Int(0), key)
    return Seq(maybe, maybe.hasValue())

# ── createApplication ─────────────────────────────────────────────────────────
def handle_create():
    return Seq(
        global_put(OW, Txn.sender()),
        global_put(PO, Global.zero_address()),
        global_put(PA, Int(0)),
        global_put(MN, DEFAULT_MIN_BET),
        global_put(MX, DEFAULT_MAX_BET),
        global_put(HB, Int(0)),
        global_put(TG, Int(0)),
        global_put(TW, Int(0)),
        global_put(TP, Int(0)),
        global_put(NC, Int(0)),
        Approve(),
    )

# ── optIn ─────────────────────────────────────────────────────────────────────
def handle_optin():
    return Seq(
        local_put(Txn.sender(), PG, Int(0)),
        local_put(Txn.sender(), PW, Int(0)),
        Approve(),
    )

# ── fundHouse(pay) ────────────────────────────────────────────────────────────
def handle_fund_house():
    pay = Gtxn[0]
    return Seq(
        Assert(Txn.sender() == global_get(OW), comment="Not owner"),
        Assert(Global.group_size() == Int(2), comment="Invalid group size"),
        Assert(Txn.group_index() == Int(1), comment="AppCall must be second"),
        Assert(pay.type_enum() == TxnType.Payment, comment="First txn must be payment"),
        Assert(pay.receiver() == Global.current_application_address(), comment="Wrong receiver"),
        Assert(pay.sender() == Txn.sender(), comment="Wrong sender"),
        Assert(pay.amount() > Int(0), comment="Must send positive amount"),
        global_put(HB, global_get(HB) + pay.amount()),
        Log(Concat(Bytes("FUND:"), Itob(pay.amount()))),
        Approve(),
    )

# ── roll(pay, betType) ────────────────────────────────────────────────────────
def handle_roll():
    pay     = Gtxn[0]
    bet_type = Btoi(Txn.application_args()[1])
    bet     = pay.amount()

    nc_new  = global_get(NC) + Int(1)
    tg_new  = global_get(TG) + Int(1)

    # Entropy — two independent SHA256 seeds
    # seed1 = sha256(blockSeed || txID || sender || nc)
    # seed2 = sha256(seed1 || tg || bet)
    seed1 = Sha256(Concat(
        Concat(
            Concat(Block(Txn.first_valid() - Int(1)).seed(), Txn.tx_id()),
            Txn.sender()
        ),
        Itob(nc_new)
    ))
    seed2 = Sha256(Concat(
        Concat(seed1, Itob(tg_new)),
        Itob(bet)
    ))

    # Die values: extract first 8 bytes of each seed → mod 6 + 1
    die1  = (Btoi(Extract(seed1, Int(0), Int(8))) % Int(6)) + Int(1)
    die2  = (Btoi(Extract(seed2, Int(0), Int(8))) % Int(6)) + Int(1)
    total = die1 + die2

    max_payout = bet * Int(4)

    # Scratch vars
    s_die1    = ScratchVar(TealType.uint64)
    s_die2    = ScratchVar(TealType.uint64)
    s_total   = ScratchVar(TealType.uint64)
    s_won     = ScratchVar(TealType.uint64)
    s_payout  = ScratchVar(TealType.uint64)
    s_seed1   = ScratchVar(TealType.bytes)
    s_seed2   = ScratchVar(TealType.bytes)
    s_bet     = ScratchVar(TealType.uint64)
    s_bet_type = ScratchVar(TealType.uint64)
    s_nc      = ScratchVar(TealType.uint64)
    s_tg      = ScratchVar(TealType.uint64)
    s_hb      = ScratchVar(TealType.uint64)

    maybe_pg = App.localGetEx(Txn.sender(), Int(0), PG)
    maybe_pw = App.localGetEx(Txn.sender(), Int(0), PW)

    return Seq(
        # H-03: enforce group structure
        Assert(Global.group_size() == Int(2), comment="Invalid group size"),
        Assert(Txn.group_index() == Int(1), comment="AppCall must be second"),
        Assert(pay.type_enum() == TxnType.Payment, comment="First txn must be payment"),
        Assert(pay.receiver() == Global.current_application_address(), comment="Wrong receiver"),
        Assert(pay.sender() == Txn.sender(), comment="Wrong sender"),

        # Contract state checks
        Assert(global_get(PA) == Int(0), comment="Contract is paused"),
        Assert(
            Or(bet_type == Int(0), bet_type == Int(1), bet_type == Int(2)),
            comment="Invalid bet type"
        ),

        # Bet bounds
        Assert(bet >= global_get(MN), comment="Bet too small"),
        Assert(bet <= global_get(MX), comment="Bet too large"),

        # H-01: solvency check BEFORE crediting bet
        Assert(global_get(HB) >= max_payout + MIN_BALANCE_RESERVE, comment="House funds insufficient"),

        # Store in scratch
        s_bet.store(bet),
        s_bet_type.store(bet_type),
        s_nc.store(nc_new),
        s_tg.store(tg_new),

        # Credit bet to house, update wagered
        global_put(HB, global_get(HB) + bet),
        global_put(TW, global_get(TW) + bet),

        # H-02: increment counters BEFORE seed derivation
        global_put(NC, nc_new),
        global_put(TG, tg_new),

        # Compute seeds and dice
        s_seed1.store(seed1),
        s_seed2.store(seed2),
        s_die1.store(die1),
        s_die2.store(die2),
        s_total.store(total),

        # Resolve outcome
        s_won.store(Int(0)),
        s_payout.store(Int(0)),
        If(And(s_bet_type.load() == UNDER_7, s_total.load() < Int(7))).Then(
            Seq(s_won.store(Int(1)), s_payout.store(s_bet.load() * Int(2)))
        ).ElseIf(And(s_bet_type.load() == LUCKY_7, s_total.load() == Int(7))).Then(
            Seq(s_won.store(Int(1)), s_payout.store(s_bet.load() * Int(4)))
        ).ElseIf(And(s_bet_type.load() == OVER_7, s_total.load() > Int(7))).Then(
            Seq(s_won.store(Int(1)), s_payout.store(s_bet.load() * Int(2)))
        ),

        # Deduct payout from house if won
        If(s_won.load() == Int(1)).Then(
            Seq(
                global_put(HB, global_get(HB) - s_payout.load()),
                global_put(TP, global_get(TP) + s_payout.load()),
            )
        ),

        # Update local state if opted in
        maybe_pg,
        If(maybe_pg.hasValue()).Then(
            Seq(
                maybe_pw,
                local_put(Txn.sender(), PG, App.localGet(Txn.sender(), PG) + Int(1)),
                If(s_won.load() == Int(1)).Then(
                    local_put(Txn.sender(), PW, App.localGet(Txn.sender(), PW) + s_payout.load())
                ),
            )
        ),

        # Emit log: LVR: + die1 + die2 + total + betType + won + payout (8 bytes each)
        Log(Concat(
            Concat(
                Concat(
                    Concat(
                        Concat(
                            Concat(Bytes("LVR:"), Itob(s_die1.load())),
                            Itob(s_die2.load())
                        ),
                        Itob(s_total.load())
                    ),
                    Itob(s_bet_type.load())
                ),
                Itob(s_won.load())
            ),
            Itob(s_payout.load())
        )),

        # Send payout if won
        If(s_won.load() == Int(1)).Then(
            InnerTxnBuilder.Execute({
                TxnField.type_enum: TxnType.Payment,
                TxnField.receiver: Txn.sender(),
                TxnField.amount: s_payout.load(),
                TxnField.note: Bytes("LuckyVoiRoll payout"),
                TxnField.fee: Int(0),
            })
        ),

        Approve(),
    )

# ── withdraw(amount) ──────────────────────────────────────────────────────────
def handle_withdraw():
    amount  = Btoi(Txn.application_args()[1])
    reserve = global_get(MX) * Int(4)
    return Seq(
        Assert(Txn.sender() == global_get(OW), comment="Not owner"),
        Assert(amount <= global_get(HB), comment="Amount exceeds balance"),
        Assert(global_get(HB) - amount >= reserve, comment="Reserve too low"),
        global_put(HB, global_get(HB) - amount),
        InnerTxnBuilder.Execute({
            TxnField.type_enum: TxnType.Payment,
            TxnField.receiver: Txn.sender(),
            TxnField.amount: amount,
            TxnField.note: Bytes("LuckyVoiRoll withdrawal"),
            TxnField.fee: Int(0),
        }),
        Log(Concat(Bytes("WITHDRAW:"), Itob(amount))),
        Approve(),
    )

# ── emergencyWithdraw() ───────────────────────────────────────────────────────
def handle_emergency_withdraw():
    actual_balance = Balance(Global.current_application_address()) - Global.min_balance()
    return Seq(
        Assert(Txn.sender() == global_get(OW), comment="Not owner"),
        Assert(global_get(PA) == Int(1), comment="Must pause first"),
        Assert(actual_balance > Int(0), comment="Nothing to withdraw"),
        global_put(HB, Int(0)),
        InnerTxnBuilder.Execute({
            TxnField.type_enum: TxnType.Payment,
            TxnField.receiver: Txn.sender(),
            TxnField.amount: actual_balance,
            TxnField.note: Bytes("LuckyVoiRoll emergency withdrawal"),
            TxnField.fee: Int(0),
        }),
        Log(Concat(Bytes("EMERGENCY:"), Itob(actual_balance))),
        Approve(),
    )

# ── pause() / unpause() ───────────────────────────────────────────────────────
def handle_pause():
    return Seq(
        Assert(Txn.sender() == global_get(OW), comment="Not owner"),
        global_put(PA, Int(1)),
        Log(Bytes("PAUSE")),
        Approve(),
    )

def handle_unpause():
    return Seq(
        Assert(Txn.sender() == global_get(OW), comment="Not owner"),
        global_put(PA, Int(0)),
        Log(Bytes("UNPAUSE")),
        Approve(),
    )

# ── setBetLimits(newMin, newMax) ──────────────────────────────────────────────
def handle_set_bet_limits():
    new_min = Btoi(Txn.application_args()[1])
    new_max = Btoi(Txn.application_args()[2])
    return Seq(
        Assert(Txn.sender() == global_get(OW), comment="Not owner"),
        Assert(new_min > Int(0), comment="Min must be > 0"),
        Assert(new_max >= new_min, comment="Max must be >= min"),
        Assert(new_max <= MAX_BET_CAP, comment="newMax exceeds 10,000 VOI safety cap"),
        Assert(new_max * Int(4) <= global_get(HB), comment="maxBet reserve would exceed house pool"),
        global_put(MN, new_min),
        global_put(MX, new_max),
        Approve(),
    )

# ── transferOwnership(newOwner) ───────────────────────────────────────────────
def handle_transfer_ownership():
    new_owner = Txn.application_args()[1]
    return Seq(
        Assert(Txn.sender() == global_get(OW), comment="Not owner"),
        Assert(new_owner != Global.zero_address(), comment="Zero address"),
        Assert(new_owner != global_get(OW), comment="Already owner"),
        global_put(PO, new_owner),
        Approve(),
    )

# ── acceptOwnership() ─────────────────────────────────────────────────────────
def handle_accept_ownership():
    return Seq(
        Assert(global_get(PO) != Global.zero_address(), comment="No pending transfer"),
        Assert(Txn.sender() == global_get(PO), comment="Not pending owner"),
        global_put(OW, global_get(PO)),
        global_put(PO, Global.zero_address()),
        Approve(),
    )

# ── Approval program ──────────────────────────────────────────────────────────
def approval_program():
    method = Txn.application_args()[0]

    return Cond(
        # Create
        [Txn.application_id() == Int(0), handle_create()],

        # Methods
        [method == Bytes("fundHouse"),          handle_fund_house()],
        [method == Bytes("roll"),               handle_roll()],
        [method == Bytes("withdraw"),           handle_withdraw()],
        [method == Bytes("emergencyWithdraw"),  handle_emergency_withdraw()],
        [method == Bytes("pause"),              handle_pause()],
        [method == Bytes("unpause"),            handle_unpause()],
        [method == Bytes("setBetLimits"),       handle_set_bet_limits()],
        [method == Bytes("transferOwnership"),  handle_transfer_ownership()],
        [method == Bytes("acceptOwnership"),    handle_accept_ownership()],
    )

# ── Clear program ─────────────────────────────────────────────────────────────
def clear_program():
    return Approve()

# ── Compile & export ──────────────────────────────────────────────────────────
if __name__ == "__main__":
    import os, json

    out_dir = os.path.join(os.path.dirname(__file__), "..", "artifacts")
    os.makedirs(out_dir, exist_ok=True)

    # Compile approval
    approval = compileTeal(
        approval_program(),
        mode=Mode.Application,
        version=8,
        optimize=OptimizeOptions(scratch_slots=True),
    )

    # Compile clear
    clear = compileTeal(
        clear_program(),
        mode=Mode.Application,
        version=8,
    )

    # Write TEAL files
    approval_path = os.path.join(out_dir, "LuckyVoiRoll.approval.teal")
    clear_path    = os.path.join(out_dir, "LuckyVoiRoll.clear.teal")
    arc32_path    = os.path.join(out_dir, "LuckyVoiRoll.arc32.json")

    with open(approval_path, "w") as f:
        f.write(approval)

    with open(clear_path, "w") as f:
        f.write(clear)

    # ARC-32 schema (matches deploy.mjs expectations)
    arc32 = {
        "name": "LuckyVoiRoll",
        "desc": "Two-dice betting game on Voi Network",
        "networks": {},
        "state": {
            "global": {
                "num_byte_slices": 2,   # ow, po
                "num_uints": 8          # pa, hb, mn, mx, tg, tw, tp, nc
            },
            "local": {
                "num_byte_slices": 0,
                "num_uints": 2          # pg, pw
            }
        },
        "contract": {
            "name": "LuckyVoiRoll",
            "methods": [
                {"name": "fundHouse",         "args": [],                                          "returns": {"type": "void"}},
                {"name": "roll",              "args": [{"name": "betType", "type": "uint64"}],     "returns": {"type": "void"}},
                {"name": "withdraw",          "args": [{"name": "amount",  "type": "uint64"}],     "returns": {"type": "void"}},
                {"name": "emergencyWithdraw", "args": [],                                          "returns": {"type": "void"}},
                {"name": "pause",             "args": [],                                          "returns": {"type": "void"}},
                {"name": "unpause",           "args": [],                                          "returns": {"type": "void"}},
                {"name": "setBetLimits",      "args": [{"name": "newMin", "type": "uint64"}, {"name": "newMax", "type": "uint64"}], "returns": {"type": "void"}},
                {"name": "transferOwnership", "args": [{"name": "newOwner", "type": "address"}],  "returns": {"type": "void"}},
                {"name": "acceptOwnership",   "args": [],                                          "returns": {"type": "void"}},
            ]
        }
    }

    with open(arc32_path, "w") as f:
        json.dump(arc32, f, indent=2)

    print(f"✅ Compiled approval → {approval_path}")
    print(f"✅ Compiled clear    → {clear_path}")
    print(f"✅ ARC-32 schema     → {arc32_path}")
    print("\nArtifacts ready. Run: node scripts/deploy.mjs mainnet")
