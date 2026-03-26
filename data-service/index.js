require('dotenv').config();
const { Pool } = require('pg');
const axios = require('axios');
const cron = require('node-cron');

const ODDS_API_KEYS = [
  'e437116ef27159e682a544d52a8add2a'
];
const getRandomOddsKey = () => ODDS_API_KEYS[Math.floor(Math.random() * ODDS_API_KEYS.length)];
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
        odds_btts_yes DECIMAL,
        odds_btts_no DECIMAL,
        odds_ou_over DECIMAL,
        odds_ou_under DECIMAL,
        odds_corners_over DECIMAL,
        odds_corners_under DECIMAL,
        odds_dc_1x DECIMAL,
        odds_dc_x2 DECIMAL,
        odds_dc_12 DECIMAL,
        odds_dnb_home DECIMAL,
        odds_dnb_away DECIMAL,
        ai_forecast VARCHAR(50) DEFAULT NULL,
        ai_edge DECIMAL DEFAULT NULL,
        ai_btts_forecast VARCHAR(50) DEFAULT NULL,
        ai_btts_edge DECIMAL DEFAULT NULL,
        ai_ou_forecast VARCHAR(50) DEFAULT NULL,
        ai_ou_edge DECIMAL DEFAULT NULL,
        ai_corners_forecast VARCHAR(50) DEFAULT NULL,
        ai_corners_edge DECIMAL DEFAULT NULL,
        ai_dc_forecast VARCHAR(50) DEFAULT NULL,
        ai_dc_edge DECIMAL DEFAULT NULL,
        ai_dnb_forecast VARCHAR(50) DEFAULT NULL,
        ai_dnb_edge DECIMAL DEFAULT NULL,
        sent_to_discord BOOLEAN DEFAULT false
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS matches_basket (
        fixture_id VARCHAR(100) PRIMARY KEY,
        league_name VARCHAR(100),
        home_team VARCHAR(100),
        away_team VARCHAR(100),
        date TIMESTAMP,
        status VARCHAR(50) DEFAULT 'NS',
        odds_home DECIMAL,
        odds_away DECIMAL,
        odds_spread_home DECIMAL,
        odds_spread_away DECIMAL,
        odds_totals_over DECIMAL,
        odds_totals_under DECIMAL,
        ai_forecast VARCHAR(50) DEFAULT NULL,
        ai_edge DECIMAL DEFAULT NULL,
        sent_to_discord BOOLEAN DEFAULT false
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS matches_tennis (
        fixture_id VARCHAR(100) PRIMARY KEY,
        home_team VARCHAR(100),
        away_team VARCHAR(100),
        date TIMESTAMP,
        status VARCHAR(50) DEFAULT 'NS',
        odds_home DECIMAL,
        odds_away DECIMAL,
        ai_forecast VARCHAR(50) DEFAULT NULL,
        ai_edge DECIMAL DEFAULT NULL,
        sent_to_discord BOOLEAN DEFAULT false
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS matches_esport (
        fixture_id VARCHAR(100) PRIMARY KEY,
        league_name VARCHAR(100),
        home_team VARCHAR(100),
        away_team VARCHAR(100),
        date TIMESTAMP,
        status VARCHAR(50) DEFAULT 'NS',
        odds_home DECIMAL,
        odds_away DECIMAL,
        ai_forecast VARCHAR(50) DEFAULT NULL,
        ai_edge DECIMAL DEFAULT NULL,
        sent_to_discord BOOLEAN DEFAULT false
      );
    `);

    console.log('All 4 tables initialized successfully (matches, matches_basket, matches_tennis, matches_esport).');
  } catch (err) {
    console.error('Error initializing db', err);
  } finally {
    client.release();
  }
}

async function fetchUpcomingMatches() {
  const ODDS_API_KEY = getRandomOddsKey();
  if (!ODDS_API_KEY) return;
  console.log('Connecting to The Odds API to grab upcoming FOOTBALL fixtures & odds (Replacing API-Football)...');
  
  try {
    const soccerKeys = [
        'soccer_epl', 'soccer_spain_la_liga', 'soccer_italy_serie_a', 
        'soccer_germany_bundesliga', 'soccer_france_ligue_one', 
        'soccer_uefa_champs_league', 'soccer_uefa_europa_league',
        'soccer_netherlands_eredivisie', 'soccer_portugal_primeira_liga',
        'soccer_fifa_world_cup_qualifiers', 'soccer_uefa_nations_league'
    ];
    
    let allMatches = [];
    for (const sKey of soccerKeys) {
        try {
            const res = await axios.get(`https://api.the-odds-api.com/v4/sports/${sKey}/odds/`, {
                params: {
                    apiKey: ODDS_API_KEY, regions: 'eu,uk', markets: 'h2h,spreads,totals', oddsFormat: 'decimal'
                }
            });
            if (res.data && Array.isArray(res.data)) {
                allMatches = allMatches.concat(res.data);
            }
        } catch(e) { } // ignoruj gdy liga nie gra
    }
    
    if (allMatches.length === 0) {
      console.log('No fixtures found from The Odds API today or tomorrow (football).');
      return;
    }
    
    const client = await pool.connect();
    let addedCount = 0;
    
    const maxDate = new Date();
    maxDate.setHours(maxDate.getHours() + 48);

    for (const match of allMatches) {
        const matchDate = new Date(match.commence_time);
        if (matchDate < new Date() || matchDate > maxDate) continue; 
        
        let oddsHome = null, oddsDraw = null, oddsAway = null;
        let oddsOuOver = null, oddsOuUnder = null;
        let oddsDc1X = null, oddsDcX2 = null, oddsDc12 = null;

        if (match.bookmakers && match.bookmakers.length > 0) {
            const bm = match.bookmakers[0];
            
            const h2h = bm.markets.find(m => m.key === 'h2h');
            if (h2h && h2h.outcomes) {
                oddsHome = h2h.outcomes.find(o => o.name === match.home_team)?.price || null;
                oddsDraw = h2h.outcomes.find(o => o.name === 'Draw')?.price || null;
                oddsAway = h2h.outcomes.find(o => o.name === match.away_team)?.price || null;
                
                if (oddsHome && oddsDraw && oddsAway) {
                    const p1 = 1/oddsHome, pX = 1/oddsDraw, p2 = 1/oddsAway;
                    const margin = (p1+pX+p2) - 1;
                    const f1=p1-margin/3, fX=pX-margin/3, f2=p2-margin/3;
                    if(f1+fX > 0) oddsDc1X = 1/(f1+fX);
                    if(fX+f2 > 0) oddsDcX2 = 1/(fX+f2);
                    if(f1+f2 > 0) oddsDc12 = 1/(f1+f2);
                }
            }
            
            const totals = bm.markets.find(m => m.key === 'totals');
            if (totals && totals.outcomes) {
                const overObj = totals.outcomes.find(o => o.name === 'Over');
                const underObj = totals.outcomes.find(o => o.name === 'Under');
                if (overObj && overObj.point === 2.5) oddsOuOver = overObj.price;
                if (underObj && underObj.point === 2.5) oddsOuUnder = underObj.price;
            }
        }
        
        try {
            await client.query(`
              INSERT INTO matches (
                fixture_id, league_name, home_team, away_team, date, 
                status, odds_home, odds_draw, odds_away, 
                odds_ou_over, odds_ou_under, odds_dc_1x, odds_dc_x2, odds_dc_12
              ) VALUES ($1, $2, $3, $4, $5, 'NS', $6, $7, $8, $9, $10, $11, $12, $13)
              ON CONFLICT (fixture_id) DO UPDATE SET
                odds_home = EXCLUDED.odds_home, odds_draw = EXCLUDED.odds_draw, odds_away = EXCLUDED.odds_away,
                odds_ou_over = EXCLUDED.odds_ou_over, odds_ou_under = EXCLUDED.odds_ou_under,
                odds_dc_1x = EXCLUDED.odds_dc_1x, odds_dc_x2 = EXCLUDED.odds_dc_x2, odds_dc_12 = EXCLUDED.odds_dc_12,
                date = EXCLUDED.date
            `, [
              `theodds_${match.id}`, match.sport_title, match.home_team, match.away_team, match.commence_time,
              oddsHome, oddsDraw, oddsAway, oddsOuOver, oddsOuUnder, oddsDc1X, oddsDcX2, oddsDc12
            ]);
            addedCount++;
        } catch (e) {
            console.error('DB Insert error:', e.message);
        }
    }
    
    console.log(`Saved matched odds to Postgres (The Odds API Soccer). Matches added: ${addedCount}`);
    client.release();
    
  } catch (error) {
    console.error('Error fetching Football TheOdds API data:', error.message);
  }
}

