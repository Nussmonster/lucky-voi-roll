"""
LuckyVoiRoll — PyTeal Smart Contract
Network: Voi (AVM-compatible)

Game mechanics — commit-reveal scheme (prevents validator-extractable-value):
  1. commit(pay, betType, commitment)
       Player sends bet payment + sha256(secret). Bet is locked in house pool.
  2. reveal(secret)
       Player reveals secret. Dice derived from sha256(Block(commitRound).seed
       || secret || nonce). Neither party could predict this before commit was
       final, so validators cannot manipulate outcomes.

  Bet types:
    Under 7  (betType=0) -> pays 2x  (sum 2-6)
    Lucky 7  (betType=1) -> pays 4x  (sum = 7)
    Over 7   (betType=2) -> pays 2x  (sum 8-12)

  Player must call reveal() within REVEAL_WINDOW rounds of commit.
  Un-revealed bets are forfeit to the house; expired commit slot resets
  automatically when the player makes a new commit.

Global state keys:
  ow  = owner address          po  = pending owner
  pa  = paused (0/1)           hb  = house balance (uVOI)
  mn  = min bet (uVOI)         mx  = max bet (uVOI)
  tg  = total games            tw  = total wagered (uVOI)
  tp  = total paid out (uVOI)  nc  = nonce counter

Local state keys:
  pg  = player games           pw  = player won (uVOI)
  cr  = commit round (0=none)  cb  = commit bet (uVOI)
  ct  = commit bet type        ch  = commit hash (sha256 of secret)

Compile:
  pip install pyteal==0.25.0 algosdk
  python contract/LuckyVoiRoll.py

Outputs:
  artifacts/LuckyVoiRoll.approval.teal
  artifacts/LuckyVoiRoll.clear.teal
  artifacts/LuckyVoiRoll.arc32.json
"""

import os, json
from pyteal import *

# Constants
UNDER_7             = Int(0)
LUCKY_7             = Int(1)
OVER_7              = Int(2)
MIN_BALANCE_RESERVE = Int(1_000_000)
DEFAULT_MIN_BET     = Int(1_000_000)
DEFAULT_MAX_BET     = Int(1_000_000_000)
MAX_BET_CAP         = Int(10_000_000_000)
REVEAL_DELAY        = Int(2)
REVEAL_WINDOW       = Int(30)

# Global state keys
OW = Bytes("ow")
PO = Bytes("po")
PA = Bytes("pa")
HB = Bytes("hb")
MN = Bytes("mn")
MX = Bytes("mx")
TG = Bytes("tg")
TW = Bytes("tw")
TP = Bytes("tp")
NC = Bytes("nc")

# Local state keys
PG = Bytes("pg")
PW = Bytes("pw")
CR = Bytes("cr")
CB = Bytes("cb")
CT = Bytes("ct")
CH = Bytes("ch")

def global_get(key):
    return App.globalGet(key)

def global_put(key, val):
    return App.globalPut(key, val)

def local_get(addr, key):
    return App.localGet(addr, key)

def local_put(addr, key, val):
    return App.localPut(addr, key, val)

def assert_payment_clean(pay):
    return Seq(
        Assert(pay.rekey_to() == Global.zero_address(),           comment="Rekey not allowed"),
        Assert(pay.close_remainder_to() == Global.zero_address(), comment="Close not allowed"),
    )

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

def handle_optin():
    return Seq(
        local_put(Txn.sender(), PG, Int(0)),
        local_put(Txn.sender(), PW, Int(0)),
        local_put(Txn.sender(), CR, Int(0)),
        local_put(Txn.sender(), CB, Int(0)),
        local_put(Txn.sender(), CT, Int(0)),
        local_put(Txn.sender(), CH, Bytes("")),
        Approve(),
    )

def handle_fund_house():
    pay = Gtxn[0]
    return Seq(
        Assert(Txn.sender() == global_get(OW), comment="Not owner"),
        Assert(Global.group_size() == Int(2)),
        Assert(Txn.group_index() == Int(1)),
        Assert(pay.type_enum() == TxnType.Payment),
        Assert(pay.receiver() == Global.current_application_address()),
        Assert(pay.sender() == Txn.sender()),
        Assert(pay.amount() > Int(0)),
        assert_payment_clean(pay),
        global_put(HB, global_get(HB) + pay.amount()),
        Log(Concat(Bytes("FUND:"), Itob(pay.amount()))),
        Approve(),
    )

