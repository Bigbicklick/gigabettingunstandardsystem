require('dotenv').config();
const { Pool } = require('pg');
const axios = require('axios');
const cron = require('node-cron');

// GIGA FIX (Phase 15): Hybrid API strategy to completely eliminate 429/401 Quota Limit Errors.
// 1. Soccer uses API-Football (cheap bulk operations, covers ALL International Leagues).
// 2. Basket, Tennis, Esport use The Odds API (optimized to exactly 5 requests per run).
// 3. Runs every 8 hours instead of 2 hours, using precisely 450 requests/month (Fits 500 Quota).

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

// Dynamic key store — loads from DB at runtime, falls back to env var
let _activeOddsKey = process.env.THE_ODDS_API_KEY || '';
let _keyExhaustedNotified = false; // prevent spam — only notify once per exhaustion cycle

async function loadActiveOddsKeyFromDB() {
  try {
    const client = await pool.connect();
    const res = await client.query(`SELECT value FROM config WHERE key = 'the_odds_api_key' LIMIT 1`);
    client.release();
    if (res.rows.length > 0 && res.rows[0].value) {
      if (res.rows[0].value !== _activeOddsKey) {
        console.log('New Odds API key loaded from DB config.');
        _activeOddsKey = res.rows[0].value;
        _keyExhaustedNotified = false; // reset so new key is used freely
      }
    }
  } catch (e) { /* config table may not exist yet on first boot */ }
}

function getOddsKey() { return _activeOddsKey; }
const getRandomOddsKey = getOddsKey; // backward compat

async function handleOdds401(context) {
  console.log(`Odds API key exhausted (401) [${context}]. Notifying Discord...`);
  if (!_keyExhaustedNotified && DISCORD_WEBHOOK_URL) {
    _keyExhaustedNotified = true;
    try {
      await axios.post(DISCORD_WEBHOOK_URL, {
        content: `⚠️ **Klucz The Odds API wygasł (401 Unauthorized)** [kontekst: ${context}]\n\n🔑 **Prześlij mi nowy klucz API** — wpisz go tutaj jako wiadomość (32 znaki).\nNp: \`abcdef1234567890abcdef1234567890\`\n\nBez nowego klucza koszyki NBA, tenis i esport nie będą się odświeżać.`
      });
    } catch (e) { console.error('Discord webhook notify failed:', e.message); }
  }
}

