const IcalExpander = require('ical-expander');

const JOIN_RE = /https:\/\/(?:meet\.google\.com|[\w.-]*zoom\.us|teams\.microsoft\.com|teams\.live\.com)\/[^\s"'<>)\\]+/i;

// Google sometimes stores titles HTML-escaped ("I&amp;S").
const decode = (t) =>
  String(t || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&');

function toItem(ev, startDate, endDate, calendar) {
  const text = `${ev.location || ''} ${ev.description || ''}`;
  const join = text.match(JOIN_RE);
  const start = startDate.toJSDate().getTime();
  return {
    id: `${ev.uid}|${start}`,
    title: decode(ev.summary) || '(no title)',
    start,
    end: endDate ? endDate.toJSDate().getTime() : start,
    allDay: Boolean(startDate.isDate),
    location: decode(ev.location),
    joinUrl: join ? join[0] : null,
    calendar,
  };
}

/** Expand an .ics document into concrete event instances overlapping [from, to). */
function parseEvents(ics, from, to, calendar = 0) {
  const expander = new IcalExpander({ ics, maxIterations: 2000 });
  const { events, occurrences } = expander.between(from, to);
  const out = [
    ...events.map((e) => toItem(e, e.startDate, e.endDate, calendar)),
    ...occurrences.map((o) => toItem(o.item, o.startDate, o.endDate, calendar)),
  ];
  return out.filter((e) => e.end > from.getTime() && e.start < to.getTime());
}

function dayRange(now = new Date(), days = 2) {
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const to = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days);
  return { from, to };
}

/** opts.urls overrides config.icalUrls (homework feeds); opts.days is how far ahead to look. */
function start(config, onUpdate, opts = {}) {
  const urls = opts.urls || config.icalUrls;
  const days = opts.days || 2;
  let events = [];
  let stopped = false;

  async function refresh() {
    if (!urls.length) {
      onUpdate({ status: 'unconfigured', events: [] });
      return;
    }
    const { from, to } = dayRange(new Date(), days);
    const results = await Promise.allSettled(
      urls.map(async (url, i) => {
        const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
        if (!res.ok) throw new Error(`calendar ${i + 1}: HTTP ${res.status}`);
        return parseEvents(await res.text(), from, to, i);
      }),
    );
    if (stopped) return;
    const failed = results.filter((r) => r.status === 'rejected');
    const fresh = results.filter((r) => r.status === 'fulfilled').flatMap((r) => r.value);
    // Keep the last good list if every calendar failed (offline, etc).
    if (fresh.length || !failed.length) events = fresh.sort((a, b) => a.start - b.start);
    onUpdate({
      status: failed.length ? 'error' : 'ok',
      error: failed.length ? failed[0].reason.message : null,
      events,
      updatedAt: Date.now(),
    });
  }

  refresh().catch((err) => onUpdate({ status: 'error', error: err.message, events }));
  const timer = setInterval(() => refresh().catch(() => {}), config.calendarRefreshMinutes * 60e3);
  return {
    refresh: () => refresh().catch(() => {}),
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}

module.exports = { start, parseEvents, dayRange };
