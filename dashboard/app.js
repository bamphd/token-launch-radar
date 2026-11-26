// Radar-4's dashboard: a pure rendering of window.RADAR, the dataset main.ts writes
// beside dashboard/. The page makes no requests and derives nothing twice: the board,
// the model panel, the accounting, and the detail drawer all read the same shipped
// figures, so the page cannot disagree with board.json. One check proves the wiring:
// the drawer recomputes its row from the model value and the two factors exactly as the
// model did, and says whether the result is the number board.json carries.
//
// The state lives in the hash — search, category, verdict, sort, tab, the open
// protocol, the compare tray — so any view of the board is a link.
(function () {
  'use strict';

  var DATA = window.RADAR;
  var kpis = document.getElementById('kpis');
  if (!DATA || !DATA.rows) {
    if (kpis) kpis.textContent = 'No radar data loaded: data.js is missing or empty.';
    return;
  }

  var COMPARE_MAX = 3;
  var state = { q: '', category: '', verdict: '', sort: 'implied', tab: 'board', selected: null, compare: [] };
  var bySlug = {};
  DATA.rows.forEach(function (r) { bySlug[r.slug] = r; });

  // -- numbers ---------------------------------------------------------------
  var usdFull = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  function moneyShort(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    var mag = Math.abs(n);
    if (mag >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (mag >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
    if (mag >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
    return usdFull.format(n);
  }
  function moneyFull(n) { return n === null || n === undefined || !isFinite(n) ? 'n/a' : usdFull.format(n); }
  function pct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(1) + '%';
  }
  function ageLabel(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + ' yrs';
    return Math.round(days) + ' days';
  }
  function chainsLabel(chains, limit) {
    if (!chains || chains.length === 0) return 'an unnamed chain';
    return chains.slice(0, limit || 2).join(', ');
  }
  function err3(n) { return typeof n === 'number' ? n.toFixed(3) : 'n/a'; }

  // -- tiny DOM helper: tag('td', 'num', 'text') ------------------------------
  function tag(name, cls, text) {
    var node = document.createElement(name);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  // -- hash state -------------------------------------------------------------
  function readHash() {
    var params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    state.q = params.get('q') || '';
    state.category = params.get('category') || '';
    state.verdict = params.get('verdict') || '';
    state.sort = params.get('sort') || 'implied';
    state.tab = params.get('tab') === 'live' ? 'live' : 'board';
    state.selected = params.get('p') || null;
    state.compare = (params.get('c') || '').split(',').filter(function (s) { return !!bySlug[s]; }).slice(0, COMPARE_MAX);
  }
  function writeHash() {
    var params = new URLSearchParams();
    if (state.q) params.set('q', state.q);
    if (state.category) params.set('category', state.category);
    if (state.verdict) params.set('verdict', state.verdict);
    if (state.sort !== 'implied') params.set('sort', state.sort);
    if (state.tab === 'live') params.set('tab', 'live');
    if (state.selected) params.set('p', state.selected);
    if (state.compare.length) params.set('c', state.compare.join(','));
    var next = params.toString();
    window.history.replaceState(null, '', next ? '#' + next : window.location.pathname + window.location.search);
  }

  // -- filtering and sorting ---------------------------------------------------
  function visibleRows() {
    var q = state.q.trim().toLowerCase();
    return DATA.rows.filter(function (r) {
      if (state.category && (r.category || 'Uncategorized') !== state.category) return false;
      if (state.verdict && r.farm.verdict !== state.verdict) return false;
      if (!q) return true;
      var hay = [r.name, r.slug, r.category || '', (r.chains || []).join(' ')].join(' ').toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }
  function sortValue(row, key) {
    if (key === 'tvl') return row.tvl_usd;
    if (key === 'growth') return row.change_7d === null ? -Infinity : row.change_7d;
    if (key === 'age') return row.age_days === null ? -1 : row.age_days;
    if (key === 'efficiency') return row.farm.efficiency;
    return row.implied_value_usd;
  }
  function orderedRows(list) {
    return list.slice().sort(function (a, b) {
      var av = sortValue(a, state.sort);
      var bv = sortValue(b, state.sort);
      if (av !== bv) return bv - av;
      return a.slug < b.slug ? -1 : 1;
    });
  }

  // -- KPI strip ----------------------------------------------------------------
  function renderKpis() {
    var cov = DATA.coverage;
    var loo = DATA.validation.loo;
    var walk = DATA.validation.walk_forward;
    var tiles = [
      [cov.total + ' / ' + cov.total, 'protocols accounted for'],
      [String(cov.ranked), 'pre-token launches ranked'],
      [cov.watchlist_covered + ' / ' + cov.watchlist_size, 'watchlist covered'],
      [String(DATA.fit.comp_count), 'trading protocols fitted the model'],
      [err3(loo.final), 'leave-one-out error, vs ' + err3(loo.flat_median) + ' flat'],
      [err3(walk.final), 'walk-forward error, vs ' + err3(walk.flat) + ' flat'],
    ];
    kpis.textContent = '';
    tiles.forEach(function (t) {
      var tile = tag('div', 'kpi');
      tile.appendChild(tag('b', null, t[0]));
      tile.appendChild(tag('span', null, t[1]));
      kpis.appendChild(tile);
    });
  }

  // -- model panel ---------------------------------------------------------------
  function miniTable(headers, rows, winIndex) {
    var table = tag('table', 'mini');
    var head = tag('tr');
    headers.forEach(function (h) { head.appendChild(tag('th', null, h)); });
    table.appendChild(tag('thead')).appendChild(head);
    var body = tag('tbody');
    rows.forEach(function (cells, i) {
      var tr = tag('tr', i === winIndex ? 'win' : null);
      cells.forEach(function (c, j) { tr.appendChild(tag('td', j > 0 ? 'num' : null, c)); });
      body.appendChild(tr);
    });
    table.appendChild(body);
    return table;
  }

  function renderModel() {
    var panel = document.getElementById('model');
    var fit = DATA.fit;
    var val = DATA.validation;
    panel.appendChild(tag('h2', null, 'The fitted model, and the tests it passed'));
    panel.appendChild(tag('p', 'intro', 'The model is fitted to the snapshot\u2019s own trading protocols — each one votes with its market cap and its TVL — and then tested blind before it ranks anything. The tests below ran on this snapshot, in this run; the numbers are the model\u2019s own record, not a claim about it.'));
    var formula = tag('div', 'formula');
    var growthNote = fit.growth_coef === 0
      ? 'growth fitted (' + (val.loo.final_growth !== undefined ? 'dropped: it worsens leave-one-out' : 'dropped') + '), age fitted and dropped the same way — neither moves a value'
      : 'growth coefficient ' + fit.growth_coef;
    formula.textContent =
      'log(market cap) = ' + fit.intercept + ' + ' + fit.slope + ' \u00d7 log(TVL) + ' + fit.w_coef + ' \u00d7 within-category size + category shift (shrunk n / (n + 4)) + chain shift (shrunk n / (n + 4))\n' +
      'implied = exp(model), rounded to whole dollars. ' + growthNote + '.';
    panel.appendChild(formula);
    var grid = tag('div', 'model-grid');
    var left = tag('div');
    left.appendChild(tag('h3', null, 'Blind tests: mean absolute log error, lower wins'));
    left.appendChild(miniTable(['Scoring', 'Error'], [
      ['Fitted line', err3(val.loo.line)],
      ['Line + category shifts', err3(val.loo.line_category)],
      ['Line + category + size', err3(val.loo.line_category_size)],
      ['Final model (+ chain shifts)', err3(val.loo.final)],
      ['Final + fitted growth', err3(val.loo.final_growth)],
      ['Final + growth + fitted age', err3(val.loo.final_growth_age)],
      ['Flat global median', err3(val.loo.flat_median)],
    ], 3));
    left.appendChild(tag('p', null, 'Walk-forward: fitted on the oldest ' + val.walk_forward.train_n + ' dated comps, the model predicts the newest ' + val.walk_forward.test_n + ' with error ' + err3(val.walk_forward.final) + ', against ' + err3(val.walk_forward.flat) + ' for the flat median on the same split. Growth would improve that test to ' + err3(val.walk_forward.final_growth) + ' and age would wreck it at ' + err3(val.walk_forward.final_growth_age) + ' — but a term stays only when it improves both blind tests, so both stay out.'));
    var decisions = tag('ul');
    val.decisions.forEach(function (d) { decisions.appendChild(tag('li', null, d)); });
    left.appendChild(decisions);
    left.appendChild(tag('p', null, 'Rank ranges come from ' + val.refits + ' bootstrap refits of the model (seed ' + val.seed + '): each row\u2019s range is the middle 80% of its refit ranks.'));
    var right = tag('div');
    right.appendChild(tag('h3', null, 'Calibration: what the model prices $100M of TVL at'));
    var scroll = tag('div', 'calib-scroll');
    scroll.appendChild(miniTable(['Category', 'Comps', 'Shift', 'Multiple'], fit.calibration.map(function (c) {
      return [c.category, String(c.comps), (c.shift >= 0 ? '+' : '') + c.shift.toFixed(4), 'x' + c.multiple_at_100m.toFixed(4)];
    }), -1));
    right.appendChild(scroll);
    right.appendChild(tag('p', null, 'The global median multiple is x' + fit.global_median + '. Categories with few comps borrow the shared line through shrinkage, so a single loud protocol cannot set its category\u2019s price. Chain shifts adjust the multiple further, and ' + fit.ratio_excluded + ' trading protocols sit the fit out with a ratio outside 0.01..10.'));
    grid.appendChild(left);
    grid.appendChild(right);
    panel.appendChild(grid);
  }

  // -- accounting ------------------------------------------------------------------
  function renderAccounting() {
    var panel = document.getElementById('accounting');
    var cov = DATA.coverage;
    panel.appendChild(tag('h2', null, 'Every protocol accounted for'));
    var recon = tag('div', 'recon');
    [
      cov.total + ' in the snapshot',
      cov.ranked + ' ranked',
      cov.excluded_pre_token + ' pre-token set aside',
      cov.traded + ' already trading',
      cov.watchlist_covered + '/' + cov.watchlist_size + ' watchlist',
    ].forEach(function (s) { recon.appendChild(tag('span', null, s)); });
    panel.appendChild(recon);
    var reasons = Object.keys(cov.excluded_by_reason || {}).sort().map(function (k) {
      return cov.excluded_by_reason[k] + ' set aside as ' + k;
    });
    if (reasons.length) panel.appendChild(tag('p', 'intro', 'Set aside: ' + reasons.join(' · ') + '.'));
    var econ = DATA.economy;
    panel.appendChild(tag('p', 'intro', 'Verdicts split the board into thirds by implied value per dollar of total cost — gas plus forgone yield plus the exit transaction — FARM at or above ' + econ.verdict_cuts.farm_above.toLocaleString('en-US') + ', SKIP below ' + econ.verdict_cuts.skip_below.toLocaleString('en-US') + ' — with ' + econ.verdict_counts.FARM + ' FARM, ' + econ.verdict_counts.THIN + ' THIN, and ' + econ.verdict_counts.SKIP + ' SKIP. A top-third row whose evidence is partial farms thin instead.'));
    var method = tag('div', 'method');
    (DATA.methodology || []).forEach(function (m) { method.appendChild(tag('p', null, m)); });
    panel.appendChild(method);
  }

  // -- board ------------------------------------------------------------------------
  function verdictPill(verdict) {
    return tag('span', 'pill ' + verdict.toLowerCase(), verdict);
  }
  function renderBoard() {
    var tbody = document.getElementById('board-body');
    var list = orderedRows(visibleRows());
    if (state.tab === 'board') document.getElementById('count').textContent = list.length + ' of ' + DATA.rows.length + ' rows shown';
    tbody.textContent = '';
    if (list.length === 0) {
      var empty = tag('tr', 'empty-row');
      var cell = tag('td', null, 'No protocol matches that filter — clear the search or pick another category or verdict.');
      cell.colSpan = 8;
      empty.appendChild(cell);
      tbody.appendChild(empty);
      return;
    }
    list.forEach(function (r) {
      var tr = tag('tr');
      tr.setAttribute('tabindex', '0');
      tr.setAttribute('aria-selected', state.selected === r.slug ? 'true' : 'false');
      tr.addEventListener('click', function () { openDetail(r.slug); });
      tr.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(r.slug); }
      });
      tr.appendChild(tag('td', 'rank-cell', String(r.rank)));
      var who = tag('td', 'who');
      who.appendChild(tag('b', null, r.name));
      who.appendChild(tag('span', null, (r.category || 'Uncategorized') + ' · ' + chainsLabel(r.chains, 2)));
      tr.appendChild(who);
      tr.appendChild(tag('td', 'num', moneyShort(r.tvl_usd)));
      var growth = tag('td', 'num ' + (r.change_7d === null ? '' : r.change_7d >= 0 ? 'up' : 'down'), pct(r.change_7d));
      tr.appendChild(growth);
      tr.appendChild(tag('td', 'num', moneyShort(r.implied_value_usd)));
      tr.appendChild(tag('td', 'num', r.rank_low + '\u2013' + r.rank_high));
      var verdictCell = tag('td');
      verdictCell.appendChild(verdictPill(r.farm.verdict));
      tr.appendChild(verdictCell);
      tr.appendChild(tag('td', 'num', '$' + r.farm.total_cost_usd + ' · ' + r.farm.hours + 'h'));
      tbody.appendChild(tr);
    });
  }

  function renderLive() {
    var tbody = document.getElementById('live-body');
    tbody.textContent = '';
    DATA.live.forEach(function (r) {
      var tr = tag('tr');
      tr.style.cursor = 'default';
      var who = tag('td', 'who');
      who.appendChild(tag('b', null, r.name));
      who.appendChild(tag('span', null, (r.category || 'Uncategorized')));
      tr.appendChild(who);
      tr.appendChild(tag('td', 'num', moneyShort(r.tvl_usd)));
      tr.appendChild(tag('td', 'num', moneyShort(r.mcap_usd)));
      tr.appendChild(tag('td', 'num', 'x' + r.ratio.toFixed(4)));
      tr.appendChild(tag('td', 'num ' + (r.change_7d === null ? '' : r.change_7d >= 0 ? 'up' : 'down'), pct(r.change_7d)));
      tbody.appendChild(tr);
    });
  }

  // -- detail drawer -------------------------------------------------------------------
  var dialog = document.getElementById('detail');
  dialog.addEventListener('close', function () {
    state.selected = null;
    writeHash();
    renderBoard();
  });

  function auditRow(label, value, total) {
    var div = tag('div', total ? 'total' : null);
    div.appendChild(tag('span', null, label));
    div.appendChild(tag('b', null, value));
    return div;
  }

  function openDetail(slug) {
    var row = bySlug[slug];
    if (!row) return;
    state.selected = slug;
    writeHash();
    dialog.textContent = '';
    var drawer = tag('div', 'drawer');
    var head = tag('div', 'drawer-head');
    var titleBox = tag('div');
    titleBox.appendChild(tag('p', 'sub', 'Rank ' + row.rank + ' of ' + DATA.rows.length + ' · rank range ' + row.rank_low + '\u2013' + row.rank_high + ' across ' + DATA.validation.refits + ' refits'));
    titleBox.appendChild(tag('h2', null, row.name));
    titleBox.appendChild(tag('p', 'sub', (row.category || 'Uncategorized') + ' on ' + chainsLabel(row.chains, 99) + ' · ' + ageLabel(row.age_days) + ' with no token'));
    head.appendChild(titleBox);
    var close = tag('button', 'x', '\u00d7');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close details');
    close.addEventListener('click', function () { dialog.close(); });
    head.appendChild(close);
    drawer.appendChild(head);

    drawer.appendChild(tag('h3', null, 'Why this number'));
    var audit = tag('div', 'audit');
    audit.appendChild(auditRow('TVL', moneyFull(row.tvl_usd)));
    audit.appendChild(auditRow('Model value (fit + shifts)', moneyFull(row.curve_usd)));
    audit.appendChild(auditRow('Category shift', (row.category_shift >= 0 ? '+' : '') + row.category_shift.toFixed(4) + ' (' + row.category_shift_n + (row.category_shift_n === 1 ? ' comp' : ' comps') + ')'));
    audit.appendChild(auditRow('Chain shift (' + (row.chains[0] || 'no chain') + ')', (row.chain_shift >= 0 ? '+' : '') + row.chain_shift.toFixed(4) + ' (' + row.chain_shift_n + (row.chain_shift_n === 1 ? ' comp' : ' comps') + ')'));
    audit.appendChild(auditRow('Within-category size (' + row.within_size.toFixed(2) + ' \u00d7 ' + row.size_coef + ')', '\u00d7' + Math.exp(row.size_coef * row.within_size).toFixed(4)));
    audit.appendChild(auditRow('Growth factor (7d ' + pct(row.change_7d) + ', fitted and dropped)', '\u00d71.0000'));
    audit.appendChild(auditRow('Age factor (' + ageLabel(row.age_days) + ', fitted and dropped)', '\u00d71.0000'));
    audit.appendChild(auditRow('Implied value', moneyFull(row.implied_value_usd), true));
    drawer.appendChild(audit);
    var recomputed = Math.max(1, Math.round(row.curve_exact * row.growth_exact * row.age_exact));
    var verdict = recomputed === row.implied_value_usd
      ? 'The drawer recomputes this row as ' + moneyFull(recomputed) + ', the same number board.json carries.'
      : 'The drawer recomputes this row as ' + moneyFull(recomputed) + ', which differs from the board — the data would be stale.';
    drawer.appendChild(tag('p', 'recompute', verdict + ' An estimate, not a price.'));

    drawer.appendChild(tag('h3', null, 'Nearest traded comps'));
    var kin = tag('table', 'kin');
    var kinHead = tag('tr');
    ['Protocol', 'Category', 'TVL', 'Market cap', 'Multiple'].forEach(function (h) { kinHead.appendChild(tag('th', null, h)); });
    kin.appendChild(tag('thead')).appendChild(kinHead);
    var kinBody = tag('tbody');
    row.kin.forEach(function (k) {
      var tr = tag('tr');
      tr.appendChild(tag('td', null, k.name));
      tr.appendChild(tag('td', null, k.category || 'Uncategorized'));
      tr.appendChild(tag('td', 'num', moneyShort(k.tvl_usd)));
      tr.appendChild(tag('td', 'num', moneyShort(k.mcap_usd)));
      tr.appendChild(tag('td', 'num', 'x' + k.ratio.toFixed(4)));
      kinBody.appendChild(tr);
    });
    kin.appendChild(kinBody);
    drawer.appendChild(kin);
    var peers = tag('p', 'recompute', row.peers.n + ' comparable protocols sit near this TVL in ' + (row.category || 'Uncategorized') + ', and ' + row.peers.traded + ' of them already trade — a smoothed share of ' + Math.round(row.peers.prevalence * 100) + '% already trading. That is a snapshot share of the peer group, not a probability this protocol launches.');
    drawer.appendChild(peers);

    drawer.appendChild(tag('h3', null, 'Farm plan — ' + row.farm.hold_days + ' days, ' + row.farm.start_date + ' to ' + row.farm.hold_end_date));
    var plan = tag('ol', 'plan');
    row.farm_steps.forEach(function (s) {
      var li = tag('li');
      var at = s.indexOf(' Cost: ');
      var action = at >= 0 ? s.slice(0, at) : s;
      var tail = at >= 0 ? s.slice(at + 1) : '';
      li.appendChild(document.createTextNode(action));
      if (tail) li.appendChild(tag('span', 'costline', tail));
      plan.appendChild(li);
    });
    drawer.appendChild(plan);

    drawer.appendChild(tag('h3', null, 'The economics, netted'));
    var econ = tag('div', 'econ');
    [
      ['$' + row.farm.total_cost_usd, 'total cost'],
      ['$' + row.farm.gas_usd, 'gas'],
      ['$' + row.farm.opportunity_cost_usd, 'forgone yield (5% a year)'],
      ['$' + row.farm.exit_fee_usd, 'exit transaction'],
      ['$' + row.farm.deposit_usd, 'deposit (returns on exit)'],
      [row.farm.hours + 'h', 'attention over ' + row.farm.hold_days + ' days'],
      ['$' + row.farm.break_even_usd, 'break-even allocation'],
      ['$' + row.farm.break_even_low_usd + ' – $' + row.farm.break_even_high_usd, 'break-even at half / double gas'],
      [row.farm.break_even_share_pct + '%', 'of implied value'],
      [row.farm.efficiency.toLocaleString('en-US'), 'implied $ per cost $'],
      [row.farm.evidence_status, 'evidence'],
    ].forEach(function (pair) {
      var cell = tag('div');
      cell.appendChild(tag('b', null, pair[0]));
      cell.appendChild(tag('span', null, pair[1]));
      econ.appendChild(cell);
    });
    drawer.appendChild(econ);
    var verdictLine = tag('p', 'recompute', 'Verdict: ' + row.farm.verdict + ' — ' + row.farm.verdict_reason);
    drawer.appendChild(verdictLine);

    var actions = tag('div', 'drawer-actions');
    var inTray = state.compare.indexOf(slug) >= 0;
    var compareBtn = tag('button', 'btn primary', inTray ? 'Remove from compare' : 'Add to compare');
    compareBtn.type = 'button';
    compareBtn.disabled = !inTray && state.compare.length >= COMPARE_MAX;
    compareBtn.addEventListener('click', function () { toggleCompare(slug); openDetail(slug); });
    actions.appendChild(compareBtn);
    var closeBtn = tag('button', 'btn', 'Close');
    closeBtn.type = 'button';
    closeBtn.addEventListener('click', function () { dialog.close(); });
    actions.appendChild(closeBtn);
    drawer.appendChild(actions);

    dialog.appendChild(drawer);
    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
    }
    renderBoard();
  }

  // -- compare tray -----------------------------------------------------------------------
  function toggleCompare(slug) {
    var at = state.compare.indexOf(slug);
    if (at >= 0) state.compare.splice(at, 1);
    else {
      state.compare.push(slug);
      while (state.compare.length > COMPARE_MAX) state.compare.shift();
    }
    writeHash();
    renderTray();
  }
  function renderTray() {
    var tray = document.getElementById('tray');
    tray.textContent = '';
    if (state.compare.length === 0) {
      tray.classList.remove('open');
      document.body.style.paddingBottom = '';
      return;
    }
    tray.classList.add('open');
    var inner = tag('div', 'tray-inner');
    state.compare.forEach(function (slug) {
      var row = bySlug[slug];
      if (!row) return;
      var card = tag('div', 'tray-card');
      card.appendChild(tag('b', null, '#' + row.rank + ' ' + row.name));
      card.appendChild(tag('span', null, moneyShort(row.implied_value_usd) + ' · range ' + row.rank_low + '\u2013' + row.rank_high + ' · ' + row.farm.verdict + ' · $' + row.farm.total_cost_usd + ' cost · break-even ' + row.farm.break_even_share_pct + '%'));
      var remove = tag('button', null, 'Remove');
      remove.type = 'button';
      remove.addEventListener('click', function () { toggleCompare(slug); });
      card.appendChild(remove);
      inner.appendChild(card);
    });
    var clear = tag('button', 'tray-clear', 'Clear compare');
    clear.type = 'button';
    clear.addEventListener('click', function () { state.compare = []; writeHash(); renderTray(); });
    inner.appendChild(clear);
    tray.appendChild(inner);
    document.body.style.paddingBottom = '120px';
  }

  // -- tabs and controls ---------------------------------------------------------------------
  function renderTabs() {
    var boardTab = document.getElementById('tab-board');
    var liveTab = document.getElementById('tab-live');
    boardTab.setAttribute('aria-selected', state.tab === 'board' ? 'true' : 'false');
    liveTab.setAttribute('aria-selected', state.tab === 'live' ? 'true' : 'false');
    document.getElementById('board').hidden = state.tab !== 'board';
    document.getElementById('live').hidden = state.tab !== 'live';
    document.getElementById('count').textContent = state.tab === 'board'
      ? orderedRows(visibleRows()).length + ' of ' + DATA.rows.length + ' rows shown'
      : DATA.live.length + ' traded anchors';
  }

  function wireControls() {
    var categories = Array.from(new Set(DATA.rows.map(function (r) { return r.category || 'Uncategorized'; }))).sort();
    var select = document.getElementById('category');
    categories.forEach(function (c) {
      var option = tag('option', null, c);
      option.value = c;
      select.appendChild(option);
    });
    select.value = state.category;
    var search = document.getElementById('q');
    search.value = state.q;
    search.addEventListener('input', function () { state.q = search.value; writeHash(); renderBoard(); });
    select.addEventListener('change', function () {
      state.category = select.value;
      writeHash();
      renderBoard();
    });
    var verdict = document.getElementById('verdict');
    verdict.value = state.verdict;
    verdict.addEventListener('change', function () { state.verdict = verdict.value; writeHash(); renderBoard(); });
    var sort = document.getElementById('sort');
    sort.value = state.sort;
    sort.addEventListener('change', function () { state.sort = sort.value; writeHash(); renderBoard(); });
    document.getElementById('tab-board').addEventListener('click', function () { state.tab = 'board'; writeHash(); renderTabs(); });
    document.getElementById('tab-live').addEventListener('click', function () { state.tab = 'live'; writeHash(); renderTabs(); });
  }

  readHash();
  renderKpis();
  renderModel();
  renderAccounting();
  renderLive();
  wireControls();
  renderTabs();
  renderBoard();
  renderTray();
  if (state.selected && bySlug[state.selected]) openDetail(state.selected);
})();
