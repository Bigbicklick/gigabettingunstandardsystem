import os
import joblib
import pandas as pd
import numpy as np
import requests
from datetime import datetime
import time
from xgboost import XGBClassifier

# --- THE GIGA BRAIN: BALLDONTLIE.IO INTEGRATION ---
API_KEY = "05261d65-b43c-4709-964a-960a6b76e026"
HEADERS = {"Authorization": API_KEY}
BASE_URL = "https://api.balldontlie.io/v1/games"

BASKET_MODEL_FILE = 'basket_model.pkl'
BASKET_STATE_FILE = 'basket_state.pkl'

def get_base_elo():
    return 1500

def get_k_factor(games_played):
    # Stabilizacja Elo: im więcej meczy, tym niższe K (mniejsze wahania)
    if games_played < 10:
        return 40
    elif games_played < 30:
        return 30
    return 20

def calculate_expected_score(rating_a, rating_b):
    # Typowe Elo wylicza P(A wygrywa z B) na podstawie przewagi ratingowej
    return 1 / (1 + 10 ** ((rating_b - rating_a) / 400))

def update_elo(rating_a, rating_b, score_a, score_b, games_played_a, games_played_b):
    expected_a = calculate_expected_score(rating_a, rating_b)
    expected_b = calculate_expected_score(rating_b, rating_a)

    actual_a = 1 if score_a > score_b else 0
    actual_b = 1 if score_b > score_a else 0

    k_a = get_k_factor(games_played_a)
    k_b = get_k_factor(games_played_b)

    new_rating_a = rating_a + k_a * (actual_a - expected_a)
    new_rating_b = rating_b + k_b * (actual_b - expected_b)

    return new_rating_a, new_rating_b

def fetch_historical_nba_games():
    """
    Pobieranie ostatnich 2 sezonów NBA z balldontlie.io.
    """
    print("Fetching NBA games from balldontlie.io...")
    all_games = []
    
    # 2 sezony wstecz aby wybudować historię Elo
    seasons = [2022, 2023, 2024]
    
    for season in seasons:
        cursor = None
        while True:
            params = {
                "per_page": 100,
                "seasons[]": season
            }
            if cursor:
                params["cursor"] = cursor
            
            resp = requests.get(BASE_URL, headers=HEADERS, params=params)
            if resp.status_code == 429:
                print(f"Rate limit hit! Sleeping for 10 seconds...")
                time.sleep(10)
                continue
                
            if resp.status_code != 200:
                print(f"Error fetching season {season}: {resp.status_code}")
                break
                
            data = resp.json()
            if "data" not in data or len(data["data"]) == 0:
                break
                
            all_games.extend(data["data"])
            time.sleep(1) # Zabezpieczenie Giga API przed banem wgłąb
            
            # Balldontlie cursor logic (next_cursor is returned in meta)
            meta = data.get("meta", {})
            cursor = meta.get("next_cursor")
            if not cursor:
                break
                
    df = pd.DataFrame(all_games)
    
    # Filtrujemy by odrzucić bzdury i nierozegrane mecze
    df = df[df['status'] == 'Final'].copy()
    
    # Rozkładamy obiekty drużynowe 
    try:
        df['home_team_name'] = df['home_team'].apply(lambda x: x['full_name'] if isinstance(x, dict) else None)
        df['away_team_name'] = df['visitor_team'].apply(lambda x: x['full_name'] if isinstance(x, dict) else None)
    except:
        pass
        
    df['date'] = pd.to_datetime(df['date'])
    df = df.sort_values('date').reset_index(drop=True)
    return df

