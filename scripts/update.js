// scripts/update.js

const fs      = require('fs');
const path    = require('path');
const axios   = require('axios');
const Database = require('@replit/database');

const db          = new Database();
const CONFIG_PATH = path.join(__dirname, '..', 'baseline.json');
const DATA_PATH   = path.join(__dirname, '..', 'docs',     'data.json');

// --- load your config ---
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const { TEAM_NAME, START_DATE } = config;

// --- 1) Fetch full team roster from NitroType API via ScraperAPI ---
async function fetchLeaderboard() {
  const targetUrl = `https://www.nitrotype.com/api/v2/teams/${TEAM_NAME}`;
  const proxyUrl  = `http://api.scraperapi.com`
                  + `?api_key=${process.env.SCRAPERAPI_KEY}`
                  + `&url=${encodeURIComponent(targetUrl)}`;
  const res = await axios.get(proxyUrl);
  const body = res.data;
  if (body.status !== 'OK' || !body.results?.members) {
    console.error('Unexpected JSON:', JSON.stringify(body).slice(0,200));
    throw new Error('Invalid team JSON');
  }

  // map into the shape we need, including your role overrides:
  return body.results.members.map(m => {
    let role = m.role;
    if (m.username === 'aiy_infection') role = 'captain';
    if (['vioiynx','neiletsky'].includes(m.username)) role = 'vicecaptain';
    return {
      username:     m.username,
      displayName:  m.displayName,
      racesPlayed:  m.racesPlayed,
      role,                    // officer|captain|member|vicecaptain
      title:         m.title,
      joinStamp:     m.joinStamp,
      lastActivity:  m.lastActivity
    };
  });
}

// --- 2) Helper to get a single user’s racesPlayed ---
async function fetchRaces(username) {
  const members = await fetchLeaderboard();
  const m = members.find(x => x.username === username);
  return m ? m.racesPlayed : 0;
}

// --- 3) Initialize baseline.json if missing ---
async function ensureBaseline() {
  const board = await fetchLeaderboard();
  config.baseline = config.baseline || {};
  board.forEach(u => {
    if (!Number.isInteger(config.baseline[u.username])) {
      config.baseline[u.username] = u.racesPlayed;
      console.log(`Baseline[${u.username}] = ${u.racesPlayed}`);
    }
  });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

// --- 4) Update docs/data.json with tournament standings ---
async function updateData() {
  const board   = await fetchLeaderboard();
  const results = board
    .map(u => ({
      ...u,
      delta: u.racesPlayed - config.baseline[u.username]
    }))
    .sort((a,b) => b.delta - a.delta);

  results.forEach(r => console.log(`Delta[${r.username}] = ${r.delta}`));

  const now = new Date();
  const last_updated = now.toLocaleString('en-US', {
    timeZone:      'America/Los_Angeles',
    month:         'long',
    day:           'numeric',
    year:          'numeric',
    hour:          'numeric',
    minute:       '2-digit',
    timeZoneName: 'short'
  });

  const out = {
    TEAM_NAME,
    START_DATE,
    last_updated,
    board: results
  };
  fs.writeFileSync(DATA_PATH, JSON.stringify(out, null, 2));
}

// --- 5) Update streaks in DB and merge them into docs/data.json ---
async function updateStreaks() {
  const streaksKey = 'streaks';
  // load or init
  const raw = (await db.get(streaksKey)) || {};
  const nowMs = Date.now();

  const members = await fetchLeaderboard();
  // set up prevCount defaults
  for (const m of members) {
    if (!raw[m.username]) {
      raw[m.username] = {
        current:  0, curStart: null, curEnd: null,
        longest:  0, longStart: null, longEnd: null
      };
    }
  }

  // process each member
  for (const m of members) {
    const u = m.username;
    const prev = (await db.get(`prevCount:${u}`)) || 0;
    const curr = await fetchRaces(u);
    await db.set(`prevCount:${u}`, curr);

    const rec = raw[u];
    if (curr > prev) {
      // raced → extend or start
      if (rec.current === 0) rec.curStart = nowMs;
      rec.current += 1;
      rec.curEnd    = nowMs;
    } else if (rec.current > 0) {
      // streak broken → check longest
      if (rec.current > rec.longest) {
        rec.longest   = rec.current;
        rec.longStart = rec.curStart;
        rec.longEnd   = rec.curEnd;
      }
      rec.current = 0;
      rec.curStart = rec.curEnd = null;
    }
  }
  // save back to DB
  await db.set(streaksKey, raw);

  // now read the existing data.json
  const fileData = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  const { TEAM_NAME, START_DATE, last_updated, board } = fileData;

  // build two sorted lists
  const current = [];
  const allTime = [];
  for (const [u,rec] of Object.entries(raw)) {
    const m = members.find(x => x.username === u) || {};
    const base = {
      username:    u,
      displayName: m.displayName || u,
      role:        m.role        || 'member'
    };
    current.push({
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
  }
  current.sort((a,b)=> b.length - a.length);
  allTime.sort((a,b)=> b.length - a.length);

  // merge into docs/data.json
  const out = {
    TEAM_NAME,
    START_DATE,
    last_updated,
    board,
    streaks: { current, allTime }
  };
  fs.writeFileSync(DATA_PATH, JSON.stringify(out, null, 2));
}

// --- 6) Drive it all ---  
(async function main(){
  try {
    await ensureBaseline();
    await updateData();
    await updateStreaks();
  } catch(err) {
    console.error(err);
    process.exit(1);
  }
})();
