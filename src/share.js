// Finds a shareable link for the song that's playing. Windows' media controls don't
// expose track IDs, so we look the song up on iTunes Search (free, no key) and share
// its song.link page, which opens the track on Spotify, Apple Music, YouTube and more.
// (song.link's JSON API needs a key now; its public pages don't.) Falls back to a
// Spotify search link.

const cache = new Map();

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { 'User-Agent': 'Apron' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function searchLink(title, artist) {
  return `https://open.spotify.com/search/${encodeURIComponent(`${title} ${artist || ''}`.trim())}`;
}

const clean = (s) => String(s || '').toLowerCase().replace(/\(.*?\)|\[.*?\]|[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

/** { url, exact } - exact is false when we could only build a search link. */
async function spotifyLink(title, artist) {
  const key = `${title}|${artist}`;
  if (cache.has(key)) return cache.get(key);
  let result = { url: searchLink(title, artist), exact: false };
  try {
    const term = encodeURIComponent(`${title} ${artist || ''}`.trim());
    const it = await getJson(`https://itunes.apple.com/search?media=music&entity=song&limit=5&term=${term}`);
    // Make sure it's the same song, not just a similar title.
    const want = clean(title).split(' ')[0];
    const track = (it.results || []).find((r) => clean(r.trackName).includes(want) && (!artist || clean(artist).includes(clean(r.artistName).split(' ')[0]) || clean(r.artistName).includes(clean(artist).split(' ')[0])));
    if (track && track.trackId) result = { url: `https://song.link/i/${track.trackId}`, exact: true };
  } catch {
    // keep the search link
  }
  cache.set(key, result);
  return result;
}

module.exports = { spotifyLink, searchLink };
