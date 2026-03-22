import pandas as pd
import numpy as np
import requests
import io
import os
import joblib
from xgboost import XGBClassifier
from sklearn.ensemble import VotingClassifier, RandomForestClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler
from sklearn.model_selection import train_test_split
from sklearn.metrics import accuracy_score, classification_report
import warnings
warnings.filterwarnings('ignore')

MODEL_PATH = "model.joblib"
STATE_PATH = "team_states.joblib"

SEASONS = [
    "1819", "1920", "2021", "2122", "2223", "2324"
]
LEAGUES = [
    "E0", "E1", "E2", "E3", "SC0", 
    "D1", "D2", 
    "I1", "I2", 
    "SP1", "SP2", 
    "F1", "F2", 
    "N1", "B1", "P1", "T1", "G1"
]

def download_data():
    """Downloads real historical match data from football-data.co.uk"""
    print("Downloading historical data...")
    dfs = []
    for league in LEAGUES:
        for season in SEASONS:
            url = f"https://www.football-data.co.uk/mmz4281/{season}/{league}.csv"
            try:
                response = requests.get(url, timeout=10)
                if response.status_code == 200:
                    df = pd.read_csv(io.StringIO(response.text))
                    dfs.append(df)
            except Exception as e:
                print(f"Failed to fetch {url}: {e}")
                
    if not dfs:
        raise Exception("No data could be downloaded. Check internet connection.")
        
    data = pd.concat(dfs, ignore_index=True)
    data = data.dropna(subset=['HomeTeam', 'AwayTeam', 'FTR'])
    
    cols_to_keep = ['Date', 'HomeTeam', 'AwayTeam', 'FTHG', 'FTAG', 'FTR', 'HC', 'AC', 'HS', 'AS', 'HST', 'AST']
    data = data.dropna(subset=cols_to_keep)
    data = data[cols_to_keep]
    data['Date'] = pd.to_datetime(data['Date'], errors='coerce', dayfirst=True)
    data = data.sort_values(by='Date').reset_index(drop=True)
    return data

class TeamState:
    def __init__(self):
        self.goals_scored = []
        self.goals_conceded = []
        self.shots = []
        self.shots_conceded = []
        self.sot = []
        self.sot_conceded = []
        self.points = []
        self.points = []
        self.streak = 0
        self.elo = 1500.0

    def update(self, gs, gc, shots, shots_c, sot, sot_c, pts):
        self.goals_scored.append(gs)
        self.goals_conceded.append(gc)
        self.shots.append(shots)
        self.shots_conceded.append(shots_c)
        self.sot.append(sot)
        self.sot_conceded.append(sot_c)
        self.points.append(pts)
        
        if len(self.goals_scored) > 5:
            self.goals_scored.pop(0)
            self.goals_conceded.pop(0)
            self.shots.pop(0)
            self.shots_conceded.pop(0)
            self.sot.pop(0)
            self.sot_conceded.pop(0)
            self.points.pop(0)
            
        if pts == 3:
            self.streak = self.streak + 1 if self.streak > 0 else 1
        elif pts == 0:
            self.streak = self.streak - 1 if self.streak < 0 else -1
        else:
            self.streak = 0
            
    def get_features(self):
        if len(self.points) == 0:
            return 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0, 0
        return (
            sum(self.points),
            sum(self.goals_scored),
            sum(self.goals_conceded),
            sum(self.shots),
            sum(self.shots_conceded),
            sum(self.sot),
            sum(self.sot_conceded),
            self.streak,
            len(self.points)
        )