def handle_commit():
    pay        = Gtxn[0]
    bet_type   = Btoi(Txn.application_args()[1])
    commitment = Txn.application_args()[2]
    s_ecr      = ScratchVar(TealType.uint64)

    return Seq(
        Assert(App.optedIn(Int(0), Global.current_application_id()), comment="Must opt in first"),
        Assert(Global.group_size() == Int(2)),
        Assert(Txn.group_index() == Int(1)),
        Assert(pay.type_enum() == TxnType.Payment),
        Assert(pay.receiver() == Global.current_application_address()),
        Assert(pay.sender() == Txn.sender()),
        assert_payment_clean(pay),
        Assert(global_get(PA) == Int(0), comment="Contract is paused"),
        Assert(
            Or(bet_type == Int(0), bet_type == Int(1), bet_type == Int(2)),
            comment="Invalid bet type",
        ),
        Assert(Len(commitment) == Int(32), comment="Commitment must be 32 bytes"),
        s_ecr.store(local_get(Txn.sender(), CR)),
        Assert(
            Or(
                s_ecr.load() == Int(0),
                Global.round() > s_ecr.load() + REVEAL_WINDOW,
            ),
            comment="Commit already pending",
        ),
        Assert(pay.amount() >= global_get(MN), comment="Bet too small"),
        Assert(pay.amount() <= global_get(MX), comment="Bet too large"),
        Assert(
            global_get(HB) >= pay.amount() * Int(4) + MIN_BALANCE_RESERVE,
            comment="House funds insufficient",
        ),
        global_put(HB, global_get(HB) + pay.amount()),
        global_put(TW, global_get(TW) + pay.amount()),
        local_put(Txn.sender(), CH, commitment),
        local_put(Txn.sender(), CR, Global.round()),
        local_put(Txn.sender(), CB, pay.amount()),
        local_put(Txn.sender(), CT, bet_type),
        Log(Concat(Bytes("COMMIT:"), Itob(pay.amount()), Itob(bet_type))),
        Approve(),
    )

def handle_reveal():
    secret   = Txn.application_args()[1]
    s_cr     = ScratchVar(TealType.uint64)
    s_bet    = ScratchVar(TealType.uint64)
    s_type   = ScratchVar(TealType.uint64)
    s_nc     = ScratchVar(TealType.uint64)
    s_seed1  = ScratchVar(TealType.bytes)
    s_seed2  = ScratchVar(TealType.bytes)
    s_die1   = ScratchVar(TealType.uint64)
    s_die2   = ScratchVar(TealType.uint64)
    s_total  = ScratchVar(TealType.uint64)
    s_won    = ScratchVar(TealType.uint64)
    s_payout = ScratchVar(TealType.uint64)

    return Seq(
        Assert(App.optedIn(Int(0), Global.current_application_id()), comment="Not opted in"),
        s_cr.store(local_get(Txn.sender(), CR)),
        Assert(s_cr.load() != Int(0),                         comment="No active commit"),
        Assert(Global.round() >= s_cr.load() + REVEAL_DELAY,  comment="Too early to reveal"),
        Assert(Global.round() <= s_cr.load() + REVEAL_WINDOW, comment="Reveal window expired"),
        Assert(Sha256(secret) == local_get(Txn.sender(), CH), comment="Invalid secret"),
        s_bet.store(local_get(Txn.sender(), CB)),
        s_type.store(local_get(Txn.sender(), CT)),
        s_nc.store(global_get(NC) + Int(1)),
        global_put(NC, s_nc.load()),
        s_seed1.store(Sha256(Concat(
            Block(s_cr.load()).seed(),
            secret,
            Itob(s_nc.load()),
        ))),
        s_seed2.store(Sha256(Concat(
            s_seed1.load(),
            Txn.sender(),
            Itob(s_bet.load()),
        ))),
        s_die1.store((Btoi(Extract(s_seed1.load(), Int(0), Int(8))) % Int(6)) + Int(1)),
        s_die2.store((Btoi(Extract(s_seed2.load(), Int(0), Int(8))) % Int(6)) + Int(1)),
        s_total.store(s_die1.load() + s_die2.load()),
        s_won.store(Int(0)),
        s_payout.store(Int(0)),
        If(And(s_type.load() == UNDER_7, s_total.load() < Int(7))).Then(
            Seq(s_won.store(Int(1)), s_payout.store(s_bet.load() * Int(2)))
        ).ElseIf(And(s_type.load() == LUCKY_7, s_total.load() == Int(7))).Then(
            Seq(s_won.store(Int(1)), s_payout.store(s_bet.load() * Int(4)))
        ).ElseIf(And(s_type.load() == OVER_7, s_total.load() > Int(7))).Then(
            Seq(s_won.store(Int(1)), s_payout.store(s_bet.load() * Int(2)))
        ),
        global_put(TG, global_get(TG) + Int(1)),
        If(s_won.load() == Int(1)).Then(
            Seq(
                global_put(HB, global_get(HB) - s_payout.load()),
                global_put(TP, global_get(TP) + s_payout.load()),
            )
        ),
        local_put(Txn.sender(), PG, local_get(Txn.sender(), PG) + Int(1)),
        If(s_won.load() == Int(1)).Then(
            local_put(Txn.sender(), PW, local_get(Txn.sender(), PW) + s_payout.load()),
        ),
        local_put(Txn.sender(), CR, Int(0)),
        local_put(Txn.sender(), CB, Int(0)),
        local_put(Txn.sender(), CT, Int(0)),
        local_put(Txn.sender(), CH, Bytes("")),
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
                    Itob(s_type.load())
                ),
                Itob(s_won.load())
            ),
            Itob(s_payout.load())
        )),
        If(s_won.load() == Int(1)).Then(
            InnerTxnBuilder.Execute({
                TxnField.type_enum: TxnType.Payment,
                TxnField.receiver:  Txn.sender(),
                TxnField.amount:    s_payout.load(),
                TxnField.note:      Bytes("LuckyVoiRoll payout"),
                TxnField.fee:       Int(0),
            })
        ),
        Approve(),
    )

