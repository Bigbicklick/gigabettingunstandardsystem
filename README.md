# Gigabet AI System

A complete, production-ready AI-powered sports betting analysis system running continuously on a VPS, sending high-quality betting suggestions to Discord.

## Requirements
- Ubuntu VPS
- Docker
- Docker Compose
- The Odds API key (free tier 500 req/month)
- Discord Webhook URL

## Setup Instructions

1. **Clone the repository** (if you haven't already):
   ```bash
   git clone <your-repo>
   cd ai_betting_system
   ```

2. **Environment Variables**:
   Copy the example config and edit it with your real keys.
   ```bash
   cp .env.example .env
   nano .env
   ```
   Add your The Odds API Key, Discord Webhook, and choose a DB password.

3. **Deploy the System**:
   Start the entire stack using Docker Compose. The Postgres DB, Redis, AI model (FastAPI), Data Fetcher, and Analysis Cron will all start automatically.
   
   ```bash
   sudo docker-compose up --build -d
   ```

## Architecture
1. **AI Service** (`ai-service`): Python FastAPI app. Downloads 5 seasons of real Premier League matches via `football-data.co.uk`, engineers chronological form & streak features, trains an **XGBoost Classifier**, and serves predictions and value bet calculations.
2. **Data Service** (`data-service`): Node.js cron. Queries the public `The Odds API` every 12 hours to fetch upcoming matches for the top 5 leagues (and MLS) and saves them (along with bet365 h2h odds) to PostgreSQL.
3. **Analysis Service** (`analysis-service`): Node.js cron. Evaluates those matches every 10 minutes against the AI. If the AI detects a value bet edge > 5% and confidence > 7/10, a message is immediately fired to the Discord Webhook.

## Managing the Service
Check logs of all services:
```bash
sudo docker-compose logs -f
```

Check specifically what the AI is predicting:
```bash
sudo docker-compose logs -f analysis-service
```
