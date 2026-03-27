from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from typing import Optional, Dict, Any, List
import joblib
import os
import uvicorn
import ml_pipeline
import ml_pipeline_basket
import ml_pipeline_esport
import ml_pipeline_tennis
import ensemble_logic
import logging
import difflib
import pandas as pd
import numpy as np
import threading
from apscheduler.schedulers.background import BackgroundScheduler

app = FastAPI(title="AI Betting Predictor", description="Machine Learning API for football match prediction.")
logger = logging.getLogger(__name__)

MODEL_PATH = ml_pipeline.MODEL_PATH
STATE_PATH = ml_pipeline.STATE_PATH

model = None
model_btts = None
model_ou = None
model_corners = None
team_states = None

# Modele NBA
team_states_basket = None

class PredictionRequest(BaseModel):
    home_team: str
    away_team: str
    odds_home: Optional[float] = None
    odds_draw: Optional[float] = None
    odds_away: Optional[float] = None
    odds_btts_yes: Optional[float] = None
    odds_btts_no: Optional[float] = None
    odds_ou_over: Optional[float] = None
    odds_ou_under: Optional[float] = None
    odds_corners_over: Optional[float] = None
    odds_corners_under: Optional[float] = None
    odds_dc_1x: Optional[float] = None
    odds_dc_x2: Optional[float] = None
    odds_dc_12: Optional[float] = None
    odds_dnb_home: Optional[float] = None
    odds_dnb_away: Optional[float] = None

class BasketPredictionRequest(BaseModel):
    home_team: str
    away_team: str
    odds_home: Optional[float] = None
    odds_away: Optional[float] = None
    odds_spread_home: Optional[float] = None
    odds_spread_away: Optional[float] = None
    odds_totals_over: Optional[float] = None
    odds_totals_under: Optional[float] = None

class PredictionRequestTennis(BaseModel):
    home_team: str
    away_team: str
    odds_home: Optional[float] = None
    odds_away: Optional[float] = None

class PredictionRequestEsport(BaseModel):
    home_team: str
    away_team: str
    odds_home: Optional[float] = None
    odds_away: Optional[float] = None

scheduler = BackgroundScheduler()

def load_ai():
    global model, model_btts, model_ou, model_corners, team_states, team_states_basket
    if not os.path.exists(MODEL_PATH) or not os.path.exists(STATE_PATH):
        logger.warning("Football Model not found. Executing ML Pipeline to fetch data and train model...")
        ml_pipeline.train_model()
        
    if not os.path.exists(ml_pipeline_basket.BASKET_STATE_FILE):
        logger.warning("Basket State not found. Skipping Basketball (non-critical).")
    
    if not os.path.exists(ml_pipeline_esport.ESPORT_MODEL_FILE):
        logger.warning("Esport Model not found. Skipping Esport (non-critical).")
        
    if not os.path.exists(ml_pipeline_tennis.TENNIS_MODEL_FILE):
        logger.warning("Tennis Model not found. Skipping Tennis (non-critical).")
    
    # Patch: if team_states.joblib was saved when ml_pipeline.py ran as __main__,
    # pickle will look for __main__.TeamState. Point it to the correct class.
    import sys
    import types
    _fake_main = types.ModuleType('__main__')
    _fake_main.TeamState = ml_pipeline.TeamState
    sys.modules.setdefault('__main__', _fake_main)
    # Also cover the case where __main__ exists but lacks TeamState
    if not hasattr(sys.modules.get('__main__'), 'TeamState'):
        sys.modules['__main__'].TeamState = ml_pipeline.TeamState

    try:
        model = joblib.load(MODEL_PATH)
        model_btts = joblib.load('model_btts.joblib')
        model_ou = joblib.load('model_ou.joblib')
        model_corners = joblib.load('model_corners.joblib')
        team_states = joblib.load(STATE_PATH)
        # Ensure all TeamState objects have the new L-system attributes (backward compat)
        for ts in team_states.values():
            if not hasattr(ts, 'l_points'):       ts.l_points = []
            if not hasattr(ts, 'l_goals_scored'):  ts.l_goals_scored = []
            if not hasattr(ts, 'l_goals_conceded'): ts.l_goals_conceded = []
            if not hasattr(ts, 'l_opponent_elo'):  ts.l_opponent_elo = []
    except Exception as e:
        logger.error(f"Cannot load Football Model. Err: {e}")
        team_states = {}

    try:
        team_states_basket = joblib.load(ml_pipeline_basket.BASKET_STATE_FILE)
    except Exception as e:
        logger.warning(f"Cannot load Basket states: {e}")
        team_states_basket = {}
    logger.info("Models and team states loaded (Football primary).")

