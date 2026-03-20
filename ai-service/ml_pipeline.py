import pandas as pd
import numpy as np
import requests
import io
import os
import joblib
from xgboost import XGBClassifier
from sklearn.model_selection import train_test_split
from sklearn.metrics import accuracy_score, classification_report
import warnings
warnings.filterwarnings('ignore')

MODEL_PATH = "model.joblib"
STATE_PATH = "team_states.joblib"

# We will fetch Premier League (E0) data for the last few seasons from football-data.co.uk
SEASONS = [
    "1819", "1920", "2021", "2122", "2223", "2324"
]
LEAGUES = ["E0", "E1", "SP1", "D1", "I1", "F1"] # Top European Leagues

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
    
    # Clean up empty rows
    data = data.dropna(subset=['HomeTeam', 'AwayTeam', 'FTR'])
    
    # We only need specific columns
    cols_to_keep = ['Date', 'HomeTeam', 'AwayTeam', 'FTHG', 'FTAG', 'FTR']
    # If odds exist, we can use them for reference, but our model predicts outcome from stats
    data = data[cols_to_keep]
    data['Date'] = pd.to_datetime(data['Date'], errors='coerce', dayfirst=True)
    data = data.sort_values(by='Date').reset_index(drop=True)
    return data

class TeamState:
    def __init__(self):
        self.goals_scored = []
        self.goals_conceded = []
        self.points = []
        self.streak = 0  # + for wins, - for losses

    def update(self, gs, gc, pts):
        self.goals_scored.append(gs)
        self.goals_conceded.append(gc)
        self.points.append(pts)
        
        # Keep only last 5
        if len(self.goals_scored) > 5:
            self.goals_scored.pop(0)
            self.goals_conceded.pop(0)
            self.points.pop(0)
            
        if pts == 3:
            self.streak = self.streak + 1 if self.streak > 0 else 1
        elif pts == 0:
            self.streak = self.streak - 1 if self.streak < 0 else -1
        else:
            self.streak = 0
            
    def get_features(self):
        if len(self.points) == 0:
            return 0.0, 0.0, 0.0, 0
        return (
            sum(self.points),
            sum(self.goals_scored),
            sum(self.goals_conceded),
            self.streak
        )

def feature_engineering(data):
    """Engineers rolling averages and form for teams chronologically."""
    print("Engineering features...")
    features = []
    labels_h2h = []
    labels_btts = []
    
    # Dictionary to keep track of team states
    team_states = {}
    
    # Mapping FTR (Full Time Result) to numerical targets
    # 0 = Home Win, 1 = Draw, 2 = Away Win
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
            
        # Get current features BEFORE the match
        h_pts, h_gs, h_gc, h_streak = team_states[home].get_features()
        a_pts, a_gs, a_gc, a_streak = team_states[away].get_features()
        
        # We only use rows where both teams have played at least 5 games for training
        if len(team_states[home].points) >= 5 and len(team_states[away].points) >= 5:
            feature_row = [
                h_pts, h_gs, h_gc, h_streak,
                a_pts, a_gs, a_gc, a_streak,
                h_pts - a_pts,  # Points diff
                (h_gs - h_gc) - (a_gs - a_gc) # GD diff
            ]
            features.append(feature_row)
            labels_h2h.append(label_map[ftr])
            # BTTS mapping: 1 if both scored, 0 otherwise
            btts_val = 1 if row['FTHG'] > 0 and row['FTAG'] > 0 else 0
            labels_btts.append(btts_val)
            
        # Update team states AFTER the match
        if ftr == 'H':
            team_states[home].update(row['FTHG'], row['FTAG'], 3)
            team_states[away].update(row['FTAG'], row['FTHG'], 0)
        elif ftr == 'A':
            team_states[home].update(row['FTHG'], row['FTAG'], 0)
            team_states[away].update(row['FTAG'], row['FTHG'], 3)
        else:
            team_states[home].update(row['FTHG'], row['FTAG'], 1)
            team_states[away].update(row['FTAG'], row['FTHG'], 1)
            
    X = np.array(features)
    y_h2h = np.array(labels_h2h)
    y_btts = np.array(labels_btts)
    return X, y_h2h, y_btts, team_states

def train_model():
    """Builds and trains the ML model pipeline."""
    data = download_data()
    X, y_h2h, y_btts, team_states = feature_engineering(data)
    
    print(f"Dataset shape: {X.shape}")
    X_train, X_test, y_h2h_train, y_h2h_test, y_btts_train, y_btts_test = train_test_split(
        X, y_h2h, y_btts, test_size=0.1, random_state=42
    )
    
    print("Training XGBoost H2H Classifier...")
    model = XGBClassifier(
        objective='multi:softprob',
        num_class=3,
        n_estimators=150,
        max_depth=4,
        learning_rate=0.05,
        subsample=0.8,
        colsample_bytree=0.8,
        random_state=42
    )
    
    model.fit(X_train, y_h2h_train)
    
    # Evaluate H2H
    y_pred = model.predict(X_test)
    acc = accuracy_score(y_h2h_test, y_pred)
    print(f"H2H Model Accuracy: {acc:.4f}")
    
    print("Training XGBoost BTTS Classifier...")
    model_btts = XGBClassifier(
        objective='binary:logistic',
        n_estimators=100,
        max_depth=4,
        learning_rate=0.05,
        subsample=0.8,
        colsample_bytree=0.8,
        random_state=42
    )
    
    model_btts.fit(X_train, y_btts_train)
    btts_pred = model_btts.predict(X_test)
    acc_btts = accuracy_score(y_btts_test, btts_pred)
    print(f"BTTS Model Accuracy: {acc_btts:.4f}")
    
    # Save model and team states
    joblib.dump(model, MODEL_PATH)
    joblib.dump(model_btts, 'model_btts.joblib')
    joblib.dump(team_states, STATE_PATH)
    print(f"Models and states saved successfully to {MODEL_PATH}, model_btts.joblib and {STATE_PATH}")

if __name__ == "__main__":
    train_model()
