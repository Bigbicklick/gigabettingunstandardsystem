import re

file_path = "data-service/index.js"

with open(file_path, "r", encoding="utf-8") as f:
    content = f.read()

new_code = """async function fetchUpcomingMatches() {
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
}"""

# Use regex to replace the entire `async function fetchUpcomingMatches() { ... }` block
# The regex finds "async function fetchUpcomingMatches() {" and consumes everything up to the corresponding closing brace
# Since JS functions can have nested braces, we use a simpler pattern based on the text structure we know
pattern = r"async function fetchUpcomingMatches\(\)\s*\{[\s\S]*?console\.error\('Error fetching API-Football data:', error\.message\);\s*\}\s*\}"

if re.search(pattern, content):
    new_content = re.sub(pattern, new_code, content)
    with open(file_path, "w", encoding="utf-8") as f:
        f.write(new_content)
    print("SUCCESS: 48h Soccer API Replaced to The Odds API.")
else:
    print("ERROR: Regex Match failed. Could not find fetchUpcomingMatches block.")
