from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from typing import Optional, Dict, Any
import joblib
import os
import uvicorn
import ml_pipeline
import ml_pipeline_basket
import ml_pipeline_tennis
import ml_pipeline_esport
import logging
import pandas as pd
import numpy as np
import threading
from apscheduler.schedulers.background import BackgroundScheduler

app = FastAPI(title="AI Betting Predictor", description="Machine Learning API for multi-sport betting prediction.")
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
    try:
        if os.path.exists(MODEL_PATH):
            model = joblib.load(MODEL_PATH)
        if os.path.exists('model_btts.joblib'):
            model_btts = joblib.load('model_btts.joblib')
        if os.path.exists('model_ou.joblib'):
            model_ou = joblib.load('model_ou.joblib')
        if os.path.exists('model_corners.joblib'):
            model_corners = joblib.load('model_corners.joblib')
        if os.path.exists(STATE_PATH):
            team_states = joblib.load(STATE_PATH)
        logger.info("Football models loaded successfully.")
    except Exception as e:
        logger.warning(f"Cannot load Football Model. Err: {e}")

    try:
        if os.path.exists(ml_pipeline_basket.BASKET_STATE_FILE):
            team_states_basket = joblib.load(ml_pipeline_basket.BASKET_STATE_FILE)
            logger.info("Basket model loaded successfully.")
    except Exception as e:
        logger.warning(f"Cannot load Basket Model. Err: {e}")

    try:
        import pickle
        if os.path.exists(ml_pipeline_tennis.TENNIS_MODEL_FILE):
            with open(ml_pipeline_tennis.TENNIS_MODEL_FILE, 'rb') as f:
                ml_pipeline_tennis.tennis_model = pickle.load(f)
            logger.info("Tennis model loaded successfully.")
    except Exception as e:
        logger.warning(f"Cannot load Tennis Model. Err: {e}")

    try:
        import pickle
        if os.path.exists(ml_pipeline_esport.ESPORT_MODEL_FILE):
            with open(ml_pipeline_esport.ESPORT_MODEL_FILE, 'rb') as f:
                ml_pipeline_esport.esport_model = pickle.load(f)
            logger.info("Esport model loaded successfully.")
    except Exception as e:
        logger.warning(f"Cannot load Esport Model. Err: {e}")

def scheduled_retrain():
    logger.info("Starting Auto-Retraining Pipeline...")
    try:
        ml_pipeline.train_model()
        load_ai()
        logger.info("Auto-Retraining Pipeline completed.")
    except Exception as e:
        logger.error(f"Failed to auto-train: {e}")

@app.on_event("startup")
async def startup_event():
    load_ai()
    scheduler.add_job(scheduled_retrain, 'cron', day_of_week='mon', hour=4, minute=0)
    scheduler.start()

def calculate_implied_prob(odds: float) -> float:
    if not odds or odds <= 1.0:
        return 0.0
    return 1.0 / float(odds)

@app.get("/health")
def health_check():
    return {"status": "ok", "football_loaded": model is not None, "basket_loaded": team_states_basket is not None}

@app.post("/predict_basket")
def predict_basket(req: BasketPredictionRequest) -> Dict[str, Any]:
    pred = ml_pipeline_basket.predict_basket_match(req.home_team, req.away_team, req.odds_home, req.odds_away)
    return {
        "value_bet": {
            "recommended_bet": str(pred.get("recommended_bet", "Pending...")),
            "model_probability": float(pred.get("model_probability", 50.0)),
            "bookmaker_odds": float(req.odds_home if pred.get("recommended_bet") == "Home Win" else (req.odds_away if req.odds_away else 2.0)),
            "edge_percent": float(pred.get("edge_percent", 0.0)),
            "is_value": bool(pred.get("is_value", False)),
            "confidence_score": 0.0,
            "recommended_stake_percentage": 0.0
        }
    }

