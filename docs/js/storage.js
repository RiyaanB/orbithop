// localStorage persistence for settings, stats and daily results. Fails soft (private mode etc).
const KEY = 'orbithop.v1';

const defaults = () => ({
  settings: { sfx: true, music: true },
  seenHowTo: false,
  stats: { runs: 0, totalHops: 0, totalStars: 0, perfects: 0, bestScore: 0, bestHops: 0, bestCombo: 0 },
  daily: {}, // 'YYYY-MM-DD' -> { attempts, best: {score,hops,stars,perfects,maxCombo,hopLog} }
  streak: { last: null, count: 0, best: 0 },
  race: { played: 0, wins: 0, bestPlace: null, bestTicks: null },
});

let mem = null;

export function load() {
  if (mem) return mem;
  let data = null;
  try {
    data = JSON.parse(localStorage.getItem(KEY) || 'null');
  } catch {
    data = null;
  }
  const d = defaults();
  mem = data && typeof data === 'object' ? deepMerge(d, data) : d;
  // keep the daily table small
  const keys = Object.keys(mem.daily).sort();
  while (keys.length > 60) delete mem.daily[keys.shift()];
  return mem;
}

export function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(mem));
  } catch {
    /* storage unavailable — keep in memory */
  }
}

function deepMerge(base, over) {
  for (const k of Object.keys(over)) {
    if (base[k] && typeof base[k] === 'object' && !Array.isArray(base[k]) && over[k] && typeof over[k] === 'object') {
      deepMerge(base[k], over[k]);
    } else if (over[k] !== undefined) {
      base[k] = over[k];
    }
  }
  return base;
}

/** Previous calendar day key for streaks. */
export function prevDayKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  const dt = new Date(y, m - 1, d - 1);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}