async function fetchUpcomingBasketballMatches() {
  const ODDS_API_KEY = getRandomOddsKey();
  if (!ODDS_API_KEY) {
    console.log('No THE_ODDS_API_KEY provided for Basketball. Skipping.');
    return;
  }
  
  console.log('Connecting to The Odds API to grab upcoming NBA fixtures & odds...');
  try {
    const response = await axios.get('https://api.the-odds-api.com/v4/sports/basketball_nba/odds/', {
      params: {
        apiKey: ODDS_API_KEY,
        regions: 'eu,uk', // Szukamy popularnych bukmacherów posiadających spready
        markets: 'h2h,spreads,totals',
        oddsFormat: 'decimal'
      }
    });

    const matches = response.data;
    if (!matches || matches.length === 0) {
      console.log('No NBA matches found.');
      return;
    }

    const client = await pool.connect();
    let savedCount = 0;
    
    for (const match of matches) {
      if (new Date(match.commence_time) < new Date()) continue; // Skip live
      
      let oddsHome = null, oddsAway = null;
      let spreadHome = null, spreadAway = null;
      let totalsOver = null, totalsUnder = null;

      // Szukamy najlepszego kursu pod kątem ML (Zwycięstwa)
      if (match.bookmakers && match.bookmakers.length > 0) {
        // Najlepszy bukmacher, ew. pierwszy z listy (np. Pinnacle, Unibet, Bet365)
        const bm = match.bookmakers[0];
        
        // H2H
        const h2hMarket = bm.markets.find(m => m.key === 'h2h');
        if (h2hMarket && h2hMarket.outcomes) {
           const hOut = h2hMarket.outcomes.find(o => o.name === match.home_team);
           const aOut = h2hMarket.outcomes.find(o => o.name === match.away_team);
           if (hOut) oddsHome = hOut.price;
           if (aOut) oddsAway = aOut.price;
        }

        // Spreads (Handicap)
        const spreadsMarket = bm.markets.find(m => m.key === 'spreads');
        if (spreadsMarket && spreadsMarket.outcomes) {
           const hOut = spreadsMarket.outcomes.find(o => o.name === match.home_team);
           const aOut = spreadsMarket.outcomes.find(o => o.name === match.away_team);
           // Przechowujemy też same linie w kursach (wartość spreadu i odd) jako Decimal logicznie
           if (hOut) oddsSpreadHome = hOut.price; 
           if (aOut) oddsSpreadAway = aOut.price;
        }

        // Totals (Over/Under)
        const totalsMarket = bm.markets.find(m => m.key === 'totals');
        if (totalsMarket && totalsMarket.outcomes) {
           const overOut = totalsMarket.outcomes.find(o => o.name === 'Over');
           const underOut = totalsMarket.outcomes.find(o => o.name === 'Under');
           if (overOut) totalsOver = overOut.price;
           if (underOut) totalsUnder = underOut.price;
        }
      }
      
      try {
        await client.query(`
          INSERT INTO matches_basket (
            fixture_id, league_name, home_team, away_team, date, 
            status, odds_home, odds_away, odds_spread_home, odds_spread_away, 
            odds_totals_over, odds_totals_under
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
          ON CONFLICT (fixture_id) DO UPDATE SET
            odds_home = EXCLUDED.odds_home,
            odds_away = EXCLUDED.odds_away,
            odds_spread_home = EXCLUDED.odds_spread_home,
            odds_spread_away = EXCLUDED.odds_spread_away,
            odds_totals_over = EXCLUDED.odds_totals_over,
            odds_totals_under = EXCLUDED.odds_totals_under
        `, [
          `nba_${match.id}`, 'NBA', match.home_team, match.away_team, match.commence_time, 
          'NS', oddsHome, oddsAway, spreadHome, spreadAway, totalsOver, totalsUnder
        ]);
        savedCount++;
      } catch (dbErr) {
        console.error('Database write error NBA:', dbErr);
      }
    }
    
    console.log(`Saved ${savedCount} upcoming NBA matches into Postgres matches_basket table.`);
    client.release();
    
  } catch (error) {
    console.error('Error fetching NBA The Odds API data:', error.message);
  }
}

