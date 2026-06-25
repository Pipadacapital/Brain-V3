"""
_attribution_math.py — a BYTE/MINOR-UNIT-EXACT Python port of the @brain/metric-engine attribution
apportionment (Brain V4 Phase 2, GROUP attribution). Reproduces the EXACT money math the TypeScript
attribution-writer + metric-engine produce, so the Spark→Iceberg gold_attribution_credit dual-run is
parity-exact with the live TS-written StarRocks brain_gold.gold_attribution_credit ledger.

Mirrored verbatim (1:1) from:
  - packages/metric-engine/src/attribution-models.ts
        WEIGHT_SCALE=1e8, computeWeightUnits (first/last/linear/position_based), distributeRemainder
        (deterministic 0,n-1,1..n-2 order), apportionMinor (largest-remainder, SIGN-PRESERVING),
        normalizeWeightUnits, computeTouchCredits / computeTouchCreditsExplicit, weightFractionString.
  - packages/metric-engine/src/attribution-datadriven.ts
        computeMarkovChannelWeights (first-order absorbing-Markov removal-effect, power iteration,
        seed/iter/tol identical), dataDrivenTouchWeightUnits, normalizeToScale.
  - packages/metric-engine/src/attribution-confidence.ts
        gradeJourneyConfidence + isDeterministicChannel (strong/partial/weak → 1.000/0.700/0.400).
  - packages/metric-engine/src/attribution-credit.ts
        computeCreditId = sha256(brand\0order\0anon\0touch_seq\0model\0'credit'\0v1) (HEX, NUL-joined).

ALL money/weight arithmetic is Python `int` (arbitrary precision) — NEVER float — exactly like the TS
uses `bigint`. The ONLY float is the Markov solve (probabilities), confined to the weight VECTOR and
quantized to 1e8 integer units before any money is apportioned — identical to the TS confinement (I-S07).

NO Spark / pyspark import here: this is a pure-Python module so the credit driver can call it per order
in a deterministic single-threaded loop (the corpus + per-order touch counts are tiny — journey grain).
"""
from __future__ import annotations  # Python 3.8 on the Spark image.

import hashlib

# ── attribution-models.ts: WEIGHT_SCALE + position constants ──────────────────────────────────────
WEIGHT_SCALE = 100_000_000               # 1e8 hundred-millionths == DECIMAL(9,8) granularity
POSITION_ENDPOINT = 40_000_000           # position-based endpoint weight 0.40
POSITION_MIDDLE_MASS = 20_000_000        # position-based total middle mass 0.20
ATTRIBUTION_MODEL_VERSION = "v1"
PER_JOURNEY_MODEL_IDS = ("first_touch", "last_touch", "linear", "position_based")

# attribution-confidence.ts: frozen numeric confidence + letter per grade.
CONFIDENCE_BY_GRADE = {"strong": "1.000", "partial": "0.700", "weak": "0.400"}
COOKIELESS_CHANNEL = "direct"


def weight_fraction_string(units: int) -> str:
    """attribution-models.weightFractionString — render 1e8-scale units as 'D.DDDDDDDD'."""
    if units < 0:
        raise ValueError(f"negative weight units: {units}")
    whole = units // WEIGHT_SCALE
    frac = units % WEIGHT_SCALE
    return f"{whole}.{str(frac).rjust(8, '0')}"


def _distribute_remainder(base, target):
    """attribution-models.distributeRemainder — deterministic order 0, n-1, then 1..n-2 ascending."""
    s = sum(base)
    remainder = target - s
    if remainder == 0:
        return list(base)
    if remainder < 0:
        raise ValueError(f"weight over-allocation: sum={s} > target={target}")
    out = list(base)
    n = len(out)
    order = [0]
    if n > 1:
        order.append(n - 1)
    for i in range(1, n - 1):
        order.append(i)
    cursor = 0
    while remainder > 0:
        idx = order[cursor % len(order)]
        out[idx] += 1
        remainder -= 1
        cursor += 1
    return out


