import os
import requests

# --- THE GIGA BRAIN: ODDS-ANCHORED TENNIS PREDICTION (Phase 11) ---
# Key Insight: Bookmaker odds are the STRONGEST signal. Form from TheSportsDB
# can add a small correction (±15% max) but should NEVER override odds completely.
# A player with odds 6.0 (~17% chance) should NOT be predicted to win.

API_KEY = "3"
BASE_SEARCH_URL = f"https://www.thesportsdb.com/api/v1/json/{API_KEY}/searchteams.php"
BASE_PLAYER_URL = f"https://www.thesportsdb.com/api/v1/json/{API_KEY}/searchplayers.php"
BASE_EVENTS_URL = f"https://www.thesportsdb.com/api/v1/json/{API_KEY}/eventslast.php"

TENNIS_MODEL_FILE = 'tennis_model.pkl'  # Kept for backwards compat but not used

def get_player_form_tennis(player_name):
    """
    Returns a form score 0-100 from TheSportsDB last results.
    50 = neutral (unknown player), higher = better form.
    """
    try:
        team_id = None
        r_search = requests.get(BASE_SEARCH_URL, params={"t": player_name}, timeout=5)
        if r_search.status_code == 200:
            data = r_search.json()
            teams = data.get("teams")
            if teams and len(teams) > 0:
                team_id = teams[0].get("idTeam")

        if not team_id:
            r_p = requests.get(BASE_PLAYER_URL, params={"p": player_name}, timeout=5)
            if r_p.status_code == 200:
                p_data = r_p.json()
                players = p_data.get("player")
                if players and len(players) > 0:
                    team_id = players[0].get("idPlayer")

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
            elif player_name.lower() in str(match.get("strHomeTeam", "")).lower() and h_s > a_s:
                wins += 1
            elif player_name.lower() in str(match.get("strAwayTeam", "")).lower() and a_s > h_s:
                wins += 1

            total_games += 1

        if total_games == 0:
            return 50.0

        return (wins / total_games) * 100.0

    except Exception as e:
        print(f"Tennis Form Error for {player_name}: {e}")
        return 50.0


def train_tennis_model():
    """No-op: Phase 11 uses odds-anchored prediction, no synthetic model needed."""
    print("TENNIS Phase 11: Odds-Anchored engine active. No synthetic model training needed.")


def predict_tennis_match(home_team, away_team, odds_home=None, odds_away=None):
    """
    Odds-Anchored prediction:
    1. Start from bookmaker implied probability (strongest signal)
    2. Apply a small form correction from TheSportsDB (max ±15%)
    3. Calculate edge vs bookmaker odds
    """
    # Fetch form from TheSportsDB
    h_form = get_player_form_tennis(home_team)
    a_form = get_player_form_tennis(away_team)

    if odds_home and odds_away and odds_home > 0 and odds_away > 0:
        # Bookmaker implied probabilities (before margin removal)
        implied_home = 1.0 / odds_home
        implied_away = 1.0 / odds_away
        total_implied = implied_home + implied_away

        # Remove overround/margin to get fair probabilities
        fair_home = implied_home / total_implied
        fair_away = implied_away / total_implied

        # Form adjustment: scale form diff to a small probability shift
        # Form diff ranges from -100 to +100
        # We allow max ±15% adjustment (0.15) to fair probability
        form_diff = h_form - a_form  # Range: -100 to +100
        form_adjustment = (form_diff / 100.0) * 0.15  # Max ±0.15

        # Apply form adjustment to fair probability
        model_home = max(0.05, min(0.95, fair_home + form_adjustment))
        model_away = 1.0 - model_home

        prob_home_pct = model_home * 100
        prob_away_pct = model_away * 100

        # Edge calculation
        edge_home = prob_home_pct - (implied_home * 100)
        edge_away = prob_away_pct - (implied_away * 100)

        # Pick the side with positive edge, respecting minimum threshold
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
            # No clear edge - pick the favorite but mark edge honestly
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
        # No odds available - use form only
        if h_form > a_form:
            return {
                "recommended_bet": "Home Win",
                "model_probability": round(h_form, 2),
                "edge_percent": 0.0,
                "is_value": False
            }
        else:
            return {
                "recommended_bet": "Away Win",
                "model_probability": round(a_form, 2),
                "edge_percent": 0.0,
                "is_value": False
            }
