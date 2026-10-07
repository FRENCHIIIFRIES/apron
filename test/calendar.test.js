const test = require('node:test');
const assert = require('node:assert');
const { parseEvents } = require('../src/calendar');

const ICS = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//test//EN
BEGIN:VEVENT
UID:standup@google.com
DTSTART:20261005T090000Z
DTEND:20261005T091500Z
RRULE:FREQ=DAILY;COUNT=10
SUMMARY:Standup
DESCRIPTION:Join: https://meet.google.com/abc-defg-hij
END:VEVENT
BEGIN:VEVENT
UID:standup@google.com
RECURRENCE-ID:20261008T090000Z
DTSTART:20261008T100000Z
DTEND:20261008T101500Z
SUMMARY:Standup (moved)
END:VEVENT
BEGIN:VEVENT
UID:dentist@google.com
DTSTART:20261007T140000Z
DTEND:20261007T150000Z
SUMMARY:Dentist
LOCATION:Main St
END:VEVENT
BEGIN:VEVENT
UID:holiday@google.com
DTSTART;VALUE=DATE:20261008
DTEND;VALUE=DATE:20261009
SUMMARY:Holiday
END:VEVENT
BEGIN:VEVENT
UID:old@google.com
DTSTART:20260101T100000Z
DTEND:20260101T110000Z
SUMMARY:Old
END:VEVENT
END:VCALENDAR`;

const from = new Date('2026-10-07T00:00:00Z');
const to = new Date('2026-10-09T00:00:00Z');

test('expands recurrences and keeps only events in range', () => {
  const titles = parseEvents(ICS, from, to).map((e) => e.title).sort();
  assert.deepStrictEqual(titles, ['Dentist', 'Holiday', 'Standup', 'Standup (moved)']);
});

test('uses the overridden instance time', () => {
  const moved = parseEvents(ICS, from, to).find((e) => e.title === 'Standup (moved)');
  assert.strictEqual(new Date(moved.start).toISOString(), '2026-10-08T10:00:00.000Z');
});

test('finds meeting links and flags all-day events', () => {
  const events = parseEvents(ICS, from, to);
  assert.strictEqual(events.find((e) => e.title === 'Standup').joinUrl, 'https://meet.google.com/abc-defg-hij');
  assert.strictEqual(events.find((e) => e.title === 'Dentist').joinUrl, null);
  assert.strictEqual(events.find((e) => e.title === 'Holiday').allDay, true);
  assert.strictEqual(events.find((e) => e.title === 'Dentist').location, 'Main St');
});