def compute_weight_units(model: str, touch_count: int):
    """attribution-models.computeWeightUnits — per-touch 1e8 weight units; Σ == WEIGHT_SCALE exactly."""
    n = touch_count
    if n <= 0:
        return []
    if n == 1:
        return [WEIGHT_SCALE]
    if model == "first_touch":
        return [WEIGHT_SCALE if i == 0 else 0 for i in range(n)]
    if model == "last_touch":
        return [WEIGHT_SCALE if i == n - 1 else 0 for i in range(n)]
    if model == "linear":
        base = [WEIGHT_SCALE // n for _ in range(n)]
        return _distribute_remainder(base, WEIGHT_SCALE)
    if model == "position_based":
        if n == 2:
            base = [WEIGHT_SCALE // 2, WEIGHT_SCALE // 2]
        else:
            middle_count = n - 2
            per_middle = POSITION_MIDDLE_MASS // middle_count
            base = [
                POSITION_ENDPOINT if (i == 0 or i == n - 1) else per_middle
                for i in range(n)
            ]
        return _distribute_remainder(base, WEIGHT_SCALE)
    raise ValueError(f"unknown / non-per-journey model for closed form: {model}")


def apportion_minor(weight_units, total_minor: int):
    """attribution-models.apportionMinor — largest-remainder, SIGN-PRESERVING. Σ out == total_minor."""
    n = len(weight_units)
    if n == 0:
        return []
    w_sum = sum(weight_units)
    if w_sum != WEIGHT_SCALE:
        raise ValueError(f"weight units must sum to {WEIGHT_SCALE}, got {w_sum}")
    sign = -1 if total_minor < 0 else 1
    mag = -total_minor if total_minor < 0 else total_minor
    raw = [0] * n
    remainder = [0] * n
    allocated = 0
    for i in range(n):
        numer = weight_units[i] * mag
        q = numer // WEIGHT_SCALE
        raw[i] = q
        remainder[i] = numer % WEIGHT_SCALE
        allocated += q
    leftover = mag - allocated
    # largest remainders first; tiebreak by index ascending (stable sort by (-rem, idx)).
    order = sorted(range(n), key=lambda i: (-remainder[i], i))
    cursor = 0
    while leftover > 0 and cursor < len(order):
        raw[order[cursor]] += 1
        leftover -= 1
        cursor += 1
    out = [sign * q for q in raw]
    if sum(out) != total_minor:
        raise ValueError(f"apportionment closed-sum violation: sum={sum(out)} != {total_minor}")
    return out


def normalize_to_scale(raw):
    """attribution-datadriven.normalizeToScale / attribution-models.normalizeWeightUnits — Σ==WEIGHT_SCALE.

    raw_i >= 0 (negatives floored to 0). Σraw==0 → uniform. Largest-remainder on (raw_i*SCALE)/Σraw.
    """
    n = len(raw)
    if n == 0:
        return []
    s = sum(r if r >= 0 else 0 for r in raw)
    if s == 0:
        base = [WEIGHT_SCALE // n for _ in range(n)]
        rem = WEIGHT_SCALE - sum(base)
        i = 0
        while rem > 0:
            base[i % n] += 1
            rem -= 1
            i += 1
        return base
    out = [0] * n
    remainder = [0] * n
    allocated = 0
    for i in range(n):
        r = raw[i] if raw[i] >= 0 else 0
        numer = r * WEIGHT_SCALE
        out[i] = numer // s
        remainder[i] = numer % s
        allocated += out[i]
    leftover = WEIGHT_SCALE - allocated
    order = sorted(range(n), key=lambda i: (-remainder[i], i))
    k = 0
    while leftover > 0 and k < len(order):
        out[order[k]] += 1
        leftover -= 1
        k += 1
    return out


# ── attribution-datadriven.ts: Markov removal-effect (FLOAT confined to the weight vector) ────────
_POWER_ITER_MAX = 1000
_POWER_ITER_TOL = 1e-12


def _conversion_probability(P, start_idx, conv_idx, transient):
    """attribution-datadriven.conversionProbability — absorbed CONVERSION mass via power iteration."""
    n = len(P)
    v = [0.0] * n
    v[start_idx] = 1.0
    for _ in range(_POWER_ITER_MAX):
        v2 = [0.0] * n
        for i in range(n):
            vi = v[i]
            if vi == 0.0:
                continue
            row = P[i]
            for j in range(n):
                p = row[j]
                if p != 0.0:
                    v2[j] += vi * p
        transient_mass = 0.0
        for t in transient:
            transient_mass += v2[t]
        v = v2
        if transient_mass < _POWER_ITER_TOL:
            break
    return v[conv_idx]


def compute_markov_channel_weights(journeys):
    """attribution-datadriven.computeMarkovChannelWeights — per-channel 1e8 weight units (Σ==SCALE).

    journeys: list of (channels:list[str], converted:bool). Returns dict channel -> weight_units.
    Degenerate: no channels → {}; zero signal → uniform across channels (normalize_to_scale).
    """
    channel_set = set()
    for chans, _conv in journeys:
        for c in chans:
            if c:
                channel_set.add(c)
    channels = sorted(channel_set)
    K = len(channels)
    if K == 0:
        return {}
    START = 0
    ch_idx = {c: i + 1 for i, c in enumerate(channels)}
    CONV = K + 1
    NUL = K + 2
    n_states = K + 3
    transient = [START] + [i + 1 for i in range(K)]
    counts = [[0] * n_states for _ in range(n_states)]
    for chans, converted in journeys:
        cl = [c for c in chans if c]
        if not cl:
            continue
        prev = START
        for c in cl:
            idx = ch_idx[c]
            counts[prev][idx] += 1
            prev = idx
        counts[prev][CONV if converted else NUL] += 1
    # base row-stochastic matrix
    P = [[0.0] * n_states for _ in range(n_states)]
    for i in transient:
        row_sum = sum(counts[i])
        if row_sum == 0:
            P[i][NUL] = 1.0
        else:
            for j in range(n_states):
                c = counts[i][j]
                if c != 0:
                    P[i][j] = c / row_sum
    P[CONV][CONV] = 1.0
    P[NUL][NUL] = 1.0
    baseline = _conversion_probability(P, START, CONV, transient)
    raw_re = []
    for ci in range(K):
        state_idx = ci + 1
        Pc = [row[:] for row in P]
        for j in range(n_states):
            Pc[state_idx][j] = 0.0
        Pc[state_idx][NUL] = 1.0
        conv_c = _conversion_probability(Pc, START, CONV, transient)
        re = max(0.0, (baseline - conv_c) / baseline) if baseline > 0 else 0.0
        raw_re.append(re)
    raw_units = [int(round(re * 1e12)) for re in raw_re]
    weight_units = normalize_to_scale(raw_units)
    return {channels[i]: weight_units[i] for i in range(K)}


def data_driven_touch_weight_units(touch_channels, channel_weight_units):
    """attribution-datadriven.dataDrivenTouchWeightUnits — per-touch units from global channel weights."""
    if not touch_channels:
        return []
    raw = [channel_weight_units.get(c, 0) for c in touch_channels]
    return normalize_to_scale(raw)


# ── attribution-confidence.ts ─────────────────────────────────────────────────────────────────────
def is_deterministic_channel(touch):
    """attribution-confidence.isDeterministicChannel — click-id OR utm.medium AND channel != 'direct'."""
    if touch["channel"] == COOKIELESS_CHANNEL:
        return False
    has_click = any(
        bool(touch.get(k))
        for k in ("fbclid", "gclid", "ttclid", "msclkid", "gbraid", "wbraid", "dclid")
    )
    has_medium = bool(touch.get("utm_medium"))
    return has_click or has_medium


def grade_journey_confidence(stitched, touch_signals):
    """attribution-confidence.gradeJourneyConfidence → (grade, confidence_string)."""
    if (not stitched) or len(touch_signals) == 0:
        grade = "weak"
    elif all(touch_signals):
        grade = "strong"
    else:
        grade = "partial"
    return grade, CONFIDENCE_BY_GRADE[grade]


# ── attribution-credit.ts: deterministic credit_id ─────────────────────────────────────────────────
def compute_credit_id(brand_id, order_id, brain_anon_id, touch_seq, model_id):
    """attribution-credit.computeCreditId — sha256 over NUL-joined fields (hex)."""
    s = (
        f"{brand_id}\0{order_id}\0{brain_anon_id}\0{touch_seq}\0{model_id}"
        f"\0credit\0{ATTRIBUTION_MODEL_VERSION}"
    )
    return hashlib.sha256(s.encode("utf-8")).hexdigest()
