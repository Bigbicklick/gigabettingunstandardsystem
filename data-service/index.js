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
  const API_KEY = process.env.API_FOOTBALL_KEY || process.env.THE_ODDS_API_KEY || '';
  if (!API_KEY) {
    console.log('No API_KEY provided, skipping fetch.');
    return;
  }
  
  console.log('Connecting to API-Football to grab today fixtures...');
  
  const todayStr = new Date().toISOString().split('T')[0];
  
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toISOString().split('T')[0];
  
  const targetLeagues = [
    39, 40, 41, 42, 179, // Anglia + Szkocja
    78, 79,              // Niemcy
    135, 136,            // Wlochy
    140, 141,            // Hiszpania
    61, 62,              // Francja
    88, 144, 94, 203, 197 // Holandia, Belgia, Portugalia, Turcja, Grecja
  ];
  
  try {
    const fixResponseToday = await axios.get('https://v3.football.api-sports.io/fixtures', {
      params: { date: todayStr },
      headers: { 'x-apisports-key': API_KEY }
    });
    
    const fixResponseTomorrow = await axios.get('https://v3.football.api-sports.io/fixtures', {
      params: { date: tomorrowStr },
      headers: { 'x-apisports-key': API_KEY }
    });
    
    let allMatches = [];
    if (fixResponseToday.data && fixResponseToday.data.response) {
       allMatches = allMatches.concat(fixResponseToday.data.response);
    }
    if (fixResponseTomorrow.data && fixResponseTomorrow.data.response) {
       allMatches = allMatches.concat(fixResponseTomorrow.data.response);
    }
    
    if (allMatches.length === 0) {
      console.log('No fixtures found from API-Football today or tomorrow.');
      return;
    }
    
    const premiumMatches = allMatches.filter(m => targetLeagues.includes(m.league.id) && m.fixture.status.short === 'NS');
    
    console.log(`Found ${premiumMatches.length} upcoming matches across the 18 expanded Giga Leagues.`);
    
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

async function fetchUpcomingBasketballMatches() {
  const ODDS_API_KEY = process.env.THE_ODDS_API_KEY || '';
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
  const ODDS_API_KEY = process.env.THE_ODDS_API_KEY || '';
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
  // The Odds API does NOT support esports - using TheSportsDB (free, key "3") instead
  console.log('Fetching upcoming Esports events from TheSportsDB...');
  const THESPORTSDB_KEY = '3';
  const esportLeagues = [
    { id: '4770', name: 'CS2 (ESL Pro League)' },
    { id: '4771', name: 'CS2 (BLAST Premier)' },
    { id: '4772', name: 'LoL (LEC)' },
    { id: '4773', name: 'LoL (LCS)' },
    { id: '4574', name: 'League of Legends World Championship' },
    { id: '4752', name: 'CS:GO Major' },
  ];

  const client = await pool.connect();
  let totalSaved = 0;

  for (const league of esportLeagues) {
    try {
      const res = await axios.get(`https://www.thesportsdb.com/api/v1/json/${THESPORTSDB_KEY}/eventsnextleague.php`, {
        params: { id: league.id }
      });

      if (!res.data || !res.data.events) continue;

      for (const event of res.data.events) {
        const homeTeam = event.strHomeTeam || 'TBD';
        const awayTeam = event.strAwayTeam || 'TBD';
        const eventDate = event.strTimestamp || event.dateEvent || new Date().toISOString();
        const fixtureId = `esp_tsdb_${event.idEvent}`;

        try {
          await client.query(`
            INSERT INTO matches_esport (fixture_id, league_name, home_team, away_team, date, status, odds_home, odds_away) 
            VALUES ($1, $2, $3, $4, $5, 'NS', NULL, NULL) ON CONFLICT (fixture_id) DO NOTHING
          `, [fixtureId, league.name, homeTeam, awayTeam, eventDate]);
          totalSaved++;
        } catch (e) { console.error('DB write error Esport:', e.message); }
      }
      console.log(`  -> ${league.name}: fetched events OK`);
    } catch (e) {
      // TheSportsDB may not have events for some league IDs - that's OK
      console.log(`  -> ${league.name}: no events or error (${e.message})`);
    }
  }
  console.log(`Saved ${totalSaved} upcoming Esports events from TheSportsDB.`);
  client.release();
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
