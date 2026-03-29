require('dotenv').config();
const { Pool } = require('pg');
const axios = require('axios');
const cron = require('node-cron');
const { Client, GatewayIntentBits } = require('discord.js');

const AI_SERVICE_URL = process.env.AI_SERVICE_URL || 'http://ai-service:8000';
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || '';
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || '';
const DB_URL = process.env.DATABASE_URL || 'postgresql://postgres:postgres@db:5432/bettingdb';

// Kelly Criterion: returns optimal stake % of bankroll (capped at 20%, null if no edge)
function calcKelly(prob, odds) {
  if (!prob || !odds || odds <= 1.0) return null;
  const b = parseFloat(odds) - 1;
  const p = parseFloat(prob) / 100;
  const f = (b * p - (1 - p)) / b;
  if (f <= 0) return null;
  return Math.round(Math.min(f * 100, 20) * 10) / 10; // cap 20%, 1 decimal
}

async function logPrediction(client, sport, fixtureId, homeTeam, awayTeam, winner, prob, odds, dateMatch) {
  try {
    const kelly = calcKelly(prob, odds);
    await client.query(`
      INSERT INTO predictions_history (sport, fixture_id, home_team, away_team, predicted_winner, predicted_prob, predicted_odds, kelly_stake, date_match)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (fixture_id, sport) DO NOTHING
    `, [sport, fixtureId, homeTeam, awayTeam, winner, prob, odds, kelly, dateMatch]);
  } catch(e) { /* non-critical */ }
}

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
          if (edge >= 5.0)  return `**+${edge}%** 🔥 GRAMY`;
          if (edge >= 3.0)  return `**+${edge}%** ✅`;
          if (edge >= 0)    return `+${edge}% 🟡`;
          return `${edge}% ❌`;
        };
        const formatOdds = (o) => o ? parseFloat(o).toFixed(2) : '-';

        // Fair probability after removing bookmaker vig
        const fairProb = (...odds) => {
          const parsed = odds.map(o => o ? 1 / parseFloat(o) : 0);
          const total = parsed.reduce((s, p) => s + p, 0);
          if (total <= 0) return null;
          return parsed.map(p => Math.round(p / total * 100));
        };

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
            const edge = parseFloat(m.ai_edge) || 0;
            const isOddsOnly = edge < -1.0 && (m.ai_btts_edge === null || parseFloat(m.ai_btts_edge) < 0);
            const sourceLabel = isOddsOnly ? '📊 Kursowe AI' : '🧠 ML AI';

            // H2H probability: prefer ML model_probability (stored), fall back to odds-based
            let winPct = null;
            if (m.ai_probability !== null && m.ai_probability !== undefined) {
              winPct = Math.round(parseFloat(m.ai_probability));
            } else {
              const h2hProbs = fairProb(m.odds_home, m.odds_draw, m.odds_away);
              if (h2hProbs) {
                if (m.ai_forecast === m.home_team)      winPct = h2hProbs[0];
                else if (m.ai_forecast === 'Draw')      winPct = h2hProbs[1];
                else if (m.ai_forecast === m.away_team) winPct = h2hProbs[2];
              }
            }
            const winPctStr = winPct !== null ? ` — **${winPct}%**` : '';
            chunk += `> ${sourceLabel}: **${m.ai_forecast}** wygra${winPctStr} szans statystycznie\n`;

            // BTTS with %
            if (m.ai_btts_forecast) {
              const bttsProbs = fairProb(m.odds_btts_yes, m.odds_btts_no);
              const bttsPct = bttsProbs ? (m.ai_btts_forecast === 'BTTS Yes' ? bttsProbs[0] : bttsProbs[1]) : null;
              chunk += `> ⚽ BTTS: **${m.ai_btts_forecast}**${bttsPct !== null ? ` — ${bttsPct}% szans` : ''}\n`;
            }

            // O/U with %
            if (m.ai_ou_forecast) {
              const ouProbs = fairProb(m.odds_ou_over, m.odds_ou_under);
              const ouPct = ouProbs ? (m.ai_ou_forecast.includes('Over') ? ouProbs[0] : ouProbs[1]) : null;
              chunk += `> 🥅 Gole O/U: **${m.ai_ou_forecast}**${ouPct !== null ? ` — ${ouPct}% szans` : ''}\n`;
            }

            // Corners with %
            if (m.ai_corners_forecast) {
              const corProbs = fairProb(m.odds_corners_over, m.odds_corners_under);
              const corPct = corProbs ? (m.ai_corners_forecast.includes('Over') ? corProbs[0] : corProbs[1]) : null;
              chunk += `> 🚩 Corners: **${m.ai_corners_forecast}**${corPct !== null ? ` — ${corPct}% szans` : ''}\n`;
            }

            if (m.ai_dc_forecast)  chunk += `> 🛡️ DC: **${m.ai_dc_forecast}**\n`;
            if (m.ai_dnb_forecast) chunk += `> ⚖️ DNB: **${m.ai_dnb_forecast}**\n`;

            // Recommendation based purely on statistical probability
            const pickedOdds = (m.ai_forecast === m.home_team || m.ai_forecast === 'Home Win') ? m.odds_home : m.odds_away;
            const kelly = winPct ? calcKelly(winPct, pickedOdds) : null;
            const kellyStr = kelly ? ` | 🎯 Kelly: **${kelly}% bankrolla**` : '';
            if (winPct !== null && winPct >= 65) {
              chunk += `> ✅ **GRAMY: ${m.ai_forecast}** — ${winPct}% szans${kellyStr} 🔥\n`;
              akoCandidates.push({ match: `${m.home_team} vs ${m.away_team}`, pick: m.ai_forecast, prob: winPct, kelly, odds: pickedOdds });
            } else if (winPct !== null && winPct >= 58) {
              chunk += `> ✅ Warto rozważyć: **${m.ai_forecast}** — ${winPct}%${kellyStr}\n`;
              akoCandidates.push({ match: `${m.home_team} vs ${m.away_team}`, pick: m.ai_forecast, prob: winPct, kelly, odds: pickedOdds });
            } else {
              chunk += `> ℹ️ Brak pewnej prognozy (${winPct !== null ? winPct + '%' : 'brak danych'})\n`;
            }
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
        akoCandidates.sort((a, b) => b.prob - a.prob);
        const topAko = [...new Map(akoCandidates.map(c => [c.match, c])).values()].slice(0, 4);
        if (topAko.length >= 2) {
          let akoText = "\n🎟️ **SUGEROWANY KUPON AKO** 🎟️\n";
          topAko.forEach((c, i) => {
            const ks = c.kelly ? ` (Kelly: ${c.kelly}%)` : '';
            akoText += `${i + 1}. ${c.match} → **${c.pick}** — ${c.prob}%${ks}\n`;
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
          SELECT home_team, away_team, date, league_name,
                 odds_home, odds_away,
                 odds_spread_home, odds_spread_away,
                 odds_totals_over, odds_totals_under, totals_point,
                 ai_forecast, ai_edge, ai_probability
          FROM matches_basket
          WHERE date > NOW() AND date < NOW() + INTERVAL '72 hours'
          ORDER BY date ASC
        `);

        if (res.rows.length === 0) {
          return message.reply(
            "ℹ️ **Brak nadchodzących meczów NBA/koszykówki na najbliższe 72h.**\n" +
            "Sprawdź jutro — mecze NBA grają niemal codziennie."
          );
        }

        const fmtOdds = (o) => o ? parseFloat(o).toFixed(2) : '-';
        const fairProb2 = (...odds) => {
          const parsed = odds.map(o => o ? 1 / parseFloat(o) : 0);
          const total = parsed.reduce((s, p) => s + p, 0);
          if (total <= 0) return null;
          return parsed.map(p => Math.round(p / total * 100));
        };
        const fmtEdge = (edge) => {
          if (edge === null || edge === undefined) return '—';
          if (edge >= 5.0) return `**+${edge}%** 🔥 GRAMY`;
          if (edge >= 3.0) return `**+${edge}%** ✅`;
          if (edge >= 0)   return `+${edge}% 🟡`;
          return `${edge}% ❌`;
        };

        let currentReport = `🏀 **RAPORT KOSZYKÓWKA [XGBoost AI]** 🏀\n📅 Najbliższe ${res.rows.length} mecz(y) — okno 72h\n\n`;
        const payloads = [];
        const akoCandidates = [];

        for (const m of res.rows) {
          const dt = new Date(m.date);
          const dateStr = dt.toLocaleDateString('pl-PL', { weekday: 'short', day: '2-digit', month: '2-digit' });
          const timeStr = dt.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });

          let chunk = `**${m.home_team} vs ${m.away_team}**\n`;
          chunk += `> 📅 ${dateStr} ${timeStr}`;
          if (m.league_name) chunk += ` | 🏆 ${m.league_name}`;
          chunk += '\n';

          chunk += `> 💰 Kursy: ${fmtOdds(m.odds_home)} / ${fmtOdds(m.odds_away)}\n`;
          if (m.odds_spread_home && m.odds_spread_away)
            chunk += `> 📊 Spread: ${fmtOdds(m.odds_spread_home)} / ${fmtOdds(m.odds_spread_away)}\n`;
          if (m.odds_totals_over && m.odds_totals_under) {
            const tpLine = m.totals_point ? ` **O/U ${parseFloat(m.totals_point)}**` : '';
            chunk += `> 🥅 Totals:${tpLine} — Over ${fmtOdds(m.odds_totals_over)} / Under ${fmtOdds(m.odds_totals_under)}\n`;
          }

          if (m.ai_forecast) {
            // Resolve Home Win / Away Win to actual team name
            const isHomeWin = m.ai_forecast === 'Home Win' || m.ai_forecast === m.home_team;
            const predictedTeamB = isHomeWin ? m.home_team : m.away_team;
            const pickedOddsB = isHomeWin ? m.odds_home : m.odds_away;

            // Win probability: prefer stored ML probability, fall back to odds-based
            let winPct = null;
            if (m.ai_probability !== null && m.ai_probability !== undefined) {
              winPct = Math.round(parseFloat(m.ai_probability));
            } else {
              const h2hP = fairProb2(m.odds_home, m.odds_away);
              if (h2hP) winPct = isHomeWin ? h2hP[0] : h2hP[1];
            }
            const sourceLabel = (m.ai_probability && parseFloat(m.ai_probability) > 0) ? '🧠 ML AI' : '📊 Kursowe AI';
            const winStr = winPct !== null ? ` — **${winPct}%**` : '';
            chunk += `> ${sourceLabel}: **${predictedTeamB}** wygra${winStr} szans statystycznie\n`;

            // Totals O/U with % and line
            if (m.odds_totals_over && m.odds_totals_under) {
              const totP = fairProb2(m.odds_totals_over, m.odds_totals_under);
              const tpLine = m.totals_point ? `O/U **${parseFloat(m.totals_point)}** — ` : '';
              if (totP) chunk += `> 🏹 Totals: ${tpLine}Over ${totP[0]}% / Under ${totP[1]}%\n`;
            }

            // Recommendation based purely on statistical probability
            const kellyB = winPct ? calcKelly(winPct, pickedOddsB) : null;
            const kellyStrB = kellyB ? ` | 🎯 Kelly: **${kellyB}% bankrolla**` : '';
            if (winPct !== null && winPct >= 65) {
              chunk += `> ✅ **GRAMY: ${predictedTeamB}** — ${winPct}% szans${kellyStrB} 🔥\n`;
              akoCandidates.push({ match: `${m.home_team} vs ${m.away_team}`, pick: predictedTeamB, prob: winPct, kelly: kellyB, odds: pickedOddsB });
            } else if (winPct !== null && winPct >= 58) {
              chunk += `> ✅ Warto rozważyć: **${predictedTeamB}** — ${winPct}%${kellyStrB}\n`;
              akoCandidates.push({ match: `${m.home_team} vs ${m.away_team}`, pick: predictedTeamB, prob: winPct, kelly: kellyB, odds: pickedOddsB });
            } else {
              chunk += `> ℹ️ Brak pewnej prognozy (${winPct !== null ? winPct + '%' : 'brak danych'})\n`;
            }
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
        akoCandidates.sort((a, b) => b.prob - a.prob);
        const topAko = [...new Map(akoCandidates.map(c => [c.match, c])).values()].slice(0, 4);
        if (topAko.length >= 2) {
          let akoText = "\n🎟️ **SUGEROWANY KUPON AKO** 🎟️\n";
          topAko.forEach((c, i) => {
            const ks = c.kelly ? ` (Kelly: ${c.kelly}%)` : '';
            akoText += `${i+1}. ${c.match} → **${c.pick}** — ${c.prob}%${ks}\n`;
          });
          akoText += "💸 Postaw jako AKO dla większego zysku!\n";
          if (currentReport.length + akoText.length > 1900) { payloads.push(currentReport); currentReport = akoText; }
          else currentReport += akoText;
        }

        if (currentReport.trim().length > 0) payloads.push(currentReport);
        for (const payload of payloads) await message.reply(payload);

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
          SELECT home_team, away_team, date,
                 odds_home, odds_away,
                 ai_forecast, ai_edge, ai_probability
          FROM matches_tennis
          WHERE date > NOW() AND date < NOW() + INTERVAL '72 hours'
          ORDER BY date ASC
        `);
        if (res.rows.length === 0) return message.reply(
          "ℹ️ **Brak nadchodzących meczów tenisa na najbliższe 72h.**\nSprawdź jutro — turnieje ATP/WTA grają przez cały tydzień."
        );

        const fmtO = (o) => o ? parseFloat(o).toFixed(2) : '-';
        const fp = (o1, o2) => {
          if (!o1 || !o2) return null;
          const s = 1/parseFloat(o1) + 1/parseFloat(o2);
          return [Math.round(1/parseFloat(o1)/s*100), Math.round(1/parseFloat(o2)/s*100)];
        };
        const fmtE = (e) => {
          if (e === null || e === undefined) return '—';
          if (e >= 5.0) return `**+${e}%** 🔥 GRAMY`;
          if (e >= 3.0) return `**+${e}%** ✅`;
          if (e >= 0)   return `+${e}% 🟡`;
          return `${e}% ❌`;
        };

        let cr = `� **RAPORT TENIS [XGBoost AI]** �\n📅 Najbliższe ${res.rows.length} mecz(y) — okno 72h\n\n`;
        const payloads = [];
        const akoCandidates = [];

        for (const m of res.rows) {
          const dt = new Date(m.date);
          const dateStr = dt.toLocaleDateString('pl-PL', { weekday: 'short', day: '2-digit', month: '2-digit' });
          const timeStr = dt.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });
          const probs = fp(m.odds_home, m.odds_away);

          let chunk = `**${m.home_team} vs ${m.away_team}**\n`;
          chunk += `> 📅 ${dateStr} ${timeStr} | 🏓 ATP/WTA\n`;
          chunk += `> 💰 Kursy: ${fmtO(m.odds_home)} / ${fmtO(m.odds_away)}\n`;

          if (m.ai_forecast) {
            const edge = parseFloat(m.ai_edge) || 0;
            let winPct = null;
            if (m.ai_probability !== null && m.ai_probability !== undefined) {
              winPct = Math.round(parseFloat(m.ai_probability));
            } else if (probs) {
              winPct = m.ai_forecast === m.home_team ? probs[0] : probs[1];
            }
            const srcLabel = (m.ai_probability && parseFloat(m.ai_probability) > 0) ? '🧠 ML AI' : '📊 Kursowe AI';
            const winStr = winPct !== null ? ` — **${winPct}%**` : '';
            chunk += `> ${srcLabel}: **${m.ai_forecast}** wygra${winStr} szans statystycznie\n`;
            const pickedOddsT = m.ai_forecast === m.home_team ? m.odds_home : m.odds_away;
            const kellyT = winPct ? calcKelly(winPct, pickedOddsT) : null;
            const kellyStrT = kellyT ? ` | 🎯 Kelly: **${kellyT}% bankrolla**` : '';
            if (winPct !== null && winPct >= 65) {
              chunk += `> ✅ **GRAMY: ${m.ai_forecast}** — ${winPct}% szans${kellyStrT} 🔥\n`;
              akoCandidates.push({ match: `${m.home_team} vs ${m.away_team}`, pick: m.ai_forecast, prob: winPct, kelly: kellyT, odds: pickedOddsT });
            } else if (winPct !== null && winPct >= 58) {
              chunk += `> ✅ Warto rozważyć: **${m.ai_forecast}** — ${winPct}%${kellyStrT}\n`;
              akoCandidates.push({ match: `${m.home_team} vs ${m.away_team}`, pick: m.ai_forecast, prob: winPct, kelly: kellyT, odds: pickedOddsT });
            } else {
              chunk += `> ℹ️ Brak pewnej prognozy (${winPct !== null ? winPct + '%' : 'brak danych'})\n`;
            }
          } else {
            chunk += `> 🤖 AI: oczekiwanie na analizę...\n`;
          }
          chunk += '\n';
          if (cr.length + chunk.length > 1900) { payloads.push(cr); cr = chunk; } else cr += chunk;
        }

        akoCandidates.sort((a, b) => b.prob - a.prob);
        const topAko = [...new Map(akoCandidates.map(c => [c.match, c])).values()].slice(0, 4);
        if (topAko.length >= 2) {
          let akoText = "\n🎟️ **SUGEROWANY KUPON AKO** 🎟️\n";
          topAko.forEach((c, i) => {
            const ks = c.kelly ? ` (Kelly: ${c.kelly}%)` : '';
            akoText += `${i+1}. ${c.match} → **${c.pick}** — ${c.prob}%${ks}\n`;
          });
          akoText += "💸 Postaw jako AKO dla większego zysku!\n";
          if (cr.length + akoText.length > 1900) { payloads.push(cr); cr = akoText; } else cr += akoText;
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
          SELECT home_team, away_team, date, league_name,
                 odds_home, odds_away,
                 ai_forecast, ai_edge, ai_probability
          FROM matches_esport
          WHERE date > NOW() AND date < NOW() + INTERVAL '72 hours'
          ORDER BY date ASC
        `);
        if (res.rows.length === 0) return message.reply(
          "ℹ️ **Brak nadchodzących meczów esportu na najbliższe 72h.**\nSprawdź jutro — CS2/Valorant/LoL grają przez cały tydzień."
        );

        const fmtO2 = (o) => o ? parseFloat(o).toFixed(2) : '-';
        const fp2 = (o1, o2) => {
          if (!o1 || !o2) return null;
          const s = 1/parseFloat(o1) + 1/parseFloat(o2);
          return [Math.round(1/parseFloat(o1)/s*100), Math.round(1/parseFloat(o2)/s*100)];
        };

        let cr = `🎮 **RAPORT ESPORT [XGBoost AI]** 🎮\n📅 Najbliższe ${res.rows.length} mecz(y) — okno 72h\n\n`;
        const payloads = [];
        const akoCandidates = [];

        for (const m of res.rows) {
          const dt = new Date(m.date);
          const dateStr = dt.toLocaleDateString('pl-PL', { weekday: 'short', day: '2-digit', month: '2-digit' });
          const timeStr = dt.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });
          const probs = fp2(m.odds_home, m.odds_away);

          let chunk = `**${m.home_team} vs ${m.away_team}**\n`;
          chunk += `> 📅 ${dateStr} ${timeStr}`;
          if (m.league_name) chunk += ` | 🎮 ${m.league_name}`;
          chunk += '\n';
          chunk += `> 💰 Kursy: ${fmtO2(m.odds_home)} / ${fmtO2(m.odds_away)}\n`;

          if (m.ai_forecast) {
            const edge = parseFloat(m.ai_edge) || 0;
            // Map "Home Win"/"Away Win" to actual team names
            let winner = m.ai_forecast;
            if (m.ai_forecast === 'Home Win') winner = m.home_team;
            else if (m.ai_forecast === 'Away Win') winner = m.away_team;

            let winPct = null;
            if (m.ai_probability !== null && m.ai_probability !== undefined) {
              const p = Math.round(parseFloat(m.ai_probability));
              if (p !== 50) winPct = p; // 50/50 means no data — suppress
            } else if (probs) {
              winPct = winner === m.home_team ? probs[0] : probs[1];
            }
            const hasOdds = m.odds_home && m.odds_away;
            const srcLabel = hasOdds ? '🧠 ML AI' : '📊 Forma AI';
            const winStr = winPct !== null ? ` — **${winPct}%**` : '';
            chunk += `> ${srcLabel}: **${winner}** wygra${winStr} szans statystycznie\n`;
            const pickedOddsE = winner === m.home_team ? m.odds_home : m.odds_away;
            const kellyE = winPct ? calcKelly(winPct, pickedOddsE) : null;
            const kellyStrE = kellyE ? ` | 🎯 Kelly: **${kellyE}% bankrolla**` : '';
            if (winPct !== null && winPct >= 65) {
              chunk += `> ✅ **GRAMY: ${winner}** — ${winPct}% szans${kellyStrE} 🔥\n`;
              akoCandidates.push({ match: `${m.home_team} vs ${m.away_team}`, pick: winner, prob: winPct, kelly: kellyE, odds: pickedOddsE });
            } else if (winPct !== null && winPct >= 58) {
              chunk += `> ✅ Warto rozważyć: **${winner}** — ${winPct}%${kellyStrE}\n`;
              akoCandidates.push({ match: `${m.home_team} vs ${m.away_team}`, pick: winner, prob: winPct, kelly: kellyE, odds: pickedOddsE });
            } else if (!hasOdds) {
              chunk += `> ℹ️ Predykcja z formy — brak kursów bukmachera\n`;
            } else {
              chunk += `> ℹ️ Brak pewnej prognozy (${winPct !== null ? winPct + '%' : 'brak danych'})\n`;
            }
          } else {
            chunk += `> 🤖 AI: oczekiwanie na analizę...\n`;
          }
          chunk += '\n';
          if (cr.length + chunk.length > 1900) { payloads.push(cr); cr = chunk; } else cr += chunk;
        }

        akoCandidates.sort((a, b) => b.prob - a.prob);
        const topAko2 = [...new Map(akoCandidates.map(c => [c.match, c])).values()].slice(0, 4);
        if (topAko2.length >= 2) {
          let akoText = "\n🎟️ **SUGEROWANY KUPON AKO** 🎟️\n";
          topAko2.forEach((c, i) => { akoText += `${i+1}. ${c.match} → **${c.pick}** (${c.prob}% statystycznie)\n`; });
          akoText += "💸 Postaw jako AKO dla większego zysku!\n";
          if (cr.length + akoText.length > 1900) { payloads.push(cr); cr = akoText; } else cr += akoText;
        }

        if (cr.trim().length > 0) payloads.push(cr);
        for (const p of payloads) await message.reply(p);
     } catch(e) {
        console.error(e);
        return message.reply("Wystąpił błąd DB dla Esportu.");
     } finally { pgClient.release(); }

  } else if (message.content === 'statsai') {
    const pgClient = await pool.connect();
    try {
      const r = await pgClient.query(`
        SELECT sport,
          COUNT(*) AS total,
          COUNT(*) FILTER (WHERE resolved = true) AS resolved,
          COUNT(*) FILTER (WHERE is_correct = true) AS correct,
          ROUND(AVG(predicted_prob),1) AS avg_prob,
          ROUND(AVG(kelly_stake),1) AS avg_kelly,
          ROUND(AVG(clv) FILTER (WHERE clv IS NOT NULL),2) AS avg_clv
        FROM predictions_history
        GROUP BY sport ORDER BY sport
      `);
      if (r.rows.length === 0) return message.reply('ℹ️ Brak historii prognoz. Poczekaj aż bot przeanalizuje kilka meczów.');

      let msg = '📊 **SKUTECZNOŚĆ AI — STATYSTYKI**\n\n';
      for (const row of r.rows) {
        const sportIcon = { basket: '🏀', esport: '🎮', football: '⚽', tennis: '🎾' }[row.sport] || '🔮';
        const hitRate = row.resolved > 0 ? `${Math.round(row.correct / row.resolved * 100)}% (${row.correct}/${row.resolved})` : 'brak danych';
        msg += `${sportIcon} **${row.sport.toUpperCase()}**\n`;
        const clvStr = row.avg_clv !== null ? ` | CLV: **${row.avg_clv > 0 ? '+' : ''}${row.avg_clv}%**` : '';
        msg += `> 📈 Prognoz: **${row.total}** | Zweryfikowanych: **${row.resolved}**\n`;
        msg += `> ✅ Trafność: **${hitRate}**${clvStr}\n`;
        msg += `> 🎯 Śr. pewność modelu: **${row.avg_prob}%** | Śr. Kelly: **${row.avg_kelly}%**\n\n`;
      }
      msg += '_Wyniki są aktualizowane automatycznie po zakończeniu meczów._';
      await message.reply(msg);
    } catch(e) {
      console.error(e);
      return message.reply('Błąd pobierania statystyk.');
    } finally { pgClient.release(); }

  } else if (message.content.startsWith('propsy')) {
    const pgClient = await pool.connect();
    try {
      const markets = { player_points: 'Punkty', player_rebounds: 'Zbiórki', player_assists: 'Asysty' };
      const r = await pgClient.query(`
        SELECT pp.player_name, pp.market, pp.line, pp.odds_over, pp.odds_under, pp.ai_pick, pp.ai_probability,
               mb.home_team, mb.away_team, pp.match_date
        FROM player_props_basket pp
        JOIN matches_basket mb ON mb.fixture_id = pp.fixture_id
        WHERE pp.match_date > NOW() AND pp.match_date < NOW() + INTERVAL '36 hours'
          AND mb.status IN ('NS', 'TBD')
          AND mb.odds_home IS NOT NULL
          AND mb.odds_away IS NOT NULL
        ORDER BY pp.match_date ASC, pp.ai_probability DESC
        LIMIT 30
      `);
      if (r.rows.length === 0) {
        return message.reply('ℹ️ Brak propsów NBA na najbliższe 36h. Dane odświeżają się co 8h — spróbuj później.');
      }

      // Group by match
      const grouped = {};
      for (const row of r.rows) {
        const key = `${row.home_team} vs ${row.away_team}`;
        if (!grouped[key]) grouped[key] = { date: row.match_date, props: [] };
        grouped[key].props.push(row);
      }

      let payloads = [], cr = '🏀 **PROPSY NBA — AI PICKS**\n_⚠️ Dane z The Odds API (pokrywa wszystkie mecze NBA). Sprawdź dostępność u swojego bukmachera._\n\n';
      const nowWarsaw = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Warsaw' }));
      for (const [matchKey, data] of Object.entries(grouped)) {
        const dt = new Date(data.date);
        const dtWarsaw = new Date(dt.toLocaleString('en-US', { timeZone: 'Europe/Warsaw' }));
        const timeStr = dt.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Warsaw' });
        const isToday = dtWarsaw.toDateString() === nowWarsaw.toDateString();
        const dayLabel = isToday ? 'Dziś' : 'Jutro';
        let chunk = `**${matchKey}** — ${dayLabel} ⏰ ${timeStr}\n`;
        for (const p of data.props) {
          const mktLabel = markets[p.market] || p.market;
          const edge = p.ai_pick === 'Over' ? parseFloat(p.odds_over) : parseFloat(p.odds_under);
          const flag = parseFloat(p.ai_probability) >= 55 ? '✅' : '🔹';
          chunk += `> ${flag} **${p.player_name}** — ${mktLabel} ${p.ai_pick} **${p.line}** @ ${parseFloat(edge).toFixed(2)} _(${p.ai_probability}%)_\n`;
        }
        chunk += '\n';
        if (cr.length + chunk.length > 1900) { payloads.push(cr); cr = chunk; } else cr += chunk;
      }
      if (cr.trim()) payloads.push(cr);
      for (const p of payloads) await message.reply(p);
    } catch(e) {
      console.error(e);
      return message.reply('Błąd pobierania propsów NBA.');
    } finally { pgClient.release(); }

  } else if (message.content.match(/^zakładam\s+(\d+(?:\.\d+)?)\s+na\s+(.+)$/i)) {
    const m = message.content.match(/^zakładam\s+(\d+(?:\.\d+)?)\s+na\s+(.+)$/i);
    const stake = parseFloat(m[1]);
    const pickRaw = m[2].trim();
    const userId = message.author.id;
    const username = message.author.username;

    if (stake < 1 || stake > 5000) return message.reply('❌ Stawka musi być między 1 a 5000 wirtualnych 💰.');

    const pgClient = await pool.connect();
    try {
      // Init bankroll if new user
      await pgClient.query(`
        INSERT INTO virtual_bankroll (user_id, username, balance) VALUES ($1,$2,1000)
        ON CONFLICT (user_id) DO UPDATE SET username=EXCLUDED.username
      `, [userId, username]);

      const bal = await pgClient.query(`SELECT balance FROM virtual_bankroll WHERE user_id=$1`, [userId]);
      const balance = parseFloat(bal.rows[0].balance);
      if (stake > balance) return message.reply(`❌ Nie masz wystarczająco środków! Twój balans: **${balance.toFixed(0)} 💰**`);

      // Find matching AI pick from upcoming matches (across all sports)
      const pickLower = pickRaw.toLowerCase();
      const upcoming = await pgClient.query(`
        SELECT 'basket' sport, fixture_id, home_team, away_team,
               CASE WHEN ai_forecast='Home Win' THEN home_team ELSE away_team END AS winner,
               CASE WHEN ai_forecast='Home Win' THEN odds_home ELSE odds_away END AS odds,
               date
        FROM matches_basket WHERE date > NOW() AND ai_forecast IS NOT NULL
        UNION ALL
        SELECT 'football', fixture_id, home_team, away_team, ai_forecast, odds_home, date
        FROM matches WHERE date > NOW() AND ai_forecast IS NOT NULL
        UNION ALL
        SELECT 'esport', fixture_id, home_team, away_team,
               CASE WHEN ai_forecast='Home Win' THEN home_team ELSE away_team END,
               CASE WHEN ai_forecast='Home Win' THEN odds_home ELSE odds_away END, date
        FROM matches_esport WHERE date > NOW() AND ai_forecast IS NOT NULL
      `);

      const matched = upcoming.rows.find(r =>
        r.winner && r.winner.toLowerCase().includes(pickLower) ||
        r.home_team.toLowerCase().includes(pickLower) ||
        r.away_team.toLowerCase().includes(pickLower)
      );

      if (!matched) {
        return message.reply(`❌ Nie znalazłem meczu z typem "**${pickRaw}**". Sprawdź betsbasket/betsfoot i wpisz nazwę drużyny.`);
      }

      const odds = parseFloat(matched.odds) || 1.9;
      const potentialWin = parseFloat((stake * odds).toFixed(2));

      await pgClient.query(`
        INSERT INTO virtual_bets (user_id, username, fixture_id, sport, pick, odds, stake, potential_win)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      `, [userId, username, matched.fixture_id, matched.sport, matched.winner, odds, stake, potentialWin]);

      await pgClient.query(`UPDATE virtual_bankroll SET balance = balance - $1, total_bets = total_bets+1, updated_at=NOW() WHERE user_id=$2`, [stake, userId]);

      const dt = new Date(matched.date);
      const timeStr = dt.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });
      await message.reply(
        `✅ **Zakład przyjęty!**\n` +
        `> 🏆 **${matched.winner}** @ **${odds.toFixed(2)}** — stawka: **${stake} 💰**\n` +
        `> 💎 Potencjalna wygrana: **${potentialWin} 💰**\n` +
        `> ⏰ Mecz: ${matched.home_team} vs ${matched.away_team} o ${timeStr}\n` +
        `> 💳 Pozostały balans: **${(balance - stake).toFixed(0)} 💰**`
      );
    } catch(e) {
      console.error(e);
      return message.reply('Błąd rejestrowania zakładu.');
    } finally { pgClient.release(); }

  } else if (message.content === 'moj_profil') {
    const userId = message.author.id;
    const pgClient = await pool.connect();
    try {
      const brRes = await pgClient.query(`SELECT * FROM virtual_bankroll WHERE user_id=$1`, [userId]);
      if (brRes.rows.length === 0) {
        return message.reply('ℹ️ Nie masz jeszcze konta! Zacznij od **zakładam <kwota> na <drużyna>**. Dostajesz **1000 💰 startowego bankrolla**!');
      }
      const br = brRes.rows[0];
      const bets = await pgClient.query(`
        SELECT pick, sport, odds, stake, potential_win, status, is_correct, profit, placed_at
        FROM virtual_bets WHERE user_id=$1 ORDER BY placed_at DESC LIMIT 10
      `, [userId]);

      const profit = parseFloat(br.balance) - 1000;
      const roi = br.total_bets > 0 ? ((profit / (br.total_bets * 100)) * 100).toFixed(1) : '0.0';
      const hitRate = (br.wins + br.losses) > 0 ? Math.round(br.wins / (br.wins + br.losses) * 100) : 0;

      let msg = `🏦 **TWÓJ PROFIL — ${br.username}**\n\n`;
      msg += `> 💰 Balans: **${parseFloat(br.balance).toFixed(0)} / 1000** startowych\n`;
      msg += `> 📈 Profit: **${profit >= 0 ? '+' : ''}${profit.toFixed(0)} 💰** | ROI: **${roi}%**\n`;
      msg += `> ✅ Trafność: **${hitRate}%** (${br.wins}W / ${br.losses}L / ${br.total_bets - br.wins - br.losses} oczekuje)\n\n`;

      if (bets.rows.length > 0) {
        msg += `**Ostatnie zakłady:**\n`;
        for (const b of bets.rows.slice(0, 5)) {
          const icon = b.status === 'pending' ? '⏳' : b.is_correct ? '✅' : '❌';
          const profitStr = b.profit !== null ? ` (${b.profit > 0 ? '+' : ''}${parseFloat(b.profit).toFixed(0)})` : '';
          msg += `> ${icon} **${b.pick}** @ ${parseFloat(b.odds).toFixed(2)} — ${parseFloat(b.stake).toFixed(0)}💰${profitStr}\n`;
        }
      }
      await message.reply(msg);
    } catch(e) {
      console.error(e);
      return message.reply('Błąd pobierania profilu.');
    } finally { pgClient.release(); }

  } else if (message.content === 'top') {
    const pgClient = await pool.connect();
    try {
      const r = await pgClient.query(`
        SELECT username, balance, wins, losses, total_bets,
               ROUND(balance - 1000, 0) AS profit,
               CASE WHEN (wins+losses)>0 THEN ROUND(wins::decimal/(wins+losses)*100,0) ELSE 0 END AS hit_rate
        FROM virtual_bankroll
        WHERE total_bets > 0
        ORDER BY balance DESC LIMIT 10
      `);
      if (r.rows.length === 0) return message.reply('ℹ️ Nikt jeszcze nie obstawił! Wpisz **zakładam 100 na <drużyna>** żeby zacząć.');

      let msg = '🏆 **RANKING TYPERÓW — WIRTUALNY BANKROLL**\n\n';
      for (let i = 0; i < r.rows.length; i++) {
        const row = r.rows[i];
        const medal = ['🥇', '🥈', '🥉'][i] || `**${i+1}.**`;
        const profitStr = row.profit >= 0 ? `+${row.profit}💰` : `${row.profit}💰`;
        msg += `${medal} **${row.username}** — ${parseFloat(row.balance).toFixed(0)}💰 (${profitStr}) | ${row.hit_rate}% trafność | ${row.total_bets} typów\n`;
      }
      msg += `\n_Zdobądź startowe 1000💰 wpisując: **zakładam 100 na <drużyna>**_`;
      await message.reply(msg);
    } catch(e) {
      console.error(e);
      return message.reply('Błąd pobierania rankingu.');
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
      AND date < NOW() + INTERVAL '48 hours'
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
              ai_dnb_edge = $12,
              ai_probability = $13
          WHERE fixture_id = $14
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
          h2h ? h2h.model_probability : null,
          match.fixture_id
        ]);
        
      } catch (aiError) {
        if (aiError.response && aiError.response.status === 404) {
          // Team not in training data — do NOT permanently block. It will retry next cycle.
          console.log(`Skipping ${match.home_team} vs ${match.away_team} (No historical AI data — will retry)`);
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
              ai_edge = $2,
              ai_probability = $3
          WHERE fixture_id = $4
        `, [
          prediction.recommended_bet,
          prediction.edge_percent,
          prediction.model_probability,
          match.fixture_id
        ]);

        const winnerIsHome = prediction.recommended_bet === match.home_team;
        const pickedOdds = winnerIsHome ? match.odds_home : match.odds_away;
        await logPrediction(client, 'basket', match.fixture_id, match.home_team, match.away_team,
          prediction.recommended_bet, prediction.model_probability, pickedOdds, match.date);

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
        await client.query(`UPDATE matches_tennis SET sent_to_discord = true, ai_forecast = $1, ai_edge = $2, ai_probability = $3 WHERE fixture_id = $4`, [pred.recommended_bet, pred.edge_percent, pred.model_probability, match.fixture_id]);
      } catch (e) {}
    }
  } catch (e) {
  } finally { client.release(); }
}

