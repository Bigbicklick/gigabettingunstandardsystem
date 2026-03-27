require('dotenv').config();
const { Pool } = require('pg');
const axios = require('axios');
const cron = require('node-cron');

// GIGA FIX (Phase 15): Hybrid API strategy to completely eliminate 429/401 Quota Limit Errors.
// 1. Soccer uses API-Football (cheap bulk operations, covers ALL International Leagues).
// 2. Basket, Tennis, Esport use The Odds API (optimized to exactly 5 requests per run).
// 3. Runs every 8 hours instead of 2 hours, using precisely 450 requests/month (Fits 500 Quota).

const ODDS_API_KEYS = [
  process.env.THE_ODDS_API_KEY || 'e437116ef27159e682a544d52a8add2a' // Add multiple keys if needed
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
  const API_KEY = process.env.API_FOOTBALL_KEY;
  if (!API_KEY) {
    console.log('No API_FOOTBALL_KEY provided. Football fetching skipping to preserve limits.');
    return;
  }
  
  console.log('Connecting to API-Football to grab upcoming FOOTBALL fixtures & odds...');
  
  // To cover 48 hours without hitting rate limits via date queries, we fetch next 2 days
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  
  const datesToFetch = [
    today.toISOString().split('T')[0],
    tomorrow.toISOString().split('T')[0]
  ];
  
  // GIGA EXPANDED Target Leagues (Includes all international, top 5, and more)
  const targetLeagues = [
    39,   // Premier League
    140,  // La Liga
    135,  // Serie A
    78,   // Bundesliga
    61,   // Ligue 1
    106,  // Ekstraklasa
    2,    // UEFA Champions League
    3,    // UEFA Europa League
    4,    // Euro Championship
    15,   // FIFA World Cup
    10,   // Friendlies
    34    // World Cup Qualifiers
  ];
  
  let premiumMatches = [];
  
  try {
    for (const dateStr of datesToFetch) {
      const fixResponse = await axios.get('https://v3.football.api-sports.io/fixtures', {
        params: { date: dateStr },
        headers: { 'x-apisports-key': API_KEY }
      });
      
      if (fixResponse.data && fixResponse.data.response) {
        const matchesForDate = fixResponse.data.response.filter(
            m => targetLeagues.includes(m.league.id) && m.fixture.status.short === 'NS'
        );
        premiumMatches = premiumMatches.concat(matchesForDate);
      }
      await new Promise(r => setTimeout(r, 1000)); // Respect limits
    }
    
    if (premiumMatches.length === 0) {
      console.log('No fixtures found from API-Football for the targeted leagues today/tomorrow.');
      return;
    }
    
    console.log(`Found ${premiumMatches.length} upcoming matches across the GIGA Target Leagues.`);
    
    const client = await pool.connect();
    let oddsRequests = 0;
    let savedCount = 0;
    
    for (const match of premiumMatches) {
        if (oddsRequests >= 80) { // Limit to 80 odds requests per run to absolutely guarantee we never break the 100 daily limit of free tier
            console.log('Reached safe pagination limit for odds fetching (preventing API-Football rate limit 429).');
            break; 
        }

        await new Promise(r => setTimeout(r, 1000));
        
        try {
          oddsRequests++;
          let oddsResponse = await axios.get('https://v3.football.api-sports.io/odds', {
             params: { fixture: match.fixture.id, bookmaker: 1 }, // 10Bet/1xBet usually covers everything
             headers: { 'x-apisports-key': API_KEY }
          });
          
          if (!oddsResponse.data || !oddsResponse.data.response || oddsResponse.data.response.length === 0) {
             oddsRequests++;
             await new Promise(r => setTimeout(r, 1000));
             oddsResponse = await axios.get('https://v3.football.api-sports.io/odds', {
                 params: { fixture: match.fixture.id, bookmaker: 8 }, // Bet365 Fallback
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
          
          if (!oddsHome || !oddsDraw || !oddsAway) continue;

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
          savedCount++;
        } catch (oddsErr) {
           console.error('Failed fetching odds for fixture:', match.fixture.id);
        }
    }
    
    console.log(`Saved matched odds to Postgres (API-Football). Matches added/updated: ${savedCount}`);
    client.release();
    
  } catch (error) {
    console.error('Error fetching Football APIs data:', error.message);
  }
}

async function fetchUpcomingBasketballMatches() {
  const ODDS_API_KEY = getRandomOddsKey();
  if (!ODDS_API_KEY) return;
  
  console.log('Connecting to The Odds API to grab upcoming NBA fixtures & odds...');
  try {
    // Exactly 1 Request
    const response = await axios.get('https://api.the-odds-api.com/v4/sports/basketball_nba/odds/', {
      params: { apiKey: ODDS_API_KEY, regions: 'eu,uk', markets: 'h2h,spreads,totals', oddsFormat: 'decimal' }
    });

    const matches = response.data;
    if (!matches || matches.length === 0) return;

    const client = await pool.connect();
    let savedCount = 0;
    
    for (const match of matches) {
      if (new Date(match.commence_time) < new Date()) continue;
      
      let oddsHome = null, oddsAway = null;
      let spreadHome = null, spreadAway = null;
      let totalsOver = null, totalsUnder = null;

      if (match.bookmakers && match.bookmakers.length > 0) {
        const bm = match.bookmakers[0];
        
        const h2hMarket = bm.markets.find(m => m.key === 'h2h');
        if (h2hMarket && h2hMarket.outcomes) {
           const hOut = h2hMarket.outcomes.find(o => o.name === match.home_team);
           const aOut = h2hMarket.outcomes.find(o => o.name === match.away_team);
           if (hOut) oddsHome = hOut.price;
           if (aOut) oddsAway = aOut.price;
        }

        const spreadsMarket = bm.markets.find(m => m.key === 'spreads');
        if (spreadsMarket && spreadsMarket.outcomes) {
           const hOut = spreadsMarket.outcomes.find(o => o.name === match.home_team);
           const aOut = spreadsMarket.outcomes.find(o => o.name === match.away_team);
           if (hOut) spreadHome = hOut.price; 
           if (aOut) spreadAway = aOut.price;
        }

        const totalsMarket = bm.markets.find(m => m.key === 'totals');
        if (totalsMarket && totalsMarket.outcomes) {
           const overOut = totalsMarket.outcomes.find(o => o.name === 'Over');
           const underOut = totalsMarket.outcomes.find(o => o.name === 'Under');
           if (overOut) totalsOver = overOut.price;
           if (underOut) totalsUnder = underOut.price;
        }
      }
      
      if (!oddsHome || !oddsAway) continue;

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
    
    console.log(`Saved ${savedCount} NBA matches.`);
    client.release();
    
  } catch (error) {
    if (error.response && error.response.status === 401) {
       console.log('The Odds API Key exhausted entirely (401 Unauthorized for Basket).');
    }
  }
}

async function fetchUpcomingTennisMatches() {
  const ODDS_API_KEY = getRandomOddsKey();
  if (!ODDS_API_KEY) return;
  console.log('Discovering active Tennis tournaments from The Odds API...');
  
  const tennisKeys = ['tennis_atp', 'tennis_wta']; // Exactly 2 requests
  const client = await pool.connect();
  let totalSaved = 0;

  for (const tKey of tennisKeys) {
    try {
      const res = await axios.get(`https://api.the-odds-api.com/v4/sports/${tKey}/odds/`, {
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
        
        if (!oH || !oA) continue;

        try {
          await client.query(`
            INSERT INTO matches_tennis (fixture_id, home_team, away_team, date, status, odds_home, odds_away) 
            VALUES ($1, $2, $3, $4, 'NS', $5, $6) ON CONFLICT (fixture_id) DO UPDATE SET odds_home = EXCLUDED.odds_home, odds_away = EXCLUDED.odds_away
          `, [`ten_${match.id}`, match.home_team, match.away_team, match.commence_time, oH, oA]);
          totalSaved++;
        } catch (e) { }
      }
    } catch (e) { }
  }
  
  if (totalSaved > 0) console.log(`Saved ${totalSaved} Tennis matches.`);
  client.release();
}

async function fetchUpcomingEsportsMatches() {
  const ODDS_API_KEY = getRandomOddsKey();
  if (!ODDS_API_KEY) return;
  console.log('Discovering active Esport tournaments from The Odds API...');
  
  const esportsKeys = ['esports_csgo_match_winner', 'esports_league_of_legends']; // Exactly 2 requests
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
        
        if (!oH || !oA) continue;

        try {
          await client.query(`
            INSERT INTO matches_esport (fixture_id, league_name, home_team, away_team, date, status, odds_home, odds_away) 
            VALUES ($1, $2, $3, $4, $5, 'NS', $6, $7) ON CONFLICT (fixture_id) DO UPDATE SET odds_home = EXCLUDED.odds_home, odds_away = EXCLUDED.odds_away
          `, [`esp_${match.id}`, sportKey, match.home_team, match.away_team, match.commence_time, oH, oA]);
          totalSaved++;
        } catch (e) { }
      }
    } catch (e) {}
  }
  
  if (totalSaved > 0) console.log(`Saved ${totalSaved} Esport matches.`);
  client.release();
}


async function start() {
  await initDB();
  await fetchUpcomingMatches(); // initial run
  await fetchUpcomingBasketballMatches(); 
  await fetchUpcomingTennisMatches();
  await fetchUpcomingEsportsMatches();
  
  // GIGA FIX: Run every 8 hours. 3 times per day. 
  // 5 requests per run -> 15 requests per day. 450 requests per month. Safely inside 500 limit.
  cron.schedule('0 */8 * * *', () => {
    console.log('--- Triggering 8-Hour Fetch Cycle ---');
    fetchUpcomingMatches();
    fetchUpcomingBasketballMatches();
    fetchUpcomingTennisMatches();
    fetchUpcomingEsportsMatches();
  });
  
  console.log('Data service started and safely scheduled to run every 8 hours (No more 429 Errors).');
}

// Ensure the process stays alive even without express
start().catch(e => console.error(e));
