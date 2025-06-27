// scripts/update.js
//
// Requires only: axios
// npm install axios

const fs    = require('fs');
const path  = require('path');
const axios = require('axios');

const CONFIG_PATH  = path.join(__dirname, '..', 'baseline.json');
const DATA_PATH    = path.join(__dirname, '..', 'docs',     'data.json');
const STREAKS_PATH = path.join(__dirname, '..', 'streaks.json');

const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const { TEAM_NAME, START_DATE } = config;

// Load or initialize your streak state
function loadState() {
  if (fs.existsSync(STREAKS_PATH)) {
    return JSON.parse(fs.readFileSync(STREAKS_PATH,'utf8'));
  }
  return {
    lastDate: null,   // last PST date string we processed, e.g. "2025-06-26"
    streaks: {}       // per-user streak records
  };
}
function saveState(state) {
  fs.writeFileSync(STREAKS_PATH, JSON.stringify(state,null,2), 'utf8');
}

// 1) Fetch roster
async function fetchLeaderboard() {
  const target = `https://www.nitrotype.com/api/v2/teams/${TEAM_NAME}`;
  const proxy  = `http://api.scraperapi.com?api_key=${process.env.SCRAPERAPI_KEY}`
               + `&url=${encodeURIComponent(target)}`;
  const { data } = await axios.get(proxy);
  if (data.status !== 'OK' || !data.results?.members) {
    throw new Error('Invalid team JSON');
  }
  return data.results.members.map(m => {
    let role = m.role;
    if (m.username === 'aiy_infection')           role = 'captain';
    if (['vioiynx','neiletsky'].includes(m.username)) role = 'vicecaptain';
    return {
      username:     m.username,
      displayName:  m.displayName,
      racesPlayed:  m.racesPlayed,
      role,         // officer|member|captain|vicecaptain
      title:        m.title,
      joinStamp:    m.joinStamp,
      lastActivity: m.lastActivity
    };
  });
}

// 2) Keep baseline.json up to date
async function ensureBaseline(board) {
  config.baseline = config.baseline || {};
  board.forEach(u => {
    if (!Number.isInteger(config.baseline[u.username])) {
      config.baseline[u.username] = u.racesPlayed;
    }
  });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config,null,2), 'utf8');
}

// 3) Write tournament leaderboard
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

// 4) Update streaks based on PST date-rollover + today’s races
async function writeStreaks(board) {
  const state = loadState();

  // figure out “today” in PST as YYYY-MM-DD
  const pstToday = new Date().toLocaleDateString('en-CA', {
    timeZone: 'America/Los_Angeles'
  });

  // if we’ve moved into a new PST day since last run…
  if (state.lastDate !== pstToday) {
    Object.values(state.streaks).forEach(rec => {
      // anyone with an ongoing streak who never raced “yesterday” gets broken
      if (rec.current > 0 && !rec.racedToday) {
        if (rec.current > rec.highLength) {
          rec.highLength = rec.current;
          rec.highStart  = rec.curStart;
          rec.highEnd    = rec.curEnd;
        }
        rec.current  = 0;
        rec.curStart = rec.curEnd = null;
      }
      // reset the “has raced today” flag for the new day
      rec.racedToday = false;
    });
    state.lastDate = pstToday;
  }

  // ensure every user has a record
  board.forEach(m => {
    if (!state.streaks[m.username]) {
      state.streaks[m.username] = {
        current:    0,
        curStart:   null,
        curEnd:     null,
        highLength: 0,
        highStart:  null,
        highEnd:    null,
        racedToday: false
      };
    }
  });

  // now mark today’s races
  board.forEach(m => {
    const rec = state.streaks[m.username];
    // what date did they last race, in PST?
    const lastActMs = (m.lastActivity || 0) * 1000;
    const pstActDay = new Date(lastActMs).toLocaleDateString('en-CA', {
      timeZone: 'America/Los_Angeles'
    });

    // if that date is today, and we haven't yet counted them...
    if (pstActDay === pstToday && !rec.racedToday) {
      rec.racedToday = true;
      if (rec.current === 0) rec.curStart = lastActMs;
      rec.current += 1;
      rec.curEnd   = lastActMs;
      if (rec.current > rec.highLength) {
        rec.highLength = rec.current;
        rec.highStart  = rec.curStart;
        rec.highEnd    = rec.curEnd;
      }
    }
  });

  saveState(state);

  // rebuild your JSON file with streaks.current & streaks.allTime
  const base   = JSON.parse(fs.readFileSync(DATA_PATH,'utf8'));
  const ranked = base.board;

  const current = [];
  const allTime = [];
  board.forEach(m => {
    const rec = state.streaks[m.username];
    const meta = {
      username:    m.username,
      displayName: m.displayName,
      role:        m.role,
      title:       m.title
    };
    current.push({
      ...meta,
      start:  rec.curStart,
      end:    rec.curEnd,
      length: rec.current
    });
    allTime.push({
      ...meta,
      start:  rec.highStart,
      end:    rec.highEnd,
      length: rec.highLength
    });
  });

  current.sort((a,b)=> b.length - a.length);
  allTime.sort((a,b)=> b.length - a.length);

  fs.writeFileSync(DATA_PATH,
    JSON.stringify({
      TEAM_NAME,
      START_DATE,
      last_updated: base.last_updated,
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
    await writeStreaks(board);
  } catch(err) {
    console.error(err);
    process.exit(1);
  }
})();