def scheduled_retrain():
    logger.info("Starting Auto-Retraining Pipeline (APScheduler) - Fetching latest results...")
    try:
        # Retrain in background thread
        ml_pipeline.train_model()
        # Atomic swap in memory happens during load_ai
        load_ai()
        logger.info("Auto-Retraining Pipeline completed. RAM memory swapped without downtime.")
    except Exception as e:
        logger.error(f"Failed to auto-train: {e}")

@app.on_event("startup")
async def startup_event():
    load_ai()
    # Schedule autonomous learning every Monday at 04:00 AM Europe Time
    scheduler.add_job(scheduled_retrain, 'cron', day_of_week='mon', hour=4, minute=0)
    scheduler.start()

def calculate_implied_prob(odds: float) -> float:
    if not odds or odds <= 1.0:
        return 0.0
    return 1.0 / odds

@app.get("/health")
def health_check():
    return {"status": "ok", "football_loaded": model is not None, "basket_loaded": team_states_basket is not None}

@app.post("/predict_basket")
def predict_basket(req: BasketPredictionRequest) -> Dict[str, Any]:
    pred = ml_pipeline_basket.predict_basket_match(req.home_team, req.away_team, req.odds_home, req.odds_away)
    return {
        "value_bet": {
            "recommended_bet": pred.get("recommended_bet", "Pending..."),
            "model_probability": pred.get("model_probability", 50.0),
            "bookmaker_odds": req.odds_home if pred.get("recommended_bet") == "Home Win" else req.odds_away,
            "edge_percent": pred.get("edge_percent", 0.0),
            "is_value": pred.get("is_value", False),
            "confidence_score": 0.0,
            "recommended_stake_percentage": 0.0
        }
    }

@app.post("/predict_tennis")
def predict_tennis(req: PredictionRequestTennis) -> Dict[str, Any]:
    pred = ml_pipeline_tennis.predict_tennis_match(req.home_team, req.away_team, req.odds_home, req.odds_away)
    return {
        "value_bet": {
            "recommended_bet": pred.get("recommended_bet", "Pending..."),
            "model_probability": pred.get("model_probability", 50.0),
            "bookmaker_odds": req.odds_home if pred.get("recommended_bet") == "Home Win" else req.odds_away,
            "edge_percent": pred.get("edge_percent", 0.0),
            "is_value": pred.get("is_value", False)
        }
    }

@app.post("/predict_esport")
def predict_esport(req: PredictionRequestEsport) -> Dict[str, Any]:
    pred = ml_pipeline_esport.predict_esport_match(req.home_team, req.away_team, req.odds_home, req.odds_away)
    return {
        "value_bet": {
            "recommended_bet": pred.get("recommended_bet", "Pending..."),
            "model_probability": pred.get("model_probability", 50.0),
            "bookmaker_odds": req.odds_home if pred.get("recommended_bet") == "Home Win" else req.odds_away,
            "edge_percent": pred.get("edge_percent", 0.0),
            "is_value": pred.get("is_value", False)
        }
    }

def resolve_team_name(name: str, known_teams: list) -> Optional[str]:
    """Return exact match or best fuzzy match (cutoff 0.72). Returns None if no good match."""
    if name in known_teams:
        return name
    matches = difflib.get_close_matches(name, known_teams, n=1, cutoff=0.72)
    if matches:
        logger.info(f"Fuzzy match: '{name}' → '{matches[0]}'")
        return matches[0]
    return None


def _remove_vig(probs: list) -> list:
    """Normalise raw implied probabilities to sum to 1.0 (remove bookmaker overround)."""
    total = sum(probs)
    if total <= 0:
        return probs
    return [p / total for p in probs]


def _kelly_stake(fair_p: float, odds: float) -> float:
    b = odds - 1.0
    if b <= 0:
        return 0.0
    kf = (fair_p * b - (1.0 - fair_p)) / b
    return round(max(kf * 0.25, 0.0) * 100, 2)


