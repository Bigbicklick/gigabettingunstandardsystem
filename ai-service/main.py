from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from typing import Optional, Dict, Any
import joblib
import os
import uvicorn
import ml_pipeline
import logging
import pandas as pd
import numpy as np

app = FastAPI(title="AI Betting Predictor", description="Machine Learning API for football match prediction.")
logger = logging.getLogger(__name__)

MODEL_PATH = ml_pipeline.MODEL_PATH
STATE_PATH = ml_pipeline.STATE_PATH

model = None
model_btts = None
model_ou = None
model_corners = None
team_states = None

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

def load_ai():
    global model, model_btts, model_ou, model_corners, team_states
    if not os.path.exists(MODEL_PATH) or not os.path.exists(STATE_PATH) or not os.path.exists('model_ou.joblib'):
        logger.warning("Model not found. Executing ML Pipeline to fetch data and train model...")
        ml_pipeline.train_model()
    
    model = joblib.load(MODEL_PATH)
    model_btts = joblib.load('model_btts.joblib')
    model_ou = joblib.load('model_ou.joblib')
    model_corners = joblib.load('model_corners.joblib')
    team_states = joblib.load(STATE_PATH)
    logger.info("Models and team states loaded successfully.")

@app.on_event("startup")
async def startup_event():
    load_ai()

def calculate_implied_prob(odds: float) -> float:
    if not odds or odds <= 1.0:
        return 0.0
    return 1.0 / odds

@app.get("/health")
def health_check():
    return {"status": "ok", "model_loaded": model is not None}

@app.post("/predict")
def predict(req: PredictionRequest) -> Dict[str, Any]:
    home = req.home_team
    away = req.away_team
    
    if home not in team_states or away not in team_states:
        raise HTTPException(status_code=404, detail="Team history not found in database. Cannot predict.")
        
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
        a_sot_attack - h_sot_defense
    ]
    
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
    
    # Value bet logic
    value_bet = False
    best_bet = None
    highest_edge = 0.0
    model_prob_for_bet = 0.0
    bookie_odds = 0.0
    
    if req.odds_home and req.odds_draw and req.odds_away:
        i_home = calculate_implied_prob(req.odds_home)
        i_draw = calculate_implied_prob(req.odds_draw)
        i_away = calculate_implied_prob(req.odds_away)
        
        edges = {
            home: (p_home - i_home, p_home, req.odds_home),
            "Draw": (p_draw - i_draw, p_draw, req.odds_draw),
            away: (p_away - i_away, p_away, req.odds_away)
        }
        
        for k, (edge, m_prob, _odds) in edges.items():
            if edge > highest_edge:
                highest_edge = edge
                best_bet = k
                model_prob_for_bet = m_prob
                bookie_odds = _odds
                
        # Value bet requires edge > 5% and confidence logic
        if highest_edge > 0.05:
            value_bet = True

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

    confidence_score = float(max(p_home, p_draw, p_away) * 10) # 0 to 10
    
    return {
        "match": f"{home} vs {away}",
        "raw_probabilities": {
            "home": round(p_home * 100, 2),
            "draw": round(p_draw * 100, 2),
            "away": round(p_away * 100, 2),
            "btts_yes": round(p_btts_yes * 100, 2),
            "btts_no": round(p_btts_no * 100, 2)
        },
        "most_likely_outcome": prediction_label,
        "value_bet": {
            "is_value": value_bet,
            "recommended_bet": best_bet,
            "edge_percent": round(highest_edge * 100, 2),
            "model_probability": round(model_prob_for_bet * 100, 2),
            "bookmaker_odds": bookie_odds,
            "confidence_score": round(confidence_score, 1),
            "recommended_stake_percentage": recommended_stake
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
