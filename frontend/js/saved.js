/* Sarodyatra — saved.js : saved places and plans (this browser), shown from the bookmark button */
const Saved = {
  places: U.load('places', []), plans: U.load('plans', []),
  init() {
    U.$('#savedBtn').onclick = e => { e.stopPropagation(); const p = U.$('#savedPop'); if (p.hidden) this.open(); else p.hidden = true; };
    document.addEventListener('click', e => { const p = U.$('#savedPop'); if (!p.hidden && !p.contains(e.target)) p.hidden = true; });
  },
  has(name) { return this.places.some(x => x.name === name); },
  togglePlace(p) {
    const i = this.places.findIndex(x => x.name === p.name);
    if (i >= 0) this.places.splice(i, 1); else { this.places.unshift({ ...p, saved: Date.now() }); U.toast(t('sv.savedPlace', { name: p.pid ? locName(Pandals.byId[p.pid]?.properties || p) : p.name })); }
    U.save('places', this.places);
  },
  addPlan(R) {
    this.plans.unshift({ day: R.day, start: R.request.start, stops: R.request.stops, request: R.request, n: R.timeline.length - 1, saved: Date.now() });
    this.plans = this.plans.slice(0, 20); U.save('plans', this.plans); U.toast(t('sv.savedPlan'));
  },
  open() {
    const pop = U.$('#savedPop');
    const pl = this.places.map((p, i) => `<div class="dd" data-p="${i}"><span class="k" style="--c:${p.type === 'station' ? '#1F6FD1' : '#B5121B'}"></span>
      <div style="flex:1"><div class="t">${U.esc(p.pid ? locName(Pandals.byId[p.pid]?.properties || p) : (p.type === 'station' ? Metro.label(p.name) : p.name))}</div></div>
      <button class="x" data-rm="${i}" title="${U.esc(t('plan.remove'))}">${U.icon('x')}</button></div>`).join('');
    const pn = this.plans.map((p, i) => `<div class="dd" data-plan="${i}"><span class="k" style="--c:#B8860B"></span>
      <div style="flex:1"><div class="t">${U.esc(t('day.' + p.day))} · ${U.esc(U.time(p.start))}</div><div class="s">${U.esc(t('plan.summary', { n: p.n, dur: '' }).replace(/ · ~$/, ''))}</div></div>
      <button class="x" data-rmp="${i}" title="${U.esc(t('plan.remove'))}">${U.icon('x')}</button></div>`).join('');
    pop.innerHTML = `<h4>${U.esc(t('sv.places'))}</h4>${pl || `<p class="hint" style="padding:4px 6px">${U.esc(t('sv.empty'))}</p>`}
      <h4>${U.esc(t('sv.plans'))}</h4>${pn || `<p class="hint" style="padding:4px 6px">${U.esc(t('sv.empty'))}</p>`}`;
    const b = U.$('#savedBtn').getBoundingClientRect();
    pop.hidden = false; pop.style.top = (b.bottom + 6) + 'px'; pop.style.left = Math.max(10, b.right - pop.offsetWidth) + 'px';
    pop.querySelectorAll('[data-p]').forEach(el => el.onclick = e => {
      if (e.target.closest('[data-rm]')) { this.places.splice(+e.target.closest('[data-rm]').dataset.rm, 1); U.save('places', this.places); this.open(); return; }
      const p = this.places[+el.dataset.p]; pop.hidden = true;
      if (p.pid) Pandals.select(p.pid, true); else if (p.type === 'station') Metro.open(p.name, true); else MapApp.flyThen(p.lat, p.lon, 16);
    });
    pop.querySelectorAll('[data-plan]').forEach(el => el.onclick = e => {
      if (e.target.closest('[data-rmp]')) { this.plans.splice(+e.target.closest('[data-rmp]').dataset.rmp, 1); U.save('plans', this.plans); this.open(); return; }
      const p = this.plans[+el.dataset.plan]; pop.hidden = true;
      Planner.stops = p.stops; Clock.set(p.day, U.toMin(p.start)); App.leftTab('plan'); Planner.run({ ...p.request, optimize: false });
    });
  },
};