def predict_from_odds_only(req: PredictionRequest) -> Dict[str, Any]:
    """Fallback: pure bookmaker-odds-based prediction when no ML training data exists for these teams.
    Removes vig, computes fair probabilities, picks best outcome per market."""

    label_h = req.home_team
    label_a = req.away_team

    # ── H2H ──────────────────────────────────────────────────────────────────
    h2h_bet, h2h_prob, h2h_odds, h2h_edge = None, 0.0, None, 0.0
    fp_home = fp_draw = fp_away = 0.0
    if req.odds_home and req.odds_away:
        raw = [1/req.odds_home, 1/req.odds_draw if req.odds_draw else 0.0, 1/req.odds_away]
        fp_home, fp_draw, fp_away = _remove_vig(raw)
        candidates = [
            (label_h,  fp_home, req.odds_home),
            ("Draw",   fp_draw, req.odds_draw) if req.odds_draw else ("Draw", 0, None),
            (label_a,  fp_away, req.odds_away),
        ]
        h2h_bet, h2h_prob, h2h_odds = max(candidates, key=lambda x: x[1])
        if h2h_odds:
            h2h_edge = round((h2h_prob - 1/h2h_odds) * 100, 2)

    # ── BTTS ─────────────────────────────────────────────────────────────────
    btts_bet, btts_prob, btts_odds, btts_edge = None, 0.0, None, 0.0
    if req.odds_btts_yes and req.odds_btts_no:
        p_yes, p_no = _remove_vig([1/req.odds_btts_yes, 1/req.odds_btts_no])
        if p_yes >= p_no:
            btts_bet, btts_prob, btts_odds = "BTTS Yes", p_yes, req.odds_btts_yes
        else:
            btts_bet, btts_prob, btts_odds = "BTTS No", p_no, req.odds_btts_no
        btts_edge = round((btts_prob - 1/btts_odds) * 100, 2)

    # ── O/U 2.5 ──────────────────────────────────────────────────────────────
    ou_bet, ou_prob, ou_odds, ou_edge = None, 0.0, None, 0.0
    if req.odds_ou_over and req.odds_ou_under:
        p_ov, p_un = _remove_vig([1/req.odds_ou_over, 1/req.odds_ou_under])
        if p_ov >= p_un:
            ou_bet, ou_prob, ou_odds = "Over 2.5", p_ov, req.odds_ou_over
        else:
            ou_bet, ou_prob, ou_odds = "Under 2.5", p_un, req.odds_ou_under
        ou_edge = round((ou_prob - 1/ou_odds) * 100, 2)

    # ── Corners ───────────────────────────────────────────────────────────────
    cor_bet, cor_prob, cor_odds, cor_edge = None, 0.0, None, 0.0
    if req.odds_corners_over and req.odds_corners_under:
        p_co, p_cu = _remove_vig([1/req.odds_corners_over, 1/req.odds_corners_under])
        if p_co >= p_cu:
            cor_bet, cor_prob, cor_odds = "Over 9.5 Corners", p_co, req.odds_corners_over
        else:
            cor_bet, cor_prob, cor_odds = "Under 9.5 Corners", p_cu, req.odds_corners_under
        cor_edge = round((cor_prob - 1/cor_odds) * 100, 2)

    # ── Double Chance ─────────────────────────────────────────────────────────
    dc_bet, dc_prob, dc_odds, dc_edge = None, 0.0, None, 0.0
    if req.odds_dc_1x and req.odds_dc_x2 and req.odds_dc_12:
        candidates_dc = [
            ("1X", _remove_vig([1/req.odds_dc_1x, 1])[0], req.odds_dc_1x),
            ("X2", _remove_vig([1/req.odds_dc_x2, 1])[0], req.odds_dc_x2),
            ("12", _remove_vig([1/req.odds_dc_12, 1])[0], req.odds_dc_12),
        ]
        dc_bet, dc_prob, dc_odds = max(candidates_dc, key=lambda x: x[1])
        dc_edge = round((dc_prob - 1/dc_odds) * 100, 2)

    # ── Draw No Bet ───────────────────────────────────────────────────────────
    dnb_bet, dnb_prob, dnb_odds, dnb_edge = None, 0.0, None, 0.0
    if req.odds_dnb_home and req.odds_dnb_away:
        p_dh, p_da = _remove_vig([1/req.odds_dnb_home, 1/req.odds_dnb_away])
        if p_dh >= p_da:
            dnb_bet, dnb_prob, dnb_odds = label_h, p_dh, req.odds_dnb_home
        else:
            dnb_bet, dnb_prob, dnb_odds = label_a, p_da, req.odds_dnb_away
        dnb_edge = round((dnb_prob - 1/dnb_odds) * 100, 2)

    confidence = 3.5  # Low — no historical ML data

    return {
        "match": f"{label_h} vs {label_a}",
        "odds_based": True,
        "raw_probabilities": {
            "home": round(fp_home * 100, 2),
            "draw": round(fp_draw * 100, 2),
            "away": round(fp_away * 100, 2),
            "btts_yes": round(btts_prob * 100, 2) if btts_bet == "BTTS Yes" else 0,
            "btts_no": round(btts_prob * 100, 2) if btts_bet == "BTTS No" else 0,
        },
        "ensemble_probabilities": {
            "home": round(fp_home * 100, 2),
            "draw": round(fp_draw * 100, 2),
            "away": round(fp_away * 100, 2),
        },
        "most_likely_outcome": h2h_bet,
        "value_bet": {
            "is_value": h2h_edge > 3.0,
            "recommended_bet": h2h_bet,
            "edge_percent": h2h_edge,
            "model_probability": round(h2h_prob * 100, 2),
            "final_prob_pct": round(h2h_prob * 100, 2),
            "value_pct": h2h_edge,
            "bookmaker_odds": h2h_odds,
            "confidence_score": confidence,
            "recommended_stake_percentage": _kelly_stake(h2h_prob, h2h_odds) if h2h_odds else 0.0,
            "models_agreeing": 0,
            "agreeing_model_names": [],
            "reasoning": f"Odds-only prediction (no ML data for these teams). Fair probability after removing vig.",
            "in_preferred_odds_range": False,
        },
        "btts_value_bet": {
            "is_value": btts_edge > 3.0,
            "recommended_bet": btts_bet,
            "edge_percent": btts_edge,
            "model_probability": round(btts_prob * 100, 2),
            "bookmaker_odds": btts_odds,
            "confidence_score": confidence,
            "recommended_stake_percentage": _kelly_stake(btts_prob, btts_odds) if btts_odds else 0.0,
        },
        "ou_value_bet": {
            "is_value": ou_edge > 3.0,
            "recommended_bet": ou_bet,
            "edge_percent": ou_edge,
            "model_probability": round(ou_prob * 100, 2),
            "bookmaker_odds": ou_odds,
            "confidence_score": confidence,
            "recommended_stake_percentage": _kelly_stake(ou_prob, ou_odds) if ou_odds else 0.0,
        },
        "corners_value_bet": {
            "is_value": cor_edge > 3.0,
            "recommended_bet": cor_bet,
            "edge_percent": cor_edge,
            "model_probability": round(cor_prob * 100, 2),
            "bookmaker_odds": cor_odds,
            "confidence_score": confidence,
            "recommended_stake_percentage": _kelly_stake(cor_prob, cor_odds) if cor_odds else 0.0,
        },
        "dc_value_bet": {
            "is_value": dc_edge > 3.0,
            "recommended_bet": dc_bet,
            "edge_percent": dc_edge,
            "model_probability": round(dc_prob * 100, 2),
            "bookmaker_odds": dc_odds,
            "confidence_score": confidence,
            "recommended_stake_percentage": _kelly_stake(dc_prob, dc_odds) if dc_odds else 0.0,
        },
        "dnb_value_bet": {
            "is_value": dnb_edge > 3.0,
            "recommended_bet": dnb_bet,
            "edge_percent": dnb_edge,
            "model_probability": round(dnb_prob * 100, 2),
            "bookmaker_odds": dnb_odds,
            "confidence_score": confidence,
            "recommended_stake_percentage": _kelly_stake(dnb_prob, dnb_odds) if dnb_odds else 0.0,
        },
    }