@app.post("/predict_tennis")
def predict_tennis(req: PredictionRequestTennis) -> Dict[str, Any]:
    pred = ml_pipeline_tennis.predict_tennis_match(req.home_team, req.away_team, req.odds_home, req.odds_away)
    return {
        "value_bet": {
            "recommended_bet": str(pred.get("recommended_bet", "Pending...")),
            "model_probability": float(pred.get("model_probability", 50.0)),
            "bookmaker_odds": float(req.odds_home if pred.get("recommended_bet") == "Home Win" else (req.odds_away if req.odds_away else 2.0)),
            "edge_percent": float(pred.get("edge_percent", 0.0)),
            "is_value": bool(pred.get("is_value", False))
        }
    }

@app.post("/predict_esport")
def predict_esport(req: PredictionRequestEsport) -> Dict[str, Any]:
    pred = ml_pipeline_esport.predict_esport_match(req.home_team, req.away_team, req.odds_home, req.odds_away)
    return {
        "value_bet": {
            "recommended_bet": str(pred.get("recommended_bet", "Pending...")),
            "model_probability": float(pred.get("model_probability", 50.0)),
            "bookmaker_odds": float(req.odds_home if pred.get("recommended_bet") == "Home Win" else (req.odds_away if req.odds_away else 2.0)),
            "edge_percent": float(pred.get("edge_percent", 0.0)),
            "is_value": bool(pred.get("is_value", False))
        }
    }

def find_best_team_match(target: str, choices: Dict[str, Any]) -> Optional[str]:
    if not target or not choices: return None
    target_clean = target.lower().strip()
    for name in choices.keys():
        if name.lower().strip() == target_clean:
            return name
    for name in choices.keys():
        n_clean = name.lower().strip()
        if target_clean in n_clean or n_clean in target_clean:
            return name
    return None

