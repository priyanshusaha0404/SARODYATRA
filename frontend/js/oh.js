/* Sarodyatra — oh.js : compact parser for OpenStreetMap opening_hours
   Handles the common forms: "24/7", "Mo-Su 10:00-22:30", "Mo-Fr 09:00-21:00; Sa,Su 10:00-23:00",
   multiple ranges "11:00-15:00,18:00-23:30", ranges past midnight "18:00-02:00", "off".
   Anything more exotic returns null (= unknown) instead of guessing. */
const OH = {
  DAYS: ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'],
  _days(spec) {
    const out = new Set();
    for (const part of spec.split(',')) {
      const m = part.trim().match(/^(Mo|Tu|We|Th|Fr|Sa|Su)(?:\s*-\s*(Mo|Tu|We|Th|Fr|Sa|Su))?$/);
      if (!m) return null;
      let a = OH.DAYS.indexOf(m[1]), b = m[2] ? OH.DAYS.indexOf(m[2]) : a;
      for (let i = a; ; i = (i + 1) % 7) { out.add(i); if (i === b) break; }
    }
    return out;
  },
  /** returns true (open) / false (closed) / null (unknown) for a Date */
  isOpen(str, when = new Date()) {
    if (!str) return null;
    str = str.trim();
    if (str === '24/7') return true;
    const dow = (when.getDay() + 6) % 7;               // Monday = 0
    const minutes = when.getHours() * 60 + when.getMinutes();
    let result = false, understood = false;
    for (let rule of str.split(';')) {
      rule = rule.trim(); if (!rule) continue;
      let m = rule.match(/^((?:(?:Mo|Tu|We|Th|Fr|Sa|Su)(?:\s*-\s*(?:Mo|Tu|We|Th|Fr|Sa|Su))?\s*,?\s*)+)\s+(.+)$/);
      let days = new Set([0, 1, 2, 3, 4, 5, 6]), times = rule;
      if (m) { days = OH._days(m[1].replace(/\s+$/, '').replace(/,$/, '')); times = m[2]; }
      if (!days) return null;
      if (/^off$|^closed$/i.test(times.trim())) { if (days.has(dow)) { result = false; understood = true; } continue; }
      const ranges = times.split(',').map(t => t.trim().match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\+?$/));
      if (ranges.some(r => !r)) return null;
      understood = true;
      for (const r of ranges) {
        const a = +r[1] * 60 + +r[2], b = +r[3] * 60 + +r[4];
        if (b > a) { if (days.has(dow) && minutes >= a && minutes < b) result = true; }
        else {   // crosses midnight
          if (days.has(dow) && minutes >= a) result = true;
          if (days.has((dow + 6) % 7) && minutes < b) result = true;
        }
      }
    }
    return understood ? result : null;
  },
};
