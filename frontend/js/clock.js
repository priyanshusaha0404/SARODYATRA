/* Sarodyatra — clock.js : selected Puja day + time (top bar). Crowds, closures, metro checks,
   routes and plans all follow it. Minutes 0–299 belong to the night of the selected day. */
const Clock = {
  cal: null, day: 'Saptami', min: 18 * 60, isNow: false,
  get hour() { return Math.floor(this.min / 60) % 24; },

  init(cal) {
    this.cal = cal;
    U.$('#dayBtn').onclick = e => { e.stopPropagation(); this.openDays(); };
    U.$('#timeBtn').onclick = e => { e.stopPropagation(); this.openTime(); };
    U.on('lang', () => this.label());
    this.now(false);
  },
  days() { return this.cal.days.filter(d => d.key !== 'Mahalaya'); },
  dateFor: {},                       // a tithi that runs over two days → today's date while it is "now"
  info(day = this.day) {
    const d = this.cal.days.find(x => x.key === day);
    if (!d) return { key: day, factor: .2, date: new Date().toISOString().slice(0, 10) };
    return this.dateFor[day] ? { ...d, date: this.dateFor[day] } : d;
  },

  now(explicit) {
    const n = new Date();
    const d = n.getHours() < 5 ? new Date(n.getTime() - 86400000) : n;
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const match = this.days().find(x => x.date === iso || (x.extra_dates || []).includes(iso));
    this.dateFor = match && match.date !== iso ? { [match.key]: iso } : {};
    if (match) { this.isNow = true; this.set(match.key, Math.floor((n.getHours() * 60 + n.getMinutes()) / 30) * 30); }
    else {
      this.isNow = false;
      this.set(U.load('clockDay', 'Saptami'), U.load('clockMin', 18 * 60));
      if (explicit) U.toast(t('clock.preview', { day: t('day.' + this.day) }));
    }
  },
  set(day, min, quiet = false) {
    this.day = day; this.min = ((min % 1440) + 1440) % 1440;
    this.label();
    if (quiet) return;
    U.save('clockDay', day); U.save('clockMin', this.min);
    U.emit('clock', { day, min: this.min });
  },
  label() {
    U.$('#dayLabel').textContent = t('day.' + this.day);
    U.$('#dayDate').textContent = U.date(this.info().date, { weekday: 'short', day: 'numeric', month: 'short' });
    U.$('#timeLabel').textContent = U.time(this.min);
  },
  text() { return `${t('day.' + this.day)}, ${U.time(this.min)}`; },

  place(pop, btn) {
    const r = btn.getBoundingClientRect();
    pop.hidden = false;
    pop.style.top = (r.bottom + 6) + 'px';
    pop.style.left = Math.min(r.left, innerWidth - pop.offsetWidth - 10) + 'px';
    const close = e => { if (!pop.contains(e.target) && e.target !== btn) { pop.hidden = true; document.removeEventListener('click', close); } };
    setTimeout(() => document.addEventListener('click', close), 0);
  },
  openDays() {
    const pop = U.$('#dayPop');
    const today = new Date().toISOString().slice(0, 10);
    pop.innerHTML = `<h4>${U.esc(t('top.day'))}</h4>` + this.days().map(d => `<button class="day-opt ${d.key === this.day ? 'on' : ''}" data-k="${d.key}">
      <span>${U.esc(t('day.' + d.key))} ${d.date === today || (d.extra_dates || []).includes(today) ? `<span class="today">• ${U.esc(t('top.now'))}</span>` : ''}</span>
      <small>${U.esc(U.date(d.date, { weekday: 'short', day: 'numeric', month: 'short' }))}${(d.extra_dates || []).map(x => ' + ' + U.esc(U.date(x, { weekday: 'short', day: 'numeric' }))).join('')}</small></button>`).join('');
    pop.querySelectorAll('.day-opt').forEach(b => b.onclick = () => { pop.hidden = true; this.set(b.dataset.k, this.min); });
    this.place(pop, U.$('#dayBtn'));
  },
  /* slider runs 06:00 → 05:30 next morning in 30-minute steps */
  toSlot(min) { return ((min - 360 + 1440) % 1440) / 30; },
  fromSlot(s) { return (360 + s * 30) % 1440; },
  openTime() {
    const pop = U.$('#timePop'); pop.classList.add('time-pop');
    const q = [['time.morning', 600], ['time.afternoon', 840], ['time.evening', 1080], ['time.night', 1260], ['time.late', 60]];
    pop.innerHTML = `<h4>${U.esc(t('top.time'))}</h4><div class="time-big" id="tpBig">${U.time(this.min)}</div>
      <input type="range" id="tpRange" min="0" max="47" step="1" value="${this.toSlot(this.min)}">
      <div class="qchips">${q.map(([k, m]) => `<button class="trail" data-m="${m}">${U.esc(t(k))}</button>`).join('')}<button class="trail" data-now="1">${U.esc(t('top.now'))}</button></div>`;
    const rg = pop.querySelector('#tpRange');
    rg.oninput = () => { pop.querySelector('#tpBig').textContent = U.time(this.fromSlot(+rg.value)); this.set(this.day, this.fromSlot(+rg.value), true); };
    rg.onchange = () => this.set(this.day, this.fromSlot(+rg.value));
    pop.querySelectorAll('[data-m]').forEach(b => b.onclick = () => { this.set(this.day, +b.dataset.m); pop.hidden = true; });
    pop.querySelector('[data-now]').onclick = () => { pop.hidden = true; this.now(true); };
    this.place(pop, U.$('#timeBtn'));
  },

  date(day = this.day, min = this.min) {
    const d = new Date(this.info(day).date + 'T00:00');
    d.setHours(Math.floor(min / 60), min % 60, 0, 0);
    if (min < 300) d.setDate(d.getDate() + 1);
    return d;
  },
  when(day, min) {
    const d = this.date(day ?? this.day, min ?? this.min), p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  },
  hm() { return U.hm(this.min); },

  /* crowd at a slot: model × rain forecast; with a pandal id, live visitor reports near "now" */
  crowd(pop, day = this.day, hour = this.hour, pid = null) { return Crowd.calc(pop, day, hour, pid); },
  closureActive(p, day = this.day, min = this.min) {
    const days = p.days || 'all';
    if (days !== 'all' && !days.split(',').includes(day)) return false;
    if (p.expires && +p.expires * 1000 < Date.now()) return false;
    const a = U.toMin(p.t_start || '00:00'), b = U.toMin(p.t_end || '23:59');
    return a <= b ? (min >= a && min <= b) : (min >= a || min <= b);
  },
};