async function fetchUpcomingTennisMatches() {
  const ODDS_API_KEY = getRandomOddsKey();
  if (!ODDS_API_KEY) return;
  console.log('Discovering active Tennis tournaments from The Odds API...');
  try {
    // Step 1: Get all sports and filter for Tennis group
    const sportsRes = await axios.get('https://api.the-odds-api.com/v4/sports', {
      params: { apiKey: ODDS_API_KEY }
    });
    const tennisSports = sportsRes.data.filter(s => s.group === 'Tennis' && s.active);
    
    if (tennisSports.length === 0) {
      console.log('No active Tennis tournaments found in The Odds API right now.');
      return;
    }
    console.log(`Found ${tennisSports.length} active Tennis tournaments: ${tennisSports.map(s => s.title).join(', ')}`);

    const client = await pool.connect();
    let totalSaved = 0;

    // Step 2: Fetch odds from each active tournament
    for (const sport of tennisSports) {
      try {
        const res = await axios.get(`https://api.the-odds-api.com/v4/sports/${sport.key}/odds/`, {
          params: { apiKey: ODDS_API_KEY, regions: 'eu,uk', markets: 'h2h', oddsFormat: 'decimal' }
        });
        
        if (!res.data || !Array.isArray(res.data)) continue;
        
        for (const match of res.data) {
          if (new Date(match.commence_time) < new Date()) continue;
          let oH = null, oA = null;
          if (match.bookmakers && match.bookmakers.length > 0) {
            const h2h = match.bookmakers[0].markets.find(m => m.key === 'h2h');
            if (h2h && h2h.outcomes) {
              const hOut = h2h.outcomes.find(o => o.name === match.home_team);
              const aOut = h2h.outcomes.find(o => o.name === match.away_team);
              if (hOut) oH = hOut.price;
              if (aOut) oA = aOut.price;
            }
          }
          try {
            await client.query(`
              INSERT INTO matches_tennis (fixture_id, home_team, away_team, date, status, odds_home, odds_away) 
              VALUES ($1, $2, $3, $4, 'NS', $5, $6) ON CONFLICT (fixture_id) DO UPDATE SET odds_home = EXCLUDED.odds_home, odds_away = EXCLUDED.odds_away
            `, [`ten_${match.id}`, match.home_team, match.away_team, match.commence_time, oH, oA]);
            totalSaved++;
          } catch (e) { console.error('DB write error Tennis:', e.message); }
        }
        console.log(`  -> ${sport.title}: fetched matches OK`);
      } catch (tournamentErr) {
        console.error(`  -> ${sport.title}: error fetching odds:`, tournamentErr.message);
      }
    }
    console.log(`Saved ${totalSaved} upcoming Tennis matches across all tournaments.`);
    client.release();
  } catch (e) { console.error('Error fetching Tennis sports list:', e.message); }
}

