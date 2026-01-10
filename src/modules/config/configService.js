// src/modules/config/configService.js

let cache = {
  data: null,
  timestamp: 0,
};

const CACHE_TTL = 8000;

async function loadConfig() {
  // 👉 acá va la lectura real de Google Sheets
  // devolver objeto { KEY: VALUE }
}

function normalize(value) {
  if (value === "SI") return true;
  if (value === "NO") return false;
  if (!isNaN(value)) return Number(value);
  if (typeof value === "string" && value.includes("|"))
    return value.split("|").map(v => v.trim());
  return value;
}

async function getConfig() {
  const now = Date.now();
  if (cache.data && now - cache.timestamp < CACHE_TTL) {
    return cache.data;
  }

  const raw = await loadConfig();
  const normalized = {};

  for (const key in raw) {
    normalized[key] = normalize(raw[key]);
  }

  cache = {
    data: normalized,
    timestamp: now,
  };

  return normalized;
}

module.exports = {
  async get(key) {
    const cfg = await getConfig();
    return cfg[key];
  },

  async isEnabled(key) {
    const val = await this.get(key);
    return val === true;
  },

  async text(key) {
    return this.get(key);
  },

  async number(key) {
    const val = await this.get(key);
    return Number(val);
  },

  async list(key) {
    const val = await this.get(key);
    return Array.isArray(val) ? val : [];
  },
}; 