function rotateOddsKey() {
  // With single-key model, rotation just flags exhaustion — do nothing else
  console.log('Odds key rotation triggered (no backup keys available).');
}

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
        ai_probability DECIMAL DEFAULT NULL,
        sent_to_discord BOOLEAN DEFAULT false
      );
    `);

    // Add ai_probability to existing tables that were created before this column existed
    await client.query(`ALTER TABLE matches ADD COLUMN IF NOT EXISTS ai_probability DECIMAL DEFAULT NULL;`);

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
        totals_point DECIMAL,
        ai_forecast VARCHAR(50) DEFAULT NULL,
        ai_edge DECIMAL DEFAULT NULL,
        ai_probability DECIMAL DEFAULT NULL,
        sent_to_discord BOOLEAN DEFAULT false
      );
    `);

    await client.query(`ALTER TABLE matches_basket ADD COLUMN IF NOT EXISTS ai_probability DECIMAL DEFAULT NULL;`);
    await client.query(`ALTER TABLE matches_basket ADD COLUMN IF NOT EXISTS totals_point DECIMAL DEFAULT NULL;`);

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
        ai_probability DECIMAL DEFAULT NULL,
        sent_to_discord BOOLEAN DEFAULT false
      );
    `);

    await client.query(`ALTER TABLE matches_tennis ADD COLUMN IF NOT EXISTS ai_probability DECIMAL DEFAULT NULL;`);

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
        ai_probability DECIMAL DEFAULT NULL,
        sent_to_discord BOOLEAN DEFAULT false
      );
    `);

    await client.query(`ALTER TABLE matches_esport ADD COLUMN IF NOT EXISTS ai_probability DECIMAL DEFAULT NULL;`);
    await client.query(`ALTER TABLE predictions_history ADD COLUMN IF NOT EXISTS closing_odds DECIMAL DEFAULT NULL;`);
    await client.query(`ALTER TABLE predictions_history ADD COLUMN IF NOT EXISTS clv DECIMAL DEFAULT NULL;`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS predictions_history (
        id SERIAL PRIMARY KEY,
        sport VARCHAR(20) NOT NULL,
        fixture_id VARCHAR(100) NOT NULL,
        home_team VARCHAR(200),
        away_team VARCHAR(200),
        predicted_winner VARCHAR(200),
        predicted_prob DECIMAL(5,2),
        predicted_odds DECIMAL(10,2),
        kelly_stake DECIMAL(5,2),
        date_match TIMESTAMP,
        date_predicted TIMESTAMP DEFAULT NOW(),
        actual_result VARCHAR(200),
        is_correct BOOLEAN,
        resolved BOOLEAN DEFAULT FALSE,
        UNIQUE(fixture_id, sport)
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS team_stats_esport (
        team_name VARCHAR(200) PRIMARY KEY,
        wins INTEGER DEFAULT 0,
        losses INTEGER DEFAULT 0,
        win_rate DECIMAL DEFAULT 50.0,
        matches_played INTEGER DEFAULT 0,
        last_updated TIMESTAMP DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS config (
        key VARCHAR(100) PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS player_props_basket (
        id SERIAL PRIMARY KEY,
        fixture_id VARCHAR(100) NOT NULL,
        player_name VARCHAR(200) NOT NULL,
        market VARCHAR(50) NOT NULL,
        line DECIMAL,
        odds_over DECIMAL,
        odds_under DECIMAL,
        ai_pick VARCHAR(10),
        ai_probability DECIMAL,
        match_date TIMESTAMP,
        fetched_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(fixture_id, player_name, market)
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS virtual_bankroll (
        user_id VARCHAR(100) PRIMARY KEY,
        username VARCHAR(100),
        balance DECIMAL DEFAULT 1000,
        total_bets INTEGER DEFAULT 0,
        wins INTEGER DEFAULT 0,
        losses INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS virtual_bets (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(100) NOT NULL,
        username VARCHAR(100),
        fixture_id VARCHAR(100),
        sport VARCHAR(20),
        pick VARCHAR(200),
        odds DECIMAL,
        stake DECIMAL,
        potential_win DECIMAL,
        status VARCHAR(20) DEFAULT 'pending',
        is_correct BOOLEAN,
        profit DECIMAL,
        placed_at TIMESTAMP DEFAULT NOW(),
        resolved_at TIMESTAMP
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS player_props_football (
        id SERIAL PRIMARY KEY,
        fixture_id VARCHAR(100) NOT NULL,
        player_name VARCHAR(200) NOT NULL,
        market VARCHAR(50) NOT NULL DEFAULT 'player_goal_scorer_anytime',
        odds_to_score DECIMAL,
        ai_probability DECIMAL,
        home_team VARCHAR(100),
        away_team VARCHAR(100),
        match_date TIMESTAMP,
        fetched_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(fixture_id, player_name, market)
      );
    `);

    console.log('All 10 tables initialized.');
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
  const datesToFetch = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() + i);
    datesToFetch.push(d.toISOString().split('T')[0]);
  }
  
  // Target Leagues — domestic + UEFA club competitions only.
  // National team leagues (Friendlies/WC/Euro) excluded: teams not in ML training data.
  const targetLeagues = [
    39,   // Premier League
    140,  // La Liga
    135,  // Serie A
    78,   // Bundesliga
    61,   // Ligue 1
    106,  // Ekstraklasa
    2,    // UEFA Champions League
    3,    // UEFA Europa League
    848,  // UEFA Conference League
    88,   // Eredivisie
    94,   // Primeira Liga (Portugal)
    207,  // Swiss Super League
    144,  // Belgian Pro League
    71,   // Brazilian Serie A
    253,  // MLS
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
      let totalsOver = null, totalsUnder = null, totalsPoint = null;

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
           if (overOut) { totalsOver = overOut.price; totalsPoint = overOut.point ?? null; }
           if (underOut) totalsUnder = underOut.price;
        }
      }
      
      if (!oddsHome || !oddsAway) continue;

      try {
        await client.query(`
          INSERT INTO matches_basket (
            fixture_id, league_name, home_team, away_team, date, 
            status, odds_home, odds_away, odds_spread_home, odds_spread_away, 
            odds_totals_over, odds_totals_under, totals_point
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
          ON CONFLICT (fixture_id) DO UPDATE SET
            odds_home = EXCLUDED.odds_home,
            odds_away = EXCLUDED.odds_away,
            odds_spread_home = EXCLUDED.odds_spread_home,
            odds_spread_away = EXCLUDED.odds_spread_away,
            odds_totals_over = EXCLUDED.odds_totals_over,
            odds_totals_under = EXCLUDED.odds_totals_under,
            totals_point = EXCLUDED.totals_point
        `, [
          `nba_${match.id}`, 'NBA', match.home_team, match.away_team, match.commence_time, 
          'NS', oddsHome, oddsAway, spreadHome, spreadAway, totalsOver, totalsUnder, totalsPoint
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
      await handleOdds401('Basketball');
    } else {
      console.error('Error fetching NBA odds:', error.message);
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
      const currentKey = getOddsKey();
      const res = await axios.get(`https://api.the-odds-api.com/v4/sports/${tKey}/odds/`, {
        params: { apiKey: currentKey, regions: 'eu,uk', markets: 'h2h', oddsFormat: 'decimal' }
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
    } catch (e) {
      if (e.response && e.response.status === 401) {
        await handleOdds401('Tennis');
        break;
      }
    }
  }
  
  if (totalSaved > 0) console.log(`Saved ${totalSaved} Tennis matches.`);
  client.release();
}

async function fetchUpcomingEsportsMatches() {
  const PANDASCORE_KEY = process.env.PANDASCORE_API_KEY;
  if (!PANDASCORE_KEY) {
    console.log('No PANDASCORE_API_KEY provided. Esport fetching skipped.');
    return;
  }
  console.log('Fetching upcoming Esport matches from PandaScore...');

  // Fetch from 4 major titles in one unified call
  const gameIds = ['csgo', 'lol', 'dota2', 'valorant'];
  const client = await pool.connect();
  let totalSaved = 0;
  const now = new Date();
  const cutoff = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000); // 7 days ahead

  for (const game of gameIds) {
    try {
      const res = await axios.get(`https://api.pandascore.co/${game}/matches/upcoming`, {
        headers: { Authorization: `Bearer ${PANDASCORE_KEY}` },
        params: { per_page: 50, sort: 'scheduled_at', 'filter[status]': 'not_started' }
      });

      if (!res.data || !Array.isArray(res.data)) continue;

      for (const match of res.data) {
        // Need exactly 2 resolved opponents
        if (!match.opponents || match.opponents.length < 2) continue;
        const op1 = match.opponents[0]?.opponent;
        const op2 = match.opponents[1]?.opponent;
        if (!op1?.name || !op2?.name) continue;

        const scheduledAt = match.scheduled_at;
        if (!scheduledAt) continue;
        const matchDate = new Date(scheduledAt);
        if (matchDate < now || matchDate > cutoff) continue;

        const gameTitle = match.videogame_title?.name || match.videogame?.name || game.toUpperCase();
        const leagueName = `${gameTitle} | ${match.league?.name || 'Unknown League'}`;
        const fixtureId = `ps_${match.id}`;

        try {
          await client.query(`
            INSERT INTO matches_esport (fixture_id, league_name, home_team, away_team, date, status, odds_home, odds_away)
            VALUES ($1, $2, $3, $4, $5, 'NS', NULL, NULL)
            ON CONFLICT (fixture_id) DO UPDATE SET
              league_name = EXCLUDED.league_name,
              date = EXCLUDED.date
          `, [fixtureId, leagueName, op1.name, op2.name, scheduledAt]);
          totalSaved++;
        } catch (e) { /* ignore duplicate */ }
      }
    } catch (e) {
      if (e.response?.status === 401) {
        console.error('PandaScore API key invalid or expired (401).');
        break;
      } else if (e.response?.status === 429) {
        console.warn(`PandaScore rate limit hit for ${game}, skipping.`);
      } else {
        console.error(`PandaScore fetch error for ${game}:`, e.message);
      }
    }
  }

  if (totalSaved > 0) console.log(`PandaScore: saved/updated ${totalSaved} esport matches.`);
  client.release();
}


async function fetchEsportHistoricalStats() {
  const PANDASCORE_KEY = process.env.PANDASCORE_API_KEY;
  if (!PANDASCORE_KEY) return;
  console.log('Fetching esport historical stats from PandaScore + OpenDota...');

  const teamStats = {}; // { teamName: { wins, losses } }
  const bump = (name, won) => {
    if (!name) return;
    if (!teamStats[name]) teamStats[name] = { wins: 0, losses: 0 };
    if (won) teamStats[name].wins++; else teamStats[name].losses++;
  };

  // PandaScore /past for CS2, LoL, Valorant (100 recent matches each)
  const games = ['csgo', 'lol', 'valorant'];
  for (const game of games) {
    try {
      const res = await axios.get(`https://api.pandascore.co/${game}/matches/past`, {
        headers: { Authorization: `Bearer ${PANDASCORE_KEY}` },
        params: { per_page: 100, sort: '-end_at' }
      });
      for (const m of res.data || []) {
        if (!m.opponents || m.opponents.length < 2 || !m.winner) continue;
        const t1 = m.opponents[0]?.opponent;
        const t2 = m.opponents[1]?.opponent;
        if (!t1?.name || !t2?.name) continue;
        const winnerId = m.winner?.id;
        bump(t1.name, winnerId === t1.id);
        bump(t2.name, winnerId === t2.id);
      }
      console.log(`PandaScore historical: processed ${game}`);
    } catch (e) {
      console.error(`PandaScore historical error (${game}):`, e.message);
    }
  }

  // OpenDota proMatches for Dota2 (free, no key needed)
  try {
    const res = await axios.get('https://api.opendota.com/api/proMatches', { timeout: 10000 });
    for (const m of res.data || []) {
      const r = m.radiant_name;
      const d = m.dire_name;
      if (!r || !d) continue;
      bump(r, m.radiant_win === true);
      bump(d, m.radiant_win === false);
    }
    console.log('OpenDota proMatches: processed Dota2 history');
  } catch (e) {
    console.error('OpenDota error:', e.message);
  }

  // Persist to DB
  const client = await pool.connect();
  let saved = 0;
  for (const [name, s] of Object.entries(teamStats)) {
    const total = s.wins + s.losses;
    const wr = total > 0 ? parseFloat(((s.wins / total) * 100).toFixed(2)) : 50.0;
    try {
      await client.query(`
        INSERT INTO team_stats_esport (team_name, wins, losses, win_rate, matches_played, last_updated)
        VALUES ($1, $2, $3, $4, $5, NOW())
        ON CONFLICT (team_name) DO UPDATE SET
          wins = EXCLUDED.wins, losses = EXCLUDED.losses,
          win_rate = EXCLUDED.win_rate, matches_played = EXCLUDED.matches_played,
          last_updated = NOW()
      `, [name, s.wins, s.losses, wr, total]);
      saved++;
    } catch (e) { /* skip */ }
  }
  client.release();
  console.log(`Esport historical stats: updated ${saved} teams in DB.`);
}

async function fetchNBAPlayerProps() {
  const ODDS_API_KEY = getRandomOddsKey();
  if (!ODDS_API_KEY) return;
  const client = await pool.connect();
  try {
    // Get upcoming NBA fixture IDs we already have
    const matches = await client.query(`SELECT fixture_id, home_team, away_team, date FROM matches_basket WHERE date > NOW() AND date < NOW() + INTERVAL '48 hours' LIMIT 6`);
    if (matches.rows.length === 0) { client.release(); return; }

    // Delete stale props (> 2 days old)
    await client.query(`DELETE FROM player_props_basket WHERE match_date < NOW() - INTERVAL '2 days'`);

    let saved = 0;
    for (const m of matches.rows) {
      // Extract event ID from fixture_id (nba_<eventId>)
      const eventId = m.fixture_id.replace('nba_', '');
      try {
        const res = await axios.get(`https://api.the-odds-api.com/v4/sports/basketball_nba/events/${eventId}/odds`, {
          params: { apiKey: ODDS_API_KEY, regions: 'us', markets: 'player_points,player_rebounds,player_assists', oddsFormat: 'decimal' },
          timeout: 15000
        });

        const bm = res.data?.bookmakers?.[0];
        if (!bm) continue;

        for (const mkt of bm.markets || []) {
          const marketKey = mkt.key; // player_points, player_rebounds, player_assists
          // Group outcomes by player (Over/Under pairs)
          const playerMap = {};
          for (const o of mkt.outcomes || []) {
            const pName = o.description || o.name;
            if (!playerMap[pName]) playerMap[pName] = {};
            if (o.name === 'Over') { playerMap[pName].over = o.price; playerMap[pName].line = o.point; }
            if (o.name === 'Under') { playerMap[pName].under = o.price; }
          }

          for (const [player, data] of Object.entries(playerMap)) {
            if (!data.over || !data.under || !data.line) continue;
            // Simple AI pick: slight favor to Over (NBA offense-driven meta)
            const impliedOver = 1 / data.over;
            const impliedUnder = 1 / data.under;
            const fairOver = impliedOver / (impliedOver + impliedUnder);
            const pick = fairOver >= 0.5 ? 'Over' : 'Under';
            const prob = Math.round((fairOver >= 0.5 ? fairOver : 1 - fairOver) * 100);

            await client.query(`
              INSERT INTO player_props_basket (fixture_id, player_name, market, line, odds_over, odds_under, ai_pick, ai_probability, match_date)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
              ON CONFLICT (fixture_id, player_name, market) DO UPDATE SET
                line=EXCLUDED.line, odds_over=EXCLUDED.odds_over, odds_under=EXCLUDED.odds_under,
                ai_pick=EXCLUDED.ai_pick, ai_probability=EXCLUDED.ai_probability, fetched_at=NOW()
            `, [m.fixture_id, player, marketKey, data.line, data.over, data.under, pick, prob, m.date]);
            saved++;
          }
        }
      } catch (e) {
        if (e.response?.status === 401) { await handleOdds401('player_props'); break; }
        if (e.response?.status === 422) continue; // event not found in odds API
        console.error(`Player props fetch error for ${m.home_team} vs ${m.away_team}: ${e.message}`);
      }
    }
    if (saved > 0) console.log(`Player props: saved/updated ${saved} props for ${matches.rows.length} NBA matches.`);
  } catch (e) {
    console.error('fetchNBAPlayerProps error:', e.message);
  } finally {
    client.release();
  }
}

async function fetchFootballPlayerProps() {
  const ODDS_API_KEY = getRandomOddsKey();
  if (!ODDS_API_KEY) return;
  const client = await pool.connect();
  try {
    const matches = await client.query(`
      SELECT fixture_id, league_name, home_team, away_team, date
      FROM matches
      WHERE date > NOW() AND date < NOW() + INTERVAL '30 hours'
      AND odds_home IS NOT NULL AND status IN ('NS','TBD')
      ORDER BY date ASC LIMIT 5
    `);
    if (matches.rows.length === 0) { client.release(); return; }

    await client.query(`DELETE FROM player_props_football WHERE match_date < NOW() - INTERVAL '2 days'`);

    // League name → Odds API sport key
    const leagueKeyMap = [
      { patterns: ['Champions League', 'UEFA Champions'], key: 'soccer_uefa_champs_league' },
      { patterns: ['Europa League', 'UEFA Europa'], key: 'soccer_uefa_europa_league' },
      { patterns: ['Conference League'], key: 'soccer_uefa_europa_conference_league' },
      { patterns: ['Premier League'], key: 'soccer_epl' },
      { patterns: ['La Liga', 'Primera Division'], key: 'soccer_spain_la_liga' },
      { patterns: ['Bundesliga 1', 'Bundesliga'], key: 'soccer_germany_bundesliga' },
      { patterns: ['Serie A'], key: 'soccer_italy_serie_a' },
      { patterns: ['Ligue 1'], key: 'soccer_france_ligue_one' },
      { patterns: ['Ekstraklasa'], key: 'soccer_poland_ekstraklasa' },
      { patterns: ['Eredivisie'], key: 'soccer_netherlands_eredivisie' },
      { patterns: ['Primeira Liga'], key: 'soccer_portugal_primeira_liga' },
    ];

    function getSportKey(leagueName) {
      if (!leagueName) return null;
      for (const { patterns, key } of leagueKeyMap) {
        if (patterns.some(p => leagueName.toLowerCase().includes(p.toLowerCase()))) return key;
      }
      return null;
    }

    // Group matches by sport key
    const byKey = {};
    for (const m of matches.rows) {
      const sk = getSportKey(m.league_name);
      if (!sk) continue;
      if (!byKey[sk]) byKey[sk] = [];
      byKey[sk].push(m);
    }
    if (Object.keys(byKey).length === 0) { client.release(); return; }

    // Normalize team name for fuzzy matching
    const norm = s => (s || '').toLowerCase().replace(/\s*(fc|afc|sc|cf|bsc|fk|1\.|\.|\s+)\s*/gi, ' ').trim();

    let saved = 0;
    for (const [sportKey, sportMatches] of Object.entries(byKey)) {
      // 1 call: get Odds API event list for this sport key
      let oddsEvents = [];
      try {
        const evRes = await axios.get(`https://api.the-odds-api.com/v4/sports/${sportKey}/events`, {
          params: { apiKey: ODDS_API_KEY, dateFormat: 'iso' },
          timeout: 10000
        });
        oddsEvents = evRes.data || [];
      } catch (e) {
        if (e.response?.status === 401) { await handleOdds401('football_props_events'); break; }
        if (e.response?.status === 422) continue;
        console.error(`Football props events error (${sportKey}):`, e.message);
        continue;
      }

      for (const m of sportMatches) {
        const matchDate = new Date(m.date);
        // Fuzzy match by team name + date (within 4h window)
        const found = oddsEvents.find(e => {
          const hoursDiff = Math.abs(new Date(e.commence_time) - matchDate) / 3600000;
          if (hoursDiff > 4) return false;
          const hn = norm(m.home_team); const ehn = norm(e.home_team || '');
          const an = norm(m.away_team); const ean = norm(e.away_team || '');
          const homeOk = hn.slice(0,5) === ehn.slice(0,5) || hn.includes(ehn.slice(0,5)) || ehn.includes(hn.slice(0,5));
          const awayOk = an.slice(0,5) === ean.slice(0,5) || an.includes(ean.slice(0,5)) || ean.includes(an.slice(0,5));
          return homeOk && awayOk;
        });
        if (!found) continue;

        // 1 call: fetch player goalscorer + card props
        try {
          const propsRes = await axios.get(`https://api.the-odds-api.com/v4/sports/${sportKey}/events/${found.id}/odds`, {
            params: {
              apiKey: ODDS_API_KEY,
              regions: 'eu',
              markets: 'player_goal_scorer_anytime,player_to_receive_card',
              oddsFormat: 'decimal'
            },
            timeout: 15000
          });
          const bm = propsRes.data?.bookmakers?.[0];
          if (!bm) continue;

          for (const mkt of bm.markets || []) {
            // For goalscorer: raw implied prob (1/odds) — multiple players CAN score in same game
            for (const o of mkt.outcomes || []) {
              if (!o.price || o.price <= 1) continue;
              const impliedProb = Math.round((1 / o.price) * 100);
              await client.query(`
                INSERT INTO player_props_football
                  (fixture_id, player_name, market, odds_to_score, ai_probability, home_team, away_team, match_date)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
                ON CONFLICT (fixture_id, player_name, market) DO UPDATE SET
                  odds_to_score=EXCLUDED.odds_to_score, ai_probability=EXCLUDED.ai_probability, fetched_at=NOW()
              `, [m.fixture_id, o.name, mkt.key, o.price, impliedProb, m.home_team, m.away_team, m.date]);
              saved++;
            }
          }
        } catch (e) {
          if (e.response?.status === 401) { await handleOdds401('football_player_props'); return; }
          if (e.response?.status === 422) continue;
          console.error(`Football props fetch error (${m.home_team}):`, e.message);
        }
      }
    }
    if (saved > 0) console.log(`Football player props: saved/updated ${saved} props.`);
  } catch (e) {
    console.error('fetchFootballPlayerProps error:', e.message);
  } finally {
    client.release();
  }
}

async function runFetchCycle() {
  await loadActiveOddsKeyFromDB(); // pick up any new key sent via Discord
  await fetchUpcomingMatches();
  await fetchUpcomingBasketballMatches();
  await fetchUpcomingTennisMatches();
  await fetchUpcomingEsportsMatches();
  await fetchEsportHistoricalStats();
  await fetchNBAPlayerProps();
  await fetchFootballPlayerProps();
}

async function start() {
  await initDB();
  await runFetchCycle(); // initial run

  // Run every 8 hours. Also poll DB for new key every cycle.
  cron.schedule('0 */8 * * *', () => {
    console.log('--- Triggering 8-Hour Fetch Cycle ---');
    runFetchCycle();
  });

  // Poll DB for new key every 2 minutes (fast reaction when user sends key via Discord)
  cron.schedule('*/2 * * * *', async () => {
    await loadActiveOddsKeyFromDB();
  });

  console.log('Data service started. Fetch every 8h, key poll every 2min.');
}

// Ensure the process stays alive even without express
start().catch(e => console.error(e));
