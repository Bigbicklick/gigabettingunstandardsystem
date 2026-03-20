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
team_states = None

class PredictionRequest(BaseModel):
    home_team: str
    away_team: str
    odds_home: Optional[float] = None
    odds_draw: Optional[float] = None
    odds_away: Optional[float] = None
    odds_btts_yes: Optional[float] = None
    odds_btts_no: Optional[float] = None

def load_ai():
    global model, model_btts, team_states
    if not os.path.exists(MODEL_PATH) or not os.path.exists(STATE_PATH) or not os.path.exists('model_btts.joblib'):
        logger.warning("Model not found. Executing ML Pipeline to fetch data and train model...")
        ml_pipeline.train_model()
    
    model = joblib.load(MODEL_PATH)
    model_btts = joblib.load('model_btts.joblib')
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
        
    h_pts, h_gs, h_gc, h_streak = team_states[home].get_features()
    a_pts, a_gs, a_gc, a_streak = team_states[away].get_features()
    
    feature_row = [
        h_pts, h_gs, h_gc, h_streak,
        a_pts, a_gs, a_gc, a_streak,
        h_pts - a_pts,
        (h_gs - h_gc) - (a_gs - a_gc)
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
    
    # Prediction class
    best_idx = np.argmax(probs)
    class_map = {0: "Home Win", 1: "Draw", 2: "Away Win"}
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
            "Home Win": (p_home - i_home, p_home, req.odds_home),
            "Draw": (p_draw - i_draw, p_draw, req.odds_draw),
            "Away Win": (p_away - i_away, p_away, req.odds_away)
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
    btts_highest_edge = 0.0
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
        }
    }

if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=False)