async function getEsportTeamWinRate(client, teamName) {
  // Exact match (case-insensitive)
  let r = await client.query(
    `SELECT win_rate, matches_played FROM team_stats_esport WHERE LOWER(team_name) = LOWER($1)`,
    [teamName]
  );
  if (r.rows.length > 0 && r.rows[0].matches_played >= 3) return parseFloat(r.rows[0].win_rate);

  // Fuzzy: pick closest by trigram similarity using pg_trgm if available, or just return 50
  // Simplified: scan all and find best levenshtein-like match via LIKE prefix
  r = await client.query(
    `SELECT team_name, win_rate, matches_played FROM team_stats_esport WHERE LOWER(team_name) LIKE $1 AND matches_played >= 3 LIMIT 1`,
    [`${teamName.toLowerCase().slice(0, 5)}%`]
  );
  if (r.rows.length > 0) return parseFloat(r.rows[0].win_rate);

  return 50.0;
}

async function analyzeUpcomingEsportsMatches() {
  const client = await pool.connect();
  try {
    const res = await client.query(`SELECT * FROM matches_esport WHERE date > NOW() AND date < NOW() + INTERVAL '48 hours' AND sent_to_discord = false AND status IN ('NS', 'TBD') LIMIT 20;`);
    if (res.rows.length > 0) console.log(`Found ${res.rows.length} Esport matches to analyze.`);
    for (const match of res.rows) {
      try {
        const hForm = await getEsportTeamWinRate(client, match.home_team);
        const aForm = await getEsportTeamWinRate(client, match.away_team);

        const oH = match.odds_home ? parseFloat(match.odds_home) : null;
        const oA = match.odds_away ? parseFloat(match.odds_away) : null;

        let forecast, prob, edge;
        if (oH && oA && oH > 1 && oA > 1) {
          const fH = (1 / oH) / (1 / oH + 1 / oA);
          const fA = 1 - fH;
          const adj = ((hForm - aForm) / 100) * 0.15;
          const mH = Math.max(0.05, Math.min(0.95, fH + adj));
          const mA = 1 - mH;
          if (mH >= mA) {
            forecast = 'Home Win'; prob = Math.round(mH * 100); edge = parseFloat(((mH - fH) * 100).toFixed(2));
          } else {
            forecast = 'Away Win'; prob = Math.round(mA * 100); edge = parseFloat(((mA - fA) * 100).toFixed(2));
          }
        } else {
          const total = hForm + aForm || 100;
          if (hForm >= aForm) {
            forecast = 'Home Win'; prob = Math.round((hForm / total) * 100); edge = -5.0;
          } else {
            forecast = 'Away Win'; prob = Math.round((aForm / total) * 100); edge = -5.0;
          }
        }

        await client.query(
          `UPDATE matches_esport SET sent_to_discord = true, ai_forecast = $1, ai_edge = $2, ai_probability = $3 WHERE fixture_id = $4`,
          [forecast, edge, prob, match.fixture_id]
        );

        const eWinner = forecast === 'Home Win' ? match.home_team : match.away_team;
        const eOdds = forecast === 'Home Win' ? oH : oA;
        await logPrediction(client, 'esport', match.fixture_id, match.home_team, match.away_team,
          eWinner, prob, eOdds, match.date);
      } catch (e) {
        console.error(`Esport analyze error for ${match.home_team} vs ${match.away_team}: ${e.message}`);
      }
    }
    if (res.rows.length > 0) console.log(`Esport: analyzed ${res.rows.length} matches.`);
  } catch (e) {
    console.error('Error in analyzeUpcomingEsportsMatches:', e.message);
  } finally { client.release(); }
}

