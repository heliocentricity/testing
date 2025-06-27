// scripts/resetBaselines.js

const fs   = require('fs');
const path = require('path');
const axios = require('axios');

const CONFIG_PATH = path.join(__dirname, '..', 'baseline.json');
const config      = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const { TEAM_NAME } = config;

async function fetchMembers() {
  const targetUrl = `https://www.nitrotype.com/api/v2/teams/${TEAM_NAME}`;
  const proxyUrl  = `http://api.scraperapi.com?api_key=${process.env.SCRAPERAPI_KEY}`
                  + `&url=${encodeURIComponent(targetUrl)}`;
  const res = await axios.get(proxyUrl);
  if (!res.data || res.data.status !== 'OK' || !res.data.results.members) {
    throw new Error('Unexpected team API response');
  }
  return res.data.results.members;
}

(async () => {
  try {
    const members = await fetchMembers();
    members.forEach(m => {
      config.baseline[m.username] = m.racesPlayed;
      console.log(`Reset baseline[${m.username}] = ${m.racesPlayed}`);
    });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
    console.log('baseline.json updated successfully.');
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
})();
