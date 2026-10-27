// Rosso dashboard: renders /api/state. Read-only; refreshes every minute.
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const MINUS = '−';

  const usdF = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const usd = (v) => (v < 0 ? MINUS : '') + usdF.format(Math.abs(v));
  const signedUsd = (v) => (v > 0 ? '+' : v < 0 ? MINUS : '') + usdF.format(Math.abs(v));
  const pct = (v, d = 1) => (v < 0 ? MINUS : '') + (Math.abs(v) * 100).toFixed(d) + '%';
  const signedPct = (v, d = 2) => (v > 0 ? '+' : v < 0 ? MINUS : '') + (Math.abs(v) * 100).toFixed(d) + '%';
  const int = (v) => new Intl.NumberFormat('en-US').format(v);

  const romeParts = (iso, opts) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Rome', ...opts }).format(new Date(iso));
  const romeTime = (iso) => romeParts(iso, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const romeDay = (iso) => romeParts(iso, { weekday: 'short', day: 'numeric', month: 'short' });
  const nyTime = (iso) => new Intl.DateTimeFormat('en-GB', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
  const minutesOf = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
  const dur = (min) => { min = Math.round(Math.abs(min)); const h = Math.floor(min / 60), m = min % 60; return h ? (m ? `${h} h ${m} min` : `${h} h`) : `${m} min`; };
  const runLabel = (runId) => `${runId.slice(11, 13)}:${runId.slice(13, 15)}`;
  const runDay = (runId) => romeDay(`${runId.slice(0, 10)}T12:00:00Z`);
  const NAMES = { briefing: 'Briefing', opening: 'Opening', 'mid-session': 'Mid-session', closing: 'Closing' };
  const STATUS = { done: 'ran', running: 'running now', due: 'due now', missed: 'missed', upcoming: 'later today', skipped: 'skipped, a later run ran', off: 'no run (weekend)' };
  const firstSentences = (text, n) => { const parts = String(text).match(/[^.!?]+[.!?]+(\s|$)/g); return parts ? parts.slice(0, n).join('').trim() : String(text).trim(); };

  let state = null;
  let lastGood = null;

  // ---------- the session in words, relative to the US open and close ----------
  function vsMarket(slot, day) {
    const t = minutesOf(slot.rome), open = minutesOf(day.market.openRome), close = minutesOf(day.market.closeRome);
    if (t < open) return `${dur(open - t)} before the US open`;
    if (t > close) return `${dur(t - close)} after the US close`;
    if (close - t <= 60) return `${dur(close - t)} before the US close`;
    return `${dur(t - open)} after the US open`;
  }

  // ---------- title row ----------
  const view = () => (location.hash === '#runs' ? 'runs' : 'overview');
  function renderTitle(s) {
    const crumb = s.fake ? 'Rosso · fake broker (test data)' : 'Rosso · Alpaca paper account';
    $$('[data-crumb]').forEach((el) => (el.textContent = crumb));
    if (view() === 'runs') {
      const first = s.runs[0];
      $('[data-title]').textContent = 'Runs';
      $('[data-finding]').textContent = first ? `${s.runs.length} runs since ${runDay(first.runId)}, ${runLabel(first.runId)}. Equity is read from each run's own record.` : 'No run has finished yet.';
      return;
    }
    $('[data-title]').textContent = `Today, ${romeDay(s.now)}`;
    const parts = [];
    const last = s.runs[s.runs.length - 1];
    if (s.lock.state === 'held') parts.push(`<b>Run ${esc(s.lock.runId)} is in progress</b>, started ${esc(romeTime(s.lock.startedAt))}.`);
    else if (s.lock.state === 'unreadable') parts.push('<b>The run lock is unreadable</b>; the next run will reconcile with Alpaca.');
    if (s.missed.length) parts.push(`<b>${s.missed.length} scheduled run${s.missed.length > 1 ? 's' : ''} missed</b> since ${esc(last ? last.runId : 'the last run')}.`);
    const n = s.next;
    const sameDay = n.runId.slice(0, 10) === s.day.date;
    parts.push(`Next: <b>${esc(NAMES[n.name].toLowerCase())} at ${esc(n.rome)}</b>${sameDay ? '' : ` on ${esc(runDay(n.runId))}`} (${esc(n.newYork)} New York)${sameDay ? `, ${esc(vsMarket(n, s.day))}` : ''}.`);
    if (last) {
      const did = last.sent ? `sent ${last.sent} order${last.sent > 1 ? 's' : ''}` : 'sent no orders';
      parts.push(`The last run, ${esc(NAMES[last.slotName].toLowerCase())} ${esc(last.runId)}, ${did}${last.rejected ? ` and had ${last.rejected} rejected` : ''}.`);
    }
    $('[data-finding]').innerHTML = parts.join(' ');
  }

  function renderStamp(s, failed) {
    const text = failed ? `Couldn't refresh. Last updated ${romeTime(s.now)}` : `Updated ${romeTime(s.now)}`;
    $$('[data-stamp]').forEach((el) => (el.textContent = text));
  }

  // ---------- the day strip ----------
  const FROM = 7 * 60, TO = 23 * 60;
  const at = (min) => `${((min - FROM) / (TO - FROM)) * 100}%`;
  function renderStrip(s) {
    const d = s.day, el = $('[data-strip]');
    const open = minutesOf(d.market.openRome), close = minutesOf(d.market.closeRome);
    const shifted = d.market.openRome !== '15:30';
    let html = `<div class="band" style="left:${at(open)};width:calc(${at(close)} - ${at(open)})"></div><div class="axis"></div>`;
    for (let h = 7; h <= 23; h += 2) {
      const cls = h === 7 ? 'tick first' : h === 23 ? 'tick last' : 'tick';
      html += `<span class="${cls}" style="left:${at(h * 60)}">${String(h).padStart(2, '0')}:00</span>`;
    }
    for (const r of d.slots) {
      const m = minutesOf(r.rome);
      const isNext = r.runId === s.next.runId;
      html += `<div class="run ${r.status}${isNext ? ' next' : ''}${m - FROM < 60 ? ' edge-l' : ''}" style="left:${at(m)}"><div class="lab"><b>${esc(r.rome)}</b><span>${esc(NAMES[r.name])}</span><span>${esc(isNext ? 'next' : STATUS[r.status])}</span></div><i class="dot"></i></div>`;
    }
    const nowMin = minutesOf(romeTime(s.now));
    if (d.weekday && nowMin >= FROM && nowMin <= TO) {
      html += `<div class="now${nowMin - FROM < 120 ? ' flip' : ''}" style="left:${at(nowMin)}"><span>Now ${esc(romeTime(s.now))}</span></div>`;
    }
    el.innerHTML = html;
    el.setAttribute('aria-label', `Today's runs in Rome time: ${d.slots.map((r) => `${NAMES[r.name]} ${r.rome}, ${STATUS[r.status]}`).join('; ')}. US session ${d.market.openRome} to ${d.market.closeRome}.`);

    $('[data-strip-list]').innerHTML = d.slots.map((r) => `<li class="${r.status}${r.runId === s.next.runId ? ' next' : ''}"><i class="dot" aria-hidden="true"></i><div class="n">${esc(NAMES[r.name])}<span>${esc(r.runId === s.next.runId ? 'next' : STATUS[r.status])}</span></div><div class="t">${esc(r.rome)}<span>${esc(r.newYork)} New York</span></div></li>`).join('');

    const notes = [`<p class="caption">US session ${esc(d.market.openRome)} to ${esc(d.market.closeRome)} Rome, 09:30 to 16:00 New York${shifted ? '. An hour earlier than usual: Italy and the US change clocks on different dates' : ''}.</p>`];
    if (!d.weekday) notes.push(`<p class="notice warn">No runs on weekends. The next is ${esc(NAMES[s.next.name].toLowerCase())} on ${esc(runDay(s.next.runId))} at ${esc(s.next.rome)}.</p>`);
    if (s.missed.length) {
      const shown = s.missed.slice(0, 6).map((m) => `${NAMES[m.name]} ${m.rome.slice(5)}`).join(' · ');
      notes.push(`<p class="notice">Missed and not run late: ${esc(shown)}${s.missed.length > 6 ? ` and ${s.missed.length - 6} more` : ''}. Was the machine off, or is the scheduler stopped?</p>`);
    }
    $('[data-day-notices]').innerHTML = notes.join('');
  }

  // ---------- account ----------
  function kpi(label, value, delta, lead) {
    return `<div class="kpi${lead ? ' lead' : ''}"><div class="kpi-label">${label}</div><div class="kpi-value num">${value}</div><div class="delta">${delta || '&nbsp;'}</div></div>`;
  }
  function renderKpis(s) {
    const el = $('[data-kpis]');
    const b = s.broker;
    if (!b.ok) {
      const last = s.runs[s.runs.length - 1];
      const fallback = last
        ? kpi('Equity', usd(last.equity), `at the end of run ${esc(last.runId)}`, true) + kpi('Cash', usd(last.cash), 'same run') + kpi('Day P&amp;L', `<span class="dash">—</span>`, '') + kpi('Invested', `<span class="dash">—</span>`, '')
        : kpi('Equity', '<span class="dash">—</span>', '', true) + kpi('Cash', '<span class="dash">—</span>', '') + kpi('Day P&amp;L', '<span class="dash">—</span>', '') + kpi('Invested', '<span class="dash">—</span>', '');
      el.innerHTML = fallback + `<div class="kpi"><div class="kpi-label">Alpaca</div><div class="kpi-value error-line" style="font-size:13px;font-weight:400">Couldn't reach it</div><div class="delta"><button class="card-link" type="button" data-refresh>Retry</button></div></div>`;
      return;
    }
    const a = b.account;
    const pnl = +(a.equity - a.lastEquity).toFixed(2);
    const invested = b.positions.reduce((t, p) => t + p.marketValue, 0);
    const pnlClass = pnl < 0 ? 'down' : pnl > 0 ? 'up' : '';
    const pnlPct = a.lastEquity ? pnl / a.lastEquity : 0;
    const c = b.clock;
    const market = c.isOpen
      ? kpi('US market', 'Open', `closes ${esc(romeTime(c.nextClose))} Rome`)
      : kpi('US market', 'Closed', `opens ${esc(romeDay(c.nextOpen))}, ${esc(romeTime(c.nextOpen))} Rome`);
    el.innerHTML =
      kpi('Equity', usd(a.equity), `${usd(a.lastEquity)} at the last close`, true) +
      kpi('Cash', usd(a.cash), `${pct(a.equity ? a.cash / a.equity : 0)} of equity`) +
      kpi('Day P&amp;L', `<span class="${pnlClass}" style="${pnl < 0 ? 'color:var(--negative)' : ''}">${signedUsd(pnl)}</span>`, `${signedPct(pnlPct)} vs the last close`) +
      kpi('Invested', usd(invested), `${b.positions.length} of ${s.rules.maxTickers} tickers`) +
      market;
  }

  // ---------- positions ----------
  function renderPositions(s) {
    const el = $('[data-positions]'), meta = $('[data-pos-meta]');
    const r = s.rules;
    const limits = `Max ${r.maxTickers} tickers, ${pct(r.maxWeight, 0)} of equity each, sold automatically at ${pct(r.stopLoss, 0)} from cost`;
    meta.textContent = limits;
    if (!s.broker.ok) {
      el.innerHTML = `<p class="error-line">Couldn't load positions from Alpaca: ${esc(s.broker.error)}. <button class="card-link" type="button" data-refresh>Retry</button></p>`;
      return;
    }
    const ps = s.broker.positions;
    if (!ps.length) {
      el.innerHTML = `<p class="empty">No positions: the account is all cash. Rosso can buy from ${esc(r.universe.join(', '))}.</p>`;
      return;
    }
    const rows = ps.map((p) => {
      const toStop = p.fromCost - r.stopLoss;
      const near = toStop < 0.01;
      const w = Math.min(1, p.weight / r.maxWeight);
      return `<tr>
        <td><span class="sym">${esc(p.symbol)}</span></td>
        <td class="n">${int(p.qty)}</td>
        <td class="n hide-phone">${usd(p.avgEntryPrice)}</td>
        <td class="n hide-phone">${usd(p.currentPrice)}</td>
        <td class="n">${usd(p.marketValue)}</td>
        <td class="n"><span class="weight"><span class="track hide-phone" title="${pct(p.weight)} of the ${pct(r.maxWeight, 0)} cap"><span class="fill" style="width:${(w * 100).toFixed(1)}%"></span></span>${pct(p.weight)}</span></td>
        <td class="n${near ? ' near-stop' : ''}">${signedPct(p.fromCost)}<span class="sub">${near ? `${(toStop * 100).toFixed(1)} pts to the stop` : ''}</span></td>
      </tr>`;
    }).join('');
    el.innerHTML = `<div class="table-wrap"><table class="positions"><thead><tr><th>Ticker</th><th class="n">Shares</th><th class="n hide-phone">Avg cost</th><th class="n hide-phone">Last</th><th class="n">Value</th><th class="n">Weight<span class="hide-phone"> of equity</span></th><th class="n">From cost</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  // ---------- the decision ----------
  function decisionHtml(run, full) {
    const orders = [
      ...run.ordersSubmitted.map((o) => `<li><span><b>${esc(o.side === 'buy' ? 'Buy' : 'Sell')} ${int(o.qty)} ${esc(o.symbol)}</b></span><span class="muted">${esc(o.outcome)}</span><span class="why">${esc(o.why)}</span></li>`),
      ...run.ordersRejected.map((o) => `<li><span><b>${esc(o.side === 'buy' ? 'Buy' : 'Sell')} ${int(o.qty)} ${esc(o.symbol)}</b></span><span class="near-stop">rejected</span><span class="why">${esc(o.reason)}</span></li>`),
    ];
    const reasoning = full ? run.reasoning : firstSentences(run.reasoning, 3);
    const cut = !full && reasoning.length < run.reasoning.trim().length;
    return `<div class="decision">
      <div><h3>Why</h3><p>${esc(reasoning)}${cut ? ` <button class="card-link more" type="button" data-expand>Read all</button>` : ''}</p></div>
      <div><h3>For the next run</h3><p>${esc(full ? run.planNext : firstSentences(run.planNext, 2))}</p></div>
      <div><h3>Orders</h3>${orders.length ? `<ul class="orders">${orders.join('')}</ul>` : '<p class="muted">None: Rosso held.</p>'}</div>
      ${run.alerts.length ? `<div><h3>Alerts</h3>${run.alerts.map((a) => `<p class="notice warn">${esc(a)}</p>`).join('')}</div>` : ''}
    </div>`;
  }
  function renderDecision(s) {
    const el = $('[data-decision]'), meta = $('[data-dec-meta]');
    const last = s.runs[s.runs.length - 1];
    if (s.baton.state === 'corrupt') meta.textContent = `Baton corrupted (${s.baton.error})`;
    if (!last) {
      el.innerHTML = '<p class="empty">No run has finished yet. The first decision appears here after the next run.</p>';
      meta.textContent = '';
      return;
    }
    meta.textContent = `${NAMES[last.slotName]} ${last.runId} · finished ${romeDay(last.finishedAt)}, ${romeTime(last.finishedAt)}`;
    el.innerHTML = decisionHtml(last, false);
    const btn = $('[data-expand]', el);
    if (btn) btn.addEventListener('click', () => { el.innerHTML = decisionHtml(last, true); });
  }

  function renderRunList(s) {
    const list = s.runs.slice(-6).reverse();
    $('[data-runs-meta]').textContent = `${s.runs.length} in total`;
    $('[data-runlist]').innerHTML = list.length
      ? list.map((r) => `<li><span class="id">${esc(runDay(r.runId))} ${esc(runLabel(r.runId))}<small>${esc(NAMES[r.slotName])}${/\.\d+\.json$/.test(r.file) ? ', rerun' : ''}</small></span><span class="num">${usd(r.equity)}</span><span class="what">${r.sent ? `${r.sent} sent` : 'held'}${r.rejected ? ` · ${r.rejected} rejected` : ''}${r.alerts.length ? ` · ${r.alerts.length} alert${r.alerts.length > 1 ? 's' : ''}` : ''} · ${esc(firstSentences(r.reasoning, 1))}</span></li>`).join('')
      : '<li><p class="empty">No runs yet.</p></li>';
  }

  // ---------- runs view ----------
  function renderRunsView(s) {
    const runs = s.runs;

    const chart = $('[data-equity-chart]');
    chart.innerHTML = '';
    if (runs.length >= 2) {
      const eq = runs.map((r) => r.equity);
      const lo = Math.min(...eq), hi = Math.max(...eq), pad = Math.max((hi - lo) * 0.25, hi * 0.005);
      Charts.line(chart, {
        labels: runs.map((r) => `${r.runId.slice(8, 10)}/${r.runId.slice(5, 7)} ${runLabel(r.runId)}${/\.(\d+)\.json$/.test(r.file) ? ` #${r.file.match(/\.(\d+)\.json$/)[1]}` : ''}`),
        min: lo - pad, max: hi + pad,
        series: [{ name: 'Equity', values: runs.map((r) => r.equity) }],
        format: (v) => usd(v),
        tickFormat: (v) => '$' + new Intl.NumberFormat('en-US').format(v),
        height: 200,
      });
    } else {
      chart.innerHTML = '<p class="empty">The line starts after two runs.</p>';
    }

    const sent = runs.reduce((t, r) => t + r.sent, 0);
    const rejected = runs.reduce((t, r) => t + r.rejected, 0);
    const alerts = runs.reduce((t, r) => t + r.alerts.length, 0);
    const change = runs.length ? runs[runs.length - 1].equity - runs[0].equity : 0;
    $('[data-facts]').innerHTML = [
      ['Runs finished', int(runs.length)],
      ['Orders sent', int(sent)],
      ['Orders rejected by the rules', int(rejected)],
      ['Alerts', int(alerts)],
      ['Missed since the last run', int(s.missed.length)],
      ['Equity change', runs.length ? signedUsd(+change.toFixed(2)) : '—'],
    ].map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');

    const table = $('[data-runs-table]');
    const rows = runs.slice().reverse();
    table.innerHTML = `<thead><tr><th>Run</th><th class="hide-phone">Slot</th><th class="n hide-phone">Finished</th><th class="n">Sent</th><th class="n">Rejected</th><th class="n hide-phone">Alerts</th><th class="n">Equity</th></tr></thead><tbody>${
      rows.map((r, i) => `<tr data-i="${i}" tabindex="0" aria-expanded="false"><td><b>${esc(r.runId)}</b>${/\.\d+\.json$/.test(r.file) ? ' <span class="pill">rerun</span>' : ''}</td><td class="hide-phone">${esc(NAMES[r.slotName])}</td><td class="n hide-phone">${esc(romeDay(r.finishedAt))}, ${esc(romeTime(r.finishedAt))}</td><td class="n">${int(r.sent)}</td><td class="n">${int(r.rejected)}</td><td class="n hide-phone">${int(r.alerts.length)}</td><td class="n">${usd(r.equity)}</td></tr>`).join('')
    }</tbody>`;
    const toggle = (tr) => {
      const next = tr.nextElementSibling;
      if (next && next.classList.contains('detail')) { next.remove(); tr.setAttribute('aria-expanded', 'false'); return; }
      const d = document.createElement('tr');
      d.className = 'detail';
      d.innerHTML = `<td colspan="7">${decisionHtml(rows[+tr.dataset.i], true)}</td>`;
      tr.after(d);
      tr.setAttribute('aria-expanded', 'true');
    };
    $$('tbody tr[data-i]', table).forEach((tr) => {
      tr.addEventListener('click', () => toggle(tr));
      tr.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(tr); } });
    });
    if (!rows.length) table.innerHTML = '<tbody><tr><td><p class="empty">No runs yet.</p></td></tr></tbody>';

    const ordersEl = $('[data-orders]');
    if (!s.broker.ok) {
      ordersEl.innerHTML = `<p class="error-line">Couldn't load orders from Alpaca: ${esc(s.broker.error)}.</p>`;
      $('[data-orders-meta]').textContent = '';
    } else {
      const os = s.broker.orders;
      $('[data-orders-meta]').textContent = `${os.length} order${os.length === 1 ? '' : 's'}`;
      ordersEl.innerHTML = os.length
        ? `<table><thead><tr><th>Order id</th><th>Side</th><th>Ticker</th><th class="n">Shares</th><th class="n">Filled</th><th class="n hide-phone">Avg price</th><th class="n hide-phone">Status</th><th class="n">Sent</th></tr></thead><tbody>${
            os.map((o) => `<tr><td>${esc(o.clientOrderId)}</td><td>${esc(o.side === 'buy' ? 'Buy' : 'Sell')}</td><td><b>${esc(o.symbol)}</b></td><td class="n">${int(o.qty)}</td><td class="n">${int(o.filledQty)}</td><td class="n hide-phone">${o.filledAvgPrice == null ? '<span class="dash">—</span>' : usd(o.filledAvgPrice)}</td><td class="n hide-phone">${esc(o.status)}</td><td class="n">${esc(romeDay(o.submittedAt))}, ${esc(romeTime(o.submittedAt))}</td></tr>`).join('')
          }</tbody></table>`
        : '<p class="empty">No orders at Alpaca in the last 48 hours.</p>';
    }
  }

  // ---------- views ----------
  function route() {
    const v = view();
    $$('[data-view]').forEach((el) => (el.hidden = el.dataset.view !== v));
    $$('[data-nav]').forEach((a) => (a.dataset.nav === v ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
    document.title = v === 'runs' ? 'Rosso · Runs' : 'Rosso · Today';
    if (state) renderTitle(state);
  }

  function render(s, failed) {
    renderTitle(s);
    renderStamp(s, failed);
    renderStrip(s);
    renderKpis(s);
    renderPositions(s);
    renderDecision(s);
    renderRunList(s);
    renderRunsView(s);
  }

  async function load() {
    $$('[data-refresh]').forEach((b) => b.setAttribute('aria-busy', 'true'));
    try {
      const res = await fetch('/api/state', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      state = await res.json();
      lastGood = state;
      render(state, false);
    } catch {
      if (lastGood) renderStamp(lastGood, true);
      else $('[data-finding]').innerHTML = `<span class="error-line">Couldn't reach the dashboard server. Is <b>bun run dashboard</b> still running?</span>`;
    } finally {
      $$('[data-refresh]').forEach((b) => b.removeAttribute('aria-busy'));
    }
  }

  document.addEventListener('click', (e) => { if (e.target.closest('[data-refresh]')) load(); });
  window.addEventListener('hashchange', route);
  route();
  load();
  setInterval(load, 60_000);
})();