def handle_withdraw():
    amount  = Btoi(Txn.application_args()[1])
    reserve = global_get(MX) * Int(4)
    return Seq(
        Assert(Txn.sender() == global_get(OW), comment="Not owner"),
        Assert(amount <= global_get(HB),       comment="Amount exceeds balance"),
        Assert(global_get(HB) - amount >= reserve, comment="Reserve too low"),
        global_put(HB, global_get(HB) - amount),
        InnerTxnBuilder.Execute({
            TxnField.type_enum: TxnType.Payment,
            TxnField.receiver:  global_get(OW),
            TxnField.amount:    amount,
            TxnField.note:      Bytes("LuckyVoiRoll withdrawal"),
            TxnField.fee:       Int(0),
        }),
        Log(Concat(Bytes("WITHDRAW:"), Itob(amount))),
        Approve(),
    )

def handle_emergency_withdraw():
    s_hb = ScratchVar(TealType.uint64)
    return Seq(
        Assert(Txn.sender() == global_get(OW), comment="Not owner"),
        Assert(global_get(PA) == Int(1),       comment="Must pause first"),
        s_hb.store(global_get(HB)),
        Assert(s_hb.load() > Int(0),           comment="Nothing to withdraw"),
        global_put(HB, Int(0)),
        InnerTxnBuilder.Execute({
            TxnField.type_enum: TxnType.Payment,
            TxnField.receiver:  global_get(OW),
            TxnField.amount:    s_hb.load(),
            TxnField.note:      Bytes("LuckyVoiRoll emergency withdrawal"),
            TxnField.fee:       Int(0),
        }),
        Log(Concat(Bytes("EMERGENCY:"), Itob(s_hb.load()))),
        Approve(),
    )

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

def handle_set_bet_limits():
    new_min = Btoi(Txn.application_args()[1])
    new_max = Btoi(Txn.application_args()[2])
    return Seq(
        Assert(Txn.sender() == global_get(OW), comment="Not owner"),
        Assert(new_min > Int(0),               comment="Min must be > 0"),
        Assert(new_max >= new_min,             comment="Max must be >= min"),
        Assert(new_max <= MAX_BET_CAP,         comment="Exceeds 10,000 VOI cap"),
        Assert(
            new_max * Int(4) + MIN_BALANCE_RESERVE <= global_get(HB),
            comment="House pool too low for new limits",
        ),
        global_put(MN, new_min),
        global_put(MX, new_max),
        Log(Concat(Bytes("LIMITS:"), Itob(new_min), Itob(new_max))),
        Approve(),
    )

