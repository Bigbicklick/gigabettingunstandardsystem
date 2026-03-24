import os
import requests

# --- THE GIGA BRAIN: ODDS-ANCHORED ESPORT PREDICTION (Phase 11) ---
# Esports matches from TheSportsDB have NO ODDS — use form-based prediction only
# When odds are available (future expansion), anchor to them like tennis.

API_KEY = "3"
BASE_SEARCH_URL = f"https://www.thesportsdb.com/api/v1/json/{API_KEY}/searchteams.php"
BASE_EVENTS_URL = f"https://www.thesportsdb.com/api/v1/json/{API_KEY}/eventslast.php"

ESPORT_MODEL_FILE = 'esport_model.pkl'  # Kept for backwards compat

def get_team_form_esport(team_name):
    """
    Returns a form score 0-100 from TheSportsDB last results.
    50 = neutral (unknown team), higher = better form.
    """
    try:
        r_search = requests.get(BASE_SEARCH_URL, params={"t": team_name}, timeout=5)
        if r_search.status_code != 200:
            return 50.0

        data = r_search.json()
        teams = data.get("teams")

        if not teams or len(teams) == 0:
            return 50.0

        team_id = teams[0].get("idTeam")
        if not team_id:
            return 50.0

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

            if str(team_id) == str(match.get("idHomeTeam")) and h_s > a_s:
                wins += 1
            elif str(team_id) == str(match.get("idAwayTeam")) and a_s > h_s:
                wins += 1

            total_games += 1

        if total_games == 0:
            return 50.0

        return (wins / total_games) * 100.0

    except Exception as e:
        print(f"Esport Form Error for {team_name}: {e}")
        return 50.0


def train_esport_model():
    """No-op: Phase 11 uses odds-anchored/form-based prediction."""
    print("ESPORT Phase 11: Odds-Anchored engine active. No synthetic model training needed.")


def predict_esport_match(home_team, away_team, odds_home=None, odds_away=None):
    """
    Odds-Anchored prediction for Esports:
    - If odds are available: anchor to bookmaker, adjust by form (max ±15%)
    - If no odds (TheSportsDB data): use form comparison directly
    """
    h_form = get_team_form_esport(home_team)
    a_form = get_team_form_esport(away_team)

    if odds_home and odds_away and odds_home > 0 and odds_away > 0:
        # Same odds-anchored logic as tennis
        implied_home = 1.0 / odds_home
        implied_away = 1.0 / odds_away
        total_implied = implied_home + implied_away

        fair_home = implied_home / total_implied
        fair_away = implied_away / total_implied

        form_diff = h_form - a_form
        form_adjustment = (form_diff / 100.0) * 0.15

        model_home = max(0.05, min(0.95, fair_home + form_adjustment))
        model_away = 1.0 - model_home

        prob_home_pct = model_home * 100
        prob_away_pct = model_away * 100

        edge_home = prob_home_pct - (implied_home * 100)
        edge_away = prob_away_pct - (implied_away * 100)

        if edge_home > edge_away and edge_home > 2.0:
            return {
                "recommended_bet": "Home Win",
                "model_probability": round(prob_home_pct, 2),
                "edge_percent": round(edge_home, 2),
                "is_value": True
            }
        elif edge_away > edge_home and edge_away > 2.0:
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
        # No odds available (TheSportsDB data) — use form comparison
        # Convert form to probability using logistic function
        form_diff = h_form - a_form
        import math
        prob_home = 1.0 / (1.0 + math.exp(-form_diff / 20.0))
        prob_home_pct = prob_home * 100
        prob_away_pct = (1.0 - prob_home) * 100

        if prob_home_pct > 50:
            return {
                "recommended_bet": "Home Win",
                "model_probability": round(prob_home_pct, 2),
                "edge_percent": round(prob_home_pct - 50, 2),
                "is_value": prob_home_pct > 55
            }
        else:
            return {
                "recommended_bet": "Away Win",
                "model_probability": round(prob_away_pct, 2),
                "edge_percent": round(prob_away_pct - 50, 2),
                "is_value": prob_away_pct > 55
            }
