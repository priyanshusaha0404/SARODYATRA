/* Sarodyatra — agent.js : Sarathi. A router hands each request to one of five specialists
   (Guide, Navigator, Planner, Foodie, Safety); each has its own tools that act on the live map.
   The Planner holds a conversation: it asks where you start (home or where you are now), train or road,
   then plans the whole outing — local train in, the best alighting station, metro / walk / bus between
   pandals timed against crowds, and the train home — and finally asks walk or bus for the longer hops.
   With GEMINI_API_KEYS in backend/.env the specialists reason with function calling and reply in
   whatever language the visitor writes. Without keys the same tools run through a built-in parser
   (English, Bangla, Banglish, Hindi/Hinglish) and reply in the interface language.
   Fast path: even with keys, anything the built-in brain understands for sure (the outing conversation, routes,
   trains, food, help, a pandal's crowd) is answered at once without waiting for the AI; misspelt place names are
   corrected first (U.fuzzyFix), so "hatibagn" or "sribhumi" still work. */
const Agent = {
  history: [], useLLM: false, busy: false, current: 'guide', ctx: {},

  AGENTS: {
    guide:     { role: 'Know every pandal: find pandals by zone, type or name, explain them, give crowd levels and the quietest times.',
                 tools: ['search_pandals', 'pandal_details', 'crowd_forecast', 'show_layers', 'go_to', 'set_time', 'handoff'] },
    navigator: { role: 'Get people from A to B on Puja nights: closure-aware routes (walk / metro / taxi / bus), metro lines, local trains (Sealdah, Howrah, Circular) with real timetables, first and last trains, blocked roads.',
                 tools: ['get_route', 'find_trains', 'metro_info', 'pandals_near_station', 'closures_near', 'plan_journey', 'start_trip', 'show_layers', 'go_to', 'set_time', 'handoff'] },
    planner:   { role: 'Build whole outings door to door: from home by local train or road, the best station to get off, every pandal of the chosen area (famous, bonedi and local, best first when time is short) timed against crowds, walk or bus between them, and the train home. Start the 3D trip and export the plan.',
                 tools: ['plan_journey', 'set_hop_mode', 'plan_trip', 'find_trains', 'add_to_plan', 'clear_plan', 'start_trip', 'export_plan', 'search_pandals', 'weather', 'set_time', 'handoff'] },
    foodie:    { role: 'Find food, sweets and cafés near the visitor or near a pandal, preferring places open at the selected time.',
                 tools: ['find_nearby', 'get_route', 'add_to_plan', 'handoff'] },
    safety:    { role: 'Safety first: nearest hospital and police, emergency numbers, toilets and drinking water, filing problem reports.',
                 tools: ['emergency_help', 'find_nearby', 'report_issue', 'get_route', 'handoff'] },
  },
  STATUS: { plan_journey: 'ai.journey', set_hop_mode: 'ai.planning', find_trains: 'ai.trains', plan_trip: 'ai.planning', get_route: 'ai.routing', metro_info: 'ai.metro', pandals_near_station: 'ai.metro', find_nearby: 'ai.searching', emergency_help: 'ai.searching' },

  SCHEMA: {
    search_pandals: { d: 'Find pandals and mark them on the map. Filter by zone (North, Central, South, East, West), category (top = famous, bonedi = heritage, para = local), name/locality text, or distance from a place.',
      p: { query: ['STRING', 'name or locality'], zone: ['STRING'], category: ['STRING', 'top|bonedi|para'], near: ['STRING', "place name or 'me'"], radius_km: ['NUMBER'], limit: ['INTEGER'] } },
    pandal_details: { d: 'Open one pandal card and return its details, nearest metro, crowd now and quietest hours.', p: { name: ['STRING'] }, r: ['name'] },
    crowd_forecast: { d: 'Hour-by-hour crowd estimate for a pandal on a puja day; returns quietest and busiest hours.', p: { name: ['STRING'], day: ['STRING', 'Shashthi|Saptami|Ashtami|Navami|Dashami'] }, r: ['name'] },
    show_layers: { d: 'Turn map layers and filters on/off.', p: { pandals: ['BOOLEAN'], metro: ['BOOLEAN'], roads: ['BOOLEAN'], closures: ['BOOLEAN'], categories: ['ARRAY', 'top|bonedi|para'], zone: ['STRING'], metro_lines: ['ARRAY', 'Blue|Green|Purple|Yellow|Orange'] } },
    go_to: { d: 'Move the map to a pandal, metro station or any place in Kolkata.', p: { place: ['STRING'] }, r: ['place'] },
    set_time: { d: 'Set the selected puja day and time (24h HH:MM). Crowds, closures and metro checks follow it.', p: { day: ['STRING'], time: ['STRING'] } },
    get_route: { d: 'Draw a closure-aware route. mode: auto, walk, metro, taxi. from/to: pandal, metro station, place or "me".', p: { to: ['STRING'], from: ['STRING'], mode: ['STRING'] }, r: ['to'] },
    metro_info: { d: 'Metro station: lines, first and last train, pandals within 1 km.', p: { station: ['STRING'] }, r: ['station'] },
    pandals_near_station: { d: 'Draw a 1 km circle around a metro station and mark the pandals inside.', p: { station: ['STRING'] }, r: ['station'] },
    closures_near: { d: 'Roads blocked near a place at the selected time.', p: { place: ['STRING'], radius_m: ['NUMBER'] } },
    plan_trip: { d: 'Plan a multi-stop pandal outing and draw it. Give a zone and/or pandal names. Returns a timed itinerary with crowds, metro legs and warnings.',
      p: { zone: ['STRING'], pandal_names: ['ARRAY'], category: ['STRING', 'top|bonedi|para|any'], start_place: ['STRING'], start_time: ['STRING', 'HH:MM 24h'], day: ['STRING'], mode: ['STRING', 'auto|walk|metro|taxi'], max_stops: ['INTEGER'] } },
    plan_journey: { d: 'Plan a whole outing door to door and draw it: start place (home area, railway station or "me"), how they come in (train = local train to the best city station, road, auto = decide), the area to see (zone North/South/Central/East/West, a locality like Hatibagan or Salt Lake, or a station), optional time budget in minutes (only the most worthwhile pandals then; without it, all of the area until late night but never past the last train home), categories (default all three, famous weighted 100, bonedi 50, local 15). Returns the train out, every pandal with times and crowd, the train home, skipped pandals and which hops also have a bus.',
      p: { start_place: ['STRING', "home area / station / 'me'"], travel: ['STRING', 'train|road|auto'], area: ['STRING'], pandal_names: ['ARRAY'], start_time: ['STRING', 'HH:MM 24h'], day: ['STRING'],
           budget_minutes: ['INTEGER'], categories: ['ARRAY', 'top|bonedi|para'], return_home: ['BOOLEAN'], mode: ['STRING', 'auto|walk|metro|taxi (inside the city)'] } },
    set_hop_mode: { d: 'After plan_journey/plan_trip: choose walk or bus for hops that have a bus option. hop = the hop number from the plan, or all = true for every such hop.', p: { mode: ['STRING', 'walk|bus'], hop: ['INTEGER'], all: ['BOOLEAN'] }, r: ['mode'] },
    find_trains: { d: 'Local trains between two railway stations after the selected time (real timetable): train number, departure, arrival, and a change if there is no direct train.', p: { from: ['STRING'], to: ['STRING'] }, r: ['from', 'to'] },
    add_to_plan: { d: 'Add a pandal, station or place to the plan.', p: { name: ['STRING'] }, r: ['name'] },
    clear_plan: { d: 'Remove all stops from the plan.', p: {} },
    start_trip: { d: 'Open the 3D trip view for the current plan or route.', p: {} },
    export_plan: { d: 'Export the current plan or route.', p: { format: ['STRING', 'pdf|word|gpx|geojson|google_maps|link'] }, r: ['format'] },
    weather: { d: 'Current temperature, rain chance and air quality in Kolkata.', p: {} },
    find_nearby: { d: 'Places near the visitor or a place: food, sweets, cafe, toilet, water, atm, pharmacy, hospital, police, fire. open_now uses the selected time.',
      p: { kind: ['STRING'], near: ['STRING', "place or 'me'"], radius_m: ['NUMBER'], open_now: ['BOOLEAN'] }, r: ['kind'] },
    emergency_help: { d: 'Nearest hospitals and police with a route to the closest hospital; emergency numbers.', p: {} },
    report_issue: { d: 'File a visitor report at the visitor location: closure, crowd, toilet, lost, issue. A closure report removes the road from routing.', p: { type: ['STRING'], note: ['STRING'] }, r: ['type'] },
    handoff: { d: 'Hand the conversation to another specialist: guide, navigator, planner, foodie or safety.', p: { agent: ['STRING'], task: ['STRING'] }, r: ['agent'] },
  },
  decl(name) {
    const s = this.SCHEMA[name], props = {};
    Object.entries(s.p).forEach(([k, [ty, d]]) => { props[k] = { type: ty, ...(d ? { description: d } : {}) }; if (ty === 'ARRAY') props[k].items = { type: 'STRING' }; });
    const o = { name, description: s.d };
    if (Object.keys(props).length) o.parameters = { type: 'OBJECT', properties: props, ...(s.r ? { required: s.r } : {}) };
    return o;
  },

  /* ── UI: a floating lamp button that opens the conversation window ── */
  open: false,
  init(health) {
    this.useLLM = !!(health && health.ai && health.ai.gemini_keys > 0);
    U.$('#aiForm').onsubmit = e => { e.preventDefault(); this.send(); };
    U.$('#sarathiFab').onclick = () => this.toggle();
    U.$('#aiClose').onclick = () => this.toggle(false);
    U.$('#aiGreetX').onclick = e => { e.stopPropagation(); this.dismissGreet(); };
    U.$('#aiGreet').onclick = () => this.toggle(true);
    U.$('#aiExpand').onclick = () => U.$('#ai').classList.toggle('expanded');
    U.$('#aiClear').onclick = () => { this.history = []; this.ctx = {}; U.$('#aiBody').innerHTML = ''; this.hello(); Voice.stop(); };
    // voice: Sarathi reads its answers aloud (on / off, remembered)
    const vb = U.$('#aiVoice');
    const paint = () => { const on = Voice.ok && Voice.on.chat; vb.classList.toggle('on', on); vb.setAttribute('aria-pressed', String(on)); vb.innerHTML = U.icon(on ? 'volume' : 'volumeX'); };
    vb.onclick = () => { if (!Voice.ok) { U.toast(t('v.noSpeech')); return; } Voice.set('chat', !Voice.on.chat); paint(); U.toast(t(Voice.on.chat ? 'v.on' : 'v.off')); };
    paint();
    const mic = U.$('#aiMic');
    mic.onclick = () => {
      this.rec = U.speech(tx => { U.$('#aiInput').value = tx; this.send(); }, () => mic.classList.remove('rec'));
      if (!this.rec) { U.toast(t('ai.noVoice')); return; }
      mic.classList.add('rec'); try { this.rec.start(); } catch {}
    };
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && this.open) this.toggle(false); });
    U.on('lang', () => {
      const h = U.$('#aiBody .msg.hello'); if (h) h.textContent = t('ai.hello');
      if (!U.$('#aiGreet').hidden) U.$('#aiGreetText').innerHTML = t(this._greetKey || 'ai.greet');
    });
    this.hello();
    this.entrance();
  },
  hello() { const d = document.createElement('div'); d.className = 'msg hello'; d.textContent = t('ai.hello'); U.$('#aiBody').appendChild(d); },
  toggle(force) {
    this.open = force === undefined ? !this.open : force;
    if (!this.open) Voice.stop();
    const w = U.$('#ai'), f = U.$('#sarathiFab');
    w.classList.toggle('open', this.open); w.setAttribute('aria-hidden', String(!this.open));
    f.classList.toggle('hidden', this.open); f.setAttribute('aria-expanded', String(this.open));
    this.dismissGreet();
    if (this.open) setTimeout(() => U.$('#aiInput').focus(), 80);
  },
  focus() { this.toggle(true); },

  /* the lamp rises in on load, says hello, and checks in now and then while closed */
  greet(key, ms = 8000) {
    if (this.open || document.body.classList.contains('trip-on')) return;
    this._greetKey = key;
    const g = U.$('#aiGreet'), f = U.$('#sarathiFab');
    U.$('#aiGreetText').innerHTML = t(key);
    g.hidden = false; requestAnimationFrame(() => g.classList.add('show'));
    f.classList.remove('rise'); void f.offsetWidth; f.classList.add('rise');
    clearTimeout(this._greetT);
    this._greetT = setTimeout(() => this.dismissGreet(), ms);
  },
  dismissGreet() {
    const g = U.$('#aiGreet'); g.classList.remove('show'); U.$('#sarathiFab').classList.remove('rise');
    clearTimeout(this._greetT); setTimeout(() => { if (!g.classList.contains('show')) g.hidden = true; }, 350);
  },
  entrance() {
    const f = U.$('#sarathiFab');
    f.classList.add('enter');
    setTimeout(() => this.greet('ai.greet', 9000), 900);
    setTimeout(() => f.classList.remove('enter'), 1800);
    let n = 0;
    this._nudgeT = setInterval(() => {
      if (n >= 3) return clearInterval(this._nudgeT);
      if (!this.open && !document.hidden && !this.used) this.greet('ai.nudge' + (++n), 7000);
    }, 180000);
  },
  say(role, text) {
    if (role === 'ai' && this._said) { this._said.push(text); if (!/^⚠/.test(text)) Voice.say(text, { channel: 'chat' }); }   // only answers to the visitor are spoken
    const d = document.createElement('div'); d.className = `msg ${role}`; d.textContent = text;
    U.$('#aiBody').appendChild(d); d.scrollIntoView({ behavior: 'smooth', block: 'end' }); return d;
  },
  /* a question with tap-to-answer chips (only ever for a question Sarathi asked) */
  ask(text, chips = []) {
    this.thinking(null);
    const d = this.say('ai', text);
    if (chips.length) {
      const box = document.createElement('div'); box.className = 'ai-chips';
      box.innerHTML = chips.map(([label, reply], i) => `<button data-i="${i}">${U.esc(label)}</button>`).join('');
      box.querySelectorAll('button').forEach(b => b.onclick = () => { if (this.busy) return; box.remove(); this.send(chips[+b.dataset.i][1]); });
      U.$('#aiBody').appendChild(box); box.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
    return d;
  },
  thinking(key) {
    U.$('#aiThinking')?.remove(); if (!key) return;
    const d = document.createElement('div'); d.className = 'thinking'; d.id = 'aiThinking';
    d.innerHTML = `<i></i><i></i><i></i><span>${U.esc(t(key))}</span>`;
    U.$('#aiBody').appendChild(d); d.scrollIntoView({ block: 'end' });
  },

  /* raw + NFD + NFC forms so Bengali nukta letters (ড়/ড়) match however they were typed */
  digits(x) { return String(x).replace(/[\u09E6-\u09EF]/g, c => c.charCodeAt(0) - 0x09E6).replace(/[\u0966-\u096F]/g, c => c.charCodeAt(0) - 0x0966); },
  forms(text) { const S = this.digits(String(text).toLowerCase()); return [S, S.normalize('NFD'), S.normalize('NFC')].join(' \u2063 '); },
  route(text) {
    const s = this.forms(text);
    const R = [
      ['safety', /(hospital|doctor|ambulance|police|thana|emergency|sos|bipod|help me|lost|harie|hariye|kho gaya|khoya|injur|faint|accident|toilet|washroom|bathroom|loo|drinking water|jol khab|paani|pani|হাসপাতাল|পুলিশ|বিপদ|হারিয়ে|শৌচালয়|টয়লেট|জল|अस्पताल|पुलिस|शौचालय|पानी|खो)/],
      ['foodie', /(khide|khabo|khabar|khete|khana|bhookh|bhuk|food|restaurant|biryani|eat|hungry|lunch|dinner|snack|mishti|sweet|mithai|cafe|coffee|\bcha\b|chai|phuchka|fuchka|roll|খিদে|খাব|খাবার|মিষ্টি|खाना|भूख|मिठाई|चाय)/],
      ['planner', /(\bplan\b|\bplanning\b|\bplanner\b|itinerary|\btrip\b|ghur|ghum|dekhbo|dekhte|dekhna|thakur|hopping|parikrama|tour|\bpdf\b|word|export|start trip|3d|প্ল্যান|ঘুর|ঠাকুর|দেখব|योजना|घूम|देखना|पंडाल घुमा)/],
      ['navigator', /(route|kivabe|kibhabe|kaise|how (do i|to|can i) (go|reach|get)|\bjabo\b|jaabo|jaun|jana|jete|direction|metro|station|last train|first train|\bbus\b|taxi|\bcab\b|rasta|road|block|closed|bondho|band|\btheke\b|\bfrom\b.+\bto\b|যাব|কিভাবে|মেট্রো|রাস্তা|বন্ধ|থেকে|कैसे|जाऊं|मेट्रो|रास्ता|बंद|से .+ तक)/],
    ];
    for (const [a, re] of R) if (re.test(s)) return a;
    return 'guide';
  },
  async send(forced) {
    const inp = U.$('#aiInput'), raw = forced || inp.value.trim();
    if (!raw || this.busy) return;
    inp.value = ''; U.$$('#aiBody .ai-chips').forEach(c => c.remove());
    Voice.stop();
    this.say('user', raw); this.busy = true; this.used = true; this._said = [];
    const text = U.fuzzyFix(raw);                     // "hatibagn", "sribhumi", "kumortuli" → the names we know
    const fs = this.forms(text);
    let agent = this.route(text);
    if (/^route(From|To)$/.test(this.ctx.pending || '')) agent = 'navigator';
    else if ((this.ctx.pending && !/^(safety|foodie)$/.test(agent)) || this.isOuting(fs) || this.isFollowUp(fs)) agent = 'planner';
    this.current = agent;
    this.thinking('ai.thinking');
    try {
      if (this.small(fs)) { /* answered */ }
      else if (this.useLLM && !this.quick(fs, agent, raw)) await this.llm(raw, agent);
      else { await this.offline(text, agent); if (this.useLLM) this.remember(raw); }
    } catch (e) { this.thinking(null); this.say('ai', '⚠ ' + e.message); }
    this.thinking(null); this.busy = false; this._said = null;
  },
  /* can the built-in brain answer this for sure, right now? (then the AI is not waited for) */
  quick(s, agent, raw) {
    if (this.ctx.pending) return true;                                   // the answer to a question we asked
    const words = s.split(' \u2063 ')[0].split(/\s+/).length;
    if (agent === 'safety') return true;
    if (words > 16) return false;                                        // a long, open question: let the AI reason
    if (agent === 'foodie') return true;
    if (agent === 'planner') return this.isOuting(s) || this.isFollowUp(s) || /(3d|start trip|pdf|word|gpx|export)/.test(s);
    if (agent === 'navigator') return !!(this.destIn(s, this.startIn(s)) || this.stationIn(s) && /(last|first|timing|kokhon|কখন|कब)/.test(s));
    if (agent === 'guide') return words <= 8 && this.pandalsIn(s).length > 0;
    return false;
  },
  /* keep the AI's memory in step when the fast path answered */
  remember(raw) {
    const out = (this._said || []).join('\n').trim(); if (!out) return;
    this.history.push({ role: 'user', parts: [{ text: raw }] }, { role: 'model', parts: [{ text: out }] }); this.trim();
  },
  /* hello / thanks / what can you do — instant, with tap-to-start chips */
  small(s) {
    const t0 = s.split(' \u2063 ')[0].trim().replace(/[!.?,]+$/, ''), n = t0.split(/\s+/).length;
    if (n <= 5 && /^(hi+|hello+|hey|hallo|helo|namaskar|nomoskar|namaste|pranam|good (morning|evening|afternoon|night)|s?h?ubho (sharodiya|sharadiya|bijoya)|নমস্কার|হ্যালো|হাই|শুভ শারদীয়া|नमस्ते|नमस्कार|प्रणाम|हेलो)(\s|$)/.test(t0) && !this.GOING.test(t0)) { this.ask(t('r.hi'), this.starters()); return true; }
    if (n <= 6 && /(thank|thanks|thx|dhonnobad|dhanyabad|dhonyobad|ধন্যবাদ|धन्यवाद|shukriya|শুক্রিয়া|শুকরিয়া)/.test(t0)) { this.thinking(null); this.say('ai', t('r.thanks')); return true; }
    if (/(who are you|what can you do|what do you do|how can you help|tumi ke|apni ke|ki korte paro|ki ki korte|ki parben|তুমি কে|আপনি কে|কী করতে পার|কি করতে পার|तुम कौन|आप कौन|क्या कर सकत)/.test(t0) || /^(help|menu|options|\?)$/.test(t0)) { this.ask(t('r.about'), this.starters()); return true; }
    return false;
  },
  starters() { return [['r.sOuting', 'r.sOutingQ'], ['r.sRoute', 'r.sRouteQ'], ['r.sFood', 'r.sFoodQ'], ['r.sHelp', 'r.sHelpQ']].map(([a, b]) => [t(a), t(b)]); },

  /* ── Gemini multi-agent loop ── */
  system(agent) {
    const a = this.AGENTS[agent], o = App.start();
    const team = Object.entries(this.AGENTS).map(([k, x]) => `${k}: ${x.role}`).join('\n');
    return `You are Sarathi, the guide inside Sarodyatra (a WebGIS for Kolkata's Durga Puja 2026). Right now you act as the "${agent}" specialist: ${a.role}
Other specialists (use the handoff tool when a request belongs to one of them; finish mixed requests yourself when your tools allow):
${team}
Context:
- Selected puja day/time: ${Clock.day} ${Clock.hm()} (dates: ${Clock.cal.days.map(d => `${d.key} ${d.date}`).join(', ')}). Today: ${new Date().toDateString()}.
- Visitor start: ${o ? `${o.type === 'me' ? 'GPS position' : Planner.startName(o)} (${(+o.lat).toFixed(4)}, ${(+o.lon).toFixed(4)})` : 'UNKNOWN — before any route or plan, ask where they start (current location, a place, a station or a pandal name). Never use the map centre.'}
- Current plan: ${Planner.summary()}
- Data: ${Pandals.all.length} pandals (zones North/Central/South/East/West; categories top=famous, bonedi=heritage, para=local), ${Metro.stations.length} metro stations on Blue, Green, Purple, Yellow, Orange lines, ${Rail.stations.length} local-train stations (Sealdah, Howrah, Circular lines) with real timetables, ${'bus route numbers on main roads'}.
- Known about this visitor: start ${this.ctx.origin ? `"${this.ctx.origin.name}"${this.ctx.origin.outside ? ' (outside the city)' : ''}` : 'unknown'}; comes in by ${this.ctx.travel || 'unknown'}.
OUTINGS ("north jabo", "I want to see South Kolkata pujas", "আজ ঠাকুর দেখতে যাব"):
- You need the start first. If unknown, ask ONE short question: where do they live / where are they now (or "my location").
- If the start is outside the city or far from the area and a local-train station is near it, ask: local train or by road? (one question).
- Then call plan_journey at once. Do not ask for the time (use the selected time unless they gave one) or a time limit (only use one they mention: "2 ghonta" = 120).
- Categories: only what they ask for; otherwise all three (famous 100, bonedi 50, local 15 — already built in).
- After planning, if some hops also have a bus, ask once: walk or bus where it helps → set_hop_mode.
- In the reply give: train number, departure → arrival and the station to get off; each pandal with time and crowd; the hop mode (walk / metro line / bus number); the train home with its time; how many pandals did not fit.
Rules:
- Use tools for every fact about pandals, routes, metro times, crowds, closures, food. Never invent names, timings, phone numbers or opening hours; crowd levels are estimates unless crowd_source says live visitor reports — say which.
- Your tools change the visitor's map directly; mention what you put on the map in a few words.
- "today/aaj/आज" means the selected puja day. "6 tay", "sondhe 6", "शाम 6 बजे" mean 18:00.
- LANGUAGE: always reply in ${I18N.NAMES[I18N.lang]} — the language the visitor chose on the website — whatever language or script they type in (Banglish typed on the Bengali site → reply in Bengali script; Hinglish on the Hindi site → Devanagari). Your replies are also read aloud, so write natural spoken ${I18N.NAMES[I18N.lang]}: short sentences, no symbols or arrows. Always write your own name as "Sarathi" and the app as "Sarodyatra" in Latin letters.
- Understand casual, misspelt and mixed-language messages (Banglish, Hinglish); never ask the visitor to rephrase when a reasonable reading exists — act on it and say what you assumed.
- Be brief and concrete: 3–8 short lines with names, times, minutes, metro lines, crowd level and last train when relevant. Use ₹ for money. No markdown headings.`;
  },
  async llm(text, agent) {
    this.history.push({ role: 'user', parts: [{ text }] });
    let hand = 0;
    for (let loop = 0; loop < 9; loop++) {
      const a = this.AGENTS[agent];
      const res = await U.post(`${CFG.API}/gemini`, { systemInstruction: { parts: [{ text: this.system(agent) }] }, tools: [{ functionDeclarations: a.tools.map(n => this.decl(n)) }],
        contents: this.history, generationConfig: { temperature: .5, maxOutputTokens: 1400 } });
      if (res.error) {
        const msg = res.error.message || String(res.error);
        this.history.pop();
        if (/No GEMINI_API_KEYS|API key|permission|invalid/i.test(msg)) { this.useLLM = false; return this.offline(text, agent); }
        this.thinking(null); this.say('ai', t('ai.busy')); return this.offline(text, agent);
      }
      const parts = (res.candidates || [])[0]?.content?.parts || [];
      const calls = parts.filter(p => p.functionCall);
      if (!calls.length) {
        const out = parts.filter(p => p.text).map(p => p.text).join('\n').trim() || t('ai.done');
        this.history.push({ role: 'model', parts: [{ text: out }] });
        this.thinking(null); this.say('ai', out); this.trim(); return;
      }
      this.history.push({ role: 'model', parts });
      const responses = [];
      for (const c of calls) {
        const { name, args } = c.functionCall;
        if (name === 'handoff') {
          if (hand < 3 && this.AGENTS[args.agent]) { hand++; agent = args.agent; this.current = agent; }
          responses.push({ functionResponse: { name, response: { result: { ok: true, now_handled_by: agent } } } });
          continue;
        }
        this.thinking(this.STATUS[name] || 'ai.thinking');
        let out; try { out = await this.exec(name, args || {}); } catch (e) { out = { error: e.message }; }
        responses.push({ functionResponse: { name, response: { result: out } } });
      }
      this.history.push({ role: 'user', parts: responses });
    }
    this.thinking(null); this.say('ai', t('ai.done'));
  },
  trim() {
    if (this.history.length <= 18) return;
    let i = this.history.length - 18;
    while (i < this.history.length && !(this.history[i].role === 'user' && this.history[i].parts[0]?.text)) i++;
    this.history = this.history.slice(i);
  },

  /* ── helpers ── */
  async place(q) {
    if (!q || /^(me|my location|here|current|ekhane|amar kache|এখানে|আমার কাছে|यहाँ|मेरे पास)$/i.test(String(q).trim())) return App.start() || await MapApp.locateNow();
    const wantsStation = Metro.STRIP.test(String(q).normalize('NFC')); Metro.STRIP.lastIndex = 0;
    const s = Metro.byName(q), nq = U.norm(q), same = x => x && U.norm(x) === nq;
    const asStation = f => ({ name: `${f.properties.name} metro`, lat: f.properties.lat, lon: f.properties.lon, type: 'station' });
    if (s && wantsStation) return asStation(s);
    // a bare station name ("sealdah", "dum dum") means the station, not a pandal that starts with it
    const exactP = Pandals.all.find(f => same(f.properties.name));
    if (!exactP) {
      if (s && [s.properties.name, s.properties.name_bn, s.properties.name_hi].some(same)) return asStation(s);
      const rs = Rail.stations.find(f => [f.properties.name, f.properties.name_bn, f.properties.name_hi].some(same));
      if (rs) return { name: rs.properties.name, lat: rs.properties.lat, lon: rs.properties.lon, type: 'rail_station', rsid: rs.properties.rsid };
    }
    const p = exactP || Pandals.find(q); if (p) return { name: p.properties.name, lat: p.properties.lat, lon: p.properties.lon, pid: p.properties.pid, type: 'pandal' };
    if (s && U.norm(q).length > 3) return { name: `${s.properties.name} metro`, lat: s.properties.lat, lon: s.properties.lon, type: 'station' };
    return App.geocode(q);
  },
  brief(f) {
    const p = f.properties, c = Pandals.crowd(p);
    return { name: p.name, type: t('cat.' + p.category), zone: p.zone, locality: p.locality, popularity: p.popularity, since: p.est_year || null,
             crowd_now: c.level, crowd_source: c.src === 'live' ? `live visitor reports (${c.n}, newest ${c.last} min ago)` : 'estimate (model × rain forecast)',
             queue_min: Pandals.queue(p.popularity, c), name_local: locName(p), nearest_metro: `${p.metro} (${p.metro_line}), ${p.walk_min} min walk` };
  },
  hrs(list) { return list.map(h => U.time(h * 60)).join(', '); },
  /* the quietest hours worth suggesting: daytime and evening, not 2–4 AM */
  quiet(b) { const q = b.best.filter(h => h >= 10 && h <= 23); return (q.length ? q : b.best).slice(0, 3); },
  legsBy(R) { const by = {}; R.legs.forEach(l => (by[l.leg] = by[l.leg] || []).push(l)); return by; },
  hopText(legs) {
    if (!legs || !legs.length) return '';
    const rail = legs.filter(l => l.mode === 'rail'), metro = legs.find(l => l.mode === 'metro'), bus = legs.find(l => l.mode === 'bus');
    const mins = Math.round(legs.reduce((x, l) => x + l.minutes, 0));
    if (rail.length) {
      const pre = legs.slice(0, legs.indexOf(rail[0])), acc = Math.round(pre.reduce((x, l) => x + l.minutes, 0));
      const how = !acc ? '' : `${pre.some(l => l.mode === 'drive') ? t('leg.taxi') : pre.some(l => l.mode === 'toto') ? t('leg.toto') : pre.some(l => l.mode === 'metro') ? t('layer.metro') : t('leg.walk')} ${U.mins(acc)} → `;
      return how + rail.map(l => t('r.jTrain', { n: l.train, from: Rail.label(l.from), dep: U.time(l.dep), to: Rail.label(l.to), arr: U.time(l.arr) })).join(' · ');
    }
    if (metro) return `${t('line.' + metro.line)} ${Metro.label(metro.from)} → ${Metro.label(metro.to)} · ${U.mins(mins)}`;
    if (bus) return `${t('leg.onlyBus', { list: U.busNames(bus) })} · ${t('leg.board', { stop: bus.from })} · ~${U.mins(mins)}`;
    if (legs.some(l => l.mode === 'drive')) return `${t('leg.taxi')} ${U.mins(mins)}`;
    if (legs.some(l => l.mode === 'toto')) return `${t('leg.toto')} ~${U.mins(mins)}`;
    return `${t('leg.walk')} ${U.mins(mins)}`;
  },
  busHops(R) {
    const out = [];
    Object.entries(this.legsBy(R)).forEach(([k, legs]) => {
      const w = legs.find(l => l.bus_options && l.bus_options.length);
      if (w) out.push({ hop: +k, to: Planner.rowName(R.timeline[+k]), walk_min: Math.round(legs.reduce((x, l) => x + l.minutes, 0)), bus: w.bus_options.slice(0, 2).map(o => ({ ref: o.ref, label: /^STA_/i.test(o.ref) ? `${o.name || ''} (STA)` : o.name ? `${U.busRef(o.ref, o.name)} (${o.name})` : U.busRef(o.ref, o.name), name: o.name, minutes: Math.round(o.minutes), board: o.board })) });
    });
    return out;
  },
  journeyBrief(R) {
    const by = this.legsBy(R), J = R.journey || {}, last = R.timeline.length - 1;
    const rows = R.timeline.slice(1).map((r, n) => ({ i: n + 1, r }));
    return { day: R.day, start: Planner.startName(Planner.stops[0]), travel: J.travel || 'city', finish: R.finish,
      train_out: (by[1] || []).filter(l => l.mode === 'rail').map(l => `${l.train} ${l.from} ${l.dep} → ${l.to} ${l.arr}`),
      stops: rows.filter(x => x.r.pid || x.r.type === 'rail_station').map(({ i, r }) => `hop ${i}: ${this.hopText(by[i])} → ${r.arrive}${r.pid ? `–${r.depart}` : ''} ${r.pid ? locName(Pandals.byId[r.pid]?.properties || r) : Planner.rowName(r)}${r.crowd ? ` [${r.crowd}, queue ~${r.queue_min}m]` : ''}`),
      train_home: R.timeline[last]?.home ? (by[last] || []).filter(l => l.mode === 'rail').map(l => `${l.train} ${l.from} ${l.dep} → ${l.to} ${l.arr}`) : [],
      not_in_time: (J.skipped || []).length, hops_with_bus: this.busHops(R), totals: R.totals, warnings: R.warnings.map(w => Planner.warnText(w)) };
  },
  day(d) { if (!d) return null; const k = d[0].toUpperCase() + d.slice(1).toLowerCase(); return Clock.cal.days.some(x => x.key === k) ? k : null; },

  /* ── tools (they all act on the map) ── */
  async exec(name, a) {
    switch (name) {
      case 'search_pandals': {
        let list = Pandals.all.slice();
        if (a.zone) list = list.filter(f => f.properties.zone.toLowerCase() === String(a.zone).toLowerCase());
        if (a.category && a.category !== 'any') list = list.filter(f => f.properties.category === a.category);
        if (a.query) { const q = U.canon(a.query); list = list.filter(f => U.canon(`${f.properties.name} ${f.properties.locality}`).includes(q)); }
        let c = null;
        if (a.near) { c = await this.place(a.near); if (c) list = list.filter(f => U.hav(c.lat, c.lon, f.properties.lat, f.properties.lon) <= (a.radius_km || 2) * 1000); }
        list.sort(c ? (x, y) => U.hav(c.lat, c.lon, x.properties.lat, x.properties.lon) - U.hav(c.lat, c.lon, y.properties.lat, y.properties.lon) : (x, y) => y.properties.popularity - x.properties.popularity);
        list = list.slice(0, a.limit || 8);
        if (!Layers.on.pandals) Layers.set('pandals', true);
        Pandals.mark(list.map(f => f.properties.pid));
        if (list.length) MapApp.map.fitBounds(L.latLngBounds(list.map(f => [f.properties.lat, f.properties.lon])).pad(.25), MapApp.fitPad());
        return { count: list.length, pandals: list.map(f => this.brief(f)) };
      }
      case 'pandal_details': {
        const f = Pandals.find(a.name); if (!f) return { error: `No pandal matching "${a.name}"` };
        Pandals.select(f.properties.pid, true);
        const b = Pandals.bestHours(f.properties.popularity);
        return { ...this.brief(f), theme: f.properties.theme, description: f.properties.descr, quietest: this.hrs(this.quiet(b)) };
      }
      case 'crowd_forecast': {
        const f = Pandals.find(a.name); if (!f) return { error: `No pandal matching "${a.name}"` };
        const day = this.day(a.day) || Clock.day, b = Pandals.bestHours(f.properties.popularity, day);
        return { pandal: f.properties.name, day, now: Pandals.crowd(f.properties).level, quietest: this.hrs(this.quiet(b)), busiest: this.hrs(b.worst), note: 'estimate' };
      }
      case 'show_layers': {
        ['pandals', 'metro', 'roads', 'closures'].forEach(k => { if (a[k] != null && Layers.on[k] !== !!a[k]) Layers.set(k, !!a[k]); });
        if (a.categories && a.categories.length) { Pandals.F.cats = new Set(a.categories.filter(c => CFG.CAT[c])); Pandals.ui(); Pandals.render(); }
        if (a.zone) { const z = a.zone[0].toUpperCase() + a.zone.slice(1).toLowerCase(); if (z === 'All' || CFG.ZONES.includes(z)) { Pandals.F.zone = z; Pandals.ui(); Pandals.render(); } }
        if (a.metro_lines) { Metro.on = new Set(a.metro_lines.filter(l => CFG.LINES[l])); Metro.render(); }
        Layers.legend();
        return { ok: true };
      }
      case 'go_to': { const p = await this.place(a.place); if (!p) return { error: 'not found' }; if (p.pid) Pandals.select(p.pid, true); else MapApp.flyThen(p.lat, p.lon, 16); return { ok: true, place: p.name }; }
      case 'set_time': { const d = this.day(a.day) || Clock.day; const m = a.time ? U.toMin(a.time) : Clock.min; Clock.set(d, m); return { selected: `${d} ${U.hm(m)}` }; }
      case 'get_route': {
        const from = a.from ? await this.place(a.from) : App.start(), to = await this.place(a.to);
        if (!a.from && !from) return { error: 'START_UNKNOWN', ask: 'Where is the visitor starting from? (current location, a place, a station or a pandal)' };
        if (!to) return { error: `Could not find "${a.to}"` }; if (!from) return { error: `Could not find "${a.from}"` };
        const r = await Route.go(from, to, a.mode === 'taxi' ? 'taxi' : (a.mode || 'auto'));
        if (!r) return { error: 'No route found' };
        return { from: from.name, to: to.name, minutes: r.minutes, km: +(r.meters / 1000).toFixed(1), chosen: r.choice, alternatives_min: r.alternatives,
          legs: r.legs.map(l => l.mode === 'metro' ? `${l.line} Line ${l.from}→${l.to} (${l.stops} stops, last train ${l.last_train || '?'})` : `${l.mode === 'walk' ? 'walk' : 'taxi'} ${Math.round(l.meters)} m ${Math.round(l.minutes)} min`),
          taxi_fare_estimate: r.fare_estimate, closures_avoided: Math.max(0, ...r.legs.map(l => l.closures_considered || 0)) };
      }
      case 'metro_info': {
        const info = await Metro.open(a.station, true); if (!info) return { error: `No metro station "${a.station}"` };
        return { station: info.name, lines: info.lines.map(l => ({ line: l.line, first: l.first, last: l.last, running_at_selected_time: l.running_now })),
                 puja_special_announced: info.puja_special_announced, pandals_within_1km: info.pandals_1km.slice(0, 8).map(p => `${p.name} (${p.walk_min} min)`) };
      }
      case 'pandals_near_station': {
        const info = await Metro.info(a.station); if (!info) return { error: 'station not found' };
        Card.station(info); const near = Metro.buffer(info);
        return { station: info.name, pandals: near.map(x => `${x.f.properties.name} (${Math.round(x.d * 1.3 / 72)} min)`) };
      }
      case 'closures_near': {
        const c = await this.place(a.place); if (!c) return { error: 'not found' };
        const r = a.radius_m || 800;
        if (!Layers.on.closures) Layers.set('closures', true);
        MapApp.flyThen(c.lat, c.lon, 16);
        const near = (Roads.closures?.features || []).filter(f => Clock.closureActive(f.properties) &&
          (f.geometry.type === 'MultiLineString' ? f.geometry.coordinates.flat() : f.geometry.coordinates).some(x => U.hav(c.lat, c.lon, x[1], x[0]) < r));
        return { place: c.name, blocked: [...new Set(near.map(f => `${f.properties.road} (${f.properties.mode === 'all' ? 'closed to all' : 'no vehicles'}, ${f.properties.src})`))].slice(0, 15) };
      }
      case 'plan_trip': {
        const start = a.start_place ? await this.place(a.start_place) : App.start();
        if (!a.start_place && !start) return { error: 'START_UNKNOWN', ask: 'Where is the visitor starting from?' };
        if (!start) return { error: `Could not find start "${a.start_place}"` };
        const d = this.day(a.day); if (d) Clock.set(d, Clock.min);
        let picks = [];
        (a.pandal_names || []).forEach(n => { const f = Pandals.find(n); if (f && !picks.includes(f)) picks.push(f); });
        if (!picks.length) {
          const zone = a.zone ? a.zone[0].toUpperCase() + a.zone.slice(1).toLowerCase() : null;
          const cats = a.category && a.category !== 'any' ? [a.category] : ['top', 'bonedi'];
          picks = Pandals.top(zone, a.max_stops || 6, cats);
          if (picks.length < 3) picks = Pandals.top(zone, a.max_stops || 6, ['top', 'bonedi', 'para']);
          if (zone && CFG.ZONES.includes(zone)) { Pandals.F.zone = zone; Pandals.ui(); }
        }
        Planner.stops = [{ ...start, type: start.type === 'me' || start.type === 'centre' ? start.type : 'place' }, ...picks.map(f => ({ name: f.properties.name, lat: f.properties.lat, lon: f.properties.lon, type: 'pandal', pid: f.properties.pid }))];
        if (a.mode) U.$('#plMode').value = a.mode;
        if (a.start_time) { U.$('#plStart').value = a.start_time; Planner._startEdited = true; }
        App.leftTab('plan');
        const R = await Planner.run({ mode: a.mode, start: a.start_time });
        if (!R) return { error: 'planning failed' };
        return { day: R.day, start: start.name, finish: R.finish, totals: R.totals, warnings: R.warnings.map(w => Planner.warnText(w)),
                 timeline: R.timeline.map(r => `${r.arrive} ${r.name}${r.crowd ? ` [${r.crowd}, queue ~${r.queue_min}m]` : ''}`),
                 legs: R.legs.map(l => l.mode === 'metro' ? `${l.line} Line ${l.from}→${l.to}` : l.mode === 'bus' ? `bus ${U.busNames(l)} from ${l.from} to ${l.to} (take only these)` : `${l.mode} ${Math.round(l.meters)} m`) };
      }
      case 'plan_journey': {
        let o = null;
        if (a.start_place) {
          o = /^(me|my location|here|current location|ekhane|এখানে|यहाँ|यहां)$/i.test(String(a.start_place).trim()) ? (App.start() || await MapApp.locateNow()) : await App.place(a.start_place);
          if (!o) return { error: `Could not find "${a.start_place}" — ask for a nearby railway station or area name` };
          this.ctx.origin = { ...o, outside: Planner.outside(o) };
        } else if (this.ctx.origin) o = this.ctx.origin;
        if (o) Planner.setStart({ ...o, type: o.type === 'me' || o.type === 'centre' ? o.type : o.type === 'rail_station' ? 'rail_station' : (o.pid || o.type === 'station') ? 'place' : 'home' });
        const d = this.day(a.day); if (d) Clock.set(d, Clock.min);
        const travel = ['train', 'road'].includes(a.travel) ? a.travel : 'auto';
        U.$('#plTravel').value = travel; if (travel !== 'auto') this.ctx.travel = travel;
        if (a.start_time) { U.$('#plStart').value = a.start_time; Planner._startEdited = true; }
        if (a.mode) U.$('#plMode').value = a.mode;
        Planner.setBudget(+a.budget_minutes || 0);
        if (a.return_home != null) { U.$('#plReturn').checked = !!a.return_home; Planner._returnEdited = true; }
        const cats = (a.categories || []).filter(c => CFG.CAT[c]);
        const opts = { travel, budget: +a.budget_minutes || 0, categories: cats.length ? cats : null, start: a.start_time };
        const picks = (a.pandal_names || []).map(n => Pandals.find(n)).filter(Boolean);
        if (picks.length) {
          Planner.stops = [Planner.stops[0], ...picks.map(f => ({ name: f.properties.name, lat: f.properties.lat, lon: f.properties.lon, type: 'pandal', pid: f.properties.pid }))];
          Planner.area = null;
        } else if (a.area) { opts.area = a.area; Planner.stops = [Planner.stops[0]]; }
        else { opts.anywhere = true; Planner.stops = [Planner.stops[0]]; Planner.area = null; }
        App.leftTab('plan');
        const R = await Planner.run(opts);
        if (!R) return { error: 'planning failed' };
        this.ctx.planned = true; this.ctx.area = a.area || this.ctx.area;
        return this.journeyBrief(R);
      }
      case 'set_hop_mode': {
        const R = Planner.result; if (!R) return { error: 'No plan yet' };
        const hops = this.busHops(R), mode = String(a.mode || 'walk').toLowerCase().startsWith('bus') ? 'bus' : 'walk';
        const pick = a.all || a.hop == null ? hops : hops.filter(h => h.hop === +a.hop);
        if (!pick.length) return { error: 'No hop with a bus option', hops_with_bus: hops };
        pick.forEach(h => { Planner.legModes[h.hop] = mode === 'bus' ? 'bus:' + h.bus[0].ref : 'walk'; });
        const R2 = await Planner.run({ optimize: false, keepModes: true });
        return R2 ? { ok: true, changed: pick.length, ...this.journeyBrief(R2) } : { error: 'replanning failed' };
      }
      case 'find_trains': {
        const q = new URLSearchParams({ frm: a.from, to: a.to, when: Clock.when() });
        const r = await U.json(`${CFG.API}/rail/trains?${q}`, {}, 20000);
        if (r.error || r.detail) return { error: 'station not found — use a railway station name' };
        Rail.open(r.from.rsid, true);
        return { from: r.from.name, to: r.to.name, direct: (r.direct || []).map(x => `${x.number} dep ${x.dep} arr ${x.arr} (to ${x.terminus})`),
                 with_change: (r.with_change || []).map(l => `${l.train} ${l.from} ${l.dep} → ${l.to} ${l.arr}`), note: 'Timetable data; Puja specials may add trains — check NTES' };
      }
      case 'add_to_plan': { const p = await this.place(a.name); if (!p) return { error: 'not found' }; Planner.add(p); return { ok: true, stops: Planner.stops.map(s => s.name) }; }
      case 'clear_plan': Planner.clear(); return { ok: true };
      case 'start_trip': {
        const trip = Planner.result ? Trip3D.fromPlan(Planner.result) : Route.last ? Trip3D.fromRoute(Route.last) : null;
        if (!trip) return { error: 'No plan or route yet' };
        Trip3D.start(trip); return { ok: true };
      }
      case 'export_plan': {
        const mode = Bar.mode, data = Bar.data; if (!mode) return { error: 'Nothing to export yet' };
        const f = String(a.format || 'pdf').toLowerCase();
        Export.run(f.startsWith('word') || f === 'doc' ? 'word' : f.includes('google') ? 'gmaps' : f, mode, data);
        return { ok: true, format: f };
      }
      case 'weather': { await Weather.load(); return Weather.data || { error: 'weather unavailable' }; }
      case 'find_nearby': {
        const kind = ({ restaurant: 'food', mishti: 'sweets', sweet: 'sweets', coffee: 'cafe', tea: 'cafe', washroom: 'toilet', bathroom: 'toilet', drinking_water: 'water', bank: 'atm', medicine: 'pharmacy', doctor: 'hospital' })[a.kind] || a.kind;
        if (!CFG.NEAR_KINDS[kind]) return { error: `unknown kind ${a.kind}` };
        const near = a.near ? await this.place(a.near) : null;
        const r = await Nearby.search(kind, near, a.radius_m || 900, !!a.open_now);
        if (r.error) return { error: r.error };
        return { kind, near: (near || App.start() || { name: t('near.around') }).name, count: r.list.length,
                 places: r.list.slice(0, 8).map(p => ({ name: p.name, distance_m: p.distance_m, open: p.open, hours: p.opening_hours || null, cuisine: p.cuisine || null, phone: p.phone || null })) };
      }
      case 'emergency_help': {
        const r = await Nearby.nearestHelp(); const h = r.hospitals[0];
        if (h) Route.go(App.start(), { lat: h.lat, lon: h.lon, name: h.name });
        return { numbers: { emergency: 112, police: 100, fire: 101, ambulance: 102, women: 1091, child: 1098 }, hospitals: r.hospitals.map(x => `${x.name} ${x.distance_m} m`), police: r.police.map(x => `${x.name} ${x.distance_m} m`) };
      }
      case 'report_issue': { const o = App.start() || await MapApp.locateNow(); if (!o) return { error: 'location unknown — ask the visitor to pick the spot on the map (SOS → pick on map)' }; return Nearby.report(o.lat, o.lon, a.type || 'issue', a.note || ''); }
      default: return { error: 'unknown tool ' + name };
    }
  },

  /* ── offline brain: same tools, keyword understanding, localized replies ── */
  zone(s) {
    return this.zoneIn(s) || [['North', /(bagbazar|kumartuli|shyambazar|hatibagan|sovabazar)/], ['South', /(ballygunge|gariahat|behala|kalighat)/],
      ['Central', /(college|sealdah|esplanade)/], ['East', /(salt lake|lake town|new town|sector)/], ['West', /(howrah|khidirpur|kidderpore)/]].find(([, re]) => re.test(s))?.[0] || null;
  },
  time(s) {
    const m = s.match(/(\d{1,2})(?::(\d{2}))?\s*(?:ta\b|tay\b|tai\b|টা|টায়|pm|am|baje|बजे|o'?clock)/i) || s.match(/(?:at|theke|से)\s+(\d{1,2})(?::(\d{2}))?/i);
    if (!m) return null;
    let h = +m[1]; const mm = m[2] || '00';
    if (/am/i.test(m[0])) { if (h === 12) h = 0; } else if (h >= 1 && h <= 11 && !/sokal|morning|सुबह|সকাল/i.test(s)) h += 12;
    return h <= 23 ? `${String(h).padStart(2, '0')}:${mm}` : null;
  },
  dayIn(s) { const D = [['Shashthi', /(shashthi|sasthi|soshti|ষষ্ঠী|षष्ठी)/], ['Saptami', /(saptami|soptomi|সপ্তমী|सप्तमी)/], ['Ashtami', /(ashtami|oshtomi|অষ্টমী|अष्टमी)/], ['Navami', /(navami|nobomi|নবমী|नवमी)/], ['Dashami', /(dashami|doshomi|দশমী|दशमी)/], ['Panchami', /(panchami|ponchomi|পঞ্চমী|पंचमी)/]]; for (const [d, re] of D) if (re.test(s)) return d; return null; },
  startIn(s) {
    const m = s.match(/(?:from\s+([a-z .'-]{3,30}?)(?:\s+at|\s+to\b|\s+till\b|\s+\d|,|\s\u2063|$))|([a-z .'-]{3,30}?)\s+(?:theke|thekey|se)\b/i) || s.match(/([\u0980-\u09FF\u0900-\u097F ]{2,30}?)\s*(?:থেকে|से)/);
    if (!m) return null;
    // "7 tay kalighat theke" → "kalighat": drop time words / numbers that sit in front of the place
    const LEAD = [/^(?:tay|ta|tai|tar|te|baje|bajey|pm|am|o'?clock|at|e|er|r|aj|aaj|sondhe|sondhya|sandhya|bikel|raat|rat|dupure|sokal|evening|tonight)\s+/i,
      /^[\u09E6-\u09EF\u0966-\u096F\d:.]+\s*/, /^(?:টায়|টা|টার|বাজে|সন্ধে|সন্ধ্যা|রাত|বিকেল|আজ|बजे|शाम|रात|आज|को|सन्ध्या)\s*/];
    let v = (m[1] || m[2] || '').trim(), prev;
    do { prev = v; LEAD.forEach(re => { v = v.replace(re, ''); }); v = v.trim(); } while (v !== prev);
    return v.length >= 2 ? v : null;
  },
  pandalsIn(s) {
    const stop = new Set(['durga', 'puja', 'pujo', 'sarbojanin', 'club', 'park', 'sangha', 'committee', 'samity', 'the', 'kolkata', 'pally', 'road', 'street', 'lane', 'block', 'metro', 'station', 'north', 'south', 'theke', 'jabo', 'kivabe']);
    const words = U.canon(s).split(' ').filter(w => w.length > 3 && !stop.has(w));
    // the same in Bangla / Devanagari script, matched against name_bn / name_hi
    const NSTOP = new Set(['দুর্গাপূজা', 'দুর্গোৎসব', 'সার্বজনীন', 'ক্লাব', 'সংঘ', 'কমিটি', 'সমিতি', 'পল্লী', 'পার্ক', 'মাঠ', 'পূজা', 'পুজো', 'ঠাকুর', 'দেখব', 'যাব', 'থেকে', 'মেট্রো',
      'दुर्गा', 'पूजा', 'दुर्गोत्सव', 'सार्वजनीन', 'क्लब', 'संघ', 'कमेटी', 'समिति', 'पल्ली', 'पार्क', 'मैदान', 'पंडाल', 'जाना', 'मेट्रो', 'कैसे']);
    const raw = String(s).normalize('NFC').toLowerCase().split(/[\s,.;:!?()।|/]+/).filter(w => w.length >= 3 && !NSTOP.has(w));
    const hits = [];
    Pandals.all.forEach(f => {
      const p = f.properties;
      const n = U.canon(p.name).split(' ').filter(w => w.length > 3 && !stop.has(w));
      const sc = n.filter(w => words.includes(w)).length;
      let best = sc ? sc / n.length + sc : 0;
      for (const nm of [p.name_bn, p.name_hi]) {
        if (!nm) continue;
        const nw = nm.normalize('NFC').split(/[\s,()]+/).filter(w => w.length >= 3 && !NSTOP.has(w));
        const s2 = nw.filter(w => raw.some(r => r === w || (r.length > 4 && r.startsWith(w)))).length;
        if (s2) best = Math.max(best, s2 / nw.length + s2);
      }
      if (best) hits.push([best, f]);
    });
    return hits.sort((x, y) => y[0] - x[0]).filter(h => h[0] >= 1.3).map(h => h[1]);
  },
  stationIn(s) { const n = U.norm(s); return Metro.stations.map(f => f.properties).sort((a, b) => b.name.length - a.name.length).find(p => [p.name, p.name_bn, p.name_hi].some(x => x && n.includes(U.norm(x))))?.name || null; },
  /* where a route should start: "from X", "X theke", "my location" (strict = only when the visitor said so) */
  fromIn(s, strict = false) {
    if (/(my (current )?location|current location|where i am|ekhan theke|ekhane|এখান থেকে|আমার লোকেশন|এখানে|मेरी लोकेशन|यहाँ से|यहां से)/.test(s)) return 'me';
    const v = this.startIn(s); if (v) return v;
    if (strict) return null;
    const o = this.originIn(s); return o || null;
  },
  /* where a route should go: a pandal, metro or railway station, a neighbourhood, or the words before "kivabe / how" */
  destIn(s, from) {
    let S = s;
    if (from && from !== 'me') S = S.split(String(from).toLowerCase()).join(' ');
    const p = this.pandalsIn(S)[0]; if (p) return p.properties.name;
    const st = this.stationIn(S); if (st) return st + ' metro';
    const rl = (Rail.stations || []).map(f => f.properties.name).filter(n => n.length >= 5).sort((a, b) => b.length - a.length).find(n => new RegExp('(?:^|[^a-z])' + n.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![a-z])').test(S));
    if (rl) return rl;
    const h = this.areaIn(S); if (h && !CFG.ZONES.includes(h)) return h;
    const m = S.match(/(?:to|towards|till|upto)\s+([a-z][a-z .'-]{2,30}?)(?=\s+(?:by|on|from|at|kivabe|kibhabe|jabo|jaabo|kaise|how|now)\b|[,.!?]|\s\u2063|$)/i)
      || S.match(/([a-z][a-z .'-]{2,30}?)(?:\s*-?\s*(?:e|te|y))?\s+(?:kivabe|kibhabe|kemne|kemon kore|jabo|jaabo|jete|jaite|kaise|jana|jaana|jaun|jau)\b/i);
    if (!m) return null;
    let v = m[1].trim(), prev;
    do { prev = v; v = v.replace(/^(ami|amra|i|we|how|do|can|go|get|reach|ekhon|now|the|a|ar|r|ebar|tarpor|then)\s+/i, '').replace(/\s+(e|te|y|ey)$/i, '').trim(); } while (v !== prev);
    return v.length >= 3 && !/^(route|rasta|kolkata|calcutta|pandal|pujo|puja|thakur|there|here|ekhane|okhane|north|south|east|west|central|home|bari|basa)$/i.test(v) ? v : null;
  },
  modeIn(s) { return /(taxi|cab|uber|ola|gari|गाड़ी|ট্যাক্সি|टैक्सी)/.test(s) ? 'taxi' : /(hete|hente|walk|on foot|হেঁটে|पैदल)/.test(s) ? 'walk' : /(metro|মেট্রো|मेट्रो)/.test(s) ? 'metro' : null; },
  /* draw a route; with no known start, ask for one (with a "my location" chip) and finish when it comes */
  async navRoute(dest, from, mode, say) {
    const C = this.ctx;
    const ask = () => { C.pending = 'routeFrom'; C.routeTo = dest; C.routeMode = mode; this.ask(t('r.askFrom'), [[t('plan.myloc'), t('r.cMe')]]); };
    if (!from && !App.start()) return ask();
    this.thinking('ai.routing');
    const r = await this.exec('get_route', { to: dest, from: from || undefined, mode: mode || 'auto' });
    if (r.error === 'START_UNKNOWN') return ask();
    if (r.error) {
      if (from === 'me' && /"me"/.test(r.error)) { C.pending = 'routeFrom'; C.routeTo = dest; C.routeMode = mode; return this.ask(t('g.locOff')); }
      const bad = /Could not find "([^"]+)"/.exec(r.error);
      if (bad && bad[1] === String(from)) { C.pending = 'routeFrom'; C.routeTo = dest; C.routeMode = mode; return this.ask(t('r.jNoPlace', { q: bad[1] }), [[t('plan.myloc'), t('r.cMe')]]); }
      if (bad) { C.pending = 'routeTo'; C.routeFrom = from; C.routeMode = mode; return this.ask(t('r.jNoPlace', { q: bad[1] })); }
      return say(t('bar.noRoute'));
    }
    const L2 = Route.last.r.legs.map(l => l.mode === 'metro' ? `• ${t('line.' + l.line)}: ${Metro.label(l.from)} → ${Metro.label(l.to)} (${l.stops === 1 ? t('leg.stop1') : t('leg.stops', { n: l.stops })})` : l.mode === 'bus' ? `• ${t('leg.busStep', { ref: l.ref, from: l.from, to: l.to, n: l.stops })} · ${U.mins(l.minutes)}` : `• ${t(l.mode === 'walk' ? 'leg.walk' : l.mode === 'toto' ? 'leg.toto' : 'leg.taxi')} ${U.km(l.meters)} · ${U.mins(l.minutes)}`);
    return say(`${t('r.route', { from: Bar.name(Route.last.from), to: Bar.name(Route.last.to), dur: U.mins(r.minutes), mode: t('mode.' + ({ drive: 'taxi', walk: 'walk', metro: 'metro' }[r.chosen] || 'auto')) })}\n${L2.join('\n')}${r.closures_avoided ? '\n' + t('r.closuresAvoided', { n: r.closures_avoided }) : ''}`);
  },

  /* ── the outing conversation (works without any AI key) ── */
  GOING: /(jabo|jaabo|jabe|jaben|jai\b|jaw|jawa|ghur|ghor|ghurbo|ghurte|dekhbo|dekhte|dekhab|dekha\b|hopping|parikrama|\bplan\b|\btrip\b|visit|\bsee\b|explore|go to|want to go|wanna go|going to|\btour\b|berob|beroch|beriye|bero\b|outing|यात्रा|घूम|देख|जाना|जाऊं|जाएंगे|जाऊँगा|जाना है|যাব|যাবো|ঘুর|দেখব|দেখতে|বেরোব|বেরোচ্ছি)/,
  /* a question about Puja itself (history, meaning, a story) is not a request to go somewhere */
  KNOW: /(history|itihas|ইতিহাস|इतिहास|what is|what are|why |meaning|mane ki|story|golpo|গল্প|কেন|क्यों|tell me about|explain|significance|ritual|niyom|নিয়ম)/,
  ROUTEQ: /(kivabe|kibhabe|kemne|kaise|how (do i|to|can i)|route|rasta|direction|কিভাবে|কীভাবে|कैसे|रास्ता)/,
  /* neighbourhoods people name when they say where they want to go (romanised, বাংলা, हिंदी) → the name the planner knows */
  HOODS: [
    ['Hatibagan', 'hatibagan|হাতিবাগান|हातीबागान'], ['Bagbazar', 'bagbazar|baghbazar|বাগবাজার|बागबाजार'], ['Kumartuli', 'kumartuli|kumortuli|কুমোরটুলি|কুমারটুলি|कुमारटोली'],
    ['Shyambazar', 'shyambazar|শ্যামবাজার|श्यामबाजार'], ['Sovabazar', 'sovabazar|shobhabazar|শোভাবাজার|शोभाबाजार'], ['Ahiritola', 'ahiritola|আহিরীটোলা'],
    ['College Square', 'college square|college street|কলেজ স্কোয়ার|কলেজ স্ট্রিট|कॉलेज स्क्वायर'], ['Santosh Mitra', 'santosh mitra|lebutala|সন্তোষ মিত্র|লেবুতলা'],
    ['Mohammad Ali Park', 'md ali park|mohammad ali park|muhammad ali park|মহম্মদ আলি পার্ক'], ['Bowbazar', 'bowbazar|বউবাজার'], ['Sealdah', 'sealdah|শিয়ালদহ|सियालदह'],
    ['Maniktala', 'maniktala|মানিকতলা'], ['Ultadanga', 'ultadanga|উল্টোডাঙা|উল্টোডাঙ্গা'], ['Kankurgachi', 'kankurgachi|কাঁকুড়গাছি'], ['Beleghata', 'beleghata|বেলেঘাটা'],
    ['Sinthee', 'sinthee|sinthi|সিঁথি'], ['Paikpara', 'paikpara|পাইকপাড়া'], ['Tala', 'tala park|tala prattoy|টালা'], ['Dakshineswar', 'dakshineswar|দক্ষিণেশ্বর|दक्षिणेश्वर'],
    ['Baranagar', 'baranagar|বরানগর'], ['Dum Dum', 'dum dum|dumdum|দমদম|दमदम'], ['Lake Town', 'lake town|laketown|লেকটাউন|লেক টাউন|लेक टाउन'],
    ['Salt Lake', 'salt lake|saltlake|bidhannagar|সল্টলেক|সল্ট লেক|বিধাননগর|साल्ट लेक|सॉल्ट लेक'], ['New Town', 'new town|newtown|নিউটাউন|নিউ টাউন|न्यू टाउन'],
    ['Kestopur', 'kestopur|keshtopur|কেষ্টপুর'], ['Baguiati', 'baguiati|বাগুইআটি'], ['Nagerbazar', 'nagerbazar|নাগেরবাজার'], ['Rajarhat', 'rajarhat|রাজারহাট'],
    ['Ballygunge', 'ballygunge|বালিগঞ্জ|बालीगंज'], ['Gariahat', 'gariahat|গড়িয়াহাট|गड़ियाहाट'], ['Kalighat', 'kalighat|কালীঘাট|कालीघाट'], ['Bhowanipore', 'bhowanipore|bhawanipur|ভবানীপুর'],
    ['Chetla', 'chetla|চেতলা'], ['Behala', 'behala|বেহালা|बेहाला'], ['Tollygunge', 'tollygunge|tollyganj|টালিগঞ্জ'], ['Jadavpur', 'jadavpur|যাদবপুর'], ['Dhakuria', 'dhakuria|ঢাকুরিয়া'],
    ['Kasba', 'kasba|কসবা'], ['Bagha Jatin', 'bagha ?jatin|বাঘাযতীন|বাঘা যতীন'], ['Garia', 'garia(?![a-z])|গড়িয়া(?!হাট)'], ['Park Circus', 'park circus|পার্ক সার্কাস'], ['Alipore', 'alipore|আলিপুর'],
    ['Khidirpur', 'khidirpur|kidderpore|খিদিরপুর'], ['Esplanade', 'esplanade|dharmatala|ধর্মতলা|এসপ্লানেড'], ['Howrah', 'howrah|হাওড়া|हावड़ा'], ['Naktala', 'naktala|নাকতলা'],
    ['Santoshpur', 'santoshpur|সন্তোষপুর'], ['Thakurpukur', 'thakurpukur|ঠাকুরপুকুর'], ['Barisha', 'barisha|বড়িশা'],
  ],
  /* North / South … as whole words only: "Madhyamgram" is not madhya (Central), "Uttarpara" is not uttar (North);
     Banglish endings (dokkhin-e, uttor-er) and Bengali / Hindi case endings (উত্তরে, दक्षिण में) are fine */
  zoneIn(s) {
    const R = [['North', 'north|uttor|uttar|উত্তর|उत्तर'], ['South', 'south|dokkhin|dokhin|dakshin|দক্ষিণ|दक्षिण'], ['Central', 'central|moddho|madhya|মধ্য|मध्य'],
      ['East', 'east|purbo|purba|পূর্ব|पूर्व'], ['West', 'west|poschim|paschim|পশ্চিম|पश्चिम']];
    if (!this._zre) this._zre = R.map(([z, w]) => [z, new RegExp('(?:^|[^a-z\\u0980-\\u09FF\\u0900-\\u097F])(?:' + w + ')(?:e|er|te|r|ey)?(?![a-z\\u0995-\\u09B9\\u09CE\\u09DC-\\u09DF\\u0915-\\u0939\\u0958-\\u095F])', 'i')]);
    const hit = this._zre.find(([, re]) => re.test(s));
    return hit ? hit[0] : null;
  },
  HUBS: new Set(['Sealdah', 'Howrah', 'Dum Dum', 'Esplanade']),
  /* the area to see: a neighbourhood beats a zone ("south er gariahat part" → Gariahat), a zone beats several
     neighbourhoods or a station that is only how they come in */
  areaIn(s) {
    if (!this._hoods) this._hoods = this.HOODS.map(([en, re]) => [en, new RegExp('(?:^|[^a-z])(?:' + re + ')', 'i')]);
    const zone = this.zoneIn(s);
    const hoods = this._hoods.filter(([, re]) => re.test(s)).map(h => h[0]);
    const local = hoods.filter(h => !this.HUBS.has(h));
    if (local.length === 1) return local[0];
    if (local.length > 1) return zone || local[0];
    return zone || hoods[0] || null;
  },
  isOuting(s) {
    if (this.ctx.pending || this.KNOW.test(s)) return false;
    const area = this.areaIn(s), noun = /(thakur|pandal|pujo|puja|ঠাকুর|প্যান্ডেল|পুজো|पंडाल|पूजा)/.test(s);
    if (!this.GOING.test(s) && !(area && noun)) return false;     // "north jabo", "thakur dekhbo", or "south kolkata pandals"
    if (this.ROUTEQ.test(s) && this.pandalsIn(s).length && !/(sob|sab|all|সব|सब|thakur dekh|ঠাকুর দেখ)/.test(s)) return false;   // "how do I get to <pandal>" is a route
    if (this.ROUTEQ.test(s) && !(area && CFG.ZONES.includes(area)) && !/(sob|sab|all|সব|सब|thakur|ঠাকুর|pandal|প্যান্ডেল|पंडाल|ghur|ঘুর|घूम|dekh|দেখ|देख|hopping|pujo|puja|পুজো|पूजा)/.test(s)) return false;   // "how do I get to Garia" too
    return !!(area || this.originIn(s) || noun || /(hopping|parikrama)/.test(s));
  },
  originIn(s) {
    if (/(my location|current location|where i am|ekhane achi|ekhon jekhane|ekhanei|এখানে আছি|এখন যেখানে|আমার লোকেশন|यहीं|मेरी लोकेशन|जहाँ हूँ)/.test(s)) return 'me';
    const tidy = v => {
      let x = String(v || '').replace(/[,.!?]+$/g, '').trim(), prev;
      do { prev = x;
        x = x.replace(/^(ami|amra|amar|amader|i|we|my|our|main|hum|mera|hamara|aami|bari|basa|home|ghar|is|in|at|ekhon|now|r|ar|and|to|so|tobe|haan|ha|yes|ok|okay|e|te|y|by|train|local|tren|rail|bus|road|gari|car|metro|আমি|আমরা|আমার|বাড়ি|বাসা|मैं|हम|मेरा|घर|ट्रेन|ট্রেন)\s+/i, '')
             .replace(/\s+(e|te|y|ey|er|theke|thekey|area|side|er dike|e thaki|thaki|achi|থেকে|এ|তে|এর|में|मे|से|के पास)$/i, '')
             .replace(/(এ|তে|য়)$/u, '').trim();
      } while (x !== prev);
      return x.length >= 3 && !/^(train|local|road|bus|north|south|east|west|central|kolkata|calcutta|pujo|puja|thakur|today|aaj)$/i.test(x) ? x : null;
    };
    const P = [
      /(?:i live (?:in|at|near)|i stay (?:in|at)|i'?m (?:in|at|near)|i am (?:in|at|near)|staying (?:in|at)|living in|my (?:home|house) is (?:in|at)|home is in|coming from|starting from|start from|from)\s+([a-z .'-]{3,30}?)(?=\s+(?:and|but|to|by|at|on|,|\d)|[,.!?]|$)/i,
      /(?:amar|amader|aamar)\s+(?:bari|basa)\s+([a-z .'-]{3,30}?)(?=\s+(?:e|te|y)\b|\s+(?:ar|r|and|,)|[,.!?]|$)/i,
      /([a-z][a-z .'-]{2,30}?)(?:\s*-?\s*(?:e|te|y|ey))?\s+(?:thaki|thake|thakchi|thaakbo|achi|aachi|acchi|rehta|rehti|rahta|rahti|rehte|rahte|se aa|se aaunga|se aaenge)\b/i,
      /([a-z][a-z .'-]{2,30}?)\s+(?:theke|thekey|theky)\b/i,
      /(?:আমার|আমাদের)\s+(?:বাড়ি|বাসা)\s+([ঀ-৿ ]{2,30}?)(?:\s|এ|তে|,|।|$)/,
      /([ঀ-৿][ঀ-৿ ]{1,30}?)\s*(?:-?এ|-?তে|-?য়)?\s+(?:থাকি|থাকছি|আছি|থেকে)/,
      /(?:मेरा|हमारा)\s+घर\s+([ऀ-ॿ ]{2,30}?)(?:\s+में|\s+मे|,|।|$)/,
      /([ऀ-ॿ][ऀ-ॿ ]{1,30}?)\s+(?:में|मे)\s+(?:रहता|रहती|रहते|हूँ|हूं|हैं)/,
      /([ऀ-ॿ][ऀ-ॿ ]{1,30}?)\s+से\b/,
    ];
    for (const re of P) { const m = s.match(re); if (m) { const v = tidy(m[1]); if (v) return v; } }
    return null;
  },
  travelIn(s) {
    if (/(local train|\btrains?\b|\btren\b|\brail\b|\blocal[- ]?e\b|ট্রেন|লোকালে|लोकल ट्रेन|ट्रेन)/.test(s)) return 'train';
    if (/(by road|\broad\b|\bbus\b|\bcar\b|\bgaa?ri\b|\bgaa?rite\b|\btaxi\b|\bcab\b|\buber\b|\bola\b|\bbike\b|scooty|সড়ক|রাস্তা দিয়ে|গাড়ি|ট্যাক্সি|বাসে|सड़क|गाड़ी|कार|टैक्सी|बस से)/.test(s)) return 'road';
    return null;
  },
  budgetIn(s) {
    if (/(dedh|der|দেড়|डेढ़)\s*(ghonta|ghanta|ghante|hour|ঘণ্টা|ঘন্টা|घंटे|घंटा)/.test(s)) return 90;
    if (/(arai|adai|আড়াই|ढाई)\s*(ghonta|ghanta|ghante|hour|ঘণ্টা|ঘন্টা|घंटे|घंटा)/.test(s)) return 150;
    if (/(adh|aadh|আধ|आधा)\s*(ghonta|ghanta|hour|ঘণ্টা|ঘন্টা|घंटा)/.test(s)) return 30;
    const m = s.match(/(\d+(?:\.\d+)?)\s*(?:-|\s)?\s*(ghonta|ghanta|ghante|ghantay|hours?|hrs?|h\b|ঘণ্টা|ঘন্টা|घंटे|घंटा|min(?:ute)?s?|minit|মিনিট|मिनट)/);
    if (!m) return null;
    const v = +m[1];
    return /min|minit|মিনিট|मिनट/.test(m[2]) ? Math.round(v) : Math.round(v * 60);
  },
  catsIn(s) {
    const c = [];
    if (/(famous|top|big|boro|bado|bada|popular|best|viral|বিখ্যাত|বড়|নামী|प्रसिद्ध|बड़े|मशहूर)/.test(s)) c.push('top');
    if (/(bonedi|bari|rajbari|heritage|zamindar|বনেদি|রাজবাড়ি|विरासत|बोनेदी)/.test(s)) c.push('bonedi');
    if (/(\bpara\b|local pujo|local puja|choto|chhoto|small|neighbourhood|পাড়া|ছোট|स्थानीय|छोटे)/.test(s)) c.push('para');
    return c.length ? c : null;
  },
  /* resolve what the visitor called their start; for "jabo ami barasat" try the last words too */
  async originPlace(v) {
    if (v === 'me') { const o = MapApp.origin() || await MapApp.locateNow(); return o ? { ...o, name: t('plan.myloc') } : null; }
    // Bengali / Hindi case endings come off: মধ্যমগ্রামে → মধ্যমগ্রাম, বারাসাতে → বারাসাত, बारासात में → बारासात
    const bare = x => x.replace(/(তে|য়|ে|এ|র|ের|কে)$/u, '').replace(/\s+(में|मे|से|के पास)$/u, '').trim();
    const w = String(v).trim().split(/\s+/), cands = [w.join(' ')];
    for (let k = Math.min(3, w.length - 1); k >= 1; k--) cands.push(w.slice(-k).join(' '));
    cands.slice().forEach(c => { const b = bare(c); if (b && b !== c && b.length >= 2) cands.push(b); });
    for (const c of cands) { const l = App.localMatches(c).find(x => x.rank < 1); if (l) return { ...l, name: l.station || l.name, outside: Planner.outside(l) }; }
    for (const c of cands) { if (c.length < 3) continue; const p = await App.place(c); if (p) return { ...p, outside: Planner.outside(p) }; }
    return null;
  },
  areaChips() { return [['North', t('r.cNorth')], ['South', t('r.cSouth')], ['Central', t('r.cCentral')], ['East', t('r.cEast')]].map(([z, r]) => [t('zone.full', { zone: t('zone.' + z) }), r]).concat([[t('r.jAnywhere'), t('r.cAny')]]); },
  isFollowUp(s) {
    const C = this.ctx;
    return !!(C.planned && !this.areaIn(s) && (this.budgetIn(s) || this.catsIn(s) || this.travelIn(s) || (this.time(s) && s.split(' \u2063 ')[0].split(/\s+/).length <= 8)));
  },
  needTravelQ(o, area) {
    if (!o || o.type === 'me' && !Planner.outside(o)) return false;
    const st = Rail.nearest(o.lat, o.lon)[0];
    if (!st || st.d > 4000) return false;
    const P = area ? Pandals.all.filter(f => f.properties.zone === area || U.canon(f.properties.name).includes(U.canon(area))) : Pandals.all;
    const c = P.length ? [P.reduce((x, f) => x + f.properties.lat, 0) / P.length, P.reduce((x, f) => x + f.properties.lon, 0) / P.length] : [22.5726, 88.3639];
    return Planner.outside(o) || U.hav(o.lat, o.lon, c[0], c[1]) > 9000;
  },
  originLabel(o) { return !o ? '' : o.type === 'rail_station' ? Rail.label(o.name) : o.type === 'station' ? Metro.label(String(o.name).replace(/ metro$/i, '')) : o.pid ? locName(Pandals.byId[o.pid]?.properties || o) : o.name; },
  areaLabel(a) {
    if (!a) return t('r.jAnywhere');
    if (CFG.ZONES.includes(a)) return t('zone.full', { zone: t('zone.' + a) });
    // a neighbourhood in the website's language, from the spellings Sarathi already knows (গড়িয়াহাট, गड़ियाहाट)
    const h = this.HOODS.find(([en]) => en === a), alts = h ? h[1].split('|') : [];
    const loc = I18N.lang === 'bn' ? alts.find(x => /[\u0980-\u09FF]/.test(x)) : I18N.lang === 'hi' ? alts.find(x => /[\u0900-\u097F]/.test(x)) : null;
    return loc && !/[()?\\]/.test(loc) ? loc : a;
  },

  async journeyTurn(text, s) {
    const C = this.ctx;
    // 1 · answering "walk or bus?"
    if (C.pending === 'bus') {
      const bus = /(\bbus\b|বাস|बस)/.test(s), walk = /(walk|hete|hente|haat|হেঁটে|হাঁট|पैदल|chal)/.test(s);
      if (bus || walk) {
        C.pending = null;
        const r = await this.exec('set_hop_mode', { mode: bus ? 'bus' : 'walk', all: true });
        if (r.error) { this.ask(r.error); return true; }
        this.ask(`${t(bus ? 'r.jBusSet' : 'r.jWalkSet', { n: r.changed })}\n${this.journeyText(Planner.result, true)}`);
        return true;
      }
      C.pending = null;
    }
    const ov = this.originIn(s);
    // the start is not the area: "Madhyamgram" as the answer to "where do you start?" says nothing about where to go
    const sA = C.pending === 'origin' && !ov && text.trim().split(/\s+/).length <= 4 ? '' : ov && ov !== 'me' ? s.split(ov).join(' ') : s;
    const area = this.areaIn(sA), travel = this.travelIn(s), budget = this.budgetIn(s), cats = this.catsIn(s), tm = this.time(s);
    // 2 · answering "where do you start?"
    if (C.pending === 'origin') {
      const v = ov || (text.trim().split(/\s+/).length <= 4 ? text.trim() : null);
      const o = v ? await this.originPlace(v) : null;
      if (!o) { this.ask(t('r.jNoPlace', { q: v || text }), [[t('plan.myloc'), t('r.cMe')]]); return true; }
      C.origin = o; C.pending = null;
    } else if (C.pending === 'travel') {
      if (!travel) { const st = Rail.nearest(C.origin.lat, C.origin.lon)[0]; this.ask(t('r.jAskTravel', { place: this.originLabel(C.origin), station: st ? Rail.label(st.f.properties.name) : '—' }), [[t('travel.train'), t('r.cTrain')], [t('travel.road'), t('r.cRoad')]]); return true; }
      C.pending = null;
    } else if (C.pending === 'area') {
      const any = /(any|anywhere|best|\bsob\b|\bsab\b|jekono|যেকোনো|সেরা|कहीं भी|सबसे)/.test(s);
      if (!area && !any) { this.ask(t('r.jAskArea'), this.areaChips()); return true; }
      C.area = area || null; C.anyArea = !area; C.pending = null;
      if (ov) { const o = await this.originPlace(ov); if (o) C.origin = o; }
    } else {
      // a fresh request (or a follow-up that changes one thing of the last plan)
      const followUp = this.isFollowUp(s) && !ov;
      if (!followUp) {
        if (!this.isOuting(s) && !area) return false;
        C.area = area || null; C.anyArea = false; C.cats = null; C.budget = null; C.time = null; C.mode = null;
      }
      if (ov) { const o = await this.originPlace(ov); if (o) C.origin = o; else { C.pending = 'origin'; this.ask(t('r.jNoPlace', { q: ov }), [[t('plan.myloc'), t('r.cMe')]]); return true; } }
    }
    if (travel) C.travel = travel;
    const cityMode = /(hete|hente|walk|on foot|হেঁটে|পায়ে হেঁটে|पैदल)/.test(s) ? 'walk' : /(taxi|cab|uber|ola|ট্যাক্সি|टैक्सी)/.test(s) ? 'taxi' : (/(metro|মেট্রো|मेट्रो)/.test(sA) && !/(metro|মেট্রো|मेट्रो)/.test(String(ov || ''))) ? 'metro' : null;
    if (cityMode) C.mode = cityMode;
    if (budget) C.budget = budget;
    if (cats) C.cats = cats;
    if (tm) C.time = tm;
    if (area) C.area = area;
    const d = this.dayIn(s); if (d) Clock.set(d, Clock.min);
    // 3 · what is still missing — one question at a time
    if (!C.area && !C.anyArea) {
      C.pending = 'area';
      this.ask(t('r.jAskArea'), this.areaChips());
      return true;
    }
    if (!C.origin) {
      C.pending = 'origin';
      this.ask(t('r.jAskStart', { area: this.areaLabel(C.area) }), [[t('plan.myloc'), t('r.cMe')]]);
      return true;
    }
    if (!C.travel && this.needTravelQ(C.origin, C.area)) {
      C.pending = 'travel';
      const st = Rail.nearest(C.origin.lat, C.origin.lon)[0];
      this.ask(t('r.jAskTravel', { place: this.originLabel(C.origin), station: Rail.label(st.f.properties.name) }), [[t('travel.train'), t('r.cTrain')], [t('travel.road'), t('r.cRoad')]]);
      return true;
    }
    // 4 · plan it
    this.thinking('ai.journey');
    const r = await this.exec('plan_journey', { start_place: undefined, travel: C.travel || 'auto', area: C.area || undefined, budget_minutes: C.budget || undefined,
      categories: C.cats || undefined, start_time: C.time || undefined, mode: C.mode || undefined, return_home: (C.travel === 'train' || C.origin.outside) ? true : undefined });
    if (r.error) { this.ask(r.error); return true; }
    const R = Planner.result;
    this.ask(this.journeyText(R));
    const hops = this.busHops(R).filter(h => h.walk_min >= 12);
    if (hops.length) {
      C.pending = 'bus';
      const h = hops.sort((a, b) => b.walk_min - a.walk_min)[0];
      this.ask(t(hops.length > 1 ? 'r.jAskBusN' : 'r.jAskBus1', { to: h.to, w: U.mins(h.walk_min), ref: h.bus[0].label || h.bus[0].ref, b: U.mins(h.bus[0].minutes), n: hops.length }),
        [[t('r.cWalk'), t('r.cWalk')], [t('r.cBus'), t('r.cBus')]]);
    }
    return true;
  },
  journeyText(R, short = false) {
    const by = this.legsBy(R), J = R.journey || {}, last = R.timeline.length - 1, out = [];
    const C = this.ctx;
    if (!short) out.push(t('r.jHead', { day: t('day.' + R.day), start: Planner.startName(Planner.stops[0]), area: this.areaLabel(C.area), leave: U.time(R.timeline[0].depart) }));
    R.timeline.forEach((r, i) => {
      if (i === 0) return;
      const hop = this.hopText(by[i]);
      if (r.type === 'rail_station' && !r.home) out.push(`🚆 ${hop} — ${t('r.jGetOff', { st: Rail.label(String(r.name).replace(/ \((station|home)\)$/, '')) })}`);
      else if (r.home) out.push(`🏠 ${hop}${J.back ? '' : ''} — ${t('r.jHome', { t: U.time(r.arrive) })}`);
      else if (r.pid) out.push(`• ${U.time(r.arrive)}–${U.time(r.depart)} ${locName(Pandals.byId[r.pid]?.properties || r)}${r.crowd ? ' · ' + t('crowd.' + r.crowd) : ''}  ← ${hop}`);
      else if (i === last) out.push(`• ${U.time(r.arrive)} ${Planner.rowName(r)} ← ${hop}`);
    });
    const n = R.timeline.filter(r => r.pid).length, sk = (J.skipped || []).length;
    out.push(t('r.jTotals', { n, t: U.time(R.finish), cost: R.totals.cost_estimate }));
    R.warnings.filter(w => w.code !== 'skipped').slice(0, 2).forEach(w => out.push('⚠ ' + Planner.warnText(w)));
    if (sk && !short) out.push(t('r.jSkipped', { n: sk }));
    if (!short) out.push(t('r.planNext'));
    return out.join('\n');
  },

  async offline(text, agent) {
    const s = this.forms(text);
    const say = m => { this.thinking(null); this.say('ai', m); };
    const tool = async (n, a) => { this.thinking(this.STATUS[n] || 'ai.thinking'); return this.exec(n, a); };
    if (agent === 'planner' && await this.journeyTurn(text, s)) return;
    const d = this.dayIn(s); if (d) Clock.set(d, Clock.min);
    const pn = f => locName(f.properties);

    if (agent === 'safety') {
      if (/(toilet|washroom|bathroom|loo|শৌচালয়|টয়লেট|शौचालय)/.test(s) || /(water|jol|paani|pani|জল|पानी)/.test(s)) {
        const kind = /(water|jol|paani|pani|জল|पानी)/.test(s) ? 'water' : 'toilet';
        const r = await tool('find_nearby', { kind, radius_m: 1500 });
        return say(r.count ? `${t('r.near', { kind: t('near.' + kind), place: r.near })}\n${r.places.slice(0, 4).map((p, i) => `${i + 1}. ${p.name} — ${U.km(p.distance_m)}`).join('\n')}` : t('near.none'));
      }
      if (/(report|block|barricade|bondho|band)/.test(s)) { await tool('report_issue', { type: 'closure', note: text }); return say(t('r.reported')); }
      const r = await tool('emergency_help', {});
      return say(t('r.emergency', { h: r.hospitals.slice(0, 2).join('; ') || '—', p: r.police.slice(0, 2).join('; ') || '—' }));
    }
    if (agent === 'foodie') {
      const kind = /(mishti|sweet|মিষ্টি|मिठाई|sandesh|rosogolla)/.test(s) ? 'sweets' : /(cafe|coffee|\bcha\b|chai|tea|চা|चाय)/.test(s) ? 'cafe' : 'food';
      const ps = this.pandalsIn(s), near = ps[0] ? ps[0].properties.name : null;
      let r = await tool('find_nearby', { kind, near, radius_m: 900, open_now: true });
      if (r.error) return say(r.error);
      if (!r.count) { r = await tool('find_nearby', { kind, near, radius_m: 1500, open_now: false }); if (!r.count) return say(t('near.none')); return say(`${t('r.nearOpenNone')}\n${r.places.slice(0, 5).map((p, i) => `${i + 1}. ${p.name} — ${U.km(p.distance_m)}`).join('\n')}`); }
      return say(`${t('r.near', { kind: t('near.' + kind), place: r.near })}\n${r.places.slice(0, 5).map((p, i) => `${i + 1}. ${p.name} — ${U.km(p.distance_m)}${p.cuisine ? ' · ' + p.cuisine.replace(/;/g, ', ') : ''}`).join('\n')}`);
    }
    if (agent === 'planner') {
      if (/(3d|start trip|যাত্রা শুরু|यात्रा शुरू)/.test(s) && (Planner.result || Route.last)) { await tool('start_trip', {}); return say(t('ai.done')); }
      if (/(pdf|word|gpx|export|download)/.test(s) && Bar.mode) { const f = /word/.test(s) ? 'word' : /gpx/.test(s) ? 'gpx' : 'pdf'; await tool('export_plan', { format: f }); return say(t('r.exported', { f: f.toUpperCase() })); }
      const zone = this.zone(s), start = this.startIn(s), tm = this.time(s);
      let names = this.pandalsIn(s).map(f => f.properties.name);
      if (names.length < 2 && /(these|them|egulo|eguli|এগুলো|এগুলি|इन्हें|इनकी|ये)/.test(s) && Pandals.hl.size) names = [...Pandals.hl].map(pid => Pandals.byId[pid].properties.name);
      const category = /(bonedi|bari|rajbari|heritage|বনেদি|विरासत)/.test(s) ? 'bonedi' : null;
      const metroAsStart = start && /metro|মেট্রো|मेट्रो/i.test(start);      // "kalighat metro theke" is a place, not a mode
      const mode = /(taxi|cab|uber|ola|gari|गाड़ी)/.test(s) ? 'taxi' : /(hete|walk|हेंटे|হেঁটে|पैदल)/.test(s) ? 'walk' : (!metroAsStart && /metro|মেট্রো|मेट्रो/.test(s)) ? 'metro' : 'auto';
      const r = await tool('plan_trip', { zone, pandal_names: names.length >= 2 ? names : [], category, start_place: start, start_time: tm || undefined, mode });
      if (r.error) return say(r.error);
      const R = Planner.result;
      return say(`${t('r.plan', { day: t('day.' + R.day), start: Planner.startName(Planner.stops[0]) })}\n${R.timeline.slice(1).map(x => `• ${U.time(x.arrive)} ${x.pid ? locName(Pandals.byId[x.pid].properties) : x.name}${x.crowd ? ' · ' + t('crowd.' + x.crowd) : ''}`).join('\n')}\n${t('r.planTotals', { t: U.time(R.finish), walk: t('u.km', { n: R.totals.walk_km }), rides: R.totals.metro_rides, cost: R.totals.cost_estimate })}${R.warnings.length ? '\n⚠ ' + Planner.warnText(R.warnings[0]) : ''}\n${t('r.planNext')}`);
    }
    if (agent === 'navigator') {
      const C = this.ctx;
      // answering "where to?" / "from where?"
      if (C.pending === 'routeTo' || C.pending === 'routeFrom') {
        const which = C.pending; C.pending = null;
        if (which === 'routeFrom') return this.navRoute(C.routeTo, this.fromIn(s) || text.trim(), C.routeMode, say);
        return this.navRoute(this.destIn(s) || text.trim(), C.routeFrom, this.modeIn(s) || C.routeMode, say);
      }
      const st = this.stationIn(s);
      if (st && /(last|first|timing|kokhon|কখন|कब|train|ট্রেন|ट्रेन)/.test(s) && !/(kivabe|kaise|jabo|route|কিভাবে|कैसे)/.test(s)) {
        const r = await tool('metro_info', { station: st });
        const info = Card.cur?.data || {};
        return say(`${t('r.metro', { station: Metro.label(r.station), lines: r.lines.map(l => t('r.metroLine', { line: t('line.' + l.line), first: l.first ? U.time(l.first) : '—', last: l.last ? U.time(l.last) : '—' })).join('; ') })}\n${t('r.metroNear', { list: (info.pandals_1km || []).slice(0, 5).map(p => p.name).join(', ') || '—' })}`);
      }
      if (/(block|bondho|closed|band|বন্ধ|बंद)/.test(s)) { const p = this.pandalsIn(s)[0]; const r = await tool('closures_near', { place: p ? p.properties.name : 'me' }); return say(r.blocked?.length ? t('r.closures', { place: p ? pn(p) : t('plan.myloc'), list: r.blocked.slice(0, 6).join(', ') }) : t('r.noClosures', { place: p ? pn(p) : t('plan.myloc') })); }
      const from = this.fromIn(s, true), dest = this.destIn(s, from), mode = this.modeIn(s);
      if (!dest) { C.pending = 'routeTo'; C.routeFrom = from; C.routeMode = mode; return this.ask(t('r.whereTo')); }
      return this.navRoute(dest, from, mode, say);
    }
    // guide
    const ps = this.pandalsIn(s);
    if (ps.length && /(bhir|crowd|queue|line|ভিড়|भीड़|kokhon|কখন|कब|when|best time)/.test(s)) {
      const day = d || Clock.day, b = Pandals.bestHours(ps[0].properties.popularity, day);
      await tool('pandal_details', { name: ps[0].properties.name });
      return say(t('r.crowd', { name: pn(ps[0]), day: t('day.' + day), now: (c0 => t('crowd.' + c0.level) + (c0.src === 'live' ? ` (${t('crowd.live')})` : ''))(Pandals.crowd(ps[0].properties, day)), best: this.hrs(this.quiet(b)), worst: this.hrs(b.worst) }));
    }
    if (ps.length) {
      const r = await tool('pandal_details', { name: ps[0].properties.name }), p = ps[0].properties;
      return say(t('r.pandal', { name: pn(ps[0]), type: t('cat.' + p.category), zone: t('zone.full', { zone: t('zone.' + p.zone) }), crowd: t('crowd.' + r.crowd_now), metro: Metro.label(p.metro), walk: t('card.walkMin', { m: p.walk_min }) }));
    }
    const zone = this.zone(s), category = /(bonedi|bari|rajbari|heritage|বনেদি|विरासत)/.test(s) ? 'bonedi' : /(para|local|choto|small|পাড়া|स्थानीय)/.test(s) ? 'para' : 'top';
    const r = await tool('search_pandals', { zone, category, limit: 8, near: /(kache|near|nearby|কাছে|पास)/.test(s) ? 'me' : undefined, radius_km: 2 });
    if (!r.count) return say(t('r.noMatch'));
    const list = Pandals.all.filter(f => Pandals.hl.has(f.properties.pid)).sort((a, b) => b.properties.popularity - a.properties.popularity);
    return say(`${t('r.list', { n: r.count })}\n${list.map((f, i) => `${i + 1}. ${pn(f)} · ${t('crowd.' + Pandals.crowd(f.properties).level)}`).join('\n')}\n${t('r.listNext')}`);
  },
};
