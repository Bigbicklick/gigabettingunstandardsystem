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

// Regex: exactly 32 lowercase hex chars (The Odds API key format)
const ODDS_KEY_REGEX = /^[a-f0-9]{32}$/i;

async function saveNewOddsKeyToDB(newKey) {
  const pgClient = await pool.connect();
  try {
    await pgClient.query(`
      INSERT INTO config (key, value, updated_at)
      VALUES ('the_odds_api_key', $1, NOW())
      ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()
    `, [newKey]);
  } finally {
    pgClient.release();
  }
}

discordClient.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  // --- API KEY SWAP HANDLER ---
  const trimmed = message.content.trim();
  if (ODDS_KEY_REGEX.test(trimmed)) {
    try {
      await saveNewOddsKeyToDB(trimmed);
      await message.reply(
        `✅ **Nowy klucz API zapisany!**\n` +
        `🔑 \`${trimmed.substring(0, 8)}...${trimmed.substring(24)}\`\n` +
        `⏳ Bot wczyta go w ciągu **2 minut** i wznowi pobieranie danych NBA/tenis/esport automatycznie.\n` +
        `Nie musisz nic więcej robić.`
      );
      console.log(`New Odds API key received from Discord user ${message.author.tag} and saved to DB.`);
    } catch (e) {
      console.error('Failed to save new Odds API key:', e.message);
      await message.reply('❌ Błąd zapisu klucza do bazy danych. Sprawdź logi.');
    }
    return;
  }

  if (message.content === 'betsfoot') {
     console.log('Received betsfoot command');
     const pgClient = await pool.connect();
     try {
        // 72h window, ALL matches — with or without AI forecast
        const res = await pgClient.query(`
          SELECT home_team, away_team, date, league_name,
                 odds_home, odds_draw, odds_away,
                 ai_forecast, ai_edge,
                 ai_btts_forecast, ai_btts_edge,
                 ai_ou_forecast, ai_ou_edge,
                 ai_corners_forecast, ai_corners_edge,
                 ai_dc_forecast, ai_dc_edge,
                 ai_dnb_forecast, ai_dnb_edge
          FROM matches
          WHERE date > NOW() AND date < NOW() + INTERVAL '72 hours'
          ORDER BY date ASC
        `);

        if (res.rows.length === 0) {
          return message.reply(
            "ℹ️ **Brak nadchodzących meczów piłkarskich na najbliższe 72h.**\n" +
            "Liga nie gra dziś ani jutro (typowy przerwa śródsezonu w tygodniu).\n" +
            "Sprawdź w weekend — Premier League, La Liga, Bundesliga grają w sobotę/niedzielę."
          );
        }

        const formatEdge = (edge) => {
          if (edge === null || edge === undefined) return '—';
          if (edge <= 0) return `${edge}%`;
          return `**+${edge}%** ✅`;
        };
        const formatOdds = (o) => o ? o.toFixed(2) : '-';

        let currentReport = `⚽ **RAPORT PIŁKARSKI [XGBoost Ensemble AI]** ⚽\n📅 Najbliższe ${res.rows.length} mecz(y) — okno 72h\n\n`;
        const payloads = [];
        let akoCandidates = [];

        for (const m of res.rows) {
          const dt = new Date(m.date);
          const dateStr = dt.toLocaleDateString('pl-PL', { weekday: 'short', day: '2-digit', month: '2-digit' });
          const timeStr = dt.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });

          let chunk = `**${m.home_team} vs ${m.away_team}**\n`;
          chunk += `> 📅 ${dateStr} ${timeStr}`;
          if (m.league_name) chunk += ` | 🏆 ${m.league_name}`;
          chunk += '\n';

          if (m.odds_home || m.odds_draw || m.odds_away) {
            chunk += `> 💰 Kursy: ${formatOdds(m.odds_home)} / ${formatOdds(m.odds_draw)} / ${formatOdds(m.odds_away)}\n`;
          }

          if (m.ai_forecast) {
            chunk += `> 🧠 **AI: ${m.ai_forecast}** (Edge: ${formatEdge(m.ai_edge)})\n`;
            if (m.ai_btts_forecast)    chunk += `> BTTS: ${m.ai_btts_forecast} (${formatEdge(m.ai_btts_edge)})\n`;
            if (m.ai_ou_forecast)      chunk += `> Gole O/U: ${m.ai_ou_forecast} (${formatEdge(m.ai_ou_edge)})\n`;
            if (m.ai_dc_forecast)      chunk += `> DC: ${m.ai_dc_forecast} (${formatEdge(m.ai_dc_edge)})\n`;
            if (m.ai_dnb_forecast)     chunk += `> DNB: ${m.ai_dnb_forecast} (${formatEdge(m.ai_dnb_edge)})\n`;
            if (m.ai_corners_forecast) chunk += `> Corners: ${m.ai_corners_forecast} (${formatEdge(m.ai_corners_edge)})\n`;

            // AKO candidates
            if (m.ai_edge > 3.0)         akoCandidates.push({ match: `${m.home_team} vs ${m.away_team}`, pick: m.ai_forecast, edge: m.ai_edge });
            if (m.ai_btts_edge > 3.0)    akoCandidates.push({ match: `${m.home_team} vs ${m.away_team}`, pick: m.ai_btts_forecast, edge: m.ai_btts_edge });
            if (m.ai_ou_edge > 3.0)      akoCandidates.push({ match: `${m.home_team} vs ${m.away_team}`, pick: m.ai_ou_forecast, edge: m.ai_ou_edge });
            if (m.ai_corners_edge > 3.0) akoCandidates.push({ match: `${m.home_team} vs ${m.away_team}`, pick: m.ai_corners_forecast, edge: m.ai_corners_edge });
            if (m.ai_dc_edge > 3.0)      akoCandidates.push({ match: `${m.home_team} vs ${m.away_team}`, pick: m.ai_dc_forecast, edge: m.ai_dc_edge });
          } else {
            chunk += `> 🤖 AI: oczekiwanie na analizę...\n`;
          }
          chunk += '\n';

          if (currentReport.length + chunk.length > 1900) {
            payloads.push(currentReport);
            currentReport = chunk;
          } else {
            currentReport += chunk;
          }
        }

        // AKO coupon
        akoCandidates.sort((a, b) => b.edge - a.edge);
        const topAko = [...new Map(akoCandidates.map(c => [c.match, c])).values()].slice(0, 4);
        if (topAko.length >= 2) {
          let akoText = "\n🎟️ **SUGEROWANY KUPON AKO** 🎟️\n";
          topAko.forEach((c, i) => {
            akoText += `${i + 1}. ${c.match} → **${c.pick}** (Edge: +${c.edge}%)\n`;
          });
          akoText += "💸 Postaw jako AKO dla większego zysku!\n";
          if (currentReport.length + akoText.length > 1900) {
            payloads.push(currentReport);
            currentReport = akoText;
          } else {
            currentReport += akoText;
          }
        }

        if (currentReport.trim().length > 0) payloads.push(currentReport);
        for (const payload of payloads) await message.reply(payload);

     } catch(e) {
        console.error(e);
        return message.reply("Wystąpił błąd podczas pobierania meczów (Database I/O).");
     } finally {
        pgClient.release();
     }
  } else if (message.content === 'betsbasket') {
     console.log('Received betsbasket command');
     const pgClient = await pool.connect();
     try {
        const res = await pgClient.query(`
          SELECT home_team, away_team, odds_home, odds_away, odds_spread_home, odds_spread_away, odds_totals_over, ai_forecast, ai_edge
          FROM matches_basket 
          WHERE date > NOW() AND date < NOW() + INTERVAL '48 hours'
        `);
        
        if (res.rows.length === 0) {
          return message.reply("ℹ️ Mój wirtualny mózg sprawdził bazę. Obecnie nie ma pobranych meczów NBA na najbliższe 48h.");
        }
        
        let currentReport = "🏀 **KURSOWY RAPORT NBA [Multi-Regional API: Phase 10]** 🏀🔥\nThe Giga Brain: Live XGBoost Engine\n\n";
        const payloads = [];
        
        for (const m of res.rows) {
             const formatEdge = (edge) => (!edge || edge <= 0) ? '0%' : `${edge}%`;

             let chunk = `**${m.home_team} vs ${m.away_team}**\n`;
             chunk += `> ML H2H: Home ${m.odds_home || '-'} | Away ${m.odds_away || '-'}\n`;
             if (m.odds_spread_home) chunk += `> Spread Home: ${m.odds_spread_home}\n`;
             if (m.odds_totals_over) chunk += `> Totals Over: ${m.odds_totals_over}\n`;
             chunk += `> AI Prediction: ${m.ai_forecast || 'Pending...'} (Edge: ${formatEdge(m.ai_edge)})\n\n`;
             
             if (currentReport.length + chunk.length > 1900) {
                 payloads.push(currentReport);
                 currentReport = chunk;
             } else {
                 currentReport += chunk;
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
        return message.reply("Wystąpił błąd podczas pobierania meczów NBA (Database I/O).");
     } finally {
        pgClient.release();
     }
  } else if (message.content === 'betstenis') {
     console.log('Received betstenis command');
     const pgClient = await pool.connect();
     try {
        const res = await pgClient.query(`
          SELECT home_team, away_team, odds_home, odds_away, ai_forecast, ai_edge
          FROM matches_tennis 
          WHERE date > NOW() AND date < NOW() + INTERVAL '48 hours'
        `);
        if (res.rows.length === 0) return message.reply("ℹ️ Mój wirtualny mózg sprawdził bazę. Obecnie nie ma pobranych meczów Tenisa (ATP) na najbliższe 48h.");
        
        let cr = "🎾 **KURSOWY RAPORT TENIS [Multi-Regional ATP: Phase 10]** 🎾🔥\nTheSportsDB Live XGBoost Fetch\n\n";
        const payloads = [];
        for (const m of res.rows) {
             const fe = (e) => (!e || e <= 0) ? '0%' : `${e}%`;
             let chunk = `**${m.home_team} vs ${m.away_team}**\n> ML H2H: Home ${m.odds_home || '-'} | Away ${m.odds_away || '-'}\n> AI Prediction: ${m.ai_forecast || 'Pending...'} (Edge: ${fe(m.ai_edge)})\n\n`;
             if (cr.length + chunk.length > 1900) { payloads.push(cr); cr = chunk; } else cr += chunk;
        }
        if (cr.trim().length > 0) payloads.push(cr);
        for (const p of payloads) await message.reply(p);
     } catch(e) {
        console.error(e);
        return message.reply("Wystąpił błąd DB dla Tenisa.");
     } finally { pgClient.release(); }
  } else if (message.content === 'betsesport') {
     console.log('Received betsesport command');
     const pgClient = await pool.connect();
     try {
        const res = await pgClient.query(`
          SELECT home_team, away_team, odds_home, odds_away, ai_forecast, ai_edge
          FROM matches_esport 
          WHERE date > NOW() AND date < NOW() + INTERVAL '48 hours'
        `);
        if (res.rows.length === 0) return message.reply("ℹ️ Mój wirtualny mózg sprawdził bazę. Obecnie nie ma pobranych meczów Esportu (CS2/LoL) na najbliższe 48h.");
        
        let cr = "🎮 **KURSOWY RAPORT ESPORT [Multi-Regional: Phase 10]** 🎮🔥\nTheSportsDB Live AI Engine\n\n";
        const payloads = [];
        for (const m of res.rows) {
             const fe = (e) => (!e || e <= 0) ? '0%' : `${e}%`;
             let chunk = `**${m.home_team} vs ${m.away_team}**\n> ML H2H: Home ${m.odds_home || '-'} | Away ${m.odds_away || '-'}\n> AI Prediction: ${m.ai_forecast || 'Pending...'} (Edge: ${fe(m.ai_edge)})\n\n`;
             if (cr.length + chunk.length > 1900) { payloads.push(cr); cr = chunk; } else cr += chunk;
        }
        if (cr.trim().length > 0) payloads.push(cr);
        for (const p of payloads) await message.reply(p);
     } catch(e) {
        console.error(e);
        return message.reply("Wystąpił błąd DB dla Esportu.");
     } finally { pgClient.release(); }
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
        
        // H2H Signal — uses ensemble final_prob_pct and value_pct
        if (h2h && h2h.is_value && h2h.confidence_score > 7.0 && h2h.value_pct > 5.0) {
          const modelsLine = h2h.agreeing_model_names && h2h.agreeing_model_names.length
            ? h2h.agreeing_model_names.map(m => `${m} ✓`).join(' | ') + ` (${h2h.models_agreeing}/4)`
            : `${h2h.models_agreeing || '?'}/4`;
          const rangeFlag = h2h.in_preferred_odds_range ? ' ✅ preferred range' : '';
          const msg = `
🔥 **GIGA SIGNAL: H2H MARKET** 🔥
⚽ **MATCH**: ${match.home_team} vs ${match.away_team}
⏰ **TIME**: ${timeStr}
📊 **PREDICTION**: ${h2h.recommended_bet}
💰 **ODDS**: ${h2h.bookmaker_odds}${rangeFlag}
📈 **FINAL PROBABILITY**: ${h2h.final_prob_pct || h2h.model_probability}%
✅ **VALUE**: +${h2h.value_pct || h2h.edge_percent}%
🧠 **MODELS AGREEING**: ${modelsLine}
💡 **REASONING**: ${h2h.reasoning || 'N/A'}
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
      await axios.post(DISCORD_WEBHOOK_URL, { content: "ℹ️ **RAPORT GODZINNY [Multi-Market AI]:**\nBrak nadchodzących meczy piłkarskich do analizy na najbliższe 24h z 18 Giga Lig Europejskich." });
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

async function analyzeUpcomingBasketMatches() {
  console.log('Running analysis on upcoming NBA matches...');
  const client = await pool.connect();
  
  try {
    const res = await client.query(`
      SELECT * FROM matches_basket 
      WHERE date > NOW() 
      AND date < NOW() + INTERVAL '48 hours'
      AND sent_to_discord = false 
      AND odds_home IS NOT NULL
      AND status IN ('NS', 'TBD');
    `);
    
    console.log(`Found ${res.rows.length} NBA matches to analyze.`);
    
    for (const match of res.rows) {
      try {
        const aiResponse = await axios.post(`${AI_SERVICE_URL}/predict_basket`, {
          home_team: match.home_team,
          away_team: match.away_team,
          odds_home: match.odds_home ? parseFloat(match.odds_home) : null,
          odds_away: match.odds_away ? parseFloat(match.odds_away) : null,
          odds_spread_home: match.odds_spread_home ? parseFloat(match.odds_spread_home) : null,
          odds_spread_away: match.odds_spread_away ? parseFloat(match.odds_spread_away) : null,
          odds_totals_over: match.odds_totals_over ? parseFloat(match.odds_totals_over) : null,
          odds_totals_under: match.odds_totals_under ? parseFloat(match.odds_totals_under) : null
        });
        
        const prediction = aiResponse.data.value_bet;
        
        // Brak Edge Threshold w trakcie Scaffoldingowania
        await client.query(`
          UPDATE matches_basket 
          SET sent_to_discord = true, 
              ai_forecast = $1, 
              ai_edge = $2
          WHERE fixture_id = $3
        `, [
          prediction.recommended_bet, 
          prediction.edge_percent, 
          match.fixture_id
        ]);
        
      } catch (aiError) {
        console.error(`Error analyzing NBA match ${match.fixture_id}:`, aiError.message);
      }
    }
  } catch (err) {
    console.error('Error in analyze Basket function:', err);
  } finally {
    client.release();
  }
}

async function analyzeUpcomingTennisMatches() {
  const client = await pool.connect();
  try {
    const res = await client.query(`SELECT * FROM matches_tennis WHERE date > NOW() AND date < NOW() + INTERVAL '48 hours' AND sent_to_discord = false AND status IN ('NS', 'TBD');`);
    for (const match of res.rows) {
      try {
        const ar = await axios.post(`${AI_SERVICE_URL}/predict_tennis`, { home_team: match.home_team, away_team: match.away_team, odds_home: typeof match.odds_home !== 'undefined' ? parseFloat(match.odds_home) : null, odds_away: typeof match.odds_away !== 'undefined' ? parseFloat(match.odds_away) : null });
        const pred = ar.data.value_bet;
        await client.query(`UPDATE matches_tennis SET sent_to_discord = true, ai_forecast = $1, ai_edge = $2 WHERE fixture_id = $3`, [pred.recommended_bet, pred.edge_percent, match.fixture_id]);
      } catch (e) {}
    }
  } catch (e) {
  } finally { client.release(); }
}

async function analyzeUpcomingEsportsMatches() {
  const client = await pool.connect();
  try {
    const res = await client.query(`SELECT * FROM matches_esport WHERE date > NOW() AND date < NOW() + INTERVAL '48 hours' AND sent_to_discord = false AND status IN ('NS', 'TBD');`);
    for (const match of res.rows) {
      try {
        const ar = await axios.post(`${AI_SERVICE_URL}/predict_esport`, { home_team: match.home_team, away_team: match.away_team, odds_home: typeof match.odds_home !== 'undefined' ? parseFloat(match.odds_home) : null, odds_away: typeof match.odds_away !== 'undefined' ? parseFloat(match.odds_away) : null });
        const pred = ar.data.value_bet;
        await client.query(`UPDATE matches_esport SET sent_to_discord = true, ai_forecast = $1, ai_edge = $2 WHERE fixture_id = $3`, [pred.recommended_bet, pred.edge_percent, match.fixture_id]);
      } catch (e) {}
    }
  } catch (e) {
  } finally { client.release(); }
}

function start() {
  // Let the DB init and data-service run first
  setTimeout(() => {
    analyzeUpcomingMatches();
    analyzeUpcomingBasketMatches();
    analyzeUpcomingTennisMatches();
    analyzeUpcomingEsportsMatches();
  }, 10000);
  
  // Run every 10 minutes for signals
  cron.schedule('*/10 * * * *', () => {
    analyzeUpcomingMatches();
    analyzeUpcomingBasketMatches();
    analyzeUpcomingTennisMatches();
    analyzeUpcomingEsportsMatches();
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
