// ==UserScript==
// @name         Almanac War Planner
// @namespace    https://shiroshura.com/
// @version      0.3.1
// @description  Ranked-war planning and decay-only finish estimates, using the visible faction war card.
// @match        https://www.torn.com/factions.php*
// @match        https://torn.com/factions.php*
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-end
// @noframes
// @license      MIT
// ==/UserScript==

(async function () {
  'use strict';
  const HOUR = 3600000;
  // Linear interpolation of the documented 1% of ORIGINAL target per hour after 24h.
  // Estimates stop at 123h: forced endings / ties are not extrapolated.
  // Reference: https://wiki.torn.com/wiki/Ranked_War
  const fraction = hours => Math.max(0, 1 - Math.max(0, hours - 24) / 100);
  function targetAt(base, start, end) {
    const h = (end - start) / HOUR;
    return base > 0 && Number.isFinite(h) && h >= 0 && h <= 123 ? base * fraction(h) : null;
  }
  function finishAt(base, start, lead) {
    if (!(base > 0) || !Number.isFinite(start) || !(lead > 0)) return null;
    if (lead >= base) return start;
    const hours = 24 + 100 * (1 - lead / base);
    return hours <= 123 ? start + hours * HOUR : null;
  }
  function plan(base, start, end, percent) {
    const target = targetAt(base, start, end);
    if (target === null || !Number.isFinite(percent) || percent < 0 || percent > 100) return null;
    const loser = base * percent / 100;
    return { target, loser, winner: loser + target };
  }
  function number(text) {
    const s = String(text ?? '').trim().replace(/,/g, '');
    return /^\d+(?:\.\d+)?$/.test(s) ? Number(s) : null;
  }
  function elapsed(text) {
    const m = String(text).replace(/\s/g, '').match(/^(\d+):(\d{2}):(\d{2}):(\d{2})$/);
    if (!m || +m[2] > 23 || +m[3] > 59 || +m[4] > 59) return null;
    return (+m[1] * 86400 + +m[2] * 3600 + +m[3] * 60 + +m[4]) * 1000;
  }
  function utcInput(t) { return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 19) : ''; }
  function parseUTC(value) {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(value)) return NaN;
    return Date.parse(value + 'Z');
  }
  function readCard(root, now = Date.now()) {
    const cards = [...root.querySelectorAll('[data-warid]')].filter(el => el.querySelector('[class*="scoreBlock___"]'));
    if (cards.length !== 1) return { error: cards.length ? 'Multiple war cards found; open one faction profile.' : 'No ranked-war card detected on this page.' };
    const box = cards[0];
    const text = selector => box.querySelector(selector)?.textContent.trim() || '';
    const side = prefix => {
      const link = box.querySelector(`[class*="${prefix}FactionName___"]`);
      const score = number(text(`[class*="scoreText___"][class*="${prefix}Faction___"]`));
      const members = text(`[class*="${prefix}Block___"]`).match(/\d+\s*\/\s*(\d+)/);
      return { id: link ? new URL(link.getAttribute('href'), 'https://www.torn.com').searchParams.get('ID') : null,
        name: link?.textContent.trim() || prefix, score, members: members ? +members[1] : null };
    };
    const targetMatch = text('[class*="target___"]').match(/([\d,.]+)\s*\/\s*([\d,.]+)/);
    const current = side('current'), opponent = side('opponent');
    if (!current.id || !opponent.id || current.score === null || opponent.score === null || !targetMatch) return { error: 'War card format not recognised. Live estimates paused.' };
    const target = number(targetMatch[2]);
    if (!(target > 0)) return { error: 'No positive lead target detected. The war may have ended.' };
    const duration = elapsed(text('[class*="timer___"]'));
    const scheduled = !!box.querySelector('[class*="statsBox___"][class*="waiting___"]');
    const active = !scheduled && (current.score > 0 || opponent.score > 0 || /YOUR FACTION IS IN A WAR/i.test(root.querySelector('.f-msg')?.textContent || ''));
    return { id: box.getAttribute('data-warid'), current, opponent, target, duration,
      start: duration !== null ? (scheduled ? now + duration : active ? now - duration : null) : null, scheduled, active, box };
  }
  function nextMatchmaking(reference) {
    const t = new Date(reference);
    t.setUTCHours(12, 0, 0, 0);
    t.setUTCDate(t.getUTCDate() + ((2 - t.getUTCDay() + 7) % 7));
    if (+t <= reference) t.setUTCDate(t.getUTCDate() + 7);
    return +t;
  }
  const BONUS_POINTS = {25:20, 50:40, 100:80};
  function bonusTotal(counts = {}) {
    return Object.entries(BONUS_POINTS).reduce((sum, [milestone, points]) => {
      const count = counts[milestone];
      return sum + (Number.isSafeInteger(count) && count > 0 ? count * points : 0);
    }, 0);
  }
  function memberShare(total, bonus, members) {
    return members > 0 && Number.isInteger(members) ? Math.max(0, total - bonus) / members : null;
  }
  function placeLauncher(root, launcher, computedStyle) {
    const view = root.defaultView;
    const viewport = view?.visualViewport;
    const width = viewport?.width || root.documentElement.clientWidth || view?.innerWidth || 1024;
    const left = viewport?.offsetLeft || 0;
    const compact = width <= 600 || !!view?.matchMedia?.('(pointer:coarse)').matches;
    const list = root.querySelector('#faction_war_list_id');
    function fits(element) {
      if (!element?.isConnected) return false;
      const rect = element.getBoundingClientRect();
      if (!(rect.width > 0 && rect.height > 0) || rect.left < left-1 || rect.right > left+width+1) return false;
      for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
        const style = computedStyle(ancestor);
        if (ancestor.hidden || style.display === 'none' || /hidden|collapse/.test(style.visibility) || style.opacity === '0') return false;
        if (ancestor === element || ancestor === root.body || ancestor === root.documentElement) continue;
        const bounds = ancestor.getBoundingClientRect();
        const clipLeft = bounds.left + ancestor.clientLeft;
        const clipTop = bounds.top + ancestor.clientTop;
        if (/hidden|clip|auto|scroll/.test(style.overflowX) && (rect.left < clipLeft-1 || rect.right > clipLeft+ancestor.clientWidth+1)) return false;
        if (/hidden|clip|auto|scroll/.test(style.overflowY) && (rect.top < clipTop-1 || rect.bottom > clipTop+ancestor.clientHeight+1)) return false;
      }
      return true;
    }
    function fallback() {
      let strip=root.getElementById('awp-mobile-launcher');
      if (!strip) {
        strip=root.createElement('div'); strip.id='awp-mobile-launcher';
      }
      launcher.className='';
      launcher.style.cssText='display:inline-flex;align-items:center;justify-content:center;min-height:44px;max-width:100%;box-sizing:border-box;padding:0 10px;cursor:pointer;color:#9fc8ee;background:#203750;border:1px solid #3b638c;border-radius:5px;text-decoration:none;font:13px/1.5 Arial,sans-serif;white-space:normal;overflow-wrap:anywhere;';
      if (launcher.parentElement !== strip) strip.append(launcher);
      // On narrow screens, never put the extra link in Torn's header links.
      // Prefer a full-width strip above the cards, outside clipped ancestors.
      let safeList = fits(list);
      for (let ancestor=list?.parentElement; safeList && ancestor && ancestor !== root.body; ancestor=ancestor.parentElement) {
        const style = computedStyle(ancestor);
        if (/hidden|clip|auto|scroll/.test(style.overflowY)) safeList=false;
      }
      if (safeList) {
        strip.style.cssText='display:block;box-sizing:border-box;max-width:100%;margin:8px 0;clear:both;';
        if (strip.nextElementSibling !== list) list.before(strip);
        if (fits(launcher)) return true;
      }
      // Manual planning remains reachable while Torn mounts/replaces its cards.
      const height = viewport?.height || view?.innerHeight || root.documentElement.clientHeight;
      const top = (viewport?.offsetTop || 0) + Math.max(8,height-106);
      strip.style.cssText='display:block;position:fixed;left:'+(left+8)+'px;top:'+top+'px;max-width:'+Math.max(0,width-16)+'px;z-index:999989;';
      if (strip.parentElement !== root.body) root.body.append(strip);
      return true;
    }
    if (compact) return fallback();
    const warfare = [...root.querySelectorAll('#top-page-links-list a[href*="sid=factionWarfare"], a[href*="sid=factionWarfare"]')].find(fits);
    if (!warfare) return fallback();
    launcher.style.cssText='cursor:pointer;margin-inline:8px;white-space:nowrap;';
    const parent = warfare.parentElement;
    const style = computedStyle(warfare), parentStyle = computedStyle(parent);
    const reversed = /flex/.test(parentStyle.display) && parentStyle.flexDirection === 'row-reverse';
    // Torn's desktop links float right, so DOM order is reversed visually.
    const after = reversed || (!/flex|grid/.test(parentStyle.display) && style.cssFloat === 'right');
    const neighbour = after ? warfare.nextElementSibling : warfare.previousElementSibling;
    launcher.className = warfare.className.split(/\s+/).filter(c => !['last','view-wars'].includes(c)).join(' ');
    if (neighbour !== launcher) {
      if (after) warfare.after(launcher); else warfare.before(launcher);
    }
    // The original link can fit even when adding another link overflows it.
    if (!fits(launcher) || !fits(warfare)) return fallback();
    root.getElementById('awp-mobile-launcher')?.remove();
    return true;
  }
  async function createCompatibleStorage(env) {
    const cache = new Map();
    let native = null, queue = Promise.resolve();
    const api = {failed:false};
    if (env.pda && typeof env.pda.loadAll === 'function' && typeof env.pda.set === 'function') {
      let timeout;
      try {
        const data = await Promise.race([
          Promise.resolve().then(() => env.pda.loadAll()),
          new Promise((_,reject) => { timeout=setTimeout(() => reject(new Error('Storage timeout')),4000); })
        ]);
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid storage');
        for (const [key,value] of Object.entries(data)) cache.set(key,value);
        native = env.pda;
      } catch { /* Older PDA versions can use GM or local storage. */ }
      finally { clearTimeout(timeout); }
    }
    function nativeWrite(key,value) {
      queue = queue.then(() => native.set(key,value)).then(() => { api.failed=false; },() => { api.failed=true; });
      return queue;
    }
    api.get = (key,fallback) => {
      if (cache.has(key)) return cache.get(key);
      let value;
      try {
        if (typeof env.gmGet === 'function') {
          const result = env.gmGet(key,undefined);
          if (result && typeof result.then === 'function') result.catch(() => {});
          else value=result;
        }
      } catch {}
      if (value === undefined) {
        try { const raw=env.local?.getItem('awp-local:'+key); if (raw !== null && raw !== undefined) value=JSON.parse(raw); }
        catch {}
      }
      if (value === undefined) return fallback;
      cache.set(key,value);
      if (native) nativeWrite(key,value);
      return value;
    };
    api.set = (key,value) => {
      cache.set(key,value);
      if (native) return nativeWrite(key,value);
      if (typeof env.gmSet === 'function') {
        try {
          const result=env.gmSet(key,value);
          if (result && typeof result.then === 'function') {
            return result.then(() => {api.failed=false;},() => {
              try { if (!env.local) throw new Error('No storage'); env.local.setItem('awp-local:'+key,JSON.stringify(value)); api.failed=false; }
              catch {api.failed=true;}
            });
          }
          api.failed=false; return;
        } catch {}
      }
      try {
        if (!env.local) throw new Error('No persistent storage');
        env.local.setItem('awp-local:'+key,JSON.stringify(value)); api.failed=false;
      } catch (error) { api.failed=true; throw error; }
    };
    api.flush = () => queue;
    return api;
  }
  const core = { createCompatibleStorage, nextMatchmaking, bonusTotal, memberShare, placeLauncher, fraction, targetAt, finishAt, plan, number, elapsed, utcInput, parseUTC, readCard };
  if (typeof module !== 'undefined' && module.exports) { module.exports = core; return; }
  if (window.top !== window.self) return;
  const startupTag = '[Almanac War Planner v0.3.1]';
  console.info(startupTag, 'Starting');
  if (!document.body) await new Promise(resolve => document.addEventListener('DOMContentLoaded',resolve,{once:true}));
  if (document.getElementById('almanac-war-planner')) return;
  let localStore=null;
  try { localStore=window.localStorage; } catch {}
  const storage = await createCompatibleStorage({
    pda:typeof PDA_storage !== 'undefined' ? PDA_storage : null,
    gmGet:typeof GM_getValue === 'function' ? GM_getValue : null,
    gmSet:typeof GM_setValue === 'function' ? GM_setValue : null,
    local:localStore
  });
  // A second injection may have completed while storage was loading.
  if (document.getElementById('almanac-war-planner')) return;

  const host = document.createElement('div');
  host.id = 'almanac-war-planner';
  host.dataset.awpVersion = '0.3.1';
  host.dataset.awpStatus = 'starting';
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `<style>
    :host{all:initial;font:13px/1.5 Arial,sans-serif;color:#e5edf8;position:fixed;right:12px;bottom:58px;z-index:999990;color-scheme:dark}
    .preset-buttons,.bonus-buttons{display:flex;gap:5px;flex-wrap:wrap;margin:7px 0}.preset-buttons button,.bonus-buttons button{padding:5px 8px;font-size:11px}.bonus-buttons .remove{padding:5px}.bonus-row{display:inline-flex;gap:2px}#bonus-summary{font-size:11px;color:#a8bad0}
    *{box-sizing:border-box}button,input,select{font:inherit;color:inherit}button{cursor:pointer;background:#213b58;border:1px solid #46678d;border-radius:5px;padding:7px 11px}button:hover{background:#305274}button:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid #73b8ff;outline-offset:2px}
    #panel{width:440px;max-width:calc(100vw - 24px);max-height:calc(100vh - 110px);max-height:calc(var(--awp-vh,100dvh) - 24px);max-width:calc(var(--awp-vw,100vw) - 16px);overflow:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch;background:#111d2d;border:1px solid #3b638c;border-radius:10px;box-shadow:0 10px 40px #0009;margin-bottom:8px}#panel[hidden],[hidden]{display:none!important}
    header{position:sticky;top:0;z-index:1;cursor:grab;touch-action:none;user-select:none;display:flex;align-items:center;justify-content:space-between;padding:12px 15px;background:#203750}header.awp-dragging{cursor:grabbing}header strong{font-size:15px}#close{padding:1px 8px}main{padding:14px}.muted,small{color:#a8bad0}small{display:block;font-size:11px}p{margin:8px 0}#status{font-size:11px;color:#b2c9e2;margin-bottom:10px}
    label{display:block;margin:9px 0 3px;color:#bdcde0;font-size:12px}input,select{width:100%;min-width:0;background:#0b1420;border:1px solid #39536e;border-radius:5px;padding:7px}input:invalid{border-color:#e8a16c}.grid{display:grid;grid-template-columns:1fr 1fr;gap:9px}.card{background:#1b2d43;padding:10px;border-radius:6px;margin:8px 0;overflow-wrap:anywhere}.value{font-size:19px;color:#8ccaff;font-weight:bold}.warn{color:#ffcf91}table{width:100%;border-collapse:collapse;font-size:11px;margin-top:10px}th,td{text-align:right;padding:7px 4px;border-bottom:1px solid #30465f}th:first-child,td:first-child{text-align:left}th{color:#adbed1}details{margin-top:13px;border-top:1px solid #30465f;padding-top:10px}summary{cursor:pointer;color:#a8ccef}#toggle{float:right}#identity{font-weight:bold}a{color:#8ccaff}#manual-note{font-size:11px}
    @media (max-width:600px),(pointer:coarse) {
      header{min-height:48px;padding:8px 10px}
      #close{min-width:44px;min-height:44px;font-size:22px}
      input,select{font-size:16px;min-height:44px}
      button{min-height:44px}
      .bonus-buttons button,.preset-buttons button{min-height:44px;min-width:44px}
      main{padding:12px}summary{padding:8px 0;min-height:40px}
      #panel{margin-bottom:0}
    }
    @media (max-width:420px) {
      .grid{grid-template-columns:minmax(0,1fr)}
      th,td{padding:7px 3px;font-size:11px}
      header strong{font-size:14px}
    }
  </style>
  <section id="panel" hidden aria-label="Almanac War Planner">
    <header><strong>Almanac War Planner <small>v0.3.1 · All times TCT / UTC</small></strong><button id="close" aria-label="Close planner">×</button></header>
    <main><div id="identity"></div><div id="status"></div>
      <div id="planning">
        <label for="winner">Planned winner</label><select id="winner"></select>
        <div class="grid"><div><label for="percent">Loser % of ORIGINAL target</label><input id="percent" type="number" min="0" max="100" step="0.1"></div><div><label for="end">Planned finish (TCT)</label><input id="end" type="datetime-local" step="60"></div></div>
        <div class="preset-buttons"><button type="button" id="preset-12">12h before MM</button><button type="button" id="preset-6">6h before MM</button><small id="mm-label"></small></div>
        <label for="bonus-faction">Expected chain bonuses</label><select id="bonus-faction"></select>
        <div class="bonus-buttons">${[25,50,100].map(n => `<span class="bonus-row"><button type="button" id="bonus-${n}" title="Add one ${n}th bonus hit (+${BONUS_POINTS[n]} score)">+${n} <span id="count-${n}"></span></button><button type="button" class="remove" id="minus-${n}" aria-label="Remove one ${n}th bonus hit">−</button></span>`).join('')}<button type="button" id="clear-bonuses">Clear</button></div>
        <div id="bonus-summary"></div>
        <small>Each click adds one bonus hit on the war opponent: 25 = 20, 50 = 40, 100 = 80 score.</small>
        <div id="plan-results"></div>
      </div>
      <details id="settings"><summary>War inputs &amp; manual overrides</summary>
        <p id="detected" class="muted"></p>
        <label for="start">Exact start (TCT; blank = detected elapsed timer)</label><input id="start" type="datetime-local" step="1">
        <label for="base">Original target (blank = detected / reconstructed)</label><input id="base" type="number" min="1" step="any" placeholder="Automatic">
        <div class="grid"><div><label for="members-current" id="label-current">Current faction members</label><input id="members-current" type="number" min="1" step="1" placeholder="Automatic"></div><div><label for="members-opponent" id="label-opponent">Opponent members</label><input id="members-opponent" type="number" min="1" step="1" placeholder="Automatic"></div></div>
        <p id="manual-note" class="muted">Saved separately for each war. Member totals include everyone shown on the war card; override for your participating roster. Scheduled cards without a readable elapsed timer need a manual start.</p>
        <button id="reset">Reset this war&rsquo;s settings</button>
      </details>
    </main>
  </section>`;
  document.body.append(host);
  const launcher = document.createElement('a');
  launcher.id = 'almanac-war-planner-launcher';
  launcher.href = '#almanac-war-planner';
  launcher.setAttribute('role', 'button');
  launcher.setAttribute('aria-expanded', 'false');
  launcher.textContent = 'War Planner';
  launcher.style.cssText = 'cursor:pointer;margin-inline:8px;white-space:nowrap;';
  const $ = id => shadow.getElementById(id);
  // Detached rendering buffer used only by the inline Live war card.
  const liveResults = document.createElement('div');
  const fmt = value => Number.isFinite(value) ? value.toLocaleString('en-GB', { maximumFractionDigits: 2 }) : '—';
  const date = (value, seconds = true) => {
    if (!Number.isFinite(value)) return '—';
    const d = new Date(value);
    return ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getUTCDay()]
      + ', ' + d.toISOString().slice(11, seconds ? 19 : 16) + ' TCT';
  };
  const esc = text => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let key = '', state = {}, card = null, autoStart = null, autoBase = null, reconstructed = false;
  let lastPageRead = 0;
  let lastTimer = null, lastTimerChange = 0, open = false, storageProblem = false;
  const fields = ['percent', 'end', 'start', 'base', 'members-current', 'members-opponent', 'winner', 'bonus-faction'];
  function defaultEnd() { return utcInput(nextMatchmaking(Date.now())).slice(0, 16); }
  function save() {
    try { storage.set(key, JSON.stringify(state)); } catch { storageProblem = true; }
  }
  function load(newKey) {
    key = newKey;
    try { state = JSON.parse(storage.get(key, '{}')); if (!state || typeof state !== 'object' || Array.isArray(state)) state = {}; }
    catch { state = {}; storageProblem = true; }
    autoStart = autoBase = lastTimer = null; reconstructed = false; lastTimerChange = Date.now();
    if (state.percent === undefined) state.percent = '40';
    if (!state.end) state.end = defaultEnd();
    for (const f of fields) if (f !== 'winner' && f !== 'bonus-faction') $(f).value = state[f] ?? '';
  }
  function populateWinner() {
    const choices = card && !card.error ? [card.current, card.opponent] : [{id:'current',name:'Current faction'},{id:'opponent',name:'Opponent'}];
    const signature = choices.map(c => c.id + ':' + c.name).join('|');
    if ($('winner').dataset.signature !== signature) {
      $('winner').replaceChildren(...choices.map(c => { const o = document.createElement('option'); o.value = c.id; o.textContent = c.name; return o; }));
      $('winner').dataset.signature = signature;
    }
    if (!choices.some(c => c.id === state.winner)) state.winner = choices[0].id;
    $('winner').value = state.winner;
    if ($('bonus-faction').dataset.signature !== signature) {
      $('bonus-faction').replaceChildren(...choices.map(c => { const o = document.createElement('option'); o.value = c.id; o.textContent = c.name; return o; }));
      $('bonus-faction').dataset.signature = signature;
    }
    if (!choices.some(c => c.id === state['bonus-faction'])) state['bonus-faction'] = state.winner;
    $('bonus-faction').value = state['bonus-faction'];
  }
  function inputs() {
    const override = (field, fallback) => $(field).value === '' ? fallback : number($(field).value);
    const start = $('start').value ? parseUTC($('start').value) : autoStart;
    return { start, base: override('base', autoBase), percent: number($('percent').value), end: parseUTC($('end').value),
      cm: override('members-current', card?.current?.members), om: override('members-opponent', card?.opponent?.members) };
  }
  function valid(v) { return Number.isFinite(v.start) && v.base > 0; }
  function countsFor(id) {
    const counts = state.bonuses?.[id];
    return counts && typeof counts === 'object' && !Array.isArray(counts) ? counts : {};
  }
  function renderBonuses(v) {
    const counts = countsFor(state['bonus-faction']);
    for (const n of [25,50,100]) {
      const count = Number.isSafeInteger(counts[n]) && counts[n] > 0 ? counts[n] : 0;
      $('count-'+n).textContent = count ? '×'+count : '';
      $('minus-'+n).disabled = count === 0;
    }
    const total = bonusTotal(counts);
    const members = state['bonus-faction'] === (card?.current?.id || 'current') ? v.cm : v.om;
    $('bonus-summary').textContent = `${fmt(total)} planned bonus score${members > 0 && Number.isInteger(members) ? ' · '+fmt(total/members)+' less score per member' : ''}`;
  }
  function render() {
    const v = inputs(), detected = card && !card.error;
    const mm = nextMatchmaking(Number.isFinite(v.start) ? v.start : Date.now());
    $('mm-label').textContent = 'MM: '+date(mm,false);
    renderBonuses(v);
    $('identity').textContent = detected ? `${card.current.name} vs ${card.opponent.name} · #${card.id}` : 'Manual war planner';
    const stale = detected && Date.now() - lastTimerChange > 90000;
    $('status').textContent = (detected ? `Read from page · ${new Date(lastPageRead || Date.now()).toISOString().slice(11,19)} TCT${stale ? ' · Timer has stopped; refresh Torn to verify live data.' : ''}` : card?.error || 'Waiting for war card.') + (storageProblem || storage.failed ? ' Settings could not be saved.' : '');
    $('detected').textContent = `Start: ${date(autoStart)}${autoStart !== null ? (card?.scheduled ? ' (from start countdown)' : ' (estimated from timer)') : ''}. Original target: ${fmt(autoBase)}${reconstructed ? ' (reconstructed from decayed target; enter exact value if known)' : ''}. Page target: ${fmt(card?.target)}.`;
    $('label-current').textContent = (card?.current?.name || 'Current faction') + ' members';
    $('label-opponent').textContent = (card?.opponent?.name || 'Opponent') + ' members';
    const error = '<p class="warn">Enter the original target and war start under War inputs, or open a live ranked-war card.</p>';
    if (!valid(v)) { $('plan-results').innerHTML = error; liveResults.innerHTML = error; return; }
    const p = v.percent !== null ? plan(v.base, v.start, v.end, v.percent) : null;
    if (!p) $('plan-results').innerHTML = '<p class="warn">Choose a finish between the start and 123 hours later, and a loser percentage from 0 to 100.</p>';
    else {
      const currentWins = state.winner === (card?.current?.id || 'current');
      const wm = currentWins ? v.cm : v.om, lm = currentWins ? v.om : v.cm;
      const winnerName = currentWins ? card?.current?.name : card?.opponent?.name;
      const winnerId = currentWins ? (card?.current?.id || 'current') : (card?.opponent?.id || 'opponent');
      const loserId = currentWins ? (card?.opponent?.id || 'opponent') : (card?.current?.id || 'current');
      const wb = bonusTotal(countsFor(winnerId)), lb = bonusTotal(countsFor(loserId));
      const rows = [['Chosen time',v.end],['12h before MM',mm-12*HOUR],['6h before MM',mm-6*HOUR]].map(([label,t]) => {
        const row = plan(v.base, v.start, t, v.percent);
        return `<tr><td>${label}<small>${esc(date(t,false))}</small></td><td>${row ? fmt(row.target) : '—'}</td><td>${row ? fmt(row.winner) : '—'}</td></tr>`;
      }).join('');
      const ws = currentWins ? card?.current?.score : card?.opponent?.score;
      const ls = currentWins ? card?.opponent?.score : card?.current?.score;
      const remaining = detected ? `<p class="muted">Remaining to plan: winner ${fmt(Math.max(0,p.winner-ws))} · loser ${fmt(Math.max(0,p.loser-ls))}.</p>${ws > p.winner || ls > p.loser ? '<p class="warn">A faction has already exceeded its planned score. These totals will not produce the chosen finish unless the scores are rebalanced.</p>' : ''}` : '';
      // PDA normalizes typographic quotes before parsing; use HTML entities in quoted HTML.
      $('plan-results').innerHTML = `<div class="card"><small>Required lead at chosen finish</small><div class="value">${fmt(p.target)}</div></div><div class="grid"><div class="card"><small>Winner score · ${esc(winnerName || 'Selected winner')}</small><div class="value">${fmt(p.winner)}</div><small>${fmt(memberShare(p.winner,wb,wm))} per member${wb ? ' · after bonuses' : ''}</small></div><div class="card"><small>Loser score · ${fmt(v.percent)}% of original target</small><div class="value">${fmt(p.loser)}</div><small>${fmt(memberShare(p.loser,lb,lm))} per member${lb ? ' · after bonuses' : ''}</small></div></div>${wb > p.winner || lb > p.loser ? '<p class="warn">Planned bonuses exceed a faction&rsquo;s total. Reduce the bonuses or adjust the plan.</p>' : ''}<table><thead><tr><th>Finish (TCT)</th><th>Lead</th><th>Winner total</th></tr></thead><tbody>${rows}</tbody></table>${remaining}${v.end-v.start <= 24*HOUR ? '<p class="warn">The target is unchanged during the first 24h. Scoring must be timed to the chosen finish; decay cannot select an exact time.</p>' : ''}${v.end < Date.now() ? '<p class="warn">The chosen finish is in the past.</p>' : ''}`;
    }
    if (detected && card.scheduled) {
      const remaining = Math.max(0, v.start-Date.now());
      liveResults.innerHTML = `<div class="card"><small>War starts</small><div class="value">${esc(date(v.start))}</div><small data-awp-countdown>${Math.floor(remaining/HOUR)}h ${Math.floor(remaining/60000)%60}m ${Math.floor(remaining/1000)%60}s until start</small></div>`;
      return;
    }
    if (!detected || !card.active) { liveResults.innerHTML = '<p class="warn">Live estimates need an active ranked-war card. You can still use the planner.</p>'; return; }
    const lead = card.current.score - card.opponent.score;
    const end = finishAt(v.base, v.start, Math.abs(lead));
    const currentTarget = targetAt(v.base, v.start, Date.now());
    let forecast = lead === 0 ? 'Scores tied — no decay-only winner forecast.' : end === null ? 'Beyond the 123-hour forecast range — no reliable finish estimate.' : end <= Date.now() ? 'Calculated threshold reached — check Torn for the confirmed result.' : date(end);
    const remainingMs = end !== null ? Math.max(0,end-Date.now()) : null;
    const countdown = remainingMs !== null && end > Date.now() ? `${Math.floor(remainingMs/HOUR)}h ${Math.floor(remainingMs/60000)%60}m ${Math.floor(remainingMs/1000)%60}s remaining` : '';
    liveResults.innerHTML = `<div class="card"><small>Estimated finish · if scoring stops</small><div class="value" style="font-size:16px">${esc(forecast)}</div><small data-awp-countdown>${esc(countdown)}</small>${stale || document.hidden ? '<small class="warn">Last known scores</small>' : ''}</div>${currentTarget !== null && Math.abs(currentTarget-card.target) > Math.max(2,v.base/100/12) ? '<p class="warn">Check the start time and original target in War inputs.</p>' : ''}`;
  }
  function initInlineWarCard() {
  const style = document.createElement('style');
  style.id = 'almanac-war-inline-style';
  style.textContent = `
    .awp-war-layout {
      display:flex!important; flex-wrap:wrap!important;
      align-items:flex-start!important; row-gap:0!important;
      column-gap:var(--awp-card-gap,10px)!important;
      height:auto!important;
    }
    .awp-war-layout > li {
      float:none!important; clear:none!important;
      flex:0 0 auto!important;
      margin-left:0!important; margin-right:0!important;
      max-width:100%; box-sizing:border-box;
    }
    .awp-war-layout > li.descriptions {
      flex:0 0 100%!important; width:100%!important;
    }
    .awp-war-layout > li.clear,
    .awp-war-layout > li.inactive:empty { display:none!important; }
    #almanac-war-live-card {
      padding:0!important; border:0!important;
      background:transparent!important; position:relative;
      list-style:none!important; overflow:visible!important;
    }
  `;
  document.head.append(style);
  const item = document.createElement('li');
  item.id = 'almanac-war-live-card';
  const inner = document.createElement('div');
  inner.style.cssText = 'height:100%;width:100%;';
  item.append(inner);
  const sr = inner.attachShadow({mode:'open'});
  sr.innerHTML = `
    <style>
      :host{display:block;height:100%;font:12px/1.35 Arial,sans-serif;color:#ddd}
      *{box-sizing:border-box}
      .box{height:100%;min-height:0;overflow:hidden;border:0!important;
        border-radius:5px!important;background:#303030 linear-gradient(#3b3b3b,#292929);
        box-shadow:0 2px 5px #0006;display:flex;flex-direction:column}
      button{width:100%;border:0;border-bottom:1px solid #0003;
        background:linear-gradient(#414141,#333);color:#91b9df;text-align:left;padding:5px 9px;
        font:bold 12px Arial,sans-serif;cursor:pointer}
      button:hover{background:#ffffff14}
      button:focus-visible{outline:2px solid #aaa;outline-offset:-2px}
      .body{padding:4px 8px;flex:1;display:flex;flex-direction:column;
        justify-content:center;align-items:center;gap:4px;min-height:0;text-align:center}
      .finish{font-size:16px;font-weight:bold;color:#9fc8ee;overflow-wrap:anywhere}
      .finish.message{font-size:12px}
      .countdown{font-size:12px;font-weight:bold;color:#bfd4e8}
      .note{font-size:10px;color:#8fa7bd;padding:3px 7px;text-align:center;border-top:1px solid #0003}
    </style>
    <div class="box">
      <button type="button" title="Open war planner">Live war</button>
      <div class="body">
        <div class="finish"></div>
        <div class="countdown"></div>
      </div>
      <div class="note">If scoring stops</div>
    </div>`;
  sr.querySelector('button').onclick = event => {
    event.preventDefault();
    event.stopPropagation();
    setOpen(true);
  };
  const finishNode = sr.querySelector('.finish');
  const countdownNode = sr.querySelector('.countdown');
  const noteNode = sr.querySelector('.note');
  let lastList = null;
  function setText(node,text) {
    if (node.textContent !== text) node.textContent = text;
  }
  return function syncInline() {
    const list = card?.box?.closest('#faction_war_list_id');
    let warItem = card?.box;
    while (warItem && warItem.parentElement !== list) warItem = warItem.parentElement;
    if (!list || !warItem || card.error || !list.isConnected) {
      item.remove();
      if (lastList) lastList.classList.remove('awp-war-layout');
      lastList = null;
      return;
    }
    if (lastList && lastList !== list) lastList.classList.remove('awp-war-layout');
    lastList = list;
    if (!list.classList.contains('awp-war-layout')) {
      // Convert Torn's horizontal item margins to a flex gap. Gaps disappear
      // at row edges, so a wrapped card starts flush with the first column.
      const nativeCards = [...list.children].filter(el =>
        el !== item && !el.matches('.inactive,.clear,.descriptions'));
      const margins = nativeCards.map(el => getComputedStyle(el));
      const left = Math.max(0,...margins.map(cs => parseFloat(cs.marginLeft)||0));
      const right = Math.max(0,...margins.map(cs => parseFloat(cs.marginRight)||0));
      list.style.setProperty('--awp-card-gap',(left+right || 10)+'px');
      list.classList.add('awp-war-layout');
    }
    // Own item follows the RW item; real Torn cards are never replaced.
    if (warItem.nextElementSibling !== item) warItem.after(item);
    const nativeItemStyle = getComputedStyle(warItem);
    for (const property of ['marginTop','marginBottom']) {
      const value = nativeItemStyle[property];
      if (value && item.style[property] !== value) item.style[property] = value;
    }
    const width = warItem.getBoundingClientRect().width;
    const height = warItem.getBoundingClientRect().height;
    const nextWidth = (width || 254) + 'px';
    const nextHeight = (height || card.box.getBoundingClientRect().height || 110) + 'px';
    if (item.style.width !== nextWidth) item.style.width = nextWidth;
    if (item.style.height !== nextHeight) item.style.height = nextHeight;
    // Read the neighbouring Torn card's actual theme, fonts and header height.
    const paint = (from,to,properties) => {
      if (!from) return;
      const computed = getComputedStyle(from);
      for (const property of properties) {
        const value = computed[property];
        if (property === 'backgroundColor' && (value === 'transparent' || value === 'rgba(0, 0, 0, 0)')) continue;
        if (value && to.style[property] !== value) to.style[property] = value;
      }
    };
    const title = card.box.querySelector('[class*="titleBlock___"]');
    const stats = card.box.querySelector('[class*="statsBox___"]');
    const bottom = card.box.querySelector('[class*="bottomBox___"]');
    const timer = card.box.querySelector('[class*="timer___"]');
    paint(card.box,sr.querySelector('.box'),['backgroundColor','backgroundImage','backgroundSize','backgroundPosition','fontFamily','color']);
    paint(title,sr.querySelector('button'),['backgroundColor','backgroundImage','backgroundSize','backgroundPosition','fontFamily','fontSize','fontWeight','textShadow']);
    paint(stats,sr.querySelector('.body'),['backgroundColor','backgroundImage','backgroundSize','backgroundPosition']);
    paint(bottom,noteNode,['backgroundColor','backgroundImage','backgroundSize','backgroundPosition','textShadow']);
    paint(timer,finishNode,['fontFamily','textShadow']);
    paint(timer,countdownNode,['fontFamily','fontSize','textShadow']);
    const headerHeight = title?.getBoundingClientRect().height;
    if (headerHeight > 0 && headerHeight < height) {
      const button = sr.querySelector('button');
      button.style.height = headerHeight+'px';
      button.style.flex = '0 0 '+headerHeight+'px';
      button.style.padding = '0 8px';
    }
    setText(sr.querySelector('button'),card.scheduled ? 'Upcoming ranked war' : 'Live war');
    const results = liveResults;
    const finish = results.querySelector('.value');
    const countdown = results.querySelector('[data-awp-countdown]');
    const message = results.querySelector('.warn');
    setText(finishNode, finish?.textContent || message?.textContent || 'Waiting for war data');
    setText(countdownNode, countdown?.textContent || '');
    const stale = document.hidden || Date.now()-lastTimerChange > 90000;
    setText(noteNode, card.scheduled ? 'Torn City Time' : stale ? 'If scoring stops · last known scores' : 'If scoring stops');
    finishNode.classList.toggle('message', !finish || !countdown?.textContent);
  };
}
  function scan() {
    placeLauncher(document, launcher, el => getComputedStyle(el));
    card = readCard(document);
    lastPageRead = Date.now();
    // Never reuse another war's settings or inferred target/start.
    const factionId = new URL(location.href).searchParams.get('ID') || 'own';
    const newKey = 'almanac-war-planner:v1:' + (card.error ? 'manual:'+factionId : card.id+':'+card.current.id);
    if (newKey !== key) load(newKey);
    if (!card.error) {
      if (card.duration !== lastTimer) { lastTimer = card.duration; lastTimerChange = Date.now(); }
      if (card.start !== null && (autoStart === null || state._wasScheduled !== card.scheduled)) { autoStart = card.start; autoBase = null; }
      state._wasScheduled = card.scheduled;
      const referenceStart = $('start').value ? parseUTC($('start').value) : autoStart;
      if (Number.isFinite(referenceStart) && autoBase === null) {
        const h = (Date.now()-referenceStart)/HOUR;
        if (card.scheduled && h < 0) { autoBase = card.target; reconstructed = false; }
        else if (h >= 0 && h <= 123) { autoBase = card.target / fraction(h); reconstructed = h > 24; }
      }
    }
    populateWinner();
    render();
    syncInlineCard();
  }
  function setOpen(value) {
    if (!value) windowPosition.stop();
    open=value; $('panel').hidden=!value;
    launcher.setAttribute('aria-expanded',String(value));
    if(value) { safeScan(true); windowPosition.restore(); }
  }
  function enableWindowDragging() {
    const positionKey = 'almanac-war-planner:window-position:v1';
    const header = shadow.querySelector('header');
    const panel = $('panel');
    let position = null, drag = null;
    try {
      const saved = JSON.parse(storage.get(positionKey, 'null'));
      if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) position = saved;
    } catch { /* Use the default bottom-right position. */ }
    function persist() {
      if (!position) return;
      try { storage.set(positionKey, JSON.stringify(position)); }
      catch { storageProblem = true; }
    }
    function viewport() {
      const vv=window.visualViewport;
      return {width:vv?.width || document.documentElement.clientWidth || window.innerWidth,
        height:vv?.height || window.innerHeight || document.documentElement.clientHeight,
        left:vv?.offsetLeft || 0, top:vv?.offsetTop || 0};
    }
    function fitViewport() {
      const view=viewport();
      host.style.setProperty('--awp-vw',view.width+'px');
      host.style.setProperty('--awp-vh',view.height+'px');
      return view;
    }
    function place(x,y) {
      const view=fitViewport();
      const rect = panel.getBoundingClientRect();
      const width = view.width, height=view.height;
      const padding = 8;
      position = {
        x: Math.round(Math.max(view.left+padding,Math.min(x,Math.max(view.left+padding,view.left+width-rect.width-padding)))),
        y: Math.round(Math.max(view.top+padding,Math.min(y,Math.max(view.top+padding,view.top+height-rect.height-padding))))
      };
      host.style.left = position.x+'px';
      host.style.top = position.y+'px';
      host.style.right = 'auto';
      host.style.bottom = 'auto';
    }
    function restore() {
      const view=fitViewport();
      if (panel.hidden) return;
      if (position) place(position.x,position.y);
      else if (view.width <= 600 || window.matchMedia?.('(pointer:coarse)').matches) {
        const rect=panel.getBoundingClientRect();
        place(view.left+(view.width-rect.width)/2,view.top+8);
      } else {
        const rect=panel.getBoundingClientRect();
        if (rect.left < view.left+8 || rect.top < view.top+8 || rect.right > view.left+view.width-8 || rect.bottom > view.top+view.height-8) {
          place(rect.left,rect.top);
        }
      }
    }
    function stop() {
      if (!drag) return;
      const id = drag.id;
      drag = null;
      header.classList.remove('awp-dragging');
      try { if (header.hasPointerCapture?.(id)) header.releasePointerCapture(id); } catch {}
      persist();
    }
    header.addEventListener('pointerdown', event => {
      if (event.button !== 0 || event.isPrimary === false || drag) return;
      if (event.target.closest?.('button,a,input,select,textarea')) return;
      const rect = host.getBoundingClientRect();
      drag = {id:event.pointerId, offsetX:event.clientX-rect.left, offsetY:event.clientY-rect.top};
      place(rect.left,rect.top);
      header.classList.add('awp-dragging');
      try { header.setPointerCapture(event.pointerId); } catch {}
      event.preventDefault();
    });
    document.addEventListener('pointermove', event => {
      if (!drag || event.pointerId !== drag.id) return;
      place(event.clientX-drag.offsetX,event.clientY-drag.offsetY);
      if (event.cancelable) event.preventDefault();
    }, {capture:true,passive:false});
    const end = event => { if (drag && event.pointerId === drag.id) stop(); };
    document.addEventListener('pointerup',end,true);
    document.addEventListener('pointercancel',end,true);
    header.addEventListener('lostpointercapture',end);
    if (!('PointerEvent' in window)) {
      header.addEventListener('touchstart',event => {
        if (event.touches.length !== 1 || event.target.closest?.('button,a,input,select,textarea')) return;
        const touch=event.changedTouches[0], rect=host.getBoundingClientRect();
        drag={id:touch.identifier,offsetX:touch.clientX-rect.left,offsetY:touch.clientY-rect.top,touch:true};
        place(rect.left,rect.top); header.classList.add('awp-dragging');
        if (event.cancelable) event.preventDefault();
      },{passive:false});
      document.addEventListener('touchmove',event => {
        if (!drag?.touch) return;
        const touch=[...event.changedTouches].find(t=>t.identifier===drag.id);
        if (!touch) return;
        place(touch.clientX-drag.offsetX,touch.clientY-drag.offsetY);
        if (event.cancelable) event.preventDefault();
      },{capture:true,passive:false});
      const touchEnd=event=>{if(drag?.touch && [...event.changedTouches].some(t=>t.identifier===drag.id))stop();};
      document.addEventListener('touchend',touchEnd,true);
      document.addEventListener('touchcancel',touchEnd,true);
    }
    window.addEventListener('blur',stop);
    window.addEventListener('resize',() => { restore(); if (!panel.hidden) persist(); });
    window.addEventListener('orientationchange',() => setTimeout(restore,100));
    window.visualViewport?.addEventListener('resize',restore);
    window.visualViewport?.addEventListener('scroll',restore);
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(restore);
      observer.observe(panel);
    }
    return {restore,stop};
  }
  const windowPosition = enableWindowDragging();
  launcher.onclick = event => { event.preventDefault(); setOpen(!open); };
  launcher.addEventListener('keydown', event => { if (event.key === ' ') { event.preventDefault(); setOpen(!open); } });
  $('close').onclick = () => setOpen(false);
  shadow.addEventListener('keydown', event => { if(event.key==='Escape') setOpen(false); });
  for (const field of fields) $(field).addEventListener('input', () => {
    state[field]=$(field).value; save();
    if(field==='start') { autoBase=null; safeScan(); } else render();
  });
  for (const hours of [12,6]) $('preset-'+hours).onclick = () => {
    const start = inputs().start;
    const mm = nextMatchmaking(Number.isFinite(start) ? start : Date.now());
    state.end = utcInput(mm-hours*HOUR).slice(0,16);
    $('end').value = state.end; save(); render();
  };
  function changeBonus(n, delta) {
    const id = state['bonus-faction'];
    if (!state.bonuses || typeof state.bonuses !== 'object' || Array.isArray(state.bonuses)) state.bonuses = {};
    const counts = { ...countsFor(id) };
    const previous = Number.isSafeInteger(counts[n]) && counts[n] > 0 ? counts[n] : 0;
    counts[n] = Math.max(0, Math.min(10000, previous+delta));
    state.bonuses[id] = counts; save(); render();
  }
  for (const n of [25,50,100]) {
    $('bonus-'+n).onclick = () => changeBonus(n,1);
    $('minus-'+n).onclick = () => changeBonus(n,-1);
  }
  $('clear-bonuses').onclick = () => {
    if (state.bonuses && typeof state.bonuses === 'object') delete state.bonuses[state['bonus-faction']];
    save(); render();
  };
  $('reset').onclick = () => { state={}; save(); const oldKey=key; key=''; load(oldKey); safeScan(); };
  const syncInlineCard = initInlineWarCard();
  let lastScanError = '';
  function safeScan(force = false) {
    try {
      if (!force && document.hidden) { render(); syncInlineCard(); } else scan();
      host.dataset.awpStatus = 'ready';
      lastScanError = '';
    } catch (error) {
      host.dataset.awpStatus = 'error';
      $('status').textContent = 'Page data could not be read. Retrying; open War inputs for manual planning.';
      const message = String(error?.message || error);
      if (message !== lastScanError) console.error(startupTag, 'Page update failed:', error);
      lastScanError = message;
    }
  }
  let mountPending = false;
  const ownIds = new Set(['almanac-war-planner','almanac-war-planner-launcher','awp-mobile-launcher','almanac-war-live-card']);
  const mountObserver = new MutationObserver(records => {
    // Moving our own launcher/cards must not schedule another mount endlessly.
    if (!records.some(record => [...record.addedNodes,...record.removedNodes].some(node => !ownIds.has(node.id)))) return;
    if (mountPending) return;
    mountPending = true;
    setTimeout(() => {
      mountPending = false;
      if (!document.hidden) safeScan();
    }, 250);
  });
  mountObserver.observe(document.body, { childList: true, subtree: true });
  setInterval(safeScan, 1000);
  document.addEventListener('visibilitychange', () => { if(!document.hidden) safeScan(); });
  safeScan(true);
  console.info(startupTag, 'Mounted; storage failures are reported in the planner status.');
})().catch(error => {
  console.error('[Almanac War Planner v0.3.1]', 'Startup failed:', error);
  const root = document.body || document.documentElement;
  if (!root || document.getElementById('awp-startup-error')) return;
  const note = document.createElement('div');
  note.id = 'awp-startup-error';
  note.setAttribute('role','alert');
  note.textContent = 'War Planner could not start: ' + String(error?.message || error);
  note.style.cssText = 'position:fixed;left:8px;right:8px;bottom:58px;z-index:999991;padding:10px;border:1px solid #3b638c;border-radius:5px;background:#111d2d;color:#ffcf91;font:13px/1.5 Arial,sans-serif;';
  root.append(note);
});