async function sendMatchStartAlerts() {
  if (!DISCORD_WEBHOOK_URL) return;
  const client = await pool.connect();
  try {
    // Find matches starting in 25-35 minutes
    const res = await client.query(`
      SELECT sport, home_team, away_team, date, ai_forecast, ai_probability,
             CASE WHEN sport='basket' THEN
               CASE WHEN ai_forecast='Home Win' THEN odds_home ELSE odds_away END
             ELSE odds_home END AS picked_odds
      FROM (
        SELECT 'football' sport, home_team, away_team, date, ai_forecast, ai_probability, odds_home, NULL::decimal odds_away
        FROM matches WHERE date BETWEEN NOW() + INTERVAL '25 minutes' AND NOW() + INTERVAL '35 minutes' AND ai_forecast IS NOT NULL
        UNION ALL
        SELECT 'basket', home_team, away_team, date, ai_forecast, ai_probability, odds_home, odds_away
        FROM matches_basket WHERE date BETWEEN NOW() + INTERVAL '25 minutes' AND NOW() + INTERVAL '35 minutes' AND ai_forecast IS NOT NULL
        UNION ALL
        SELECT 'esport', home_team, away_team, date, ai_forecast, ai_probability, odds_home, odds_away
        FROM matches_esport WHERE date BETWEEN NOW() + INTERVAL '25 minutes' AND NOW() + INTERVAL '35 minutes' AND ai_forecast IS NOT NULL
      ) t
    `);

    for (const m of res.rows) {
      const sportIcon = { football: '⚽', basket: '🏀', esport: '🎮', tennis: '🎾' }[m.sport] || '🔮';
      const isHomeWin = m.ai_forecast === 'Home Win' || (m.ai_forecast !== 'Away Win' && m.ai_forecast === m.home_team);
      const winner = isHomeWin ? m.home_team : (m.ai_forecast === 'Away Win' ? m.away_team : m.ai_forecast);
      const prob = m.ai_probability ? Math.round(parseFloat(m.ai_probability)) : null;
      const probStr = prob && prob >= 58 ? ` | **${prob}% szans**` : '';
      const gramy = prob && prob >= 65 ? ' 🔥 **GRAMY!**' : '';

      await axios.post(DISCORD_WEBHOOK_URL, {
        content: `🔔 **MECZ ZA 30 MINUT!** ${sportIcon}\n` +
          `> **${m.home_team}** vs **${m.away_team}**\n` +
          `> 🤖 AI typ: **${winner}**${probStr}${gramy}\n` +
          `> ⏰ Za ~30 minut — postaw teraz lub wpisz \`zakładam <kwota> na ${winner}\`!`
      });
    }
  } catch (e) {
    console.error('sendMatchStartAlerts error:', e.message);
  } finally {
    client.release();
  }
}

