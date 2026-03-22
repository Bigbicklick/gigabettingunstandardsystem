require('dotenv').config();
const { Pool } = require('pg');
const axios = require('axios');
const cron = require('node-cron');

const API_KEY = process.env.THE_ODDS_API_KEY || 'demo_key';
const DB_URL = process.env.DATABASE_URL || 'postgresql://postgres:postgres@db:5432/bettingdb';

const pool = new Pool({
  connectionString: DB_URL,
});

async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS matches (
        fixture_id VARCHAR(100) PRIMARY KEY,
        league_name VARCHAR(100),
        home_team VARCHAR(100),
        away_team VARCHAR(100),
        date TIMESTAMP,
        status VARCHAR(50),
        odds_home DECIMAL,
        odds_draw DECIMAL,
        odds_away DECIMAL,
        ai_forecast VARCHAR(50) DEFAULT NULL,
        ai_edge DECIMAL DEFAULT NULL,
        sent_to_discord BOOLEAN DEFAULT false
      );
    `);
    console.log('Database initialized successfully.');
  } catch (err) {
    console.error('Error initializing db', err);
  } finally {
    client.release();
  }
}

async function fetchUpcomingMatches() {
  const API_KEY = process.env.API_FOOTBALL_KEY || process.env.THE_ODDS_API_KEY || '';
  if (!API_KEY) {
    console.log('No API_KEY provided, skipping fetch.');
    return;
  }
  
  console.log('Connecting to API-Football to grab today fixtures...');
  
  const todayStr = new Date().toISOString().split('T')[0];
  const targetLeagues = [39, 140, 135, 78, 61, 106]; // EPL, LaLiga, SerieA, Buli, Ligue1, Ekstraklasa
  
  try {
    const fixResponse = await axios.get('https://v3.football.api-sports.io/fixtures', {
      params: { date: todayStr },
      headers: { 'x-apisports-key': API_KEY }
    });
    
    if (!fixResponse.data || !fixResponse.data.response) {
      console.log('No fixtures found from API-Football today.');
      return;
    }
    
    const allMatches = fixResponse.data.response;
    const premiumMatches = allMatches.filter(m => targetLeagues.includes(m.league.id) && m.fixture.status.short === 'NS');
    
    console.log(`Found ${premiumMatches.length} upcoming matches across the Top 6 watched leagues.`);
    
    const client = await pool.connect();
    let requestsUsed = 1; // Used 1 for fixtures 
    
    for (const match of premiumMatches) {
        // Delay to respect API ratelimits of basic tier (10 limits per second typically, but 1 request per loop is safe)
        await new Promise(r => setTimeout(r, 1000));
        
        try {
          requestsUsed++;
          let oddsResponse = await axios.get('https://v3.football.api-sports.io/odds', {
             params: { fixture: match.fixture.id, bookmaker: 1 },
             headers: { 'x-apisports-key': API_KEY }
          });
          
          if (!oddsResponse.data || !oddsResponse.data.response || oddsResponse.data.response.length === 0) {
             // Fallback to Bet365 if 1xBet doesn't have odds for this yet
             requestsUsed++;
             oddsResponse = await axios.get('https://v3.football.api-sports.io/odds', {
                 params: { fixture: match.fixture.id, bookmaker: 8 },
                 headers: { 'x-apisports-key': API_KEY }
             });
             
             if (!oddsResponse.data || !oddsResponse.data.response || oddsResponse.data.response.length === 0) {
                 continue; // Still no odds
             }
          }
          
          const bookmakers = oddsResponse.data.response[0].bookmakers;
          
          let oddsHome = null, oddsDraw = null, oddsAway = null;
          let oddsBttsYes = null, oddsBttsNo = null;
          let oddsOuOver = null, oddsOuUnder = null;
          let oddsCornersOver = null, oddsCornersUnder = null;
          let oddsDc1X = null, oddsDcX2 = null, oddsDc12 = null;
          let oddsDnbHome = null, oddsDnbAway = null;
          
          for (const bookmaker of bookmakers) {
            if (bookmaker && bookmaker.bets) {
              const h2h = bookmaker.bets.find(b => b.id === 1);
              if (h2h && !oddsHome) {
                oddsHome = h2h.values.find(v => v.value === 'Home')?.odd || null;
                oddsDraw = h2h.values.find(v => v.value === 'Draw')?.odd || null;
                oddsAway = h2h.values.find(v => v.value === 'Away')?.odd || null;
              }
              
              const totals = bookmaker.bets.find(b => b.id === 5);
              if (totals && !oddsOuOver) {
                oddsOuOver = totals.values.find(v => v.value === 'Over 2.5')?.odd || null;
                oddsOuUnder = totals.values.find(v => v.value === 'Under 2.5')?.odd || null;
              }

              const btts = bookmaker.bets.find(b => b.id === 8);
              if (btts && !oddsBttsYes) {
                oddsBttsYes = btts.values.find(v => v.value === 'Yes')?.odd || null;
                oddsBttsNo = btts.values.find(v => v.value === 'No')?.odd || null;
              }
              
              const corners = bookmaker.bets.find(b => b.id === 45 || b.name === 'Corners Over/Under');
              if (corners && !oddsCornersOver) {
                oddsCornersOver = corners.values.find(v => v.value === 'Over 9.5' || v.value === 'Over 9.50' || v.value === 'Over 9')?.odd || null;
                oddsCornersUnder = corners.values.find(v => v.value === 'Under 9.5' || v.value === 'Under 9.50' || v.value === 'Under 9')?.odd || null;
              }
              
              const dc = bookmaker.bets.find(b => b.id === 12 || b.name === 'Double Chance');
              if (dc && !oddsDc1X) {
                oddsDc1X = dc.values.find(v => v.value === 'Home/Draw' || v.value === '1X')?.odd || null;
                oddsDcX2 = dc.values.find(v => v.value === 'Draw/Away' || v.value === 'X2')?.odd || null;
                oddsDc12 = dc.values.find(v => v.value === 'Home/Away' || v.value === '12')?.odd || null;
              }

              const dnb = bookmaker.bets.find(b => b.id === 53 || b.name === 'Draw No Bet' || b.name === 'Draw no bet');
              if (dnb && !oddsDnbHome) {
                oddsDnbHome = dnb.values.find(v => v.value === 'Home')?.odd || null;
                oddsDnbAway = dnb.values.find(v => v.value === 'Away')?.odd || null;
              }
            }
          }
          
          // Save or Update
          await client.query(`
            INSERT INTO matches (fixture_id, league_name, home_team, away_team, date, status, odds_home, odds_draw, odds_away, odds_btts_yes, odds_btts_no, odds_ou_over, odds_ou_under, odds_corners_over, odds_corners_under, odds_dc_1x, odds_dc_x2, odds_dc_12, odds_dnb_home, odds_dnb_away)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
            ON CONFLICT (fixture_id) DO UPDATE 
            SET odds_home = EXCLUDED.odds_home, 
                odds_draw = EXCLUDED.odds_draw, 
                odds_away = EXCLUDED.odds_away,
                odds_btts_yes = EXCLUDED.odds_btts_yes,
                odds_btts_no = EXCLUDED.odds_btts_no,
                odds_ou_over = EXCLUDED.odds_ou_over,
                odds_ou_under = EXCLUDED.odds_ou_under,
                odds_corners_over = EXCLUDED.odds_corners_over,
                odds_corners_under = EXCLUDED.odds_corners_under,
                odds_dc_1x = EXCLUDED.odds_dc_1x,
                odds_dc_x2 = EXCLUDED.odds_dc_x2,
                odds_dc_12 = EXCLUDED.odds_dc_12,
                odds_dnb_home = EXCLUDED.odds_dnb_home,
                odds_dnb_away = EXCLUDED.odds_dnb_away,
                date = EXCLUDED.date;
          `, [
            `fb_${match.fixture.id}`, 
            match.league.name, 
            match.teams.home.name, 
            match.teams.away.name, 
            match.fixture.date, 
            match.fixture.status.short, 
            oddsHome, oddsDraw, oddsAway, oddsBttsYes, oddsBttsNo, oddsOuOver, oddsOuUnder, oddsCornersOver, oddsCornersUnder, oddsDc1X, oddsDcX2, oddsDc12, oddsDnbHome, oddsDnbAway
          ]);
        } catch (oddsErr) {
           console.error('Failed fetching odds for fixture:', match.fixture.id);
        }
    }
    
    console.log(`Saved matched odds to Postgres. Free API-Football requests consumed this cycle: ${requestsUsed}`);
    client.release();
    
  } catch (error) {
    console.error('Error fetching API-Football data:', error.message);
  }
}

async function start() {
  await initDB();
  await fetchUpcomingMatches(); // initial run
  
  // The user explicitly authorized ignoring the 500 requests/month limit
  // in favor of getting bets sooner (will use multiple API keys if needed).
  // Fetching every 2 hours (12x a day) for 4 markets.
  cron.schedule('0 */2 * * *', () => {
    fetchUpcomingMatches();
  });
  
  console.log('Data service started and aggressively scheduled to run every 2 hours.');
}

// Ensure the process stays alive even without express
start().catch(e => console.error(e));