@app.post("/predict")
def predict(req: PredictionRequest) -> Dict[str, Any]:
    known = list(team_states.keys()) if team_states else []
    home = resolve_team_name(req.home_team, known) or req.home_team
    away = resolve_team_name(req.away_team, known) or req.away_team

    if home not in team_states or away not in team_states:
        logger.info(f"No ML data for '{req.home_team}'/'{req.away_team}' — using odds-only fallback.")
        return predict_from_odds_only(req)
        
    h_pts, h_gs, h_gc, h_sh, h_sh_c, h_sot, h_sot_c, h_streak, h_games = team_states[home].get_features()
    a_pts, a_gs, a_gc, a_sh, a_sh_c, a_sot, a_sot_c, a_streak, a_games = team_states[away].get_features()
    
    if h_games < 1: h_games = 1
    if a_games < 1: a_games = 1
    
    h_attack = h_gs / h_games
    h_defense = h_gc / h_games
    a_attack = a_gs / a_games
    a_defense = a_gc / a_games
    
    h_shot_attack = h_sh / h_games
    h_shot_defense = h_sh_c / h_games
    a_shot_attack = a_sh / a_games
    a_shot_defense = a_sh_c / a_games
    
    h_sot_attack = h_sot / h_games
    h_sot_defense = h_sot_c / h_games
    a_sot_attack = a_sot / a_games
    a_sot_defense = a_sot_c / a_games
    
    h_elo = team_states[home].elo
    a_elo = team_states[away].elo
    
    feature_row = [
        h_pts, h_gs, h_gc, h_streak,
        a_pts, a_gs, a_gc, a_streak,
        h_pts - a_pts,  # Points diff
        (h_gs - h_gc) - (a_gs - a_gc), # GD diff
        h_attack, h_defense,
        a_attack, a_defense,
        h_attack - a_defense, # Home pressure
        a_attack - h_defense, # Away pressure
        h_shot_attack, h_shot_defense,
        a_shot_attack, a_shot_defense,
        h_sot_attack, h_sot_defense,
        a_sot_attack, a_sot_defense,
        h_sot_attack - a_sot_defense,
        a_sot_attack - h_sot_defense,
        h_elo,          # ELO Rating
        a_elo,          # ELO Rating
        h_elo - a_elo   # ELO Difference Power
    ]
    
    import math
    def poisson(lam, k):
        return math.exp(-lam) * (lam ** k) / math.factorial(k)
        
    poisson_btts_yes = 0.0
    poisson_ou_over = 0.0
    
    # Generowanie matematycznej siatki Poissona (max 7 goli)
    for h in range(7):
        for a in range(7):
            p = poisson(h_attack, h) * poisson(a_attack, a)
            if h > 0 and a > 0:
                poisson_btts_yes += p
            if h + a > 2.5:
                poisson_ou_over += p

    poisson_btts_no = 1.0 - poisson_btts_yes
    poisson_ou_under = 1.0 - poisson_ou_over
    
    # Model predictions
    # 0 = Home, 1 = Draw, 2 = Away
    X = np.array([feature_row])
    probs = model.predict_proba(X)[0]
    
    p_home = float(probs[0])
    p_draw = float(probs[1])
    p_away = float(probs[2])
    
    # BTTS predictions
    probs_btts = model_btts.predict_proba(X)[0]
    p_btts_no = float(probs_btts[0])
    p_btts_yes = float(probs_btts[1])
    
    # Over/Under predictions
    probs_ou = model_ou.predict_proba(X)[0]
    p_ou_under = float(probs_ou[0])
    p_ou_over = float(probs_ou[1])
    
    # Corners predictions
    probs_cor = model_corners.predict_proba(X)[0]
    p_cor_under = float(probs_cor[0])
    p_cor_over = float(probs_cor[1])
    
    # Prediction class
    best_idx = np.argmax(probs)
    class_map = {0: home, 1: "Draw", 2: away}
    prediction_label = class_map[best_idx]
    
    # -------------------------------------------------------------------
    # ENSEMBLE: Extract individual sub-model probabilities from VotingClassifier
    # -------------------------------------------------------------------
    try:
        xgb_probs_h2h = model.estimators_[0].predict_proba(X)[0].tolist()
    except Exception:
        xgb_probs_h2h = [p_home, p_draw, p_away]
    try:
        rf_probs_h2h = model.estimators_[1].predict_proba(X)[0].tolist()
    except Exception:
        rf_probs_h2h = [p_home, p_draw, p_away]
    try:
        lr_probs_h2h = model.estimators_[2].predict_proba(X)[0].tolist()
    except Exception:
        lr_probs_h2h = [p_home, p_draw, p_away]

    # -------------------------------------------------------------------
    # L-SYSTEM: Compute probability from 24-game TeamState history
    # -------------------------------------------------------------------
    h_win_rate, h_draw_rate, h_gd_pg, h_avg_opp_elo, h_l_games = team_states[home].get_l_system_features()
    a_win_rate, a_draw_rate, a_gd_pg, a_avg_opp_elo, a_l_games = team_states[away].get_l_system_features()

    lsys_probs_h2h = ensemble_logic.compute_l_system_prob(
        h_elo=h_elo,
        a_elo=a_elo,
        h_win_rate=h_win_rate,
        a_win_rate=a_win_rate,
        h_draw_rate=h_draw_rate,
        a_draw_rate=a_draw_rate,
        h_gd_per_game=h_gd_pg,
        a_gd_per_game=a_gd_pg,
    )

    # Weighted ensemble: final_prob = 0.4*XGB + 0.2*RF + 0.2*LR + 0.2*L_SYSTEM
    match_label = f"{home} vs {away}"
    final_probs_h2h = ensemble_logic.compute_weighted_ensemble(
        xgb_probs_h2h, rf_probs_h2h, lr_probs_h2h, lsys_probs_h2h
    )
    ensemble_logic.log_model_outputs(
        match_label, xgb_probs_h2h, rf_probs_h2h, lr_probs_h2h, lsys_probs_h2h, final_probs_h2h
    )

    fp_home = float(final_probs_h2h[0])
    fp_draw = float(final_probs_h2h[1])
    fp_away = float(final_probs_h2h[2])

    # -------------------------------------------------------------------
    # H2H VALUE BET — Safety Filters + Consensus Check
    # -------------------------------------------------------------------
    value_bet = False
    best_bet = None
    highest_edge = -100.0
    model_prob_for_bet = 0.0
    bookie_odds = 0.0
    models_agreeing_count = 0
    agreeing_names: List[str] = []
    h2h_reasoning = ""
    h2h_final_prob = 0.0
    h2h_value_pct = 0.0

    if req.odds_home and req.odds_draw and req.odds_away:
        # Each candidate: (label, final_ensemble_prob, odds, class_index)
        outcomes_h2h = [
            (home,   fp_home, req.odds_home,  0),
            ("Draw", fp_draw, req.odds_draw,  1),
            (away,   fp_away, req.odds_away,  2),
        ]

        for outcome_label, final_prob, odds_val, outcome_idx in outcomes_h2h:
            # FILTER 1: Reject odds > 10
            if odds_val > ensemble_logic.MAX_ODDS:
                ensemble_logic.log_rejected(match_label, outcome_label, odds_val, final_prob,
                                            final_prob - 1.0/odds_val,
                                            f"Odds {odds_val} > MAX {ensemble_logic.MAX_ODDS}")
                continue
            # FILTER 2: Require final_prob > 0.65
            if final_prob < ensemble_logic.MIN_FINAL_PROB:
                ensemble_logic.log_rejected(match_label, outcome_label, odds_val, final_prob,
                                            final_prob - 1.0/odds_val,
                                            f"final_prob {final_prob:.1%} < 65%")
                continue
            # FILTER 3: Require value > 0.05
            value_candidate = final_prob - (1.0 / odds_val)
            if value_candidate <= ensemble_logic.MIN_VALUE:
                ensemble_logic.log_rejected(match_label, outcome_label, odds_val, final_prob,
                                            value_candidate,
                                            f"value {value_candidate:.1%} <= 5%")
                continue
            # FILTER 4: Require at least 2 models agreeing
            cnt, names = ensemble_logic.count_models_agreeing(
                outcome_idx, xgb_probs_h2h, rf_probs_h2h, lr_probs_h2h, lsys_probs_h2h
            )
            if cnt < ensemble_logic.MIN_MODELS_AGREE:
                ensemble_logic.log_rejected(match_label, outcome_label, odds_val, final_prob,
                                            value_candidate,
                                            f"only {cnt} model(s) agree — need {ensemble_logic.MIN_MODELS_AGREE}")
                continue
            # All filters passed — take best value candidate
            if value_candidate > highest_edge:
                highest_edge = value_candidate
                best_bet = outcome_label
                model_prob_for_bet = final_prob
                bookie_odds = odds_val
                models_agreeing_count = cnt
                agreeing_names = names
                h2h_final_prob = final_prob
                h2h_value_pct = value_candidate

        if best_bet is not None:
            value_bet = True
            h2h_reasoning = ensemble_logic.build_reasoning(
                h_elo, a_elo, h_win_rate, a_win_rate,
                bookie_odds, agreeing_names, h2h_final_prob, h2h_value_pct
            )
            ensemble_logic.log_decision(
                match_label, best_bet, bookie_odds, h2h_final_prob,
                h2h_value_pct, models_agreeing_count, h2h_reasoning
            )

    recommended_stake = 0.0
    if value_bet and best_bet:
        # fractional Kelly formula (25% Kelly for risk management)
        # f* = (p * b - q) / b
        # where p = win probability, q = lose probability (1-p), b = decimal odds - 1
        b = bookie_odds - 1.0
        p = model_prob_for_bet
        q = 1.0 - p
        if b > 0:
            kelly_fraction = (p * b - q) / b
            if kelly_fraction > 0:
                recommended_stake = round((kelly_fraction * 0.25) * 100, 2)

    btts_value_bet = False
    btts_best_bet = None
    btts_highest_edge = -100.0
    btts_model_prob = 0.0
    btts_bookie_odds = 0.0
    
    if req.odds_btts_yes and req.odds_btts_no:
        i_yes = calculate_implied_prob(req.odds_btts_yes)
        i_no = calculate_implied_prob(req.odds_btts_no)
        
        edges_btts = {
            "Select YES": (p_btts_yes - i_yes, p_btts_yes, req.odds_btts_yes),
            "Select NO": (p_btts_no - i_no, p_btts_no, req.odds_btts_no)
        }
        
        for k, (edge, m_prob, _odds) in edges_btts.items():
            if edge > btts_highest_edge:
                btts_highest_edge = edge
                btts_best_bet = k
                btts_model_prob = m_prob
                btts_bookie_odds = _odds
                
        if btts_highest_edge > 0.05:
            poisson_prob_for_bet = poisson_btts_yes if btts_best_bet == "Select YES" else poisson_btts_no
            poisson_edge = poisson_prob_for_bet - (1.0 / btts_bookie_odds)
            if poisson_edge > 0.03:
                btts_value_bet = True

    btts_recommended_stake = 0.0
    if btts_value_bet and btts_best_bet:
        b = btts_bookie_odds - 1.0
        p = btts_model_prob
        q = 1.0 - p
        if b > 0:
            kelly_fraction = (p * b - q) / b
            if kelly_fraction > 0:
                btts_recommended_stake = round((kelly_fraction * 0.25) * 100, 2)
                
    # Over/Under value bet logic
    ou_value_bet = False
    ou_best_bet = None
    ou_highest_edge = -100.0
    ou_model_prob = 0.0
    ou_bookie_odds = 0.0
    
    if req.odds_ou_over and req.odds_ou_under:
        i_over = calculate_implied_prob(req.odds_ou_over)
        i_under = calculate_implied_prob(req.odds_ou_under)
        
        edges_ou = {
            "Over 2.5 Goals": (p_ou_over - i_over, p_ou_over, req.odds_ou_over),
            "Under 2.5 Goals": (p_ou_under - i_under, p_ou_under, req.odds_ou_under)
        }
        
        for k, (edge, m_prob, _odds) in edges_ou.items():
            if edge > ou_highest_edge:
                ou_highest_edge = edge
                ou_best_bet = k
                ou_model_prob = m_prob
                ou_bookie_odds = _odds
                
        if ou_highest_edge > 0.05:
            poisson_prob_for_bet = poisson_ou_over if ou_best_bet == "Over 2.5 Goals" else poisson_ou_under
            poisson_edge = poisson_prob_for_bet - (1.0 / ou_bookie_odds)
            if poisson_edge > 0.03:
                ou_value_bet = True

    ou_recommended_stake = 0.0
    if ou_value_bet and ou_best_bet:
        b = ou_bookie_odds - 1.0
        p = ou_model_prob
        if b > 0:
            kf = (p * b - (1.0 - p)) / b
            if kf > 0:
                ou_recommended_stake = round((kf * 0.25) * 100, 2)

    # Corners value bet logic
    cor_value_bet = False
    cor_best_bet = None
    cor_highest_edge = -100.0
    cor_model_prob = 0.0
    cor_bookie_odds = 0.0
    
    if req.odds_corners_over and req.odds_corners_under:
        i_over_cor = calculate_implied_prob(req.odds_corners_over)
        i_under_cor = calculate_implied_prob(req.odds_corners_under)
        
        edges_cor = {
            "Over 9.5 Corners": (p_cor_over - i_over_cor, p_cor_over, req.odds_corners_over),
            "Under 9.5 Corners": (p_cor_under - i_under_cor, p_cor_under, req.odds_corners_under)
        }
        
        for k, (edge, m_prob, _odds) in edges_cor.items():
            if edge > cor_highest_edge:
                cor_highest_edge = edge
                cor_best_bet = k
                cor_model_prob = m_prob
                cor_bookie_odds = _odds
                
        if cor_highest_edge > 0.05:
            cor_value_bet = True

    cor_recommended_stake = 0.0
    if cor_value_bet and cor_best_bet:
        b = cor_bookie_odds - 1.0
        p = cor_model_prob
        if b > 0:
            kf = (p * b - (1.0 - p)) / b
            if kf > 0:
                cor_recommended_stake = round((kf * 0.25) * 100, 2)

    dc_value_bet = False
    dc_best_bet = None
    dc_highest_edge = -100.0
    dc_model_prob = 0.0
    dc_bookie_odds = 0.0
    
    if req.odds_dc_1x and req.odds_dc_x2 and req.odds_dc_12:
        i_1x = calculate_implied_prob(req.odds_dc_1x)
        i_x2 = calculate_implied_prob(req.odds_dc_x2)
        i_12 = calculate_implied_prob(req.odds_dc_12)
        
        reference_label = best_bet if best_bet else prediction_label
        edges_dc = {}
        if reference_label == home or reference_label == "Draw":
            edges_dc["1X"] = ((p_home + p_draw) - i_1x, p_home + p_draw, req.odds_dc_1x)
        if reference_label == away or reference_label == "Draw":
            edges_dc["X2"] = ((p_away + p_draw) - i_x2, p_away + p_draw, req.odds_dc_x2)
        if reference_label == home or reference_label == away:
            edges_dc["12"] = ((p_home + p_away) - i_12, p_home + p_away, req.odds_dc_12)
        
        for k, (edge, m_prob, _odds) in edges_dc.items():
            if edge > dc_highest_edge:
                dc_highest_edge = edge
                dc_best_bet = k
                dc_model_prob = m_prob
                dc_bookie_odds = _odds
                
        if dc_highest_edge > 0.05:
            dc_value_bet = True

    dc_recommended_stake = 0.0
    if dc_value_bet and dc_best_bet:
        b = dc_bookie_odds - 1.0
        p = dc_model_prob
        if b > 0:
            kf = (p * b - (1.0 - p)) / b
            if kf > 0:
                dc_recommended_stake = round((kf * 0.25) * 100, 2)

    dnb_value_bet = False
    dnb_best_bet = None
    dnb_highest_edge = -100.0
    dnb_model_prob = 0.0
    dnb_bookie_odds = 0.0
    
    if req.odds_dnb_home and req.odds_dnb_away and p_draw < 1.0:
        p_dnb_home = p_home / (1.0 - p_draw)
        p_dnb_away = p_away / (1.0 - p_draw)
        
        i_dnb_home = calculate_implied_prob(req.odds_dnb_home)
        i_dnb_away = calculate_implied_prob(req.odds_dnb_away)
        
        reference_label = best_bet if best_bet else prediction_label
        edges_dnb = {}
        if reference_label == home:
            edges_dnb[home] = (p_dnb_home - i_dnb_home, p_dnb_home, req.odds_dnb_home)
        elif reference_label == away:
            edges_dnb[away] = (p_dnb_away - i_dnb_away, p_dnb_away, req.odds_dnb_away)
        
        for k, (edge, m_prob, _odds) in edges_dnb.items():
            if edge > dnb_highest_edge:
                dnb_highest_edge = edge
                dnb_best_bet = k
                dnb_model_prob = m_prob
                dnb_bookie_odds = _odds
                
        if dnb_highest_edge > 0.05:
            dnb_value_bet = True

    dnb_recommended_stake = 0.0
    if dnb_value_bet and dnb_best_bet:
        b = dnb_bookie_odds - 1.0
        p = dnb_model_prob
        if b > 0:
            kf = (p * b - (1.0 - p)) / b
            if kf > 0:
                dnb_recommended_stake = round((kf * 0.25) * 100, 2)

    confidence_score = float(max(fp_home, fp_draw, fp_away) * 10) # 0 to 10 (uses ensemble)
    in_preferred_range = (
        ensemble_logic.PREFERRED_ODDS_LOW <= bookie_odds <= ensemble_logic.PREFERRED_ODDS_HIGH
    ) if bookie_odds else False

    return {
        "match": f"{home} vs {away}",
        "raw_probabilities": {
            "home": round(p_home * 100, 2),
            "draw": round(p_draw * 100, 2),
            "away": round(p_away * 100, 2),
            "btts_yes": round(p_btts_yes * 100, 2),
            "btts_no": round(p_btts_no * 100, 2)
        },
        "ensemble_probabilities": {
            "home": round(fp_home * 100, 2),
            "draw": round(fp_draw * 100, 2),
            "away": round(fp_away * 100, 2),
        },
        "most_likely_outcome": prediction_label,
        "value_bet": {
            "is_value": value_bet,
            "recommended_bet": best_bet,
            "edge_percent": round(h2h_value_pct * 100, 2),
            "model_probability": round(model_prob_for_bet * 100, 2),
            "final_prob_pct": round(h2h_final_prob * 100, 2),
            "value_pct": round(h2h_value_pct * 100, 2),
            "bookmaker_odds": bookie_odds,
            "confidence_score": round(confidence_score, 1),
            "recommended_stake_percentage": recommended_stake,
            "models_agreeing": models_agreeing_count,
            "agreeing_model_names": agreeing_names,
            "reasoning": h2h_reasoning,
            "in_preferred_odds_range": in_preferred_range,
        },
        "btts_value_bet": {
            "is_value": btts_value_bet,
            "recommended_bet": btts_best_bet,
            "edge_percent": round(btts_highest_edge * 100, 2),
            "model_probability": round(btts_model_prob * 100, 2),
            "bookmaker_odds": btts_bookie_odds,
            "confidence_score": round(confidence_score, 1),
            "recommended_stake_percentage": btts_recommended_stake
        },
        "ou_value_bet": {
            "is_value": ou_value_bet,
            "recommended_bet": ou_best_bet,
            "edge_percent": round(ou_highest_edge * 100, 2),
            "model_probability": round(ou_model_prob * 100, 2),
            "bookmaker_odds": ou_bookie_odds,
            "confidence_score": round(confidence_score, 1),
            "recommended_stake_percentage": ou_recommended_stake
        },
        "corners_value_bet": {
            "is_value": cor_value_bet,
            "recommended_bet": cor_best_bet,
            "edge_percent": round(cor_highest_edge * 100, 2),
            "model_probability": round(cor_model_prob * 100, 2),
            "bookmaker_odds": cor_bookie_odds,
            "confidence_score": round(confidence_score, 1),
            "recommended_stake_percentage": cor_recommended_stake
        },
        "dc_value_bet": {
            "is_value": dc_value_bet,
            "recommended_bet": dc_best_bet,
            "edge_percent": round(dc_highest_edge * 100, 2),
            "model_probability": round(dc_model_prob * 100, 2),
            "bookmaker_odds": dc_bookie_odds,
            "confidence_score": round(confidence_score, 1),
            "recommended_stake_percentage": dc_recommended_stake
        },
        "dnb_value_bet": {
            "is_value": dnb_value_bet,
            "recommended_bet": dnb_best_bet,
            "edge_percent": round(dnb_highest_edge * 100, 2),
            "model_probability": round(dnb_model_prob * 100, 2),
            "bookmaker_odds": dnb_bookie_odds,
            "confidence_score": round(confidence_score, 1),
            "recommended_stake_percentage": dnb_recommended_stake
        }
    }

if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=False)