async function resolveVirtualBets() {
  const client = await pool.connect();
  try {
    // Get finished matches with known results from all sports
    const finished = await client.query(`
      SELECT ph.fixture_id, ph.sport, ph.predicted_winner, ph.is_correct,
             ph.predicted_odds, ph.predicted_prob,
             CASE ph.sport
               WHEN 'basket' THEN (SELECT CASE WHEN mb.ai_forecast='Home Win' THEN mb.odds_home ELSE mb.odds_away END FROM matches_basket mb WHERE mb.fixture_id=ph.fixture_id)
               WHEN 'football' THEN (SELECT m.odds_home FROM matches m WHERE m.fixture_id=ph.fixture_id)
               ELSE NULL
             END AS current_odds
      FROM predictions_history ph
      WHERE ph.resolved = true AND ph.is_correct IS NOT NULL
        AND EXISTS (SELECT 1 FROM virtual_bets vb WHERE vb.fixture_id=ph.fixture_id AND vb.status='pending')
    `);

    for (const match of finished.rows) {
      const vbets = await client.query(`SELECT * FROM virtual_bets WHERE fixture_id=$1 AND status='pending'`, [match.fixture_id]);
      for (const vb of vbets.rows) {
        const won = match.is_correct === true;
        const profit = won ? parseFloat((vb.potential_win - vb.stake).toFixed(2)) : -parseFloat(vb.stake);

        await client.query(`
          UPDATE virtual_bets SET status=$1, is_correct=$2, profit=$3, resolved_at=NOW()
          WHERE id=$4
        `, [won ? 'won' : 'lost', won, profit, vb.id]);

        await client.query(`
          UPDATE virtual_bankroll SET
            balance = balance + $1,
            wins = wins + $2,
            losses = losses + $3,
            updated_at = NOW()
          WHERE user_id = $4
        `, [
          won ? parseFloat(vb.potential_win) : 0,
          won ? 1 : 0,
          won ? 0 : 1,
          vb.user_id
        ]);

        // Notify user if webhook available
        if (DISCORD_WEBHOOK_URL) {
          const icon = won ? '✅' : '❌';
          await axios.post(DISCORD_WEBHOOK_URL, {
            content: `${icon} **<@${vb.user_id}> — Rozliczenie zakładu**\n` +
              `> 🏆 **${vb.pick}** — ${won ? 'WYGRANA' : 'PRZEGRANA'}\n` +
              `> 💰 ${won ? `+${parseFloat(vb.potential_win - vb.stake).toFixed(0)}💰 zysk` : `-${parseFloat(vb.stake).toFixed(0)}💰 strata`}\n` +
              `> 💳 Twój balans: zaktualizowany — wpisz \`moj_profil\` żeby sprawdzić`
          }).catch(() => {});
        }
      }

      // Update CLV in predictions_history
      if (match.current_odds && match.predicted_odds) {
        const closingImplied = 1 / parseFloat(match.current_odds);
        const predictedImplied = parseFloat(match.predicted_prob) / 100;
        const clv = parseFloat(((predictedImplied - closingImplied) * 100).toFixed(2));
        await client.query(`UPDATE predictions_history SET clv=$1, closing_odds=$2 WHERE fixture_id=$3 AND sport=$4`,
          [clv, match.current_odds, match.fixture_id, match.sport]);
      }
    }
  } catch (e) {
    console.error('resolveVirtualBets error:', e.message);
  } finally {
    client.release();
  }
}

