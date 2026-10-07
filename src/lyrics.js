// Synced lyrics from LRCLIB (free, no API key), fetched once per track.

/** "[01:23.45] line" LRC text -> [{ t: seconds, text }] sorted by time. */
function parseLrc(lrc) {
  const lines = [];
  for (const raw of String(lrc || '').split(/\r?\n/)) {
    const stamps = [...raw.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    if (!stamps.length) continue;
    const text = raw.replace(/\[[^\]]*\]/g, '').trim();
    for (const s of stamps) lines.push({ t: Number(s[1]) * 60 + Number(s[2]), text });
  }
  return lines.sort((a, b) => a.t - b.t);
}

/** Index of the line playing at `pos` seconds, or -1 before the first line. */
function lineAt(lines, pos) {
  let lo = 0;
  let hi = lines.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].t <= pos) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

// Strip things like " - 1998 Remastered Version" and "(feat. X)" that LRCLIB won't know.
function cleanTitle(title) {
  return String(title || '')
    .replace(/\s*[-–]\s*(\d{4}\s+)?remaster(ed)?.*$/i, '')
    .replace(/\s*\((feat|ft|with)\.?[^)]*\)/gi, '')
    .trim();
}

function create(onUpdate) {
  const cache = new Map();
  let currentKey = '';

  async function fetchFor(m) {
    const title = cleanTitle(m.title);
    const artist = String(m.artist || '').split(/,|&| feat\.? /i)[0].trim();
    const params = new URLSearchParams({ track_name: title, artist_name: artist });
    if (m.duration > 0) params.set('duration', String(Math.round(m.duration)));
    const headers = { 'User-Agent': 'Apron (https://github.com/FRENCHIIIFRIES/apron)' };
    let res = await fetch(`https://lrclib.net/api/get?${params}`, { headers, signal: AbortSignal.timeout(10000) });
    if (res.status === 404) {
      // Durations differ between services; fall back to a search without it.
      params.delete('duration');
      res = await fetch(`https://lrclib.net/api/search?${params}`, { headers, signal: AbortSignal.timeout(10000) });
      const list = res.ok ? await res.json() : [];
      const hit = list.find((r) => r.syncedLyrics);
      return hit ? parseLrc(hit.syncedLyrics) : [];
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return data.syncedLyrics ? parseLrc(data.syncedLyrics) : [];
  }

  return {
    /** Call with each media update; fetches when the track changes. */
    track(m) {
      if (!m || !m.active || !m.title) return;
      const key = `${m.title}|${m.artist}`;
      if (key === currentKey) return;
      currentKey = key;
      if (cache.has(key)) {
        onUpdate({ key, lines: cache.get(key) });
        return;
      }
      onUpdate({ key, lines: null }); // loading
      fetchFor(m)
        .then((lines) => {
          cache.set(key, lines);
          if (cache.size > 50) cache.delete(cache.keys().next().value);
          if (key === currentKey) onUpdate({ key, lines });
        })
        .catch(() => {
          if (key === currentKey) onUpdate({ key, lines: [] });
        });
    },
  };
}

module.exports = { create, parseLrc, lineAt, cleanTitle };
