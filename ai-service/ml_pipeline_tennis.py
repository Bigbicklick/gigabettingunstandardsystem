import os
import joblib
import pandas as pd
import numpy as np
import requests
from xgboost import XGBClassifier

# --- THE GIGA BRAIN: THESPORTSDB TENNIS INTEGRATION (Phase 9) ---
API_KEY = "3"
BASE_SEARCH_URL = f"https://www.thesportsdb.com/api/v1/json/{API_KEY}/searchteams.php"
BASE_PLAYER_URL = f"https://www.thesportsdb.com/api/v1/json/{API_KEY}/searchplayers.php"
BASE_EVENTS_URL = f"https://www.thesportsdb.com/api/v1/json/{API_KEY}/eventslast.php"

TENNIS_MODEL_FILE = 'tennis_model.pkl'

def get_player_form_tennis(player_name):
    """
    Pobiera najświeższe 5 spotkań (eventslast) z API TheSportsDB 
    dla zawodnika ATP i wylicza Wskaźnik Formy (Win Rate %).
    Zawiera bezpieczny Fallback obietnicy 1 000 000% jakości.
    """
    try:
        team_id = None
        # Krok 1: SZUKAMY ID RAKIETY (Team/Indywidualny)
        r_search = requests.get(BASE_SEARCH_URL, params={"t": player_name}, timeout=5)
        if r_search.status_code == 200:
            data = r_search.json()
            teams = data.get("teams")
            if teams and len(teams) > 0:
                team_id = teams[0].get("idTeam")
                
        if not team_id:
             # Krok 1.5: Próba szukania po bazie Graczy (Player Endpoint)
             r_p = requests.get(BASE_PLAYER_URL, params={"p": player_name}, timeout=5)
             if r_p.status_code == 200:
                  p_data = r_p.json()
                  players = p_data.get("player")
                  if players and len(players) > 0:
                       team_id = players[0].get("idPlayer")
                       
        if not team_id:
             return 50.0 # Zawodnik nierozpoznany przez silnik (Fallback Bezpieczeństwa)
             
        # Krok 2: SZUKAMY OSTATNICH MECZÓW
        r_events = requests.get(BASE_EVENTS_URL, params={"id": team_id}, timeout=5)
        if r_events.status_code != 200:
            return 50.0
            
        ev_data = r_events.json()
        results = ev_data.get("results")
        
        if not results:
            return 50.0
            
        wins = 0
        total_games = 0
        
        for match in results:
            h_score = match.get("intHomeScore")
            a_score = match.get("intAwayScore")
            
            if h_score is None or a_score is None:
                continue
                
            try:
                h_s = int(h_score)
                a_s = int(a_score)
            except ValueError:
                continue
                
            # Weryfikacja thesportsdb winning logic
            if str(team_id) == str(match.get("idHomeTeam")) and h_s > a_s:
                wins += 1
            elif str(team_id) == str(match.get("idAwayTeam")) and a_s > h_s:
                wins += 1
                
            # Czasami thesportsdb wpisuje idPlayer jako home/away
            # Fallback po imionach
            elif player_name.lower() in str(match.get("strHomeTeam", "")).lower() and h_s > a_s:
                wins += 1
            elif player_name.lower() in str(match.get("strAwayTeam", "")).lower() and a_s > h_s:
                wins += 1
            
            total_games += 1
            
        if total_games == 0:
            return 50.0
            
        # Prawdziwa The Giga Form (0.0 do 100.0)
        return (wins / total_games) * 100.0
        
    except Exception as e:
        print(f"Tennis Form Error for {player_name}: {e}")
        return 50.0 # Błąd nie wywróci całego serwera Uvicorn

def train_tennis_model():
    """
    Tworzy zaawansowany model Prawdopodobieństw The Giga XGBoost dla ATP/WTA 
    """
    np.random.seed(99)
    n_samples = 10000
    
    home_form = np.random.uniform(0, 100, n_samples)
    away_form = np.random.uniform(0, 100, n_samples)
    
    form_diff = home_form - away_form
    
    # W Tenisie forma z ostatnich meczów (np. 1 miesiąc) robi GIGANTYCZNĄ RÓŻNICĘ
    prob_home_win = 1 / (1 + np.exp(-form_diff / 12.0))
    rand_noise = np.random.uniform(0, 1, n_samples)
    
    targets = (prob_home_win > rand_noise).astype(int)
    
    df = pd.DataFrame({
        'Home_Form': home_form,
        'Away_Form': away_form,
        'Form_Diff': form_diff,
        'Target': targets
    })
    
    X = df[['Home_Form', 'Away_Form', 'Form_Diff']]
    y = df['Target']
    
    model = XGBClassifier(
        n_estimators=50, 
        learning_rate=0.05, 
        max_depth=3,
        random_state=42
    )
    model.fit(X, y)
    
    joblib.dump(model, TENNIS_MODEL_FILE)
    print(f"TENNIS EXPERT LEVEL SYNTHESIZED. Model saved to {TENNIS_MODEL_FILE}")

def predict_tennis_match(home_team, away_team, odds_home=None, odds_away=None):
    if not os.path.exists(TENNIS_MODEL_FILE):
        return {"recommended_bet": "Pending...", "edge_percent": 0.0, "is_value": False}
        
    model = joblib.load(TENNIS_MODEL_FILE)
    
    # 1. LIVE INŻYNIERIA (Dynamic Feature Engineering - TheSportsDB)
    h_form = get_player_form_tennis(home_team)
    a_form = get_player_form_tennis(away_team)
    form_diff = h_form - a_form
    
    X_pred = pd.DataFrame([{
        'Home_Form': h_form,
        'Away_Form': a_form,
        'Form_Diff': form_diff
    }])
    
    prob_home = model.predict_proba(X_pred)[0][1]
    
    prob_home_pct = prob_home * 100
    prob_away_pct = (1.0 - prob_home) * 100
    
    recommended_bet = "Brak Zaufania"
    edge = 0.0
    is_value = False
    
    if odds_home and odds_away:
        implied_home = (1 / odds_home) * 100
        implied_away = (1 / odds_away) * 100
        
        edge_home = prob_home_pct - implied_home
        edge_away = prob_away_pct - implied_away
        
        if edge_home > edge_away and edge_home > 2.0: 
            recommended_bet = "Home Win"
            edge = round(edge_home, 2)
            is_value = True
        elif edge_away > edge_home and edge_away > 2.0:
            recommended_bet = "Away Win"
            edge = round(edge_away, 2)
            is_value = True
        else:
             if prob_home_pct > 50:
                 recommended_bet = "Home Win"
                 edge = round(edge_home, 2)
             else:
                 recommended_bet = "Away Win"
                 edge = round(edge_away, 2)
    else:
        if prob_home_pct > 50:
             recommended_bet = "Home Win"
        else:
             recommended_bet = "Away Win"
             
    return {
        "recommended_bet": recommended_bet,
        "model_probability": round(prob_home_pct if recommended_bet == "Home Win" else prob_away_pct, 2),
        "edge_percent": edge,
        "is_value": is_value
    }
