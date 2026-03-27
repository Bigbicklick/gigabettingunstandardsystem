"""
Ensemble Logic Module — GigaBet AI System
Handles: weighted ensemble, L-system probability, safety filters, structured logging.
"""

import numpy as np
import math
import json
import os
import logging
from datetime import datetime
from typing import List, Dict, Tuple, Optional

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# ENSEMBLE WEIGHTS
# ---------------------------------------------------------------------------
WEIGHT_XGB = 0.40
WEIGHT_RF  = 0.20
WEIGHT_LR  = 0.20
WEIGHT_LSY = 0.20

# ---------------------------------------------------------------------------
# SAFETY FILTER THRESHOLDS
# ---------------------------------------------------------------------------
MAX_ODDS          = 10.0    # Hard reject: odds too high
MIN_FINAL_PROB    = 0.65    # Hard reject: model not confident
MIN_VALUE         = 0.05    # Hard reject: no mathematical edge
MIN_MODELS_AGREE  = 2       # Hard reject: models don't consensus

PREFERRED_ODDS_LOW  = 1.20
PREFERRED_ODDS_HIGH = 2.50

# ---------------------------------------------------------------------------
# LOGGING SETUP
# ---------------------------------------------------------------------------
LOG_DIR = os.path.join(os.path.dirname(__file__), "logs")
os.makedirs(LOG_DIR, exist_ok=True)

DECISION_LOG  = os.path.join(LOG_DIR, "decisions.jsonl")
REJECTED_LOG  = os.path.join(LOG_DIR, "rejected.jsonl")
MODEL_OUT_LOG = os.path.join(LOG_DIR, "model_outputs.jsonl")


def _append_log(filepath: str, record: dict):
    """Thread-safe append of one JSON line to a log file."""
    try:
        record["ts"] = datetime.utcnow().isoformat()
        with open(filepath, "a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")
    except Exception as e:
        logger.warning(f"Log write failed ({filepath}): {e}")


def log_model_outputs(match: str, xgb_p, rf_p, lr_p, lsys_p, final_p):
    _append_log(MODEL_OUT_LOG, {
        "match": match,
        "xgb_probs": [round(float(x), 4) for x in xgb_p],
        "rf_probs":  [round(float(x), 4) for x in rf_p],
        "lr_probs":  [round(float(x), 4) for x in lr_p],
        "lsys_probs": [round(float(x), 4) for x in lsys_p],
        "final_probs": [round(float(x), 4) for x in final_p],
    })


def log_decision(match: str, outcome: str, odds: float, final_prob: float,
                 value: float, models_agreeing: int, reasoning: str):
    _append_log(DECISION_LOG, {
        "match": match,
        "outcome": outcome,
        "odds": odds,
        "final_prob_pct": round(final_prob * 100, 2),
        "value_pct": round(value * 100, 2),
        "models_agreeing": models_agreeing,
        "reasoning": reasoning,
    })


def log_rejected(match: str, outcome: str, odds: float, final_prob: float,
                 value: float, reason: str):
    _append_log(REJECTED_LOG, {
        "match": match,
        "outcome": outcome,
        "odds": odds,
        "final_prob_pct": round(final_prob * 100, 2) if final_prob else None,
        "value_pct": round(value * 100, 2) if value is not None else None,
        "rejection_reason": reason,
    })


# ---------------------------------------------------------------------------
# L-SYSTEM PROBABILITY
# ---------------------------------------------------------------------------

def compute_l_system_prob(
    h_elo: float,
    a_elo: float,
    h_win_rate: float,    # wins / games (0-1)
    a_win_rate: float,
    h_draw_rate: float,   # draws / games (0-1)
    a_draw_rate: float,
    h_gd_per_game: float, # (goals_scored - goals_conceded) / games
    a_gd_per_game: float,
    home_advantage_elo: float = 100.0
) -> List[float]:
    """
    Compute L-system probabilities [p_home, p_draw, p_away] using:
      - ELO difference (with home advantage)
      - Win/draw rates
      - Goal difference per game
    Normalised via softmax to sum to 1.
    """
    # ELO-based expected home win probability
    elo_prob_home = 1.0 / (1.0 + 10.0 ** ((a_elo - (h_elo + home_advantage_elo)) / 400.0))

    # Combine ELO with win rate and goal difference signals
    # Score = weighted combination → higher means more likely to win
    home_score = (0.5 * elo_prob_home +
                  0.25 * h_win_rate +
                  0.25 * _sigmoid(h_gd_per_game - a_gd_per_game))

    away_score = (0.5 * (1.0 - elo_prob_home) +
                  0.25 * a_win_rate +
                  0.25 * _sigmoid(a_gd_per_game - h_gd_per_game))

    # Draw score based on average draw rates and closeness of teams
    elo_diff_abs = abs(h_elo - a_elo)
    closeness = max(0.0, 1.0 - elo_diff_abs / 400.0)
    draw_score = 0.5 * ((h_draw_rate + a_draw_rate) / 2.0) + 0.5 * closeness * 0.33

    raw = np.array([home_score, draw_score, away_score], dtype=float)
    probs = _softmax(raw)
    return probs.tolist()


