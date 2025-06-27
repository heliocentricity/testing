// scripts/update.js

const fs    = require('fs');
const path  = require('path');
const axios = require('axios');

const CONFIG_PATH = path.join(__dirname, '..', 'baseline.json');
const DATA_PATH   = path.join(__dirname, '..', 'docs',     'data.json');

// load config
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const { TEAM_NAME, START_DATE } = config;

// fetch via NitroType’s API + ScraperAPI proxy
async function fetchLeaderboard() {
  const targetUrl = `https://www.nitrotype.com/api/v2/teams/${TEAM_NAME}`;
  const proxyUrl  = `http://api.scraperapi.com`
                  + `?api_key=${process.env.SCRAPERAPI_KEY}`
                  + `&url=${encodeURIComponent(targetUrl)}`;
  const res  = await axios.get(proxyUrl);
  const body = res.data;

  if (body.status !== 'OK' || !body.results || !Array.isArray(body.results.members)) {
    console.error('⚠️  Unexpected JSON:', JSON.stringify(body).slice(0,200));
    throw new Error('Invalid team JSON');
  }

  return body.results.members.map(m => {
  let role = m.role;
  if (m.username === 'aiy_infection') role = 'captain';
  if (m.username === 'vioiynx' || m.username === 'neiletsky') role = 'vicecaptain';
  return {
    username:     m.username,
    displayName:  m.displayName,
    racesPlayed:  m.racesPlayed,
    role,                    // officer|captain|member
    title:         m.title,  // title under name
    joinStamp:     m.joinStamp,
    lastActivity:  m.lastActivity
  };
});
}

async function ensureBaseline() {
  const board = await fetchLeaderboard();
  config.baseline = config.baseline || {};
  board.forEach(({ username, racesPlayed }) => {
    if (!Number.isInteger(config.baseline[username])) {
      config.baseline[username] = racesPlayed;
      console.log(`Baseline[${username}] = ${racesPlayed}`);
    }
  });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

async function updateData() {
  const board  = await fetchLeaderboard();
  const results = board
    .map(u => ({
      ...u,
      delta: u.racesPlayed - config.baseline[u.username]
    }))
    .sort((a,b) => b.delta - a.delta);

  results.forEach(r => console.log(`Delta[${r.username}] = ${r.delta}`));

  // PST timestamp
  const now = new Date();
  const last_updated = now.toLocaleString('en-US',{
    timeZone:       'America/Los_Angeles',
    month:          'long',
    day:            'numeric',
    year:           'numeric',
    hour:           'numeric',
    minute:        '2-digit',
    timeZoneName:  'short'
  });

  fs.writeFileSync(
    DATA_PATH,
    JSON.stringify(
      { TEAM_NAME, START_DATE, last_updated, board: results },
      null,
      2
    )
  );
}

(async () => {
  try {
    await ensureBaseline();
    await updateData();
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
})();

const db = new Database();

// load or init streaks store
const streaksKey = 'streaks';
let streaks = (await db.get(streaksKey)) || {};

// get timestamp now
const now = Date.now();

// helper: did user race since last check?
async function didRaceSince(user, lastCount) {
  const curr = await fetchRaces(user);
  return { raced: curr > lastCount, curr };
}

// 1) Update tournament baseline/deltas (your existing code) …
await ensureBaseline();
await updateDeltas();

// 2) Fetch team members & loop to update streaks
const members = await fetchTeamMembers();
for (let m of members) {
  const u = m.username;
  // initialize per-user record
  if (!streaks[u]) streaks[u] = {
    current: 0,      // current streak length in hours
    curStart: null,  // timestamp
    curEnd:   null,
    longest:  0,
    longStart: null,
    longEnd:   null
  };

  // previous known races count:
  const lastCount = (await db.get(`prevCount:${u}`)) || 0;
  const { raced, curr } = await didRaceSince(u, lastCount);

  // store new prevCount for next hour
  await db.set(`prevCount:${u}`, curr);

  if (raced) {
    // extend or start streak
    if (streaks[u].current === 0) {
      streaks[u].curStart = now;
    }
    streaks[u].current += 1;
    streaks[u].curEnd = now;
  } else {
    // if they just broke a non-zero streak, check longest
    if (streaks[u].current > 0) {
      if (streaks[u].current > streaks[u].longest) {
        streaks[u].longest    = streaks[u].current;
        streaks[u].longStart  = streaks[u].curStart;
        streaks[u].longEnd    = streaks[u].curEnd;
      }
      // reset current
      streaks[u].current = 0;
      streaks[u].curStart = streaks[u].curEnd = null;
    }
  }
}

// 3) Save streaks back to DB
await db.set(streaksKey, streaks);

// 4) Build JSON files for front-end
const data = { 
  last_updated: new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }),
  board:  (await db.get('deltas')) || [],
  streaks: {
    current:  Object.entries(streaks).map(([u,rec]) => ({
      username:    u,
      displayName: /* fetch or store this too */,
      role:        /* store role in update.json */,
      start:       rec.curStart,
      end:         rec.curEnd,
      length:      rec.current
    })).sort((a,b)=>b.length-a.length),
    allTime:   Object.entries(streaks).map(([u,rec]) => ({
      username:    u,
      displayName: /* … */,
      role:        /* … */,
      start:       rec.longStart,
      end:         rec.longEnd,
      length:      rec.longest
    })).sort((a,b)=>b.length-a.length)
  }
};
fs.writeFileSync('docs/data.json', JSON.stringify(data, null, 2));

