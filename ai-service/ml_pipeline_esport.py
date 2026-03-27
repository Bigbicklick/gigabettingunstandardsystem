import os
import difflib
import psycopg2

# --- ESPORT PREDICTION: DB-backed win-rate engine (Phase 12) ---
# Team stats sourced from PandaScore historical + OpenDota, stored in team_stats_esport table.
# Falls back to 50.0 if team is unknown.

ESPORT_MODEL_FILE = 'esport_model.pkl'  # Kept for backwards compat

DB_URL = os.environ.get('DATABASE_URL', 'postgresql://postgres:postgres@db:5432/bettingdb')

_team_cache = {}   # in-memory cache to avoid repeated DB lookups per process lifetime
_all_names = None  # cached list of all team names for fuzzy matching

def _load_all_names(cur):
    global _all_names
    if _all_names is None:
        cur.execute("SELECT team_name FROM team_stats_esport")
        _all_names = [row[0] for row in cur.fetchall()]
    return _all_names

def get_team_form_esport(team_name):
    """
    Returns win-rate 0-100 from team_stats_esport table.
    Uses fuzzy name matching when exact match not found.
    50.0 = neutral fallback for unknown teams.
    """
    if team_name in _team_cache:
        return _team_cache[team_name]
    try:
        conn = psycopg2.connect(DB_URL, connect_timeout=5)
        cur = conn.cursor()

        # 1) Exact match (case-insensitive)
        cur.execute(
            "SELECT win_rate, matches_played FROM team_stats_esport WHERE LOWER(team_name) = LOWER(%s)",
            (team_name,)
        )
        row = cur.fetchone()

        if not row:
            # 2) Fuzzy match
            names = _load_all_names(cur)
            close = difflib.get_close_matches(team_name, names, n=1, cutoff=0.6)
            if close:
                cur.execute(
                    "SELECT win_rate, matches_played FROM team_stats_esport WHERE team_name = %s",
                    (close[0],)
                )
                row = cur.fetchone()

        conn.close()

        if row and row[1] >= 3:  # need at least 3 matches to trust the data
            result = float(row[0])
            _team_cache[team_name] = result
            return result
    except Exception as e:
        print(f"Esport DB lookup error for '{team_name}': {e}")

    return 50.0


def train_esport_model():
    """No-op: Phase 12 uses DB-backed win-rate engine."""
    print("ESPORT Phase 12: DB win-rate engine active.")


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
