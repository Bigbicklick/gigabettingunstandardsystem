require('dotenv').config();
const { Pool } = require('pg');
const axios = require('axios');
const cron = require('node-cron');

const API_KEY = process.env.API_FOOTBALL_KEY || 'demo_key';
const DB_URL = process.env.DATABASE_URL || 'postgresql://postgres:postgres@db:5432/bettingdb';

const pool = new Pool({
  connectionString: DB_URL,
});

async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS matches (
        fixture_id INT PRIMARY KEY,
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
  console.log('Fetching upcoming matches from API-Football...');
  const date = new Date().toISOString().split('T')[0];
  try {
    // Top 5 leagues
    const leagues = [39, 140, 135, 78, 61]; 
    
    for (const league of leagues) {
      const response = await axios.get(`https://v3.football.api-sports.io/fixtures`, {
        headers: { 'x-apisports-key': API_KEY },
        params: { date, league, season: new Date().getFullYear() }
      });
      
      const fixtures = response.data.response || [];
      console.log(`Found ${fixtures.length} fixtures for league ${league}`);
      
      for (const f of fixtures) {
        // Fetch odds for this fixture
        let oddsHome = null, oddsDraw = null, oddsAway = null;
        try {
          const oddsRes = await axios.get(`https://v3.football.api-sports.io/odds`, {
            headers: { 'x-apisports-key': API_KEY },
            params: { fixture: f.fixture.id, bookmaker: 8 } // Bet365
          });
          const oddsData = oddsRes.data.response[0]?.bookmakers[0]?.bets.find(b => b.name === 'Match Winner')?.values;
          if (oddsData) {
            oddsHome = oddsData.find(v => v.value === 'Home')?.odd || null;
            oddsDraw = oddsData.find(v => v.value === 'Draw')?.odd || null;
            oddsAway = oddsData.find(v => v.value === 'Away')?.odd || null;
          }
        } catch (e) {
          console.error(`Could not fetch odds for fixture ${f.fixture.id}`);
        }

        await pool.query(`
          INSERT INTO matches (fixture_id, league_name, home_team, away_team, date, status, odds_home, odds_draw, odds_away)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          ON CONFLICT (fixture_id) DO UPDATE 
          SET odds_home = EXCLUDED.odds_home, 
              odds_draw = EXCLUDED.odds_draw, 
              odds_away = EXCLUDED.odds_away,
              status = EXCLUDED.status;
        `, [
          f.fixture.id, f.league.name, f.teams.home.name, f.teams.away.name, 
          f.fixture.date, f.fixture.status.short, oddsHome, oddsDraw, oddsAway
        ]);
      }
    }
    console.log('Successfully saved matches to DB.');
  } catch (e) {
    console.error('Error fetching from API-Football', e.message);
  }
}

async function start() {
  await initDB();
  await fetchUpcomingMatches(); // initial run
  
  // Run every 2 hours
  cron.schedule('0 */2 * * *', () => {
    fetchUpcomingMatches();
  });
  
  console.log('Data service started and scheduled.');
}

// Ensure the process stays alive even without express
start().catch(e => console.error(e));