async function fetchUpcomingEsportsMatches() {
  const ODDS_API_KEY = getRandomOddsKey();
  if (!ODDS_API_KEY) return;
  console.log('Discovering active Esport tournaments from The Odds API...');
  try {
    const esportsKeys = ['esports_csgo_match_winner', 'esports_league_of_legends', 'esports_dota_2_match_winner', 'esports_valorant', 'esports_overwatch'];
    const client = await pool.connect();
    let totalSaved = 0;

    for (const sportKey of esportsKeys) {
      try {
        const res = await axios.get(`https://api.the-odds-api.com/v4/sports/${sportKey}/odds/`, {
          params: { apiKey: ODDS_API_KEY, regions: 'eu,uk', markets: 'h2h', oddsFormat: 'decimal' }
        });
        
        if (!res.data || !Array.isArray(res.data)) continue;
        
        for (const match of res.data) {
          if (new Date(match.commence_time) < new Date()) continue;
          let oH = null, oA = null;
          if (match.bookmakers && match.bookmakers.length > 0) {
            const h2h = match.bookmakers[0].markets.find(m => m.key === 'h2h');
            if (h2h && h2h.outcomes) {
              const hOut = h2h.outcomes.find(o => o.name === match.home_team);
              const aOut = h2h.outcomes.find(o => o.name === match.away_team);
              if (hOut) oH = hOut.price;
              if (aOut) oA = aOut.price;
            }
          }
          try {
            await client.query(`
              INSERT INTO matches_esport (fixture_id, league_name, home_team, away_team, date, status, odds_home, odds_away) 
              VALUES ($1, $2, $3, $4, $5, 'NS', $6, $7) ON CONFLICT (fixture_id) DO UPDATE SET odds_home = EXCLUDED.odds_home, odds_away = EXCLUDED.odds_away
            `, [`esp_${match.id}`, sportKey, match.home_team, match.away_team, match.commence_time, oH, oA]);
            totalSaved++;
          } catch (e) { console.error('DB write error Esport:', e.message); }
        }
      } catch (tournamentErr) {
        if (tournamentErr.response && tournamentErr.response.status === 404) {
            // Ignorujemy 404 bo dany e-sport może po prostu nie grać w tym momencie
        } else {
            console.error(`Error fetching odds for ${sportKey}:`, tournamentErr.message);
        }
      }
    }
    console.log(`Saved ${totalSaved} upcoming Esport matches.`);
    client.release();
  } catch (e) { console.error('Error in fetch Esport:', e.message); }
}


async function start() {
  await initDB();
  await fetchUpcomingMatches(); // initial run
  await fetchUpcomingBasketballMatches(); // initial basket run
  await fetchUpcomingTennisMatches();
  await fetchUpcomingEsportsMatches();
  
  // The user explicitly authorized ignoring the 500 requests/month limit
  // in favor of getting bets sooner (will use multiple API keys if needed).
  // Fetching every 2 hours (12x a day) for 4 markets.
  cron.schedule('0 */2 * * *', () => {
    fetchUpcomingMatches();
    fetchUpcomingBasketballMatches();
    fetchUpcomingTennisMatches();
    fetchUpcomingEsportsMatches();
  });
  
  console.log('Data service started and aggressively scheduled to run every 2 hours (Multi-Sport enabled).');
}

// Ensure the process stays alive even without express
start().catch(e => console.error(e));
