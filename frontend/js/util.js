/* Sarodyatra — util.js : shared helpers, localized formatting, icon set, tiny event bus */
const U = {
  $: (s, r = document) => r.querySelector(s),
  $$: (s, r = document) => [...r.querySelectorAll(s)],
  esc: s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
  toast(msg, ms = 3000) {
    const el = U.$('#toast'); el.textContent = msg; el.classList.add('show');
    clearTimeout(U._tt); U._tt = setTimeout(() => el.classList.remove('show'), ms);
  },
  hav(a1, o1, a2, o2) {
    const p = Math.PI / 180, R = 6371000;
    const a = Math.sin((a2 - a1) * p / 2) ** 2 + Math.cos(a1 * p) * Math.cos(a2 * p) * Math.sin((o2 - o1) * p / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  },
  /* localized units */
  km(m) {
    m = Math.max(0, +m || 0);
    return m < 1000 ? t('u.m', { n: Math.round(m / 10) * 10 }) : t('u.km', { n: (m / 1000).toFixed(m < 10000 ? 1 : 0) });
  },
  mins(m) {
    m = Math.max(0, Math.round(+m || 0));
    if (m < 60) return t('u.min', { n: m });
    const h = Math.floor(m / 60), r = m % 60;
    return r ? t('u.hmin', { h, m: r }) : t('u.h', { h });
  },
  /** "18:30" (or minutes since midnight) → localized "6:30 PM" */
  time(v) {
    let h, m;
    if (typeof v === 'number') { h = Math.floor(v / 60) % 24; m = v % 60; }
    else { [h, m] = String(v || '0:0').split(':').map(Number); }
    const d = new Date(2026, 9, 18, h, m);
    return new Intl.DateTimeFormat(I18N.lang === 'en' ? 'en-US' : I18N.LOCALE[I18N.lang], { hour: 'numeric', minute: '2-digit', hour12: true }).format(d);
  },
  date(iso, opts = { day: 'numeric', month: 'short' }) {
    return new Intl.DateTimeFormat(I18N.LOCALE[I18N.lang], opts).format(new Date(iso + 'T12:00'));
  },
  hm(min) { min = ((Math.round(min) % 1440) + 1440) % 1440; return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`; },
  toMin(hm) { const [h, m] = String(hm).split(':').map(Number); return h * 60 + (m || 0); },

  debounce(fn, ms = 250) { let tm; return (...a) => { clearTimeout(tm); tm = setTimeout(() => fn(...a), ms); }; },
  async json(url, opts = {}, timeout = 30000) {
    const ctl = new AbortController(); const id = setTimeout(() => ctl.abort(), timeout);
    try {
      const r = await fetch(url, { ...opts, signal: ctl.signal });
      const ct = r.headers.get('content-type') || '';
      const data = ct.includes('json') ? await r.json() : { error: (await r.text()).slice(0, 300) };
      if (!r.ok && data && !data.error) data.error = `HTTP ${r.status}`;
      if (data && typeof data === 'object') data._status = r.status;
      return data;
    } catch (e) { return { error: e.name === 'AbortError' ? 'timeout' : e.message, _status: 0 }; }
    finally { clearTimeout(id); }
  },
  post(url, body, timeout = 120000) { return U.json(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, timeout); },   // plans can take a while on a small server
  download(content, name, type = 'text/plain') {
    const blob = content instanceof Blob ? content : new Blob([content], { type });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 800);
  },
  load(k, d) { try { return JSON.parse(localStorage.getItem('pujox:' + k)) ?? d; } catch { return d; } },
  save(k, v) { try { localStorage.setItem('pujox:' + k, JSON.stringify(v)); } catch {} },

  /* event bus */
  _ev: {},
  on(e, f) { (U._ev[e] = U._ev[e] || []).push(f); },
  emit(e, d) { (U._ev[e] || []).forEach(f => { try { f(d); } catch (err) { console.error(e, err); } }); },

  /* text matching that copes with Kolkata spelling variants */
  norm: s => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9ঀ-৿ऀ-ॿ ]/g, ' ').replace(/\s+/g, ' ').trim(),
  VARIANTS: [[/bagh ?bazar|bag bazar/g, 'bagbazar'], [/sho[bv]h?abazar|sobhabazar|shovabazar/g, 'sovabazar'], [/kumor ?tuli|kumar ?tuli/g, 'kumartuli'],
    [/sarbo?jonin|sarbajanin|sarvajanin/g, 'sarbojanin'], [/desh ?priya/g, 'deshapriya'], [/sree ?bhumi|sri ?bhumi|shreebhumi/g, 'sreebhumi'],
    [/(muhammad|mohammad|md) ali/g, 'muhammad ali'], [/ekdaliya/g, 'ekdalia'], [/ahiritala/g, 'ahiritola'], [/notun/g, 'nutan'], [/palli\b/g, 'pally'],
    [/college (sq|sqare|sqaure|squre|sqr)\b/g, 'college square'], [/bally ?gunj\b|baliganj|ballyganj/g, 'ballygunge'], [/santosh ?mitra/g, 'santosh mitra'], [/salt ?lake/g, 'salt lake'], [/lake ?town/g, 'lake town']],
  /* Bengali / Hindi spellings of well-known puja localities → the English names used in the data */
  SCRIPT_ALIASES: [['বাগবাজার|बागबाज़ार|बागबाजार', 'bagbazar'], ['কুমারটুলি|কুমোরটুলি|कुमारटुली|कुमोरटुली', 'kumartuli'], ['আহিরীটোলা|অহিরীটোলা|अहिरीटोला', 'ahiritola'],
    ['শোভাবাজার|शोभाबाज़ार|शोभाबाजार', 'sovabazar'], ['রাজবাড়ি|राजबाड़ी', 'rajbari'], ['দেশপ্রিয়|देशप्रिय', 'deshapriya'], ['একডালিয়া|एकडालिया', 'ekdalia'],
    ['সুরুচি|सुरुचि', 'suruchi'], ['চেতলা|चेतला', 'chetla'], ['ত্রিধারা|त्रिधारा', 'tridhara'], ['সিংহী|সিংঘী|सिंघी', 'singhi'], ['কলেজ স্কোয়ার|कॉलेज स्क्वायर', 'college square'],
    ['মহম্মদ আলি|মোহাম্মদ আলি|मोहम्मद अली', 'muhammad ali'], ['সন্তোষ মিত্র|संतोष मित्रा|संतोष मित्र', 'santosh mitra'], ['হাতিবাগান|हाथीबागान|हातीबागान', 'hatibagan'],
    ['শ্রীভূমি|श्रीभूमि', 'sreebhumi'], ['লেকটাউন|লেক টাউন|लेक टाउन', 'lake town'], ['বেহালা|बेहाला', 'behala'], ['নাকতলা|नकतला|नाकतला', 'naktala'],
    ['হিন্দুস্তান পার্ক|हिंदुस्तान पार्क', 'hindusthan park'], ['বাদামতলা|बादामतला', 'badamtala'], ['মুদিয়ালি|मुदियाली', 'mudiali'], ['কাশী বোস|काशी बोस', 'kashi bose'],
    ['দমদম পার্ক|दमदम पार्क', 'dum dum park'], ['টালা|टाला', 'tala'], ['সিকদার বাগান|सिकदार बागान', 'sikdar bagan'], ['জগৎ মুখার্জি|जगत मुखर्जी', 'jagat mukherjee'],
    ['কালীঘাট|कालीघाट', 'kalighat'], ['ভবানীপুর|भवानीपुर', 'bhowanipur'], ['বালিগঞ্জ|बालीगंज', 'ballygunge'], ['সল্টলেক|সল্ট লেক|साल्ट लेक', 'salt lake'],
    ['বেলেঘাটা|बेलेघाटा', 'beliaghata'], ['খিদিরপুর|खिदिरपुर', 'kidderpore'], ['বড়িশা|बड़िशा', 'barisha'], ['মল্লিক বাড়ি|मल्लिक बाड़ी', 'mallick bari'],
    ['লাহা বাড়ি|लाहा बाड़ी', 'laha bari'], ['রানী রাসমণি|रानी रासमणि', 'rani rashmoni'], ['ঠনঠনিয়া|ठनठनिया', 'thanthania'], ['দত্ত বাড়ি|दत्त बाड़ी', 'dutta bari']]
    .map(([a, b]) => [new RegExp(a, 'g'), ` ${b} `]),
  canon(s) { let n = String(s || ''); U.SCRIPT_ALIASES.forEach(([re, to]) => n = n.replace(re, to)); n = U.norm(n); U.VARIANTS.forEach(([re, to]) => n = n.replace(re, to)); return n; },

  /* typo-tolerant names: a sound key for romanised Bangla (sh/s, bh/b, o/a, ee/i, w/v/b … all the same)
     and a small edit distance, so "hatibagn", "sribhumi", "kumortuli", "baghbazaar" find the right place */
  phon(w) {
    return String(w || '').toLowerCase().replace(/[^a-z]/g, '')
      .replace(/ph/g, 'f').replace(/bh/g, 'b').replace(/dh/g, 'd').replace(/th/g, 't').replace(/gh/g, 'g').replace(/kh/g, 'k').replace(/ch/g, 'c').replace(/jh/g, 'j').replace(/sh/g, 's')
      .replace(/[wv]/g, 'b').replace(/z/g, 'j').replace(/q/g, 'k').replace(/x/g, 'ks').replace(/ee|y/g, 'i').replace(/oo/g, 'u').replace(/o/g, 'a')
      .replace(/h/g, '').replace(/(.)\1+/g, '$1');
  },
  lev(a, b, max = 2) {
    if (Math.abs(a.length - b.length) > max) return max + 1;
    let pp = null, prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i]; let low = i;
      for (let j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        if (pp && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) cur[j] = Math.min(cur[j], pp[j - 2] + 1);   // swapped letters
        low = Math.min(low, cur[j]);
      }
      if (low > max) return max + 1;
      pp = prev; prev = cur;
    }
    return prev[b.length];
  },
  /* words people type that must never be "corrected" into a place name */
  KEEP: new Set(('where there which when what with from into then than this that they them have here near nearby please thanks thank route train trains metro station local road walk taxi bus buses ' +
    'north south east west central kolkata calcutta pandal pandals pujo puja durga thakur famous bonedi hours hour today tonight evening morning night start plan trip ' +
    'theke kivabe kibhabe jabo jaabo jete dekhbo dekhte khabo khabar khete thaki achi ache achhe amar amra ekhon ekhane kache sondhe bikel raat ghonta ghanta minute minutes ' +
    'toilet hospital police crowd queue bhir chai coffee sweets mishti food hungry water emergency help location current about after before going visit want shall could would ' +
    'kaise kahan jana jaana dekhna ghumna sabse famous best quiet quietest timing timings first last open close closed block blocked ' +
    'shashthi sasthi soshti saptami soptomi ashtami oshtomi navami nobomi dashami doshomi panchami mahalaya bijoya sharodiya saradiya sharadiya shubho subho ' +
    'washroom bathroom restaurant biryani phuchka fuchka sandesh rosogolla rasgulla family friends parents children elderly ticket tickets platform ' +
    'korbo korchi korte korben jacchi jachhi thakbo ghurbo berobo kothay kothai kokhon kemon kotodur hoyeche ashchi aschi firbo ferar bondhu ' +
    'karna karenge chahiye kitna kitne jayenge wapas mujhe humein chalo chalna saath sathe saathe')
    .split(' ')),
  /* name words that say nothing about which place it is — never a correction target */
  GENERIC: new Set(('durga puja pujo utsab utsav sarbojanin sarbajanin sarvajanin club sporting sangha sangh samity samiti committee association parishad ' +
    'park road street lane sarani avenue square state estate block colony nagar pally palli para bari house halt junction chord line cabin station main ' +
    'maidan math mandir temple ghat bazar market society friends youth unit welfare boys girls old upper lower ward city town east west north south central').split(' ')),
  _vocab: null,
  vocab() {
    if (U._vocab) return U._vocab;
    const words = new Map();
    const add = (s, w = 1) => U.canon(s).split(' ').forEach(x => { if (x.length >= 4 && /^[a-z]+$/.test(x) && !U.KEEP.has(x) && !U.GENERIC.has(x)) words.set(x, (words.get(x) || 0) + w); });
    // the app objects are top-level consts (not window properties), so they are named directly
    (typeof Pandals !== 'undefined' && Pandals.all || []).forEach(f => { add(f.properties.name, 2); add(f.properties.locality || ''); });
    (typeof Metro !== 'undefined' && Metro.stations || []).forEach(f => add(f.properties.name, 2));
    (typeof Rail !== 'undefined' && Rail.stations || []).forEach(f => add(f.properties.name));
    (typeof Agent !== 'undefined' && Agent.HOODS || []).forEach(([en]) => add(en, 3));
    const list = [...words].map(([w, n]) => ({ w, n, k: U.phon(w) }));
    if (list.length > 50) U._vocab = list;     // build once the data has loaded
    return list;
  },
  /* rewrite misspelt place words in a sentence to the names we know; everything else is left alone */
  fuzzyFix(text) {
    const V = U.vocab(); if (!V.length) return text;
    const known = new Set(V.map(v => v.w));
    return String(text).replace(/[A-Za-z]{4,}/g, word => {
      const w = word.toLowerCase();
      if (known.has(w) || U.KEEP.has(w) || U.GENERIC.has(w) || U.canon(w) !== w) return word;   // already a name we know (or a spelling canon() fixes)
      const k = U.phon(w); if (k.length < 3) return word;
      // short words only when they sound exactly the same; longer ones may differ by one letter (two from 9 letters on),
      // the first sound must agree, and at most a quarter of it may change
      const max = w.length >= 9 ? 2 : w.length >= 6 ? 1 : 0;
      let best = null, bd = 9;
      for (const v of V) {
        if (v.k[0] !== k[0]) continue;
        if (v.k === k) { if (bd > 0 || v.n > best.n) { best = v; bd = 0; } continue; }
        if (!max || Math.abs(v.k.length - k.length) > max) continue;
        const d = U.lev(k, v.k, max);
        if (d <= max && d / Math.max(k.length, v.k.length) <= .25 && (d < bd || d === bd && v.n > best.n)) { best = v; bd = d; }
      }
      return best ? best.w : word;
    });
  },

  speech(onText, onEnd) {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition; if (!SR) return null;
    const r = new SR(); r.lang = { en: 'en-IN', bn: 'bn-IN', hi: 'hi-IN' }[I18N.lang]; r.interimResults = false;
    r.onresult = e => onText(e.results[0][0].transcript); r.onend = onEnd; r.onerror = onEnd; return r;
  },

  /* the buses for a bus leg: the chosen one first, then every other route that serves the same two stops */
  buses(l) {
    const main = l.ref ? [{ ref: l.ref, name: l.name || '' }] : [];
    const more = (l.others || []).map(x => typeof x === 'string' ? { ref: x, name: '' } : x).filter(x => x.ref && x.ref !== l.ref);
    return main.concat(more).map(b => ({ ...b, raw: b.ref, ref: U.busRef(b.ref, b.name), sta: /^STA_/i.test(b.ref) }));
  },
  /* the number people see on the bus: S_37 → S-37, MIDI_1 → Midi 1; STA routes have none → "STA bus" + where it runs */
  busRef(ref, name) {
    const r = String(ref || '');
    if (/^STA_/i.test(r)) return t('bus.sta');
    return r.replace(/^MIDI_/i, 'Midi ').replace(/_/g, '-');
  },
  /* "DN43 (Madhyamgram – Barasat), STA bus (Dhulagarh – Sealdah)" */
  busNames(l, sep = ', ') { return U.buses(l).map(b => b.name ? `${b.ref} (${String(b.name).replace(/\s*-\s*/g, ' – ')})` : b.ref).join(sep); },

  /* UI fragments */
  crowdChip(level) { return level ? `<span class="crowd c-${level.replace(' ', '-').toLowerCase()}">${U.esc(t('crowd.' + level))}</span>` : ''; },
  lineChip(l) { return `<span class="lchip" style="--c:${CFG.LINES[l] || '#666'}">${U.esc(t('line.' + l))}</span>`; },
  pop5(n) { return `<span class="pop5" title="${n}/5">${[1, 2, 3, 4, 5].map(i => `<i class="${i <= n ? 'on' : ''}"></i>`).join('')}</span>`; },

  /* stroke icon set (24×24) */
  ICONS: {
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    calendar: '<rect x="3.5" y="5" width="17" height="15" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
    clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
    chevron: '<path d="m6 9 6 6 6-6"/>',
    chevronL: '<path d="m15 6-6 6 6 6"/>',
    chevronR: '<path d="m9 6 6 6-6 6"/>',
    bookmark: '<path d="M6.5 3.5h11v17l-5.5-4-5.5 4z"/>',
    heart: '<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/>',
    spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18"/>',
    temple: '<path d="M12 2.5 9.5 6h5zM7 10h10M6 10l1-4h10l1 4M5.5 21v-8h13v8M3.5 21h17M10 21v-4h4v4M12 13v1"/>',
    pin: '<path d="M12 21s-6.5-5.7-6.5-11a6.5 6.5 0 0 1 13 0c0 5.3-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.4"/>',
    star: '<path d="m12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"/>',
    home: '<path d="M4 11 12 4l8 7v9H4z"/><path d="M10 20v-5h4v5"/>',
    metro: '<rect x="5.5" y="3.5" width="13" height="13" rx="3.5"/><path d="M5.5 10.5h13M9 20l-2-3.5M15 20l2-3.5"/><circle cx="9" cy="13.5" r=".8"/><circle cx="15" cy="13.5" r=".8"/>',
    road: '<path d="M7 21 10 3M17 21 14 3M12 6v2M12 11v2M12 16v2"/>',
    block: '<path d="M12 3.5 21 19.5H3z"/><path d="M12 10v4M12 17h.01"/>',
    target: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r=".8"/>',
    locate: '<circle cx="12" cy="12" r="3.2"/><circle cx="12" cy="12" r="8"/><path d="M12 1.5v3M12 19.5v3M1.5 12h3M19.5 12h3"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    minus: '<path d="M5 12h14"/>',
    x: '<path d="M6 6l12 12M18 6 6 18"/>',
    walk: '<circle cx="13" cy="4.5" r="1.8"/><path d="m10 21 2-6.5-2.5-2.5 1-4.5 3 2 3 1M9.5 8 6.5 10l-1 3.5M12 14.5l3 2.5 1 4"/>',
    taxi: '<path d="M5 16V11l2-4.5h10l2 4.5v5M3.5 16h17v3h-17zM9 4h6"/><circle cx="7.5" cy="19" r="1.4"/><circle cx="16.5" cy="19" r="1.4"/>',
    route: '<circle cx="6" cy="18" r="2.4"/><circle cx="18" cy="6" r="2.4"/><path d="M8.4 18H15a3 3 0 0 0 0-6H9a3 3 0 0 1 0-6h6.6"/>',
    send: '<path d="M21 3 10.5 13.5M21 3l-6.5 18-4-7.5L3 9.5z"/>',
    mic: '<rect x="9" y="2.5" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3.5"/>',
    volume: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>',
    volumeX: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="m16 9.5 5 5M21 9.5l-5 5"/>',
    download: '<path d="M12 3.5v12M7 11l5 5 5-5M4.5 20.5h15"/>',
    play: '<path d="M7 4.5v15l12-7.5z"/>',
    pause: '<path d="M8 5v14M16 5v14"/>',
    cube: '<path d="M12 2.5 20.5 7v10L12 21.5 3.5 17V7z"/><path d="M3.5 7 12 11.5 20.5 7M12 11.5v10"/>',
    layers: '<path d="M12 3 2.5 8 12 13l9.5-5z"/><path d="m2.5 13 9.5 5 9.5-5"/>',
    sliders: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
    food: '<path d="M7 3v8M5 3v5a2 2 0 0 0 4 0V3M7 11v10M16 21V3c-2 1-3.5 3.5-3.5 7H16"/>',
    drop: '<path d="M12 3.5s6 6.4 6 10.5a6 6 0 0 1-12 0c0-4.1 6-10.5 6-10.5z"/>',
    toilet: '<circle cx="7" cy="4.5" r="1.6"/><circle cx="17" cy="4.5" r="1.6"/><path d="M5 21v-6H4l1.5-7h3L10 15H9v6M15 21V8h4v7h-1v6"/>',
    cross: '<rect x="3.5" y="3.5" width="17" height="17" rx="3"/><path d="M12 8v8M8 12h8"/>',
    shield: '<path d="M12 3 4.5 6v6c0 4.5 3.2 7.7 7.5 9 4.3-1.3 7.5-4.5 7.5-9V6z"/>',
    fire: '<path d="M12 21a6 6 0 0 0 6-6c0-3.5-2.5-5.5-3.5-9-1.5 2-2.5 3-2.5 5-1-1-1.5-2-1.5-3.5C8 9 6 11.5 6 15a6 6 0 0 0 6 6z"/>',
    cash: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><circle cx="12" cy="12" r="2.6"/>',
    pill: '<rect x="3" y="9" width="18" height="6" rx="3" transform="rotate(-45 12 12)"/><path d="m9 9 6 6"/>',
    cup: '<path d="M4 8h12v6a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5zM16 10h2a2.5 2.5 0 0 1 0 5h-2M8 3v2M12 3v2"/>',
    sweet: '<circle cx="12" cy="13" r="6.5"/><path d="M8.5 9.5c1-1 2.2-1.5 3.5-1.5"/>',
    database: '<ellipse cx="12" cy="5.5" rx="7.5" ry="2.8"/><path d="M4.5 5.5v13c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8v-13M4.5 12c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8"/>',
    globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.5 2.6 3.5 5.4 3.5 8.5s-1 5.9-3.5 8.5c-2.5-2.6-3.5-5.4-3.5-8.5s1-5.9 3.5-8.5z"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M18.7 5.3l-1.4 1.4M6.7 17.3l-1.4 1.4"/>',
    cloud: '<path d="M7 18.5h10a4 4 0 0 0 .6-8A5.5 5.5 0 0 0 7 11a3.8 3.8 0 0 0 0 7.5z"/>',
    rain: '<path d="M7 15.5h10a4 4 0 0 0 .6-8A5.5 5.5 0 0 0 7 8a3.8 3.8 0 0 0 0 7.5zM8 18.5l-1 2M12 18.5l-1 2M16 18.5l-1 2"/>',
    grip: '<circle cx="9" cy="6" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="18" r="1"/>',
    reset: '<path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3L4.5 9M4.5 4.5V9H9"/>',
    share: '<circle cx="18" cy="5.5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="18.5" r="2.5"/><path d="m8.2 10.8 7.6-4M8.2 13.2l7.6 4"/>',
    flag: '<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>',
    expand: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
    train: '<rect x="6" y="3" width="12" height="14" rx="3"/><path d="M6 10h12M9.5 20.5 8 17M14.5 20.5 16 17M4 21.5h16"/><circle cx="9" cy="13.5" r=".9"/><circle cx="15" cy="13.5" r=".9"/><path d="M10 6h4"/>',
    bus: '<rect x="4.5" y="3.5" width="15" height="14" rx="2.5"/><path d="M4.5 11h15M4.5 7h15M7.5 17.5V20M16.5 17.5V20"/><circle cx="8" cy="14.3" r=".9"/><circle cx="16" cy="14.3" r=".9"/>',
    toto: '<path d="M4 17V9.5A3.5 3.5 0 0 1 7.5 6H14l4 5v6M4 12h14M10 6v6"/><circle cx="7" cy="17.5" r="1.8"/><circle cx="16.5" cy="17.5" r="1.8"/>',
    user: '<circle cx="12" cy="8" r="3.8"/><path d="M4.5 20.5a7.5 7.5 0 0 1 15 0"/>',
    hourglass: '<path d="M6.5 3.5h11M6.5 20.5h11M7.5 3.5c0 5 9 5 9 8.5s-9 3.5-9 8.5M16.5 3.5c0 5-9 5-9 8.5s9 3.5 9 8.5"/>',
  },
  /* a glossy 3D map pin (teardrop with a hole) in any colour; `inner` puts a number or an icon in the hole.
     gpin → inline HTML (Leaflet / page; shading defs live once in index.html)
     gpinSVG → a self-contained SVG image (drawn into the 3D map as a GPU icon); it also carries its ground shadow */
  _gpinParts(color, inner) {
    const B = 'M32 93 C27.5 77 6 59 6 32 A26 26 0 1 1 58 32 C58 59 36.5 77 32 93 Z', H = 'M44.5 31 A12.5 12.5 0 1 0 19.5 31 A12.5 12.5 0 1 0 44.5 31 Z';
    const W = H + ' M46.2 28.6 A12.3 12.3 0 1 1 21.6 28.6 A12.3 12.3 0 1 1 46.2 28.6 Z';
    let hole = '';
    if (inner && inner.icon) hole = `<circle cx="32" cy="31" r="11.4" fill="#fff"/><svg x="23" y="22" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">${U.ICONS[inner.icon] || ''}</svg>`;
    else if (inner && inner.text != null) hole = `<circle cx="32" cy="31" r="11.4" fill="#fff"/><text x="32" y="${String(inner.text).length > 1 ? 35.6 : 36.4}" font-size="${String(inner.text).length > 1 ? 12.5 : 15}" font-weight="800" text-anchor="middle" fill="${color}" font-family="Hind,Arial,sans-serif">${U.esc(inner.text)}</text>`;
    return `<path d="${B} ${H}" fill="${color}" fill-rule="evenodd" stroke="rgba(0,0,0,.28)" stroke-width="1.6"/><path d="${B} ${H}" fill="url(#gpShade)" fill-rule="evenodd"/><path d="${B} ${H}" fill="url(#gpSide)" fill-rule="evenodd"/>
      <path d="${W}" fill="${color}" fill-rule="evenodd"/><path d="${W}" fill="url(#gpWall)" fill-rule="evenodd"/>
      <path d="M40.5 18.6 A15.5 15.5 0 0 1 47 33" fill="none" stroke="#fff" stroke-opacity=".55" stroke-width="1.6" stroke-linecap="round"/>
      <path d="M51.5 47 C49 58 41 70 34.5 83" fill="none" stroke="#fff" stroke-opacity=".28" stroke-width="1.5" stroke-linecap="round"/>
      <ellipse cx="19" cy="17" rx="7.5" ry="4.2" transform="rotate(-38 19 17)" fill="url(#gpSpec)"/>${hole}`;
  },
  gpin(color, w = 34, inner = null, cls = '') {
    return `<span class="gp ${cls}" style="--w:${w}px"><svg viewBox="0 0 64 96" aria-hidden="true">${U._gpinParts(color, inner)}</svg></span>`;
  },
  gpinSVG(color, inner = null) {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 100" width="64" height="100"><defs>
      <radialGradient id="gpShade" cx="34%" cy="22%" r="85%"><stop offset="0" stop-color="#fff" stop-opacity=".55"/><stop offset=".22" stop-color="#fff" stop-opacity=".12"/><stop offset=".55" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".42"/></radialGradient>
      <linearGradient id="gpSide" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#000" stop-opacity="0"/><stop offset=".62" stop-color="#000" stop-opacity="0"/><stop offset=".9" stop-color="#000" stop-opacity=".28"/><stop offset="1" stop-color="#fff" stop-opacity=".22"/></linearGradient>
      <linearGradient id="gpWall" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#000" stop-opacity=".5"/><stop offset=".6" stop-color="#000" stop-opacity=".22"/><stop offset="1" stop-color="#fff" stop-opacity=".18"/></linearGradient>
      <radialGradient id="gpSpec" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="#fff" stop-opacity=".9"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
      <radialGradient id="gpGround" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="#000" stop-opacity=".45"/><stop offset="1" stop-color="#000" stop-opacity="0"/></radialGradient>
    </defs><ellipse cx="32" cy="94.5" rx="17" ry="4.6" fill="url(#gpGround)"/>${U._gpinParts(color, inner)}</svg>`;
  },
  icon(name, cls = '') { return `<svg class="ico ${cls}" viewBox="0 0 24 24" aria-hidden="true">${U.ICONS[name] || ''}</svg>`; },
  /** replace <i data-icon="x"></i> placeholders with SVG icons */
  icons(root = document) { root.querySelectorAll('i[data-icon]').forEach(el => { el.outerHTML = U.icon(el.dataset.icon, el.className); }); },
};