async function sendDailyCoupon() {
  if (!DISCORD_WEBHOOK_URL) return;
  const client = await pool.connect();
  try {
    // Fetch top picks across all sports for the next 36h, probability >= 58%
    const rows = [];

    // CONSENSUS FILTER: prob >= 65% AND (odds <= 2.5 OR prob >= 72%)
    // This ensures bookmaker also rates the pick as likely, reducing false positives
    const foot = await client.query(`
      SELECT 'football' AS sport, home_team, away_team, ai_forecast AS winner, ai_probability AS prob,
             CASE WHEN ai_forecast = home_team THEN odds_home ELSE odds_away END AS odds, date, league_name
      FROM matches WHERE date > NOW() AND date < NOW() + INTERVAL '36 hours'
      AND ai_probability >= 65 AND ai_forecast IS NOT NULL
      AND (
        (CASE WHEN ai_forecast = home_team THEN odds_home ELSE odds_away END) <= 2.5
        OR ai_probability >= 72
      )
      ORDER BY ai_probability DESC LIMIT 3`);
    rows.push(...foot.rows);

    const bask = await client.query(`
      SELECT 'basket' AS sport, home_team, away_team,
             CASE WHEN ai_forecast = 'Home Win' THEN home_team ELSE away_team END AS winner,
             ai_probability AS prob,
             CASE WHEN ai_forecast = 'Home Win' THEN odds_home ELSE odds_away END AS odds, date, league_name
      FROM matches_basket WHERE date > NOW() AND date < NOW() + INTERVAL '36 hours'
      AND ai_probability >= 65 AND ai_forecast IS NOT NULL
      AND (
        (CASE WHEN ai_forecast = 'Home Win' THEN odds_home ELSE odds_away END) <= 2.5
        OR ai_probability >= 72
      )
      ORDER BY ai_probability DESC LIMIT 4`);
    rows.push(...bask.rows);

    const esp = await client.query(`
      SELECT 'esport' AS sport, home_team, away_team,
             CASE WHEN ai_forecast='Home Win' THEN home_team ELSE away_team END AS winner,
             ai_probability AS prob,
             CASE WHEN ai_forecast='Home Win' THEN odds_home ELSE odds_away END AS odds, date, league_name
      FROM matches_esport WHERE date > NOW() AND date < NOW() + INTERVAL '36 hours'
      AND ai_probability >= 70 AND ai_forecast IS NOT NULL
      ORDER BY ai_probability DESC LIMIT 3`);
    rows.push(...esp.rows);

    // Sort all by prob desc, take top 6
    rows.sort((a, b) => parseFloat(b.prob) - parseFloat(a.prob));
    const top = rows.slice(0, 6);

    if (top.length === 0) {
      await axios.post(DISCORD_WEBHOOK_URL, { content: '🎟️ **KUPON NA DZIŚ/NOC** 🎟️\nBrak meczów z wystarczającą pewnością modelu (>58%) w najbliższych 36h. Wróć jutro!' });
      return;
    }

    const sportIcon = { football: '⚽', basket: '🏀', esport: '🎮', tennis: '🎾' };
    let msg = '🎟️ **KUPON NA DZIŚ/NOC — AI PICKS** 🎟️\n';
    msg += `📅 ${new Date().toLocaleDateString('pl-PL', { weekday: 'long', day: '2-digit', month: '2-digit' })} | Top typów na najbliższe 36h\n\n`;

    let totalKelly = 0;
    for (const m of top) {
      const dt = new Date(m.date);
      const timeStr = dt.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });
      const prob = Math.round(parseFloat(m.prob));
      const odds = m.odds ? parseFloat(m.odds).toFixed(2) : '-';
      const kelly = m.odds ? calcKelly(prob, parseFloat(m.odds)) : null;
      const kellyStr = kelly ? ` | Kelly: **${kelly}%**` : '';
      totalKelly += kelly || 0;
      msg += `${sportIcon[m.sport] || '🔮'} **${m.winner}** _(${m.home_team} vs ${m.away_team})_\n`;
      msg += `> ⏰ ${timeStr}${m.league_name ? ` | ${m.league_name}` : ''} | Kurs: **${odds}** | **${prob}% szans**${kellyStr}\n\n`;
    }

    msg += `───────────────────\n`;
    msg += `📊 Łącznie **${top.length}** typów | Śr. pewność: **${Math.round(top.reduce((s,r)=>s+parseFloat(r.prob),0)/top.length)}%**\n`;
    if (totalKelly > 0) msg += `🎯 Śr. Kelly stake: **${Math.round(totalKelly/top.length * 10)/10}% bankrolla** na każdy typ\n`;
    msg += `\n⚠️ _Typuj odpowiedzialnie. AI to narzędzie, nie gwarancja._`;

    await axios.post(DISCORD_WEBHOOK_URL, { content: msg });
    console.log('Sent daily coupon to Discord.');
  } catch (err) {
    console.error('Error sending daily coupon:', err.message);
  } finally {
    client.release();
  }
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

  // Daily coupon at 20:00 (Europe/Warsaw = UTC+1/+2)
  cron.schedule('0 19 * * *', () => { sendDailyCoupon(); }, { timezone: 'Europe/Warsaw' });

  // Match start alerts — every 5 minutes
  cron.schedule('*/5 * * * *', () => { sendMatchStartAlerts(); });

  // Resolve virtual bets + CLV — every 30 minutes
  cron.schedule('*/30 * * * *', () => { resolveVirtualBets(); });

  console.log('Analysis service: 10min analysis, 5min match alerts, 30min bet resolution, 20:00 daily coupon.');
}

start();

if (DISCORD_BOT_TOKEN) {
  console.log('Attempting to login to Discord...');
  discordClient.login(DISCORD_BOT_TOKEN).catch(console.error);
}