def _sigmoid(x: float) -> float:
    return 1.0 / (1.0 + math.exp(-x))


def _softmax(arr: np.ndarray) -> np.ndarray:
    e = np.exp(arr - arr.max())
    return e / e.sum()


# ---------------------------------------------------------------------------
# WEIGHTED ENSEMBLE
# ---------------------------------------------------------------------------

def compute_weighted_ensemble(
    xgb_probs: List[float],
    rf_probs:  List[float],
    lr_probs:  List[float],
    lsys_probs: List[float],
) -> np.ndarray:
    """
    Returns final_probs array [p_home, p_draw, p_away] using fixed weights.
    final_prob = 0.4*XGB + 0.2*RF + 0.2*LR + 0.2*L_SYSTEM
    """
    xgb  = np.array(xgb_probs,  dtype=float)
    rf   = np.array(rf_probs,   dtype=float)
    lr   = np.array(lr_probs,   dtype=float)
    lsys = np.array(lsys_probs, dtype=float)

    # Ensure all are valid probability vectors (sum to 1)
    xgb  = xgb  / xgb.sum()  if xgb.sum()  > 0 else np.ones(3) / 3
    rf   = rf   / rf.sum()   if rf.sum()   > 0 else np.ones(3) / 3
    lr   = lr   / lr.sum()   if lr.sum()   > 0 else np.ones(3) / 3
    lsys = lsys / lsys.sum() if lsys.sum() > 0 else np.ones(3) / 3

    final = WEIGHT_XGB * xgb + WEIGHT_RF * rf + WEIGHT_LR * lr + WEIGHT_LSY * lsys
    return final


# ---------------------------------------------------------------------------
# SAFETY FILTERS
# ---------------------------------------------------------------------------

def count_models_agreeing(
    predicted_idx: int,
    xgb_probs: List[float],
    rf_probs:  List[float],
    lr_probs:  List[float],
    lsys_probs: List[float],
) -> Tuple[int, List[str]]:
    """
    Counts how many sub-models predict the same class as `predicted_idx`.
    Returns (count, list_of_agreeing_model_names).
    """
    agreeing = []
    if np.argmax(xgb_probs)  == predicted_idx: agreeing.append("XGBoost")
    if np.argmax(rf_probs)   == predicted_idx: agreeing.append("RandomForest")
    if np.argmax(lr_probs)   == predicted_idx: agreeing.append("LogisticReg")
    if np.argmax(lsys_probs) == predicted_idx: agreeing.append("L-System")
    return len(agreeing), agreeing


def apply_safety_filters(
    final_prob: float,
    odds: float,
    models_agreeing: int,
    match: str = "",
    outcome: str = "",
) -> Tuple[bool, str]:
    """
    Returns (passes: bool, reason: str).
    A bet ONLY passes when ALL four conditions are met.
    """
    if odds is None or odds <= 1.0:
        reason = f"Invalid odds ({odds})"
        log_rejected(match, outcome, odds, final_prob, None, reason)
        return False, reason

    if odds > MAX_ODDS:
        reason = f"Odds {odds} > max allowed {MAX_ODDS}"
        value = final_prob - (1.0 / odds)
        log_rejected(match, outcome, odds, final_prob, value, reason)
        return False, reason

    if final_prob < MIN_FINAL_PROB:
        reason = f"final_prob {final_prob:.1%} < required {MIN_FINAL_PROB:.0%}"
        value = final_prob - (1.0 / odds)
        log_rejected(match, outcome, odds, final_prob, value, reason)
        return False, reason

    if models_agreeing < MIN_MODELS_AGREE:
        reason = f"Only {models_agreeing} model(s) agree — need {MIN_MODELS_AGREE}"
        value = final_prob - (1.0 / odds)
        log_rejected(match, outcome, odds, final_prob, value, reason)
        return False, reason

    value = final_prob - (1.0 / odds)
    if value <= MIN_VALUE:
        reason = f"Value {value:.1%} ≤ minimum {MIN_VALUE:.0%}"
        log_rejected(match, outcome, odds, final_prob, value, reason)
        return False, reason

    return True, "All filters passed"


def build_reasoning(
    h_elo: float,
    a_elo: float,
    h_win_rate: float,
    a_win_rate: float,
    odds: float,
    agreeing_names: List[str],
    final_prob: float,
    value: float,
) -> str:
    """Builds a human-readable reasoning string for the Discord message."""
    parts = []

    elo_diff = h_elo - a_elo
    if elo_diff > 50:
        parts.append(f"ELO advantage +{elo_diff:.0f}")
    elif elo_diff < -50:
        parts.append(f"ELO disadvantage {elo_diff:.0f}")
    else:
        parts.append("Teams evenly matched (ELO)")

    wr_diff = h_win_rate - a_win_rate
    if wr_diff > 0.1:
        parts.append(f"home win rate +{wr_diff:.0%} better")
    elif wr_diff < -0.1:
        parts.append(f"away win rate +{-wr_diff:.0%} better")

    if PREFERRED_ODDS_LOW <= odds <= PREFERRED_ODDS_HIGH:
        parts.append("preferred odds range ✓")

    parts.append(f"models agreeing: {', '.join(agreeing_names)}")

    return " | ".join(parts)
