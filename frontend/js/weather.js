/* Sarodyatra — weather.js : live temperature, rain chance and air quality for the map view (Open-Meteo, no key) */
const Weather = {
  data: null,
  async init() {
    U.on('lang', () => this.render());
    await this.load();
    setInterval(() => this.load(), 20 * 60 * 1000);
  },
  async load() {
    const [lat, lon] = CFG.CENTER;
    const [w, a] = await Promise.all([
      U.json(`${CFG.OPEN_METEO}?latitude=${lat}&longitude=${lon}&current=temperature_2m,precipitation,weather_code&hourly=precipitation_probability&forecast_days=1&timezone=Asia%2FKolkata`, {}, 9000),
      U.json(`${CFG.AIR_QUALITY}?latitude=${lat}&longitude=${lon}&current=us_aqi&timezone=Asia%2FKolkata`, {}, 9000)]);
    if (w.error || !w.current) return;
    const h = new Date().getHours();
    const rain = (w.hourly?.precipitation_probability || [])[h];
    this.data = { temp: Math.round(w.current.temperature_2m), code: w.current.weather_code, rain, aqi: a && a.current ? Math.round(a.current.us_aqi) : null };
    this.render();
  },
  render() {
    const d = this.data, el = U.$('#weather'); if (!d) return;
    const icon = d.code >= 51 ? 'rain' : d.code >= 2 ? 'cloud' : 'sun';
    const aq = d.aqi == null ? '' : d.aqi <= 50 ? 'aqi.good' : d.aqi <= 100 ? 'aqi.moderate' : d.aqi <= 150 ? 'aqi.poor' : 'aqi.bad';
    el.innerHTML = `${U.icon(icon)}<div><b>${d.temp}°C</b>${d.rain != null ? `<small>${U.esc(t('g.weatherRain', { p: d.rain }))}</small>` : ''}</div>
      ${d.aqi != null ? `<div class="aqi"><b style="font-size:14px">${U.esc(t('g.aqi', { v: d.aqi }))}</b><small>${U.esc(t(aq))}</small></div>` : ''}`;
    el.hidden = false;
  },
};
