// scripts/update.js

const fs    = require('fs');
const path  = require('path');
const axios = require('axios');

const CONFIG_PATH  = path.join(__dirname, '..', 'baseline.json');
const DATA_PATH    = path.join(__dirname, '..', 'docs',     'data.json');
const STREAKS_PATH = path.join(__dirname, '..', 'streaks.json');

// --- load config & utility paths ---
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const { TEAM_NAME, START_DATE } = config;

// --- 1) Fetch leaderboard via ScraperAPI ---
async function fetchLeaderboard() {
  const targetUrl = `https://www.nitrotype.com/api/v2/teams/${TEAM_NAME}`;
  const proxyUrl  = `http://api.scraperapi.com`
                  + `?api_key=${process.env.SCRAPERAPI_KEY}`
                  + `&url=${encodeURIComponent(targetUrl)}`;
  const { data: body } = await axios.get(proxyUrl);

  if (body.status !== 'OK' || !body.results?.members) {
    console.error('Unexpected JSON:', JSON.stringify(body).slice(0,200));
    throw new Error('Invalid team JSON');
  }

  return body.results.members.map(m => {
    let role = m.role;
    if (m.username === 'aiy_infection') role = 'captain';
    if (['vioiynx','neiletsky'].includes(m.username)) role = 'vicecaptain';
    return {
      username:    m.username,
      displayName: m.displayName,
      racesPlayed: m.racesPlayed,
      role,                   // officer|captain|member|vicecaptain
      title:        m.title,
      joinStamp:    m.joinStamp,
      lastActivity: m.lastActivity
    };
  });
}

// --- helper to fetch a single user's racesPlayed ---
async function fetchRaces(username) {
  const board = await fetchLeaderboard();
  const m = board.find(x => x.username === username);
  return m ? m.racesPlayed : 0;
}

// --- load or init streaks file ---
function loadStreakState() {
  if (fs.existsSync(STREAKS_PATH)) {
    return JSON.parse(fs.readFileSync(STREAKS_PATH,'utf8'));
  } else {
    return { streaks: {}, prevCount: {} };
  }
}
function saveStreakState(state) {
  fs.writeFileSync(STREAKS_PATH,
    JSON.stringify(state, null, 2), 'utf8');
}

// --- 2) Ensure baseline.json has all users ---
async function ensureBaseline() {
  const board = await fetchLeaderboard();
  config.baseline = config.baseline||{};
  board.forEach(u => {
    if (!Number.isInteger(config.baseline[u.username])) {
      config.baseline[u.username] = u.racesPlayed;
      console.log(`Baseline[${u.username}] = ${u.racesPlayed}`);
    }
  });
  fs.writeFileSync(CONFIG_PATH,
    JSON.stringify(config, null, 2), 'utf8');
}

// --- 3) Update tournament data.json ---
async function updateTournament() {
  const board   = await fetchLeaderboard();
  const results = board
    .map(u => ({
      ...u,
      delta: u.racesPlayed - config.baseline[u.username]
    }))
    .sort((a,b) => b.delta - a.delta);

  results.forEach(r => console.log(`Delta[${r.username}] = ${r.delta}`));

  const now = new Date();
  const last_updated = now.toLocaleString('en-US',{
    timeZone: 'America/Los_Angeles',
    month:    'long',
    day:      'numeric',
    year:     'numeric',
    hour:      'numeric',
    minute:   '2-digit',
    timeZoneName: 'short'
  });

  const out = {
    TEAM_NAME,
    START_DATE,
    last_updated,
    board: results
  };
  fs.writeFileSync(DATA_PATH,
    JSON.stringify(out, null, 2), 'utf8');
}

// --- 4) Update streaks.json and merge into data.json ---
async function updateStreaks() {
  const state = loadStreakState();
  const members = await fetchLeaderboard();
  const nowMs = Date.now();

  // ensure every member has an entry
  members.forEach(m => {
    if (!state.streaks[m.username]) {
      state.streaks[m.username] = {
        current: 0, curStart: null, curEnd: null,
        longest: 0, longStart: null, longEnd: null
      };
    }
    if (state.prevCount[m.username] == null) {
      state.prevCount[m.username] = m.racesPlayed;
    }
  });

  // process each member
  for (const m of members) {
    const u = m.username;
    const prev = state.prevCount[u] || 0;
    const curr = await fetchRaces(u);
    state.prevCount[u] = curr;

    const rec = state.streaks[u];
    if (curr > prev) {
      // extended streak
      if (rec.current === 0) rec.curStart = nowMs;
      rec.current += 1;
      rec.curEnd = nowMs;
    } else if (rec.current > 0) {
      // streak broken → update longest
      if (rec.current > rec.longest) {
        rec.longest   = rec.current;
        rec.longStart = rec.curStart;
        rec.longEnd   = rec.curEnd;
      }
      rec.current  = 0;
      rec.curStart = rec.curEnd = null;
    }
  }

  // save streak state
  saveStreakState(state);

  // read existing tournament data
  const fileData = JSON.parse(fs.readFileSync(DATA_PATH,'utf8'));
  const { TEAM_NAME, START_DATE, last_updated, board } = fileData;

  // build streaks lists
  const current = [];
  const allTime = [];
  members.forEach(m => {
    const u = m.username;
    const rec = state.streaks[u];
    const base = {
      username:    u,
      displayName: m.displayName,
      role:        m.role
    };
    current.push ({
      ...base,
      start: rec.curStart,
      end:   rec.curEnd,
      length: rec.current
    });
    allTime.push({
      ...base,
      start: rec.longStart,
      end:   rec.longEnd,
      length: rec.longest
    });
  });
  current.sort((a,b)=>b.length - a.length);
  allTime.sort((a,b)=>b.length - a.length);

  // merge and write final data.json
  const out = {
    TEAM_NAME,
    START_DATE,
    last_updated,
    board,
    streaks: { current, allTime }
  };
  fs.writeFileSync(DATA_PATH,
    JSON.stringify(out, null, 2), 'utf8');
}

// --- 5) Execute ---
;(async function main(){
  try {
    await ensureBaseline();
    await updateTournament();
    await updateStreaks();
  } catch(err) {
    console.error(err);
    process.exit(1);
  }
})();