def handle_transfer_ownership():
    new_owner = Txn.application_args()[1]
    return Seq(
        Assert(Txn.sender() == global_get(OW),    comment="Not owner"),
        Assert(Len(new_owner) == Int(32),          comment="Invalid address length"),
        Assert(new_owner != Global.zero_address(), comment="Zero address"),
        Assert(new_owner != global_get(OW),        comment="Already owner"),
        global_put(PO, new_owner),
        Log(Concat(Bytes("TRANSFER:"), new_owner)),
        Approve(),
    )

def handle_accept_ownership():
    return Seq(
        Assert(global_get(PO) != Global.zero_address(), comment="No pending transfer"),
        Assert(Txn.sender() == global_get(PO),          comment="Not pending owner"),
        global_put(OW, global_get(PO)),
        global_put(PO, Global.zero_address()),
        Log(Concat(Bytes("OWNER:"), Txn.sender())),
        Approve(),
    )

def approval_program():
    method = Txn.application_args()[0]
    return Cond(
        [Txn.application_id() == Int(0),       handle_create()],
        [method == Bytes("fundHouse"),          handle_fund_house()],
        [method == Bytes("commit"),             handle_commit()],
        [method == Bytes("reveal"),             handle_reveal()],
        [method == Bytes("withdraw"),           handle_withdraw()],
        [method == Bytes("emergencyWithdraw"),  handle_emergency_withdraw()],
        [method == Bytes("pause"),              handle_pause()],
        [method == Bytes("unpause"),            handle_unpause()],
        [method == Bytes("setBetLimits"),       handle_set_bet_limits()],
        [method == Bytes("transferOwnership"),  handle_transfer_ownership()],
        [method == Bytes("acceptOwnership"),    handle_accept_ownership()],
    )

def clear_program():
    return Approve()

if __name__ == "__main__":
    out_dir = os.path.join(os.path.dirname(__file__), "..", "artifacts")
    os.makedirs(out_dir, exist_ok=True)

    approval = compileTeal(
        approval_program(),
        mode=Mode.Application,
        version=8,
        optimize=OptimizeOptions(scratch_slots=True),
    )
    clear = compileTeal(clear_program(), mode=Mode.Application, version=8)

    approval_path = os.path.join(out_dir, "LuckyVoiRoll.approval.teal")
    clear_path    = os.path.join(out_dir, "LuckyVoiRoll.clear.teal")
    arc32_path    = os.path.join(out_dir, "LuckyVoiRoll.arc32.json")

    with open(approval_path, "w") as f:
        f.write(approval)
    with open(clear_path, "w") as f:
        f.write(clear)

    arc32 = {
        "name": "LuckyVoiRoll",
        "desc": "Two-dice commit-reveal betting game on Voi Network",
        "networks": {},
        "state": {
            "global": {"num_byte_slices": 2, "num_uints": 8},
            "local":  {"num_byte_slices": 1, "num_uints": 5},
        },
        "contract": {
            "name": "LuckyVoiRoll",
            "methods": [
                {"name": "fundHouse",         "args": [],                                                                           "returns": {"type": "void"}},
                {"name": "commit",            "args": [{"name": "betType",    "type": "uint64"}, {"name": "commitment", "type": "byte[]"}], "returns": {"type": "void"}},
                {"name": "reveal",            "args": [{"name": "secret",     "type": "byte[]"}],                                   "returns": {"type": "void"}},
                {"name": "withdraw",          "args": [{"name": "amount",     "type": "uint64"}],                                   "returns": {"type": "void"}},
                {"name": "emergencyWithdraw", "args": [],                                                                           "returns": {"type": "void"}},
                {"name": "pause",             "args": [],                                                                           "returns": {"type": "void"}},
                {"name": "unpause",           "args": [],                                                                           "returns": {"type": "void"}},
                {"name": "setBetLimits",      "args": [{"name": "newMin",     "type": "uint64"}, {"name": "newMax",     "type": "uint64"}], "returns": {"type": "void"}},
                {"name": "transferOwnership", "args": [{"name": "newOwner",   "type": "address"}],                                  "returns": {"type": "void"}},
                {"name": "acceptOwnership",   "args": [],                                                                           "returns": {"type": "void"}},
            ],
        },
    }

    with open(arc32_path, "w") as f:
        json.dump(arc32, f, indent=2)

    print(f"Compiled approval -> {approval_path}  ({len(approval.splitlines())} lines)")
    print(f"Compiled clear    -> {clear_path}")
    print(f"ARC-32            -> {arc32_path}")
    print("\nArtifacts ready. Run: node scripts/deploy.mjs mainnet")
