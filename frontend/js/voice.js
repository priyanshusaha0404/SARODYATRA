/* Sarodyatra — voice.js : speech for the 3D trip guide and for Sarathi — always in the language the website is in.
   Which voice speaks:
     1. a natural voice the browser already has for that language (Microsoft Edge: Tanishaa / Swara / Neerja;
        Chrome: Google हिन्दी, Google English) — instant, works offline;
     2. otherwise the server's neural voice (/api/tts: বাংলা Tanishaa, हिंदी Swara, Indian English Neerja), cached;
     3. otherwise any browser voice for the language; only if there is none at all, English.
   Times, distances and numbers are said the way people say them: "সন্ধ্যা ৬টা ৭ মিনিটে", "शाम 6 बजकर 7 मिनट पर". */
const Voice = {
  ok: ('speechSynthesis' in window && 'SpeechSynthesisUtterance' in window) || 'Audio' in window,
  synth: 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window,
  on: { trip: true, chat: true },
  TAG: { en: 'en-IN', bn: 'bn-IN', hi: 'hi-IN' },
  server: false, serverBad: false, _warned: {}, _audio: [], _gen: 0,

  init(health) {
    const saved = U.load('voice', null);
    if (saved) Object.assign(this.on, saved);
    this.server = !!(health && health.tts);
    if (this.synth) {
      const load = () => { this.voices = speechSynthesis.getVoices() || []; };
      load(); speechSynthesis.onvoiceschanged = load;
    }
    U.on('lang', () => this.stop());
  },
  set(channel, v) {
    this.on[channel] = v; U.save('voice', this.on);
    if (!v) this.stop();
  },
  stop() {
    this._gen++;                                       // anything still loading for the old text is dropped
    if (this.synth) try { speechSynthesis.cancel(); } catch {}
    this._audio.forEach(a => { try { a.pause(); a.src = ''; } catch {} }); this._audio = [];
  },

  /* ── which voice ── */
  voicesFor(lang) {
    const tag = this.TAG[lang].toLowerCase();
    return (this.voices || []).filter(v => v.lang && (v.lang.replace('_', '-').toLowerCase() === tag || v.lang.toLowerCase().startsWith(lang + '-') || v.lang.toLowerCase() === lang));
  },
  natural(v) { return /natural|neural|online|google|premium|enhanced/i.test(v.name); },
  /* the best browser voice for a language; good = a natural one (not a robotic desktop voice) */
  voiceFor(lang, good = false) {
    let V = this.voicesFor(lang);
    if (lang === 'en') V = V.filter(v => /IN/i.test(v.lang)).concat(V.filter(v => /GB/i.test(v.lang)), V);
    if (good) V = V.filter(v => this.natural(v) && (lang !== 'en' || /IN/i.test(v.lang)));   // English: an Indian voice says our names best
    const score = v => (this.natural(v) ? 4 : 0) + (/IN/i.test(v.lang) ? 2 : 0) + (v.localService ? 0 : 1);
    return V.slice().sort((a, b) => score(b) - score(a))[0] || null;
  },
  /* how a language will be spoken: 'browser' (natural voice), 'server' (neural, from /api/tts), 'basic' (any voice) or null */
  engine(lang) {
    if (this.synth && this.voiceFor(lang, true)) return 'browser';
    if (this.server && !this.serverBad) return 'server';
    if (this.synth && (this.voiceFor(lang) || !(this.voices || []).length)) return 'basic';
    return null;
  },
  /* the language to speak in: the website's language whenever any engine can say it, else English (said once) */
  speakLang(want) {
    if (want === 'en' || this.engine(want)) return want;
    if (!this._warned[want]) { this._warned[want] = true; U.toast(t('v.noVoice', { lang: I18N.NAMES?.[want] || want })); }
    return 'en';
  },
  scriptOf(text) { return /[ঀ-৿]/.test(text) ? 'bn' : /[ऀ-ॿ]/.test(text) ? 'hi' : 'en'; },

  /* text tidied for the ear: no emoji, bullets or arrows; money, ranges and numbers as people say them */
  clean(text, lang) {
    const rupees = { en: 'rupees', bn: 'টাকা', hi: 'रुपये' }[lang], to = { en: ' to ', bn: ' থেকে ', hi: ' से ' }[lang];
    let s = String(text)
      .replace(/[০-৯]/g, d => '০১২৩৪৫৬৭৮৯'.indexOf(d))
      .replace(/(\d{1,2}):(\d{2})\s*(AM|PM|am|pm|a\.m\.|p\.m\.)/g, (m, h, mm, ap) => this.time(lang, `${(+h % 12) + (/p/i.test(ap) ? 12 : 0)}:${mm}`))
      .replace(/<[^>]+>/g, '')
      .replace(/₹\s?(\d[\d,]*)/g, `$1 ${rupees}`)
      .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, '')
      .replace(/[•⚠⌂]/g, '')
      .replace(/(\d|AM|PM|am|pm)\s*[–—-]\s*(?=\d)/g, `$1${to}`)          // 7:03 PM–7:43 PM → … to …
      .replace(/\s*[→⇒]\s*/g, lang === 'en' ? ' to ' : ', ')
      .replace(/\s*←\s*/g, ', ')
      .replace(/\s*[·|]\s*/g, ', ')
      .replace(/\s+—\s+/g, ', ')
      .replace(/~\s?/g, lang === 'en' ? 'about ' : '')
      .replace(/\(?\be\.g\.\s*/gi, lang === 'en' ? 'for example, ' : '').replace(/[()“”"]/g, '')
      .replace(/\s*\n+\s*/g, '. ')
      .replace(/\.\s*\./g, '.')
      .replace(/\s{2,}/g, ' ').trim();
    if (lang === 'bn') s = s.replace(/([\u0980-\u09FF]+)-(তে|এ|এর|কে)(?![\u0980-\u09FF])/g, (m, w, suf) => this.bnCase(w, suf))   // দমদম-এ → দমদমে
      .replace(/\d/g, d => '০১২৩৪৫৬৭৮৯'[d]);              // Bengali numerals read most naturally
    return s;
  },

  /* Bengali case endings joined the way they are spoken: দমদমে, বেলগাছিয়ায়, সিটিতে; লাইনের, বেলগাছিয়ার */
  bnCase(w, suf) {
    const consonant = /[\u0995-\u09B9\u09CE\u09DC-\u09DF]$/.test(w), aa = /[\u09BE\u0986\u0985]$/.test(w);
    if (suf === 'এর') return w + (consonant ? 'ের' : 'র');
    if (suf === 'কে') return w + 'কে';
    return w + (consonant ? 'ে' : aa ? 'য়' : 'তে');
  },
  /* say something in the website's language. channel 'trip' | 'chat'; flush drops what is still queued;
     onend fires once everything has been said (or could not be) */
  say(text, { channel = 'trip', lang = null, flush = false, onend = null } = {}) {
    const done = () => { if (onend) { const f = onend; onend = null; f(); } };
    if (!this.ok || !this.on[channel] || !text) { done(); return false; }
    let L = lang || this.scriptOf(text);
    if (L === 'en' && !lang && I18N.lang !== 'en' && !/[A-Za-z]{3}/.test(text)) L = I18N.lang;
    const eng = this.engine(L);
    if (!eng) {
      if (!this._warned['read-' + L]) { this._warned['read-' + L] = true; U.toast(t('v.noVoiceRead', { lang: I18N.NAMES?.[L] || L })); }
      done(); return false;
    }
    const clean = this.clean(text, L);
    if (!clean) { done(); return false; }
    if (flush) this.stop();
    if (eng === 'server') return this.viaServer(clean, L, done);
    // browser voices: short sentences (Chrome cuts long utterances off)
    const voice = this.voiceFor(L, eng === 'browser') || this.voiceFor(L);
    const parts = clean.split(/(?<=[.!?।])\s+/).map(x => x.trim()).filter(Boolean);
    parts.forEach((p, i) => {
      const u = new SpeechSynthesisUtterance(p);
      u.lang = this.TAG[L]; if (voice) u.voice = voice;
      u.rate = L === 'en' ? 1 : .95; u.pitch = 1;
      if (i === parts.length - 1) { u.onend = done; u.onerror = done; }
      speechSynthesis.speak(u);
    });
    return true;
  },
  /* neural voice from the server: the whole text in one or two clips, played in order */
  viaServer(text, L, done) {
    const gen = this._gen;
    const chunks = [];
    let cur = '';
    text.split(/(?<=[.!?।])\s+/).forEach(p => { if ((cur + ' ' + p).length > 480 && cur) { chunks.push(cur); cur = p; } else cur = cur ? cur + ' ' + p : p; });
    if (cur) chunks.push(cur);
    const clips = chunks.map(c => { const a = new Audio(`${CFG.API}/tts?lang=${L}&text=${encodeURIComponent(c)}`); a.preload = 'auto'; return a; });
    this._audio.push(...clips);
    let i = 0;
    const next = () => {
      if (gen !== this._gen) return done();
      if (i >= clips.length) return done();
      const a = clips[i++];
      a.onended = next;
      a.onerror = () => {                              // server voice failed: browser voice for the rest of the visit
        if (a._failed) return; a._failed = true;
        if (gen !== this._gen) return done();          // we stopped it ourselves
        this.serverBad = true;
        const rest = chunks.slice(i - 1).join(' ');
        if (this.synth && (this.voiceFor(L) || !(this.voices || []).length)) {
          const u = new SpeechSynthesisUtterance(rest); u.lang = this.TAG[L]; const v = this.voiceFor(L); if (v) u.voice = v;
          u.onend = done; u.onerror = done; speechSynthesis.speak(u);
        } else done();
      };
      a.play().catch(a.onerror);
    };
    next();
    return true;
  },
  speaking() { return (this.synth && (speechSynthesis.speaking || speechSynthesis.pending)) || this._audio.some(a => !a.paused && !a.ended); },

  /* ── words for the ear in a given language ── */
  tl(lang, key, vars) {
    const row = STR[key]; let s = row ? (row[I18N.INDEX[lang]] || row[0]) : key;
    if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] ?? m));
    return s;
  },
  mins(lang, n) {
    n = Math.max(1, Math.round(n)); const h = Math.floor(n / 60), m = n % 60;
    const W = { en: ['hour', 'hours', 'minute', 'minutes'], bn: ['ঘণ্টা', 'ঘণ্টা', 'মিনিট', 'মিনিট'], hi: ['घंटा', 'घंटे', 'मिनट', 'मिनट'] }[lang];
    return [h ? `${h} ${W[h > 1 ? 1 : 0]}` : '', m ? `${m} ${W[m > 1 ? 3 : 2]}` : ''].filter(Boolean).join(' ');
  },
  /* a clock time as said aloud. at = "at that time": সন্ধ্যা ৬টা ৭ মিনিটে · शाम 6 बजकर 7 मिनट पर · 6:07 PM */
  time(lang, v, at = false) {
    let h, m;
    if (typeof v === 'number') { h = Math.floor(v / 60) % 24; m = Math.round(v % 60); }
    else { [h, m] = String(v || '0:0').split(':').map(Number); }
    const h12 = h % 12 || 12;
    const nx = h12 % 12 + 1;                            // the next hour, for "quarter to"
    if (lang === 'bn') {
      // সাড়ে ছ'টা, সোয়া সাতটা, পৌনে আটটা — the way Kolkata says it
      const part = h < 4 ? 'রাত' : h < 6 ? 'ভোর' : h < 12 ? 'সকাল' : h < 16 ? 'দুপুর' : h < 18 ? 'বিকেল' : h < 20 ? 'সন্ধ্যা' : 'রাত';
      const ta = at ? 'টায়' : 'টা';
      if (m === 30) return `${part} ${h12 === 1 ? 'দেড়' : h12 === 2 ? 'আড়াই' : 'সাড়ে ' + h12}${ta}`;
      if (m === 15) return `${part} সোয়া ${h12}${ta}`;
      if (m === 45) return `${part} পৌনে ${nx}${ta}`;
      return m ? `${part} ${h12}টা ${m} মিনিট${at ? 'ে' : ''}` : `${part} ${h12}${ta}`;
    }
    if (lang === 'hi') {
      // साढ़े छह, सवा सात, पौने आठ बजे
      const part = h < 4 ? 'रात' : h < 12 ? 'सुबह' : h < 16 ? 'दोपहर' : h < 20 ? 'शाम' : 'रात';
      if (m === 30) return `${part} ${h12 === 1 ? 'डेढ़' : h12 === 2 ? 'ढाई' : 'साढ़े ' + h12} बजे`;
      if (m === 15) return `${part} सवा ${h12} बजे`;
      if (m === 45) return `${part} पौने ${nx} बजे`;
      return m ? `${part} ${h12} बजकर ${m} मिनट${at ? ' पर' : ''}` : `${part} ${h12} बजे`;
    }
    const t12 = `${h12}${m ? ':' + String(m).padStart(2, '0') : ''} ${h < 12 ? 'AM' : 'PM'}`;
    return at ? `at ${t12}` : t12;
  },
  dist(lang, meters) {
    const W = { en: ['metres', 'kilometres'], bn: ['মিটার', 'কিলোমিটার'], hi: ['मीटर', 'किलोमीटर'] }[lang];
    return meters < 1000 ? `${Math.max(50, Math.round(meters / 50) * 50)} ${W[0]}` : `${(meters / 1000).toFixed(1).replace(/\.0$/, '')} ${W[1]}`;
  },
  /* a place name in the spoken language: pandal by pid, metro / railway station by name, else as given */
  name(lang, { pid, metro, rail, raw }) {
    const pick = p => p && ((lang === 'bn' && p.name_bn) || (lang === 'hi' && p.name_hi) || p.name);
    if (pid && Pandals.byId[pid]) return pick(Pandals.byId[pid].properties);
    if (metro) { const f = Metro.byName(String(metro).replace(/ metro$/i, '')); if (f) return pick(f.properties); }
    if (rail) { const f = Rail.byName?.(String(rail).replace(/ \((station|home)\)$/, '')); if (f) return pick(f.properties); }
    return raw || '';
  },
};
