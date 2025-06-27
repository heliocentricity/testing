// scripts/update.js
//
// deps: axios, luxon
// npm install axios luxon

const fs    = require('fs');
const path  = require('path');
const axios = require('axios');
const { DateTime } = require('luxon');

const CONFIG_PATH  = path.join(__dirname, '..', 'baseline.json');
const DATA_PATH    = path.join(__dirname, '..', 'docs',     'data.json');
const STREAKS_PATH = path.join(__dirname, '..', 'streaks.json');

const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const { TEAM_NAME, START_DATE } = config;

// return ms of today at 00:00 in America/Los_Angeles
function getPSTMidnight(ms) {
  return DateTime
    .fromMillis(ms, { zone: 'America/Los_Angeles' })
    .startOf('day')
    .toMillis();
}

async function fetchLeaderboard() {
  const target = `https://www.nitrotype.com/api/v2/teams/${TEAM_NAME}`;
  const proxy  = `http://api.scraperapi.com?api_key=${process.env.SCRAPERAPI_KEY}`
               + `&url=${encodeURIComponent(target)}`;
  const { data } = await axios.get(proxy);
  if (data.status !== 'OK' || !data.results?.members) {
    console.error('Bad API response:', JSON.stringify(data).slice(0,200));
    throw new Error('Invalid team JSON');
  }
  return data.results.members.map(m => {
    let role = m.role;
    if (m.username === 'aiy_infection') role = 'captain';
    if (['vioiynx','neiletsky'].includes(m.username)) role = 'vicecaptain';
    return {
      username:    m.username,
      displayName: m.displayName,
      racesPlayed: m.racesPlayed,
      role,                     // officer|member|captain|vicecaptain
      title:       m.title,     // bring title into streaks too
      joinStamp:   m.joinStamp,
      lastActivity:m.lastActivity
    };
  });
}

function loadState() {
  if (fs.existsSync(STREAKS_PATH)) {
    return JSON.parse(fs.readFileSync(STREAKS_PATH,'utf8'));
  }
  // initial empty state
  return { streaks: {}, prevCount: {} };
}

function saveState(state) {
  fs.writeFileSync(STREAKS_PATH, JSON.stringify(state,null,2), 'utf8');
}

async function ensureBaseline(board) {
  config.baseline = config.baseline || {};
  board.forEach(u => {
    if (!Number.isInteger(config.baseline[u.username])) {
      config.baseline[u.username] = u.racesPlayed;
      console.log(`Baseline[${u.username}] = ${u.racesPlayed}`);
    }
  });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config,null,2), 'utf8');
}

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

async function writeStreaks(board) {
  const state   = loadState();
  const nowMs   = Date.now();
  const today0  = getPSTMidnight(nowMs);
  const yestEnd = today0 - 1;

  // init missing users
  board.forEach(m => {
    if (!state.streaks[m.username]) {
      state.streaks[m.username] = {
        current:    0,
        curStart:   null,
        curEnd:     null,
        highLength: 0,
        highStart:  null,
        highEnd:    null,
        racedToday: false,
        lastReset:  0
      };
    }
    if (state.prevCount[m.username] == null) {
      state.prevCount[m.username] = m.racesPlayed;
    }
  });

  // update each user
  board.forEach(m => {
    const u    = m.username;
    const rec  = state.streaks[u];
    const prev = state.prevCount[u] || 0;
    const curr = m.racesPlayed;

    // daily PST reset
    if (rec.lastReset < today0) {
      if (!rec.racedToday && rec.current > 0) {
        // end yesterday's streak
        rec.curEnd = yestEnd;
        if (rec.current > rec.highLength) {
          rec.highLength = rec.current;
          rec.highStart  = rec.curStart;
          rec.highEnd    = rec.curEnd;
        }
        rec.current  = 0;
        rec.curStart = rec.curEnd = null;
      }
      rec.racedToday = false;
      rec.lastReset  = today0;
    }

    // did they race since PST midnight?
    const lastActMs = (m.lastActivity||0) * 1000;
    if (!rec.racedToday && lastActMs >= today0) {
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

    state.prevCount[u] = curr;
  });

  saveState(state);

  // read back tournament JSON
  const base   = JSON.parse(fs.readFileSync(DATA_PATH,'utf8'));
  const ranked = base.board;

  // build streak arrays
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

  // write combined
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

(async ()=>{
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
