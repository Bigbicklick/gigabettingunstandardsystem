import os
import difflib
import psycopg2

# --- ESPORT PREDICTION: In-memory win-rate engine (Phase 12) ---
# Team stats loaded from team_stats_esport table ONCE at startup.
# Zero DB calls during prediction — instant dictionary lookup.

ESPORT_MODEL_FILE = 'esport_model.pkl'  # Kept for backwards compat

DB_URL = os.environ.get('DATABASE_URL', 'postgresql://postgres:postgres@db:5432/bettingdb')

# { "team_name_lower": (win_rate, matches_played, original_name) }
_stats: dict = {}


def load_team_stats():
    """Load all team stats from DB into memory. Called at startup and periodically."""
    global _stats
    try:
        conn = psycopg2.connect(DB_URL, connect_timeout=5)
        cur = conn.cursor()
        cur.execute("SELECT team_name, win_rate, matches_played FROM team_stats_esport")
        rows = cur.fetchall()
        conn.close()
        _stats = {row[0].lower(): (float(row[1]), int(row[2]), row[0]) for row in rows}
        print(f"Esport team stats loaded: {len(_stats)} teams.")
    except Exception as e:
        print(f"Esport stats load error: {e}. Using empty cache.")
        _stats = {}


def get_team_form_esport(team_name: str) -> float:
    """
    Returns win-rate 0-100 from in-memory cache.
    Uses fuzzy name matching when exact match not found.
    50.0 = neutral fallback for unknown teams.
    """
    if not _stats:
        return 50.0

    key = team_name.lower()

    # 1) Exact match
    if key in _stats:
        win_rate, played, _ = _stats[key]
        return win_rate if played >= 3 else 50.0

    # 2) Fuzzy match
    all_keys = list(_stats.keys())
    close = difflib.get_close_matches(key, all_keys, n=1, cutoff=0.6)
    if close:
        win_rate, played, _ = _stats[close[0]]
        return win_rate if played >= 3 else 50.0

    return 50.0


def train_esport_model():
    """No-op: Phase 12 uses in-memory win-rate engine."""
    print("ESPORT Phase 12: in-memory win-rate engine active.")


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
        # No odds available — fallback to form comparison only
        total = h_form + a_form if (h_form + a_form) > 0 else 100.0
        prob_home = round((h_form / total) * 100, 2)
        prob_away = round((a_form / total) * 100, 2)
        if h_form >= a_form:
            return {
                "recommended_bet": "Home Win",
                "model_probability": prob_home,
                "edge_percent": -5.0,
                "is_value": False
            }
        else:
            return {
                "recommended_bet": "Away Win",
                "model_probability": prob_away,
                "edge_percent": -5.0,
                "is_value": False
            }