def feature_engineering(df):
    print("Building Giga ELO vectors for NBA...")
    elos = {}
    games_played = {}
    last_game_date = {} # Do liczenia "Rest Days"
    
    features = []
    
    for idx, row in df.iterrows():
        try:
            home = row['home_team_name']
            away = row['away_team_name']
            
            if not home or not away:
                continue
                
            # Initialize
            if home not in elos:
                elos[home] = get_base_elo()
                games_played[home] = 0
            if away not in elos:
                elos[away] = get_base_elo()
                games_played[away] = 0
                
            home_elo = elos[home]
            away_elo = elos[away]
            
            # Giga Wskaźnik "Rest Days" (Dni od ostatniego meczu)
            home_rest = 7 # Default max
            away_rest = 7
            
            if home in last_game_date:
                home_rest = min((row['date'] - last_game_date[home]).days, 7)
            if away in last_game_date:
                away_rest = min((row['date'] - last_game_date[away]).days, 7)
                
            score_h = row['home_team_score']
            score_a = row['visitor_team_score']
            
            if score_h is None or score_a is None:
                continue
                
            # Cecha decydująca
            target = 1 if score_h > score_a else 0
            
            # Zapisz wektor przed zmianą ELO (na podstawie wiedzy pre-match)
            features.append({
                'Home_Elo': home_elo,
                'Away_Elo': away_elo,
                'Elo_Diff': home_elo - away_elo,
                'Home_Rest_Days': home_rest,
                'Away_Rest_Days': away_rest,
                'Target': target
            })
            
            # Update history
            new_home_elo, new_away_elo = update_elo(home_elo, away_elo, score_h, score_a, games_played[home], games_played[away])
            elos[home] = new_home_elo
            elos[away] = new_away_elo
            
            games_played[home] += 1
            games_played[away] += 1
            last_game_date[home] = row['date']
            last_game_date[away] = row['date']
        except Exception as e:
            continue
            
    # Zapisz stan drużyn by /predict uvicorna mógł go czytać w czasie rzeczywistym
    state = {
        'elos': elos,
        'last_game_date': last_game_date
    }
    joblib.dump(state, BASKET_STATE_FILE)
    
    return pd.DataFrame(features)

def train_basket_model():
    df = fetch_historical_nba_games()
    if df.empty:
        print("Brak meczów z API Balldontlie. Przerywam trening NBA.")
        return
        
    df_features = feature_engineering(df)
    
    X = df_features[['Home_Elo', 'Away_Elo', 'Elo_Diff', 'Home_Rest_Days', 'Away_Rest_Days']]
    y = df_features['Target']
    
    model = XGBClassifier(
        n_estimators=100, 
        learning_rate=0.05, 
        max_depth=4,
        random_state=42
    )
    model.fit(X, y)
    
    joblib.dump(model, BASKET_MODEL_FILE)
    print(f"BASKETBALL MACHINE LEARNING TRAINED. Model saved to {BASKET_MODEL_FILE}")

