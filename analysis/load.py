"""Load the exported dataset with correct types.

The single most important thing this module does is refuse to let a wei value
become a float. ``total_fee_wei`` routinely exceeds 2**53, and float64 carries
53 bits of mantissa, so ``pd.read_csv`` inferring float64 for a cost column
silently rounds every value in it. The rounding is invisible - the numbers still
look like numbers - and it lands directly in the paper's cost figures.

So every uint256 column is read as a string and converted to ``int`` (Python
ints are arbitrary precision) or ``Decimal`` where division is needed.

Usage::

    from load import load_export
    df = load_export("data/export.csv")
"""

from __future__ import annotations

from decimal import Decimal
from pathlib import Path

import pandas as pd

# ---------------------------------------------------------------------------
# Column groups. Keeping these explicit rather than inferred is the point: a new
# cost column added to the export must be classified here deliberately, not
# silently picked up as a float.
# ---------------------------------------------------------------------------

#: uint256 quantities. Read as str, converted to int. NEVER float.
WEI_COLUMNS = [
    "M_C1",
    "M_C2",
    "M_C3",
    "M_C3_op_l1_data_fee_wei",
    "M_C3_arb_l1_gas_allocation",
    "M_C4_numerator_wei",
    "total_fee_wei",
    "l1_gas_used",
    "l1_gas_price",
    "l2_gas_used",
    "force_gas_used",
    "l1_base_fee_at_submit",
    "gas_limit",
]

#: Latency metrics, in seconds. Integer seconds, but nullable.
LATENCY_METRICS = ["M_L1", "M_L2", "M_L3", "M_L4"]

#: Companion columns every latency metric must carry (BLUEPRINT section 11).
def companions(metric: str) -> tuple[str, str]:
    return f"{metric}_mixed_clock", f"{metric}_resolution_sec"


#: Cost columns that exist on ONE protocol only and are NOT interchangeable.
#: See migration 003 - one is a fee in wei at the L1 gas price, the other an L2
#: gas allocation at the L2 gas price.
PROTOCOL_SPECIFIC_COST_COLUMNS = {
    "op-stack": "M_C3_op_l1_data_fee_wei",
    "arbitrum-nitro": "M_C3_arb_l1_gas_allocation",
}

#: The only cost figure comparable across protocols.
CROSS_PROTOCOL_COST_COLUMN = "total_fee_wei"


def _to_int(value: object) -> int | None:
    """Exact integer, or None. Never a float."""
    if value is None:
        return None
    s = str(value).strip()
    if s == "" or s.lower() in {"nan", "none"}:
        return None
    return int(s)


def _to_decimal(value: object) -> Decimal | None:
    if value is None:
        return None
    s = str(value).strip()
    if s == "" or s.lower() in {"nan", "none"}:
        return None
    return Decimal(s)


def load_export(path: str | Path) -> pd.DataFrame:
    """Read export.csv with every column typed deliberately.

    All columns are read as ``str`` first so pandas cannot infer float64 for a
    wei column, then converted explicitly.
    """
    path = Path(path)
    df = pd.read_csv(path, dtype=str, keep_default_na=False, na_values=[""])

    for col in WEI_COLUMNS:
        if col in df.columns:
            # object dtype holding Python ints - exact at any magnitude.
            df[col] = df[col].map(_to_int)

    for metric in LATENCY_METRICS:
        if metric in df.columns:
            # Int64 is pandas' nullable integer: a missing latency stays missing
            # rather than becoming NaN in a float column.
            df[metric] = pd.to_numeric(df[metric], errors="coerce").astype("Int64")
        mixed, res = companions(metric)
        if mixed in df.columns:
            df[mixed] = pd.to_numeric(df[mixed], errors="coerce").astype("Int64")
        if res in df.columns:
            # Resolution can be fractional (Arbitrum's L2 block time is 0.25s).
            df[res] = pd.to_numeric(df[res], errors="coerce")

    for col in ("retry_count", "calldata_bytes", "nonce", "is_complete", "M_U1"):
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors="coerce").astype("Int64")

    for col in df.columns:
        if col.endswith("_block_number") or col.endswith("_block_timestamp"):
            df[col] = pd.to_numeric(df[col], errors="coerce").astype("Int64")

    return df


def cell_key(df: pd.DataFrame) -> pd.Series:
    """The experimental cell: protocol x chain x path.

    Statistics are reported per cell because pooling across chains or paths
    would average over the very differences the study is measuring.
    """
    return df["chain_key"].astype(str) + " / " + df["path"].astype(str)


def wei_to_eth(value: int | None) -> Decimal | None:
    """Exact conversion for display. Decimal, not float."""
    if value is None:
        return None
    return Decimal(value) / Decimal(10**18)


def check_companions(df: pd.DataFrame) -> list[str]:
    """Every latency column must carry its mixed-clock and resolution columns.

    Returns a list of problems; empty means the export is well-formed. Called by
    the report so a malformed export fails loudly rather than being analysed.
    """
    problems: list[str] = []
    for metric in LATENCY_METRICS:
        if metric not in df.columns:
            continue
        for col in companions(metric):
            if col not in df.columns:
                problems.append(f"{metric} present but {col} missing")
    return problems


def coverage(df: pd.DataFrame, column: str) -> tuple[int, int]:
    """``(n_total, n_with_metric)`` for a column.

    Reported alongside every statistic. A run whose tracking was interrupted
    exports a null latency, and an analysis that silently drops those rows is
    computing over a different denominator than the one it claims. Both numbers
    are always printed together for exactly that reason.
    """
    n_total = len(df)
    n_with = int(df[column].notna().sum()) if column in df.columns else 0
    return n_total, n_with
