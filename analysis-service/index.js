require('dotenv').config();
const { Pool } = require('pg');
const axios = require('axios');
const cron = require('node-cron');

const DB_URL = process.env.DATABASE_URL || 'postgresql://postgres:postgres@db:5432/bettingdb';
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const AI_SERVICE_URL = process.env.AI_SERVICE_URL || 'http://ai-service:8000';

const pool = new Pool({
  connectionString: DB_URL,
});

async function notifyDiscord(matchData) {
  if (!DISCORD_WEBHOOK_URL) {
    console.log('No DISCORD_WEBHOOK_URL provided, skipping discord notification.');
    return;
  }
  
  const timeStr = new Date(matchData.date).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
  
  const message = `
🔥 MATCH: ${matchData.home_team} vs ${matchData.away_team}
⏰ TIME: ${timeStr}
📊 PREDICTION: ${matchData.prediction.most_likely_outcome}
💰 ODDS: ${matchData.prediction.value_bet.bookmaker_odds}
📈 MODEL PROBABILITY: ${matchData.prediction.value_bet.model_probability}%
✅ VALUE BET: YES
🧠 CONFIDENCE: ${matchData.prediction.value_bet.confidence_score}/10
`;

  try {
    await axios.post(DISCORD_WEBHOOK_URL, { content: message.trim() });
    console.log(`Successfully sent to Discord: ${matchData.home_team} vs ${matchData.away_team}`);
  } catch (err) {
    console.error('Error sending to Discord:', err.message);
  }
}

async function analyzeUpcomingMatches() {
  console.log('Running analysis on upcoming matches...');
  const client = await pool.connect();
  
  try {
    // Select matches that have not started, have odds, and haven't been evaluated/sent
    const res = await client.query(`
      SELECT * FROM matches 
      WHERE date > NOW() 
      AND sent_to_discord = false 
      AND odds_home IS NOT NULL
      AND status IN ('NS', 'TBD');
    `);
    
    console.log(`Found ${res.rows.length} matches to analyze.`);
    
    for (const match of res.rows) {
      try {
        // Query AI Service
        const aiResponse = await axios.post(`${AI_SERVICE_URL}/predict`, {
          home_team: match.home_team,
          away_team: match.away_team,
          odds_home: parseFloat(match.odds_home),
          odds_draw: parseFloat(match.odds_draw),
          odds_away: parseFloat(match.odds_away)
        });
        
        const prediction = aiResponse.data;
        
        // Mark as sent so we don't query it again endlessly
        await client.query(`
          UPDATE matches 
          SET sent_to_discord = true, ai_forecast = $1, ai_edge = $2 
          WHERE fixture_id = $3
        `, [
          prediction.most_likely_outcome, 
          prediction.value_bet.edge_percent, 
          match.fixture_id
        ]);
        
        // Determine high-quality value bet
        // The user asked for Only high-confidence bets -> confidence > 7 and edge > 5%
        if (prediction.value_bet.is_value && prediction.value_bet.confidence_score > 7.0 && prediction.value_bet.edge_percent > 5.0) {
          await notifyDiscord({ ...match, prediction });
        }
        
      } catch (aiError) {
        // Normal to fail 404 if team wasn't in historical database (e.g. newly promoted)
        if (aiError.response && aiError.response.status === 404) {
          console.log(`Skipping ${match.home_team} vs ${match.away_team} (No historical AI data)`);
          // Mark as processed so we don't spam errors
          await client.query(`UPDATE matches SET sent_to_discord = true WHERE fixture_id = $1`, [match.fixture_id]);
        } else {
          console.error(`Error analyzing match ${match.fixture_id}:`, aiError.message);
        }
      }
    }
    
  } catch (err) {
    console.error('Error in analyze function:', err);
  } finally {
    client.release();
  }
}

function start() {
  // Let the DB init and data-service run first
  setTimeout(() => {
    analyzeUpcomingMatches();
  }, 10000);
  
  // Run every 10 minutes (user requirement: Run every 5–10 minutes)
  cron.schedule('*/10 * * * *', () => {
    analyzeUpcomingMatches();
  });
  
  console.log('Analysis service scheduled to run every 10 minutes.');
}

start();