def predict_basket_match(home_team, away_team, odds_home=None, odds_away=None):
    """
    Odds-Anchored prediction for NBA:
    1. Start from bookmaker implied probability (strongest signal)
    2. Apply Elo-based correction (max ±15%)
    3. Apply rest days micro-adjustment (max ±3%)
    """
    if not os.path.exists(BASKET_STATE_FILE):
        # No Elo state — fall back to pure odds with 1% market-efficiency adjustment
        if odds_home and odds_away and float(odds_home) > 0 and float(odds_away) > 0:
            implied_h = 1.0 / float(odds_home)
            implied_a = 1.0 / float(odds_away)
            total = implied_h + implied_a
            fair_h = implied_h / total
            
            # Without ELO, we assume the market is mostly right but favor the favorite slightly 
            # (favorite-longshot bias happens in some markets, but in NBA favorites are often undervalued)
            adj = 0.01 if fair_h > 0.5 else -0.01
            prob_h = fair_h + adj
            prob_a = 1.0 - prob_h
            edge_h = (prob_h - implied_h) * 100
            edge_a = (prob_a - implied_a) * 100

            if prob_h > 0.5:
                return {
                    "recommended_bet": "Home Win",
                    "model_probability": round(prob_h * 100, 2),
                    "edge_percent": round(edge_h, 2),
                    "is_value": edge_h > 3.0
                }
            else:
                return {
                    "recommended_bet": "Away Win",
                    "model_probability": round(prob_a * 100, 2),  # Fixed: return AWAY probability
                    "edge_percent": round(edge_a, 2),
                    "is_value": edge_a > 3.0
                }
        return {"recommended_bet": "Analysis Pending", "model_probability": 50.0, "edge_percent": 0.0, "is_value": False}

    state = joblib.load(BASKET_STATE_FILE)
    elos = state['elos']
    last_game_date = state['last_game_date']

    home_elo = elos.get(home_team, get_base_elo())
    away_elo = elos.get(away_team, get_base_elo())

    today = datetime.now()
    home_rest = 7
    away_rest = 7
    if home_team in last_game_date:
        home_rest = min((today - last_game_date[home_team]).days, 7)
    if away_team in last_game_date:
        away_rest = min((today - last_game_date[away_team]).days, 7)

    if odds_home and odds_away and odds_home > 0 and odds_away > 0:
        # Bookmaker implied probabilities
        implied_home = 1.0 / odds_home
        implied_away = 1.0 / odds_away
        total_implied = implied_home + implied_away

        # Fair probabilities (margin removed)
        fair_home = implied_home / total_implied
        fair_away = implied_away / total_implied

        # Elo adjustment: small correction on top of bookmaker odds (capped at ±8%)
        # Bookmaker odds are the primary signal; Elo only provides minor context
        elo_diff = home_elo - away_elo
        # Only apply Elo adjustment if we have REAL Elo data (not both default 1500)
        if home_elo != get_base_elo() or away_elo != get_base_elo():
            elo_expected = calculate_expected_score(home_elo, away_elo)
            elo_adjustment = (elo_expected - 0.5) * 0.16  # Scale: max ±8%
            elo_adjustment = max(-0.08, min(0.08, elo_adjustment))
        else:
            elo_adjustment = 0.0

        # Rest days micro-adjustment (max ±3%)
        rest_diff = home_rest - away_rest
        rest_adjustment = (rest_diff / 7.0) * 0.03  # Max ±3%

        # Combine
        model_home = max(0.05, min(0.95, fair_home + elo_adjustment + rest_adjustment))
        model_away = 1.0 - model_home

        prob_home_pct = model_home * 100
        prob_away_pct = model_away * 100

        edge_home = prob_home_pct - (implied_home * 100)
        edge_away = prob_away_pct - (implied_away * 100)

        if edge_home > edge_away and edge_home > 3.0:
            return {
                "recommended_bet": "Home Win",
                "model_probability": round(prob_home_pct, 2),
                "edge_percent": round(edge_home, 2),
                "is_value": True
            }
        elif edge_away > edge_home and edge_away > 3.0:
            return {
                "recommended_bet": "Away Win",
                "model_probability": round(prob_away_pct, 2),
                "edge_percent": round(edge_away, 2),
                "is_value": True
            }
        else:
            if prob_home_pct > prob_away_pct:
                return {
                    "recommended_bet": "Home Win",
                    "model_probability": round(prob_home_pct, 2),
                    "edge_percent": round(edge_home, 2),
                    "is_value": False
                }
            else:
                return {
                    "recommended_bet": "Away Win",
                    "model_probability": round(prob_away_pct, 2),
                    "edge_percent": round(edge_away, 2),
                    "is_value": False
                }
    else:
        # No odds — use Elo-based prediction only
        elo_prob = calculate_expected_score(home_elo, away_elo)
        if elo_prob > 0.5:
            return {"recommended_bet": "Home Win", "model_probability": round(elo_prob * 100, 2), "edge_percent": 0.0, "is_value": False}
        else:
            return {"recommended_bet": "Away Win", "model_probability": round((1 - elo_prob) * 100, 2), "edge_percent": 0.0, "is_value": False}

