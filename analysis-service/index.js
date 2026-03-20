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

// Notification functions handled inline
async function analyzeUpcomingMatches() {
  console.log('Running analysis on upcoming matches...');
  const client = await pool.connect();
  
  try {
    // Select matches that haven't started, are playing in the next 24h, have odds, and haven't been evaluated/sent
    const res = await client.query(`
      SELECT * FROM matches 
      WHERE date > NOW() 
      AND date < NOW() + INTERVAL '24 hours'
      AND sent_to_discord = false 
      AND odds_home IS NOT NULL
      AND status IN ('NS', 'TBD');
    `);
    
    console.log(`Found ${res.rows.length} matches to analyze.`);
    
    for (const match of res.rows) {
      try {
        const aiResponse = await axios.post(`${AI_SERVICE_URL}/predict`, {
          home_team: match.home_team,
          away_team: match.away_team,
          odds_home: match.odds_home ? parseFloat(match.odds_home) : null,
          odds_draw: match.odds_draw ? parseFloat(match.odds_draw) : null,
          odds_away: match.odds_away ? parseFloat(match.odds_away) : null,
          odds_btts_yes: match.odds_btts_yes ? parseFloat(match.odds_btts_yes) : null,
          odds_btts_no: match.odds_btts_no ? parseFloat(match.odds_btts_no) : null
        });
        
        const prediction = aiResponse.data;
        const h2h = prediction.value_bet;
        const btts = prediction.btts_value_bet;
        const timeStr = new Date(match.date).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
        
        // H2H Signal
        if (h2h && h2h.is_value && h2h.confidence_score > 7.0 && h2h.edge_percent > 5.0) {
          const msg = `
🔥 **GIGA SIGNAL: H2H MARKET** 🔥
⚽ **MATCH**: ${match.home_team} vs ${match.away_team}
⏰ **TIME**: ${timeStr}
📊 **PREDICTION**: ${prediction.most_likely_outcome}
💰 **MIN ODDS**: ${h2h.bookmaker_odds}
📈 **MODEL PROBABILITY**: ${h2h.model_probability}%
✅ **VALUE BET EDGE**: ${h2h.edge_percent}%
🧠 **CONFIDENCE**: ${h2h.confidence_score}/10
💸 **SUGGESTED STAKE**: ${h2h.recommended_stake_percentage}% of bankroll (1/4 Kelly)`;
          if (DISCORD_WEBHOOK_URL) await axios.post(DISCORD_WEBHOOK_URL, { content: msg.trim() });
        }
        
        // BTTS Signal
        if (btts && btts.is_value && btts.confidence_score > 6.0 && btts.edge_percent > 5.0) {
          const msgBtts = `
🥅 **GIGA SIGNAL: BTTS MARKET** (Obie Drużyny Strzelą) 🥅
⚽ **MATCH**: ${match.home_team} vs ${match.away_team}
⏰ **TIME**: ${timeStr}
📉 **PREDICTION**: ${btts.recommended_bet}
💰 **MIN ODDS**: ${btts.bookmaker_odds}
📈 **MODEL PROBABILITY**: ${btts.model_probability}%
✅ **VALUE BET EDGE**: ${btts.edge_percent}%
🧠 **CONFIDENCE**: ${btts.confidence_score}/10
💸 **SUGGESTED STAKE**: ${btts.recommended_stake_percentage}% of bankroll (1/4 Kelly)`;
          if (DISCORD_WEBHOOK_URL) await axios.post(DISCORD_WEBHOOK_URL, { content: msgBtts.trim() });
        }
        
        // Mark as sent so we don't query it again endlessly
        await client.query(`
          UPDATE matches 
          SET sent_to_discord = true, 
              ai_forecast = $1, 
              ai_edge = $2,
              ai_btts_forecast = $3,
              ai_btts_edge = $4
          WHERE fixture_id = $5
        `, [
          prediction.most_likely_outcome, 
          h2h ? h2h.edge_percent : null, 
          btts ? btts.recommended_bet : null,
          btts ? btts.edge_percent : null,
          match.fixture_id
        ]);
        
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

async function sendHourlyReport() {
  if (!DISCORD_WEBHOOK_URL) return;
  const client = await pool.connect();
  try {
    const res = await client.query(`
      SELECT home_team, away_team, ai_forecast, ai_edge, ai_btts_forecast, ai_btts_edge
      FROM matches 
      WHERE date > NOW() AND date < NOW() + INTERVAL '24 hours'
      AND ai_forecast IS NOT NULL
    `);
    
    if (res.rows.length === 0) {
      await axios.post(DISCORD_WEBHOOK_URL, { content: "ℹ️ **RAPORT GODZINNY [GigaBet AI]:**\nBrak nadchodzących meczy do analizy na najbliższe 24h w śledzonych ligach." });
      return;
    }
    
    let report = "ℹ️ **RAPORT GODZINNY [Multi-Market]:**\nPrzeanalizowałem dzisiejsze mecze w tle (szukając Krawędzi), ale obecnie nie ma wystarczająco mocnych sygnałów (Value Bets). Oto lista poddanych analizie spotkań na najbliższe 24h:\n\n";
    let count = 0;
    for (const m of res.rows) {
      if (count < 15) {
         report += `⚽ ${m.home_team} vs ${m.away_team}\n   ├─ H2H: ${m.ai_forecast} (Edge: ${m.ai_edge}%)\n   └─ BTTS: ${m.ai_btts_forecast || 'N/A'} (Edge: ${m.ai_btts_edge || 0}%)\n`;
         count++;
      }
    }
    if (res.rows.length > 15) {
       report += `\n...oraz ${res.rows.length - 15} innych meczów (łącznie ${res.rows.length}).`;
    }
    
    await axios.post(DISCORD_WEBHOOK_URL, { content: report });
    console.log('Sent hourly report to Discord.');
  } catch (err) {
    console.error('Error sending hourly report:', err);
  } finally {
    client.release();
  }
}

function start() {
  // Let the DB init and data-service run first
  setTimeout(() => {
    analyzeUpcomingMatches();
  }, 10000);
  
  // Run every 10 minutes for signals
  cron.schedule('*/10 * * * *', () => {
    analyzeUpcomingMatches();
  });

  // Run every hour at minute 0 for the summary report
  cron.schedule('0 * * * *', () => {
    sendHourlyReport();
  });
  
  console.log('Analysis service scheduled to run every 10 minutes (Signals) and every 1 hour (Reports).');
}

start();
