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
  console.log('Fetching upcoming matches from The Odds API...');
  
  try {
    // The Odds API soccer keys
    const sports = [
      'soccer_epl',             // Premier League
      'soccer_spain_la_liga',   // La Liga
      'soccer_italy_serie_a',   // Serie A
      'soccer_germany_bundesliga' // Bundesliga
    ]; 
    
    for (const sport of sports) {
      console.log(`Fetching odds for ${sport}...`);
      try {
        const response = await axios.get(`https://api.the-odds-api.com/v4/sports/${sport}/odds/`, {
          params: {
            apiKey: API_KEY,
            regions: 'eu,uk', // bet365, pinnacle etc
            markets: 'h2h,btts,totals,alternate_totals_corners',
            oddsFormat: 'decimal'
          }
        });
        
        const fixtures = response.data || [];
        console.log(`Found ${fixtures.length} upcoming fixtures for ${sport}`);
        
        for (const f of fixtures) {
          let oddsHome = null, oddsDraw = null, oddsAway = null;
          let oddsBttsYes = null, oddsBttsNo = null;
          let oddsOuOver = null, oddsOuUnder = null;
          let oddsCornersOver = null, oddsCornersUnder = null;
          
          for (const bookmaker of f.bookmakers) {
            if (bookmaker && bookmaker.markets) {
              const h2hMarket = bookmaker.markets.find(m => m.key === 'h2h');
              if (h2hMarket && !oddsHome) {
                const homeOutcome = h2hMarket.outcomes.find(o => o.name === f.home_team);
                const awayOutcome = h2hMarket.outcomes.find(o => o.name === f.away_team);
                const drawOutcome = h2hMarket.outcomes.find(o => o.name.toLowerCase() === 'draw');
                oddsHome = homeOutcome ? homeOutcome.price : null;
                oddsAway = awayOutcome ? awayOutcome.price : null;
                oddsDraw = drawOutcome ? drawOutcome.price : null;
              }
              
              const bttsMarket = bookmaker.markets.find(m => m.key === 'btts');
              if (bttsMarket && !oddsBttsYes) {
                const yesOutcome = bttsMarket.outcomes.find(o => o.name === 'Yes');
                const noOutcome = bttsMarket.outcomes.find(o => o.name === 'No');
                oddsBttsYes = yesOutcome ? yesOutcome.price : null;
                oddsBttsNo = noOutcome ? noOutcome.price : null;
              }
              
              const totalsMarket = bookmaker.markets.find(m => m.key === 'totals');
              if (totalsMarket && !oddsOuOver) {
                const overOutcome = totalsMarket.outcomes.find(o => o.name === 'Over');
                const underOutcome = totalsMarket.outcomes.find(o => o.name === 'Under');
                oddsOuOver = overOutcome ? overOutcome.price : null;
                oddsOuUnder = underOutcome ? underOutcome.price : null;
              }
              
              const cornersMarket = bookmaker.markets.find(m => m.key === 'alternate_totals_corners' || m.key === 'corners');
              if (cornersMarket && !oddsCornersOver) {
                const overOutcome = cornersMarket.outcomes.find(o => o.name.includes('Over'));
                const underOutcome = cornersMarket.outcomes.find(o => o.name.includes('Under'));
                oddsCornersOver = overOutcome ? overOutcome.price : null;
                oddsCornersUnder = underOutcome ? underOutcome.price : null;
              }
            }
          }

          // Use f.id as fixture_id (string)
          // The Odds API doesn't provide status directly before match, we default to 'NS' (Not Started)
          await pool.query(`
            INSERT INTO matches (fixture_id, league_name, home_team, away_team, date, status, odds_home, odds_draw, odds_away, odds_btts_yes, odds_btts_no, odds_ou_over, odds_ou_under, odds_corners_over, odds_corners_under)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
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
                date = EXCLUDED.date;
          `, [
            f.id, sport, f.home_team, f.away_team, 
            f.commence_time, 'NS', oddsHome, oddsDraw, oddsAway, oddsBttsYes, oddsBttsNo, oddsOuOver, oddsOuUnder, oddsCornersOver, oddsCornersUnder
          ]);
        }
      } catch (e) {
         if (e.response && e.response.status === 401) {
             console.error('Invalid THE_ODDS_API_KEY!');
         } else {
             console.error(`Error fetching ${sport}`, e.message);
         }
      }
    }
    console.log('Successfully saved matches to DB from The Odds API.');
  } catch (e) {
    console.error('Core Error', e.message);
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
