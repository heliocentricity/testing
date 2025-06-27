// scripts/update.js

const fs    = require('fs');
const path  = require('path');
const axios = require('axios');

const CONFIG_PATH  = path.join(__dirname, '..', 'baseline.json');
const DATA_PATH    = path.join(__dirname, '..', 'docs',     'data.json');
const STREAKS_PATH = path.join(__dirname, '..', 'streaks.json');

// load config
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const { TEAM_NAME, START_DATE } = config;

// 1) Fetch the entire team roster once via ScraperAPI
async function fetchLeaderboard() {
  const target    = `https://www.nitrotype.com/api/v2/teams/${TEAM_NAME}`;
  const proxy     = `http://api.scraperapi.com?api_key=${process.env.SCRAPERAPI_KEY}`
                    + `&url=${encodeURIComponent(target)}`;
  const { data }  = await axios.get(proxy);

  if (data.status !== 'OK' || !data.results?.members) {
    console.error('Bad API response:', JSON.stringify(data).slice(0,200));
    throw new Error('Invalid team JSON');
  }

  return data.results.members.map(m => {
    let role = m.role;
    if (m.username === 'aiy_infection')        role = 'captain';
    if (['vioiynx','neiletsky'].includes(m.username)) role = 'vicecaptain';
    return {
      username:    m.username,
      displayName: m.displayName,
      racesPlayed: m.racesPlayed,
      role,                      // officer|member|captain|vicecaptain
      title:        m.title,
      joinStamp:    m.joinStamp,
      lastActivity: m.lastActivity
    };
  });
}

// Helpers to load/save your streak state file
function loadState() {
  if (fs.existsSync(STREAKS_PATH)) {
    return JSON.parse(fs.readFileSync(STREAKS_PATH,'utf8'));
  }
  return { streaks: {}, prevCount: {} };
}
function saveState(s) {
  fs.writeFileSync(STREAKS_PATH, JSON.stringify(s,null,2), 'utf8');
}

// 2) Ensure baseline.json has an entry for every user
async function ensureBaseline(board) {
  config.baseline = config.baseline||{};
  board.forEach(u => {
    if (!Number.isInteger(config.baseline[u.username])) {
      config.baseline[u.username] = u.racesPlayed;
      console.log(`Baseline[${u.username}] = ${u.racesPlayed}`);
    }
  });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config,null,2), 'utf8');
}

// 3) Write the tournament part of data.json
function writeTournament(board) {
  const now = new Date();
  const last_updated = now.toLocaleString('en-US',{
    timeZone: 'America/Los_Angeles',
    month:    'long',
    day:      'numeric',
    year:     'numeric',
    hour:     'numeric',
    minute:   '2-digit',
    timeZoneName: 'short'
  });

  const ranked = board
    .map(u => ({
      ...u,
      delta: u.racesPlayed - config.baseline[u.username]
    }))
    .sort((a,b)=> b.delta - a.delta);

  ranked.forEach(r => console.log(`Delta[${r.username}] = ${r.delta}`));

  fs.writeFileSync(DATA_PATH,
    JSON.stringify({
      TEAM_NAME,
      START_DATE,
      last_updated,
      board: ranked
    }, null, 2),
    'utf8'
  );
}

// 4) Build & write streaks (current + allTime) into the same data.json
function writeStreaks(board) {
  const state = loadState();
  const nowMs = Date.now();

  // init missing entries
  board.forEach(m => {
    if (!state.streaks[m.username]) {
      state.streaks[m.username] = {
        current:0, curStart:null, curEnd:null,
        longest:0, longStart:null,longEnd:null
      };
    }
    if (state.prevCount[m.username] == null) {
      state.prevCount[m.username] = m.racesPlayed;
    }
  });

  // update each
  board.forEach(m => {
    const u    = m.username;
    const rec  = state.streaks[u];
    const prev = state.prevCount[u] || 0;
    const curr = m.racesPlayed;
    state.prevCount[u] = curr;

    if (curr > prev) {
      if (rec.current === 0) rec.curStart = nowMs;
      rec.current += 1;
      rec.curEnd    = nowMs;
    } else if (rec.current > 0) {
      // streak broken
      if (rec.current > rec.longest) {
        rec.longest   = rec.current;
        rec.longStart = rec.curStart;
        rec.longEnd   = rec.curEnd;
      }
      rec.current = 0;
      rec.curStart = rec.curEnd = null;
    }
  });

  saveState(state);

  // now read back your tournament JSON
  const base = JSON.parse(fs.readFileSync(DATA_PATH,'utf8'));
  const { TEAM_NAME, START_DATE, last_updated, board: ranked } = base;

  // produce arrays
  const current = [], allTime = [];
  board.forEach(m => {
    const rec = state.streaks[m.username];
    const meta = {
      username:    m.username,
      displayName: m.displayName,
      role:        m.role
    };
    current.push({
      ...meta,
      start: rec.curStart,
      end:   rec.curEnd,
      length: rec.current
    });
    allTime.push({
      ...meta,
      start: rec.longStart,
      end:   rec.longEnd,
      length: rec.longest
    });
  });
  current.sort((a,b)=>b.length-a.length);
  allTime.sort((a,b)=>b.length-a.length);

  // write combined
  fs.writeFileSync(DATA_PATH,
    JSON.stringify({
      TEAM_NAME,
      START_DATE,
      last_updated,
      board: ranked,
      streaks: { current, allTime }
    }, null, 2),
    'utf8'
  );
}

// 5) Main
;(async ()=>{
  try {
    const board = await fetchLeaderboard();
    await ensureBaseline(board);
    writeTournament(board);
    writeStreaks(board);
  } catch(err) {
    console.error(err);
    process.exit(1);
  }
})();