@app.post("/predict")
def predict(req: PredictionRequest) -> Dict[str, Any]:
    global team_states
    home_raw = req.home_team
    away_raw = req.away_team
    
    if team_states is None:
        try:
            team_states = joblib.load(STATE_PATH)
        except:
            team_states = {}
            
    home = find_best_team_match(home_raw, team_states)
    away = find_best_team_match(away_raw, team_states)
    
    # Feature collection
    if not home or not away or home not in team_states or away not in team_states:
        h_pts, h_gs, h_gc, h_sh, h_sh_c, h_sot, h_sot_c, h_streak, h_games = 1.5, 13.0, 13.0, 100.0, 100.0, 40.0, 40.0, 0, 10
        a_pts, a_gs, a_gc, a_sh, a_sh_c, a_sot, a_sot_c, a_streak, a_games = 1.5, 13.0, 13.0, 100.0, 100.0, 40.0, 40.0, 0, 10
        h_elo, a_elo = 1500.0, 1500.0
    else:
        h_pts, h_gs, h_gc, h_sh, h_sh_c, h_sot, h_sot_c, h_streak, h_games = team_states[home].get_features()
        a_pts, a_gs, a_gc, a_sh, a_sh_c, a_sot, a_sot_c, a_streak, a_games = team_states[away].get_features()
        h_elo = team_states[home].elo
        a_elo = team_states[away].elo

    h_g = max(1, h_games)
    a_g = max(1, a_games)
    
    h_attack = h_gs / h_g
    h_defense = h_gc / h_g
    a_attack = a_gs / a_g
    a_defense = a_gc / a_g
    
    h_shot_attack = h_sh / h_g
    h_shot_defense = h_sh_c / h_g
    a_shot_attack = a_sh / a_g
    a_shot_defense = a_sh_c / a_g
    
    h_sot_attack = h_sot / h_g
    h_sot_defense = h_sot_c / h_g
    a_sot_attack = a_sot / a_g
    a_sot_defense = a_sot_c / a_g
    
    feature_row = [
        float(h_pts), float(h_gs), float(h_gc), float(h_streak),
        float(a_pts), float(a_gs), float(a_gc), float(a_streak),
        float(h_pts - a_pts),
        float((h_gs - h_gc) - (a_gs - a_gc)),
        float(h_attack), float(h_defense),
        float(a_attack), float(a_defense),
        float(h_attack - a_defense), float(a_attack - h_defense),
        float(h_shot_attack), float(h_shot_defense),
        float(a_shot_attack), float(a_shot_defense),
        float(h_sot_attack), float(h_sot_defense),
        float(a_sot_attack), float(a_sot_defense),
        float(h_sot_attack - a_sot_defense),
        float(a_sot_attack - h_sot_defense),
        float(h_elo), float(a_elo), float(h_elo - a_elo)
    ]
    
    import math
    def poisson_pdf(lam, k):
        if lam <= 0: return 1.0 if k == 0 else 0.0
        return math.exp(-lam) * (lam ** k) / math.factorial(k)
        
    poisson_btts_yes = 0.0
    poisson_ou_over = 0.0
    for h_goals in range(7):
        for a_goals in range(7):
            p = poisson_pdf(h_attack, h_goals) * poisson_pdf(a_attack, a_goals)
            if h_goals > 0 and a_goals > 0: poisson_btts_yes += p
            if h_goals + a_goals > 2.5: poisson_ou_over += p

    poisson_btts_no = 1.0 - poisson_btts_yes
    poisson_ou_under = 1.0 - poisson_ou_over
    
    if model is None:
        p_home = calculate_implied_prob(req.odds_home) if req.odds_home else 0.33
        p_draw = calculate_implied_prob(req.odds_draw) if req.odds_draw else 0.33
        p_away = calculate_implied_prob(req.odds_away) if req.odds_away else 0.33
        p_btts_yes = calculate_implied_prob(req.odds_btts_yes) if req.odds_btts_yes else poisson_btts_yes
        p_btts_no = 1.0 - p_btts_yes
        p_ou_over = calculate_implied_prob(req.odds_ou_over) if req.odds_ou_over else poisson_ou_over
        p_ou_under = 1.0 - p_ou_over
        p_cor_over = calculate_implied_prob(req.odds_corners_over) if req.odds_corners_over else 0.5
        p_cor_under = 1.0 - p_cor_over
    else:
        X = np.array([feature_row])
        probs = model.predict_proba(X)[0]
        p_home, p_draw, p_away = float(probs[0]), float(probs[1]), float(probs[2])
        
        if model_btts:
            probs_btts = model_btts.predict_proba(X)[0]
            p_btts_no, p_btts_yes = float(probs_btts[0]), float(probs_btts[1])
        else:
            p_btts_yes, p_btts_no = float(poisson_btts_yes), float(poisson_btts_no)
            
        if model_ou:
            probs_ou = model_ou.predict_proba(X)[0]
            p_ou_under, p_ou_over = float(probs_ou[0]), float(probs_ou[1])
        else:
            p_ou_over, p_ou_under = float(poisson_ou_over), float(poisson_ou_under)
            
        if model_corners:
            probs_cor = model_corners.predict_proba(X)[0]
            p_cor_under, p_cor_over = float(probs_cor[0]), float(probs_cor[1])
        else:
            p_cor_over, p_cor_under = 0.5, 0.5

    best_idx = int(np.argmax([p_home, p_draw, p_away]))
    prediction_label = {0: home if home else home_raw, 1: "Draw", 2: away if away else away_raw}[best_idx]
    
    # Value detection
    def get_value(m_p, o_book):
        if not o_book or o_book <= 1.0: return 0.0, False
        implied = 1.0 / float(o_book)
        edge = float(m_p) - implied
        return edge, edge > 0.05

    highest_edge = -100.0
    best_bet = None
    model_prob_for_bet = 0.0
    bookie_odds = 0.0
    value_bet = False

    if req.odds_home and req.odds_draw and req.odds_away:
        for k, p_val, odds_val in [(home if home else home_raw, p_home, req.odds_home), ("Draw", p_draw, req.odds_draw), (away if away else away_raw, p_away, req.odds_away)]:
            e, v = get_value(p_val, odds_val)
            if e > highest_edge:
                highest_edge, best_bet, model_prob_for_bet, bookie_odds, value_bet = e, k, p_val, odds_val, v

    # Helper for Stakes
    def safe_kelly(p_win, o_book):
        if not o_book or o_book <= 1.0 or not p_win: return 0.0
        b = float(o_book) - 1.0
        q = 1.0 - float(p_win)
        kf = (float(p_win) * b - q) / b
        return float(round(max(0, kf * 0.25) * 100, 2))

    # BTTS
    btts_edge_y, btts_val_y = get_value(p_btts_yes, req.odds_btts_yes)
    btts_edge_n, btts_val_n = get_value(p_btts_no, req.odds_btts_no)
    btts_best_bet = "Select YES" if btts_edge_y > btts_edge_n else "Select NO"
    btts_highest_edge = max(btts_edge_y, btts_edge_n)
    btts_value_bet = (btts_val_y or btts_val_n) and (poisson_btts_yes > 0.3 if btts_best_bet=="Select YES" else True)
    btts_bookie_odds = req.odds_btts_yes if btts_best_bet=="Select YES" else req.odds_btts_no
    btts_model_prob = p_btts_yes if btts_best_bet=="Select YES" else p_btts_no

    # OU
    ou_edge_o, ou_val_o = get_value(p_ou_over, req.odds_ou_over)
    ou_edge_u, ou_val_u = get_value(p_ou_under, req.odds_ou_under)
    ou_best_bet = "Over 2.5 Goals" if ou_edge_o > ou_edge_u else "Under 2.5 Goals"
    ou_highest_edge = max(ou_edge_o, ou_edge_u)
    ou_value_bet = (ou_val_o or ou_val_u)
    ou_bookie_odds = req.odds_ou_over if ou_best_bet=="Over 2.5 Goals" else req.odds_ou_under
    ou_model_prob = p_ou_over if ou_best_bet=="Over 2.5 Goals" else p_ou_under

    # Corners
    cor_edge_o, cor_val_o = get_value(p_cor_over, req.odds_corners_over)
    cor_edge_u, cor_val_u = get_value(p_cor_under, req.odds_corners_under)
    cor_best_bet = "Over 9.5 Corners" if cor_edge_o > cor_edge_u else "Under 9.5 Corners"
    cor_highest_edge = max(cor_edge_o, cor_edge_u)
    cor_value_bet = (cor_val_o or cor_val_u)
    cor_bookie_odds = req.odds_corners_over if cor_best_bet=="Over 9.5 Corners" else req.odds_corners_under
    cor_model_prob = p_cor_over if cor_best_bet=="Over 9.5 Corners" else p_cor_under

    # Double Chance
    dc_best_bet, dc_highest_edge, dc_value_bet, dc_bookie_odds, dc_model_prob = None, -100.0, False, 0.0, 0.0
    if req.odds_dc_1x and req.odds_dc_x2 and req.odds_dc_12:
        for k, p_v, o_v in [("1X", p_home+p_draw, req.odds_dc_1x), ("X2", p_away+p_draw, req.odds_dc_x2), ("12", p_home+p_away, req.odds_dc_12)]:
            e, v = get_value(p_v, o_v)
            if e > dc_highest_edge: dc_highest_edge, dc_best_bet, dc_value_bet, dc_bookie_odds, dc_model_prob = e, k, v, o_v, p_v

    # DNB
    dnb_best_bet, dnb_highest_edge, dnb_value_bet, dnb_bookie_odds, dnb_model_prob = None, -100.0, False, 0.0, 0.0
    if req.odds_dnb_home and req.odds_dnb_away and p_draw < 1.0:
        p_dnb_h, p_dnb_a = p_home/(1-p_draw), p_away/(1-p_draw)
        for k, p_v, o_v in [(home if home else home_raw, p_dnb_h, req.odds_dnb_home), (away if away else away_raw, p_dnb_a, req.odds_dnb_away)]:
            e, v = get_value(p_v, o_v)
            if e > dnb_highest_edge: dnb_highest_edge, dnb_best_bet, dnb_value_bet, dnb_bookie_odds, dnb_model_prob = e, k, v, o_v, p_v

    confidence_score = float(round(float(max(p_home, p_draw, p_away) * 10), 1))
    
    return {
        "match": f"{home_raw} vs {away_raw}",
        "raw_probabilities": {
            "home": round(p_home * 100, 2), "draw": round(p_draw * 100, 2), "away": round(p_away * 100, 2),
            "btts_yes": round(p_btts_yes * 100, 2), "btts_no": round(p_btts_no * 100, 2)
        },
        "most_likely_outcome": str(prediction_label),
        "value_bet": {
            "is_value": bool(value_bet), "recommended_bet": str(best_bet) if best_bet else None,
            "edge_percent": round(highest_edge * 100, 2) if highest_edge > -90.0 else 0.0, "model_probability": round(model_prob_for_bet * 100, 2),
            "bookmaker_odds": float(bookie_odds or 0.0), "confidence_score": confidence_score,
            "recommended_stake_percentage": safe_kelly(model_prob_for_bet, bookie_odds)
        },
        "btts_value_bet": {
            "is_value": bool(btts_value_bet), "recommended_bet": str(btts_best_bet) if btts_best_bet else None,
            "edge_percent": round(btts_highest_edge * 100, 2) if btts_highest_edge > -90.0 else 0.0, "model_probability": round(btts_model_prob * 100, 2),
            "bookmaker_odds": float(btts_bookie_odds or 0.0), "confidence_score": confidence_score,
            "recommended_stake_percentage": safe_kelly(btts_model_prob, btts_bookie_odds)
        },
        "ou_value_bet": {
            "is_value": bool(ou_value_bet), "recommended_bet": str(ou_best_bet) if ou_best_bet else None,
            "edge_percent": round(ou_highest_edge * 100, 2) if ou_highest_edge > -90.0 else 0.0, "model_probability": round(ou_model_prob * 100, 2),
            "bookmaker_odds": float(ou_bookie_odds or 0.0), "confidence_score": confidence_score,
            "recommended_stake_percentage": safe_kelly(ou_model_prob, ou_bookie_odds)
        },
        "corners_value_bet": {
            "is_value": bool(cor_value_bet), "recommended_bet": str(cor_best_bet) if cor_best_bet else None,
            "edge_percent": round(cor_highest_edge * 100, 2) if cor_highest_edge > -90.0 else 0.0, "model_probability": round(cor_model_prob * 100, 2),
            "bookmaker_odds": float(cor_bookie_odds or 0.0), "confidence_score": confidence_score,
            "recommended_stake_percentage": safe_kelly(cor_model_prob, cor_bookie_odds)
        },
        "dc_value_bet": {
            "is_value": bool(dc_value_bet), "recommended_bet": str(dc_best_bet) if dc_best_bet else None,
            "edge_percent": round(dc_highest_edge * 100, 2) if dc_highest_edge > -90.0 else 0.0, "model_probability": round(dc_model_prob * 100, 2),
            "bookmaker_odds": float(dc_bookie_odds or 0.0), "confidence_score": confidence_score,
            "recommended_stake_percentage": safe_kelly(dc_model_prob, dc_bookie_odds)
        },
        "dnb_value_bet": {
            "is_value": bool(dnb_value_bet), "recommended_bet": str(dnb_best_bet) if dnb_best_bet else None,
            "edge_percent": round(dnb_highest_edge * 100, 2) if dnb_highest_edge > -90.0 else 0.0, "model_probability": round(dnb_model_prob * 100, 2),
            "bookmaker_odds": float(dnb_bookie_odds or 0.0), "confidence_score": confidence_score,
            "recommended_stake_percentage": safe_kelly(dnb_model_prob, dnb_bookie_odds)
        }
    }

if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=False)
