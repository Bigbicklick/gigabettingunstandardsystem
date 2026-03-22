require('dotenv').config();
const { Pool } = require('pg');
const axios = require('axios');
const cron = require('node-cron');
const { Client, GatewayIntentBits } = require('discord.js');

const AI_SERVICE_URL = process.env.AI_SERVICE_URL || 'http://ai-service:8000';
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || '';
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || '';
const DB_URL = process.env.DATABASE_URL || 'postgresql://postgres:postgres@db:5432/bettingdb';

const discordClient = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ]
});

discordClient.on('ready', () => {
  console.log(`Discord Bot logged in as ${discordClient.user.tag}!`);
});

console.log('Checking DISCORD_BOT_TOKEN status: ', DISCORD_BOT_TOKEN ? 'PROVIDED' : 'MISSING');

const getEdgeAdvice = (edge) => {
    if (!edge || edge <= 0) return "nie ma sensu wchodzić ❌";
    if (edge < 3.0) return "możesz spróbować ale nic szalonego 🟡";
    return "obstawiaj na to szczególnie, większe szanse 🔥";
};

discordClient.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  if (message.content === 'bets') {
     console.log('Received bets command');
     const pgClient = await pool.connect();
     try {
        const res = await pgClient.query(`
          SELECT home_team, away_team, ai_forecast, ai_edge, ai_btts_forecast, ai_btts_edge, ai_ou_forecast, ai_ou_edge, ai_corners_forecast, ai_corners_edge, ai_dc_forecast, ai_dc_edge, ai_dnb_forecast, ai_dnb_edge
          FROM matches 
          WHERE date > NOW() AND date < NOW() + INTERVAL '24 hours'
          AND ai_forecast IS NOT NULL
        `);
        
        if (res.rows.length === 0) {
          return message.reply("ℹ️ Mój wirtualny mózg sprawdził bazę. Obecnie nie ma żadnych zbuforowanych meczów na najbliższe 24h z Free Tierowym Edge'm.");
        }
        
        let currentReport = "⚽ **AKTUALNE SKANOWANIE RYNKÓW NA ŻYCZENIE SZEFA** ⚽\n\n";
        const payloads = [];
        
        for (const m of res.rows) {
             const formatEdge = (edge) => (!edge || edge <= -5000) ? 'Brak kursów' : `${edge}% - ${getEdgeAdvice(edge)}`;

             let chunk = `**${m.home_team} vs ${m.away_team}**\n`;
             chunk += `> Zwycięzca: ${m.ai_forecast} (Edge: ${formatEdge(m.ai_edge)})\n`;
             chunk += `> Podwójna Szansa (DC): ${m.ai_dc_forecast || 'Brak'} (Edge: ${formatEdge(m.ai_dc_edge)})\n`;
             chunk += `> Remis Nie Ma Zakładu (DNB): ${m.ai_dnb_forecast || 'Brak'} (Edge: ${formatEdge(m.ai_dnb_edge)})\n`;
             chunk += `> Gole O/U: ${m.ai_ou_forecast || 'Brak'} (Edge: ${formatEdge(m.ai_ou_edge)})\n`;
             chunk += `> BTTS: ${m.ai_btts_forecast || 'Brak'} (Edge: ${formatEdge(m.ai_btts_edge)})\n`;
             chunk += `> Corners: ${m.ai_corners_forecast || 'Brak'} (Edge: ${formatEdge(m.ai_corners_edge)})\n\n`;
             
             if (currentReport.length + chunk.length > 1900) {
                 payloads.push(currentReport);
                 currentReport = chunk;
             } else {
                 currentReport += chunk;
             }
        }
        
        let akoCandidates = [];
        res.rows.forEach(m => {
            if (m.ai_edge > 3.0) akoCandidates.push({ match: `${m.home_team} vs ${m.away_team}`, pick: m.ai_forecast, edge: m.ai_edge });
            if (m.ai_btts_edge > 3.0) akoCandidates.push({ match: `${m.home_team} vs ${m.away_team}`, pick: m.ai_btts_forecast, edge: m.ai_btts_edge });
            if (m.ai_ou_edge > 3.0) akoCandidates.push({ match: `${m.home_team} vs ${m.away_team}`, pick: m.ai_ou_forecast, edge: m.ai_ou_edge });
            if (m.ai_corners_edge > 3.0) akoCandidates.push({ match: `${m.home_team} vs ${m.away_team}`, pick: m.ai_corners_forecast, edge: m.ai_corners_edge });
            if (m.ai_dc_edge > 3.0) akoCandidates.push({ match: `${m.home_team} vs ${m.away_team}`, pick: m.ai_dc_forecast, edge: m.ai_dc_edge });
            if (m.ai_dnb_edge > 3.0) akoCandidates.push({ match: `${m.home_team} vs ${m.away_team}`, pick: m.ai_dnb_forecast, edge: m.ai_dnb_edge });
        });
        
        akoCandidates.sort((a, b) => b.edge - a.edge);
        const topAko = akoCandidates.slice(0, 4);
        
        if (topAko.length >= 2) {
            let akoText = "\n🎟️ **SUGEROWANY KUPON AKO (Z NAJLEPSZYCH VALUEBETÓW)** 🎟️\n";
            topAko.forEach((c, idx) => {
               akoText += `${idx + 1}. ${c.match} -> **${c.pick}** (Edge: ${c.edge}%)\n`;
            });
            akoText += "Zbuduj z tego kupon powiększając potencjalny zysk! 💸\n";
            
            if (currentReport.length + akoText.length > 1900) {
                payloads.push(currentReport);
                currentReport = akoText;
            } else {
                currentReport += akoText;
            }
        }

        if (currentReport.trim().length > 0) {
             payloads.push(currentReport);
        }

        for (const payload of payloads) {
             await message.reply(payload);
        }
     } catch(e) {
        console.error(e);
        return message.reply("Wystąpił błąd podczas pobierania meczów (Database I/O).");
     } finally {
        pgClient.release();
     }
  }
});

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
          odds_btts_no: match.odds_btts_no ? parseFloat(match.odds_btts_no) : null,
          odds_ou_over: match.odds_ou_over ? parseFloat(match.odds_ou_over) : null,
          odds_ou_under: match.odds_ou_under ? parseFloat(match.odds_ou_under) : null,
          odds_corners_over: match.odds_corners_over ? parseFloat(match.odds_corners_over) : null,
          odds_corners_under: match.odds_corners_under ? parseFloat(match.odds_corners_under) : null,
          odds_dc_1x: match.odds_dc_1x ? parseFloat(match.odds_dc_1x) : null,
          odds_dc_x2: match.odds_dc_x2 ? parseFloat(match.odds_dc_x2) : null,
          odds_dc_12: match.odds_dc_12 ? parseFloat(match.odds_dc_12) : null,
          odds_dnb_home: match.odds_dnb_home ? parseFloat(match.odds_dnb_home) : null,
          odds_dnb_away: match.odds_dnb_away ? parseFloat(match.odds_dnb_away) : null
        });
        
        const prediction = aiResponse.data;
        const h2h = prediction.value_bet;
        const btts = prediction.btts_value_bet;
        const ou = prediction.ou_value_bet;
        const cor = prediction.corners_value_bet;
        const dc = prediction.dc_value_bet;
        const dnb = prediction.dnb_value_bet;
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
        
        // Over/Under Signal
        if (ou && ou.is_value && ou.confidence_score > 6.0 && ou.edge_percent > 5.0) {
          const msgOu = `
⚽ **GIGA SIGNAL: GOALS OVER/UNDER 2.5** ⚽
🏟️ **MATCH**: ${match.home_team} vs ${match.away_team}
⏰ **TIME**: ${timeStr}
📉 **PREDICTION**: ${ou.recommended_bet}
💰 **MIN ODDS**: ${ou.bookmaker_odds}
📈 **MODEL PROBABILITY**: ${ou.model_probability}%
✅ **VALUE BET EDGE**: ${ou.edge_percent}%
🧠 **CONFIDENCE**: ${ou.confidence_score}/10
💸 **SUGGESTED STAKE**: ${ou.recommended_stake_percentage}% of bankroll (1/4 Kelly)`;
          if (DISCORD_WEBHOOK_URL) await axios.post(DISCORD_WEBHOOK_URL, { content: msgOu.trim() });
        }
        
        // Corners Signal
        if (cor && cor.is_value && cor.confidence_score > 6.0 && cor.edge_percent > 5.0) {
          const msgCor = `
🚩 **GIGA SIGNAL: CORNERS TOTAL (O/U 9.5)** 🚩
⚽ **MATCH**: ${match.home_team} vs ${match.away_team}
⏰ **TIME**: ${timeStr}
📉 **PREDICTION**: ${cor.recommended_bet}
💰 **MIN ODDS**: ${cor.bookmaker_odds}
📈 **MODEL PROBABILITY**: ${cor.model_probability}%
✅ **VALUE BET EDGE**: ${cor.edge_percent}%
🧠 **CONFIDENCE**: ${cor.confidence_score}/10
💸 **SUGGESTED STAKE**: ${cor.recommended_stake_percentage}% of bankroll (1/4 Kelly)`;
          if (DISCORD_WEBHOOK_URL) await axios.post(DISCORD_WEBHOOK_URL, { content: msgCor.trim() });
        }
        
        // Double Chance Signal
        if (dc && dc.is_value && dc.edge_percent > 3.0) {
          const msgDc = `
🛡️ **GIGA SIGNAL: DOUBLE CHANCE (Bezpieczny Rynek)** 🛡️
⚽ **MATCH**: ${match.home_team} vs ${match.away_team}
⏰ **TIME**: ${timeStr}
📉 **PREDICTION**: ${dc.recommended_bet}
💰 **MIN ODDS**: ${dc.bookmaker_odds}
📈 **MODEL PROBABILITY**: ${dc.model_probability}%
✅ **VALUE BET EDGE**: ${dc.edge_percent}%
🧠 **CONFIDENCE**: ${dc.confidence_score}/10
💸 **SUGGESTED STAKE**: ${dc.recommended_stake_percentage}% of bankroll (1/4 Kelly)`;
          if (DISCORD_WEBHOOK_URL) await axios.post(DISCORD_WEBHOOK_URL, { content: msgDc.trim() });
        }
        
        // Draw No Bet Signal
        if (dnb && dnb.is_value && dnb.edge_percent > 3.0) {
          const msgDnb = `
⚖️ **GIGA SIGNAL: DRAW NO BET (Zwrot przy remisie)** ⚖️
⚽ **MATCH**: ${match.home_team} vs ${match.away_team}
⏰ **TIME**: ${timeStr}
📉 **PREDICTION**: ${dnb.recommended_bet}
💰 **MIN ODDS**: ${dnb.bookmaker_odds}
📈 **MODEL PROBABILITY**: ${dnb.model_probability}%
✅ **VALUE BET EDGE**: ${dnb.edge_percent}%
🧠 **CONFIDENCE**: ${dnb.confidence_score}/10
💸 **SUGGESTED STAKE**: ${dnb.recommended_stake_percentage}% of bankroll (1/4 Kelly)`;
          if (DISCORD_WEBHOOK_URL) await axios.post(DISCORD_WEBHOOK_URL, { content: msgDnb.trim() });
        }
        
        // Mark as sent so we don't query it again endlessly
        await client.query(`
          UPDATE matches 
          SET sent_to_discord = true, 
              ai_forecast = $1, 
              ai_edge = $2,
              ai_btts_forecast = $3,
              ai_btts_edge = $4,
              ai_ou_forecast = $5,
              ai_ou_edge = $6,
              ai_corners_forecast = $7,
              ai_corners_edge = $8,
              ai_dc_forecast = $9,
              ai_dc_edge = $10,
              ai_dnb_forecast = $11,
          ai_dnb_edge = $12
      WHERE fixture_id = $13
    `, [
      h2h ? h2h.recommended_bet : null, 
      h2h ? h2h.edge_percent : null, 
          btts ? btts.recommended_bet : null,
          btts ? btts.edge_percent : null,
          ou ? ou.recommended_bet : null,
          ou ? ou.edge_percent : null,
          cor ? cor.recommended_bet : null,
          cor ? cor.edge_percent : null,
          dc ? dc.recommended_bet : null,
          dc ? dc.edge_percent : null,
          dnb ? dnb.recommended_bet : null,
          dnb ? dnb.edge_percent : null,
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
      SELECT home_team, away_team, ai_forecast, ai_edge, ai_btts_forecast, ai_btts_edge, ai_ou_forecast, ai_ou_edge, ai_corners_forecast, ai_corners_edge, ai_dc_forecast, ai_dc_edge, ai_dnb_forecast, ai_dnb_edge
      FROM matches 
      WHERE date > NOW() AND date < NOW() + INTERVAL '24 hours'
      AND ai_forecast IS NOT NULL
    `);
    
    if (res.rows.length === 0) {
      await axios.post(DISCORD_WEBHOOK_URL, { content: "ℹ️ **RAPORT GODZINNY [Multi-Market AI]:**\nBrak nadchodzących meczy do analizy na najbliższe 24h w 4 śledzonych ligach europejskich." });
      return;
    }
    
    let report = "ℹ️ **RAPORT GODZINNY [Multi-Market AI]:**\nPrzeanalizowałem dzisiejsze mecze w tle. Szukam w pełni bezpiecznych matematycznych przewag. Brak pewniaków. Lista zbadanych spotkań w oparciu o The Odds API:\n\n";
    let count = 0;
    for (const m of res.rows) {
      if (count < 10) {
         const formatEdge = (edge) => (!edge || edge <= -5000) ? 'Brak kursów' : `${edge}% - ${getEdgeAdvice(edge)}`;
         
         report += `⚽ **${m.home_team} vs ${m.away_team}**\n`;
         report += `   ├─ Zwycięzca: ${m.ai_forecast} (Edge: ${formatEdge(m.ai_edge)})\n`;
         report += `   ├─ Podwójna Szansa (DC): ${m.ai_dc_forecast || 'N/A'} (Edge: ${formatEdge(m.ai_dc_edge)})\n`;
         report += `   ├─ Remis Nie Ma Zakładu (DNB): ${m.ai_dnb_forecast || 'N/A'} (Edge: ${formatEdge(m.ai_dnb_edge)})\n`;
         report += `   ├─ O.D. Strzelą: ${m.ai_btts_forecast || 'N/A'} (Edge: ${formatEdge(m.ai_btts_edge)})\n`;
         report += `   ├─ Liczba Goli: ${m.ai_ou_forecast || 'N/A'} (Edge: ${formatEdge(m.ai_ou_edge)})\n`;
         report += `   └─ Rzuty Rożne: ${m.ai_corners_forecast || 'N/A'} (Edge: ${formatEdge(m.ai_corners_edge)})\n\n`;
         count++;
      }
    }
    if (res.rows.length > 15) {
       report += `\n...oraz ${res.rows.length - 15} innych meczów (łącznie ${res.rows.length}).`;
    }
    
    let akoCandidates = [];
    res.rows.forEach(m => {
        if (m.ai_edge > 3.0) akoCandidates.push({ match: `${m.home_team} vs ${m.away_team}`, pick: m.ai_forecast, edge: m.ai_edge });
        if (m.ai_btts_edge > 3.0) akoCandidates.push({ match: `${m.home_team} vs ${m.away_team}`, pick: m.ai_btts_forecast, edge: m.ai_btts_edge });
        if (m.ai_ou_edge > 3.0) akoCandidates.push({ match: `${m.home_team} vs ${m.away_team}`, pick: m.ai_ou_forecast, edge: m.ai_ou_edge });
        if (m.ai_corners_edge > 3.0) akoCandidates.push({ match: `${m.home_team} vs ${m.away_team}`, pick: m.ai_corners_forecast, edge: m.ai_corners_edge });
        if (m.ai_dc_edge > 3.0) akoCandidates.push({ match: `${m.home_team} vs ${m.away_team}`, pick: m.ai_dc_forecast, edge: m.ai_dc_edge });
        if (m.ai_dnb_edge > 3.0) akoCandidates.push({ match: `${m.home_team} vs ${m.away_team}`, pick: m.ai_dnb_forecast, edge: m.ai_dnb_edge });
    });
    
    akoCandidates.sort((a, b) => b.edge - a.edge);
    const topAko = akoCandidates.slice(0, 4);
    
    if (topAko.length >= 2) {
        report += "\n\n🎟️ **SUGEROWANY KUPON AKO (Z NAJLEPSZYCH VALUEBETÓW)** 🎟️\n";
        topAko.forEach((c, idx) => {
           report += `${idx + 1}. ${c.match} -> **${c.pick}** (Edge: ${c.edge}%)\n`;
        });
        report += "Zbuduj z tego kupon powiększając potencjalny zysk! 💸\n";
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

if (DISCORD_BOT_TOKEN) {
  console.log('Attempting to login to Discord...');
  discordClient.login(DISCORD_BOT_TOKEN).catch(console.error);
}