def feature_engineering(data):
    """Engineers rolling averages and form for teams chronologically."""
    print("Engineering features...")
    features = []
    labels_h2h = []
    labels_btts = []
    labels_ou = []
    labels_corners = []
    
    team_states = {}
    label_map = {'H': 0, 'D': 1, 'A': 2}
    
    for idx, row in data.iterrows():
        home = row['HomeTeam']
        away = row['AwayTeam']
        ftr = row['FTR']
        if ftr not in label_map:
            continue
            
        if home not in team_states:
            team_states[home] = TeamState()
        if away not in team_states:
            team_states[away] = TeamState()
            
        h_pts, h_gs, h_gc, h_sh, h_sh_c, h_sot, h_sot_c, h_streak, h_games = team_states[home].get_features()
        a_pts, a_gs, a_gc, a_sh, a_sh_c, a_sot, a_sot_c, a_streak, a_games = team_states[away].get_features()
        
        if h_games >= 5 and a_games >= 5:
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
                a_sot_attack - h_sot_defense,
                team_states[home].elo,
                team_states[away].elo,
                team_states[home].elo - team_states[away].elo
            ]
            features.append(feature_row)
            labels_h2h.append(label_map[ftr])
            
            btts_val = 1 if row['FTHG'] > 0 and row['FTAG'] > 0 else 0
            labels_btts.append(btts_val)
            
            ou_val = 1 if (row['FTHG'] + row['FTAG']) > 2.5 else 0
            labels_ou.append(ou_val)
            
            corners_val = 1 if (row['HC'] + row['AC']) > 9.5 else 0
            labels_corners.append(corners_val)
            
        if ftr == 'H':
            team_states[home].update(row['FTHG'], row['FTAG'], row['HS'], row['AS'], row['HST'], row['AST'], 3)
            team_states[away].update(row['FTAG'], row['FTHG'], row['AS'], row['HS'], row['AST'], row['HST'], 0)
            s_home, s_away = 1.0, 0.0
        elif ftr == 'A':
            team_states[home].update(row['FTHG'], row['FTAG'], row['HS'], row['AS'], row['HST'], row['AST'], 0)
            team_states[away].update(row['FTAG'], row['FTHG'], row['AS'], row['HS'], row['AST'], row['HST'], 3)
            s_home, s_away = 0.0, 1.0
        else:
            team_states[home].update(row['FTHG'], row['FTAG'], row['HS'], row['AS'], row['HST'], row['AST'], 1)
            team_states[away].update(row['FTAG'], row['FTHG'], row['AS'], row['HS'], row['AST'], row['HST'], 1)
            s_home, s_away = 0.5, 0.5
            
        # Elo Update Algorithm
        h_elo = team_states[home].elo
        a_elo = team_states[away].elo
        e_home = 1 / (1 + 10 ** ((a_elo - (h_elo + 100)) / 400))
        e_away = 1 - e_home
        
        team_states[home].elo = h_elo + 20 * (s_home - e_home)
        team_states[away].elo = a_elo + 20 * (s_away - e_away)
            
    X = np.array(features)
    y_h2h = np.array(labels_h2h)
    y_btts = np.array(labels_btts)
    y_ou = np.array(labels_ou)
    y_corners = np.array(labels_corners)
    return X, y_h2h, y_btts, y_ou, y_corners, team_states

def train_model():
    """Builds and trains the Ensemble pipeline."""
    data = download_data()
    X, y_h2h, y_btts, y_ou, y_corners, team_states = feature_engineering(data)
    
    print(f"Dataset shape: {X.shape}")
    X_train, X_test, y_h2h_train, y_h2h_test, y_btts_train, y_btts_test, y_ou_train, y_ou_test, y_cor_train, y_cor_test = train_test_split(
        X, y_h2h, y_btts, y_ou, y_corners, test_size=0.1, random_state=42
    )
    
    # Base Estimators
    xgb_multi = XGBClassifier(objective='multi:softprob', num_class=3, n_estimators=100, max_depth=4, learning_rate=0.05, random_state=42)
    xgb_bin = XGBClassifier(objective='binary:logistic', n_estimators=100, max_depth=4, learning_rate=0.05, random_state=42)
    rf_base = RandomForestClassifier(n_estimators=100, max_depth=5, random_state=42)
    lr_base = Pipeline([('scaler', StandardScaler()), ('lr', LogisticRegression(max_iter=1000, random_state=42))])
    
    print("Training Ensemble H2H Classifier...")
    model = VotingClassifier(estimators=[('xgb', xgb_multi), ('rf', rf_base), ('lr', lr_base)], voting='soft')
    model.fit(X_train, y_h2h_train)
    y_pred = model.predict(X_test)
    print(f"H2H Model Accuracy: {accuracy_score(y_h2h_test, y_pred):.4f}")
    
    print("Training Ensemble BTTS Classifier...")
    model_btts = VotingClassifier(estimators=[('xgb', xgb_bin), ('rf', rf_base), ('lr', lr_base)], voting='soft')
    model_btts.fit(X_train, y_btts_train)
    print(f"BTTS Model Accuracy: {accuracy_score(y_btts_test, model_btts.predict(X_test)):.4f}")
    
    print("Training Ensemble Over/Under 2.5 Classifier...")
    model_ou = VotingClassifier(estimators=[('xgb', xgb_bin), ('rf', rf_base), ('lr', lr_base)], voting='soft')
    model_ou.fit(X_train, y_ou_train)
    print(f"Over/Under Model Accuracy: {accuracy_score(y_ou_test, model_ou.predict(X_test)):.4f}")

    print("Training Ensemble Corners >9.5 Classifier...")
    model_corners = VotingClassifier(estimators=[('xgb', xgb_bin), ('rf', rf_base), ('lr', lr_base)], voting='soft')
    model_corners.fit(X_train, y_cor_train)
    print(f"Corners Model Accuracy: {accuracy_score(y_cor_test, model_corners.predict(X_test)):.4f}")
    
    # Save model and team states
    joblib.dump(model, MODEL_PATH)
    joblib.dump(model_btts, 'model_btts.joblib')
    joblib.dump(model_ou, 'model_ou.joblib')
    joblib.dump(model_corners, 'model_corners.joblib')
    joblib.dump(team_states, STATE_PATH)
    print(f"All 4 Ensemble models and states saved successfully to {STATE_PATH}")

if __name__ == "__main__":
    train_model()
