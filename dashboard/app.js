// Token Radar's dashboard, radar-2. The page is a pure rendering of window.RADAR, the dataset
// main.ts writes beside dashboard/: the ranked board with its filters and sorts, a detail drawer
// that shows the model's own arithmetic and the protocol's farm plan, the calibration table the
// multiples were measured from, and a side-by-side compare for up to three protocols. It makes
// no requests: every number on screen arrived in data.js, and the farm plans and multiples are
// rendered exactly as shipped, never re-derived, so the page and the board cannot disagree.
// One exception proves the rule: the detail drawer recomputes its row from the snapshot
// figures and the shipped multiple, in the model's own order, and says whether the result is
// the number board.json carries.
(function () {
  'use strict';

  var DATA = window.RADAR;
  if (!DATA) return;
  var mount = document.getElementById('board');
  var state = { q: '', category: 'all', tab: 'pre-token', sort: 'implied', dir: -1, selected: null, compare: [] };
  var COMPARE_MAX = 3;

  // -- formatting -------------------------------------------------------------
  var usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  var fmt = {
    money: function (n) {
      if (n === null || n === undefined || !isFinite(n)) return 'n/a';
      var mag = Math.abs(n);
      if (mag >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
      if (mag >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
      if (mag >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
      return usd0.format(n);
    },
    pct: function (n) {
      if (n === null || n === undefined || !isFinite(n)) return 'n/a';
      return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
    },
    age: function (days) {
      if (days === null || days === undefined) return 'unknown';
      if (days >= 365) return (days / 365).toFixed(1) + 'y';
      return Math.max(0, Math.round(days)) + 'd';
    },
    mult: function (n) { return 'x' + n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '.0'); },
    chains: function (chains, limit) {
      if (!chains || chains.length === 0) return 'an unnamed chain';
      return chains.slice(0, limit).join(', ');
    }
  };

  // The model's arithmetic, in the model's order: TVL x multiple x growth x maturity.
  // The detail drawer runs this on the shipped figures and compares it with the board's
  // number; the two agree exactly, because the board ran the same expression.
  function impliedOf(row, model) {
    var growth = Math.min(model.growth_cap, Math.max(model.growth_floor, row.change_7d === null || row.change_7d === undefined ? 0 : row.change_7d));
    var growthMult = 1 + (growth / 100) * model.growth_weight;
    var age = row.age_days === null || row.age_days === undefined ? model.unknown_age_days : row.age_days;
    var maturity = model.maturity_floor + (Math.min(Math.max(age, 0), model.maturity_days) / model.maturity_days) * model.maturity_range;
    return Math.max(1, Math.round(row.tvl_usd * row.multiple * growthMult * maturity));
  }

  // -- tiny DOM helper ---------------------------------------------------------
  // el('div', {class: 'x', text: 'y', onclick: fn}, child1, [child2, child3]):
  // attributes become properties, text, HTML, listeners (on*) or attributes, and
  // children are appended in order (strings become text nodes, arrays flatten).
  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (key) {
        var value = attrs[key];
        if (value === null || value === undefined) return;
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key === 'html') node.innerHTML = value;
        else if (key.slice(0, 2) === 'on') node.addEventListener(key.slice(2), value);
        else node.setAttribute(key, value);
      });
    }
    var append = function (child) {
      if (child === null || child === undefined || child === false) return;
      if (Array.isArray(child)) { child.forEach(append); return; }
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    };
    for (var i = 2; i < arguments.length; i++) append(arguments[i]);
    return node;
  }

  function textCell(value, cls) { return el('td', { class: cls || 'num', text: value }); }

  // -- shareable state ----------------------------------------------------------
  function readHash() {
    var params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    if (params.get('q')) state.q = params.get('q');
    if (params.get('p')) state.selected = params.get('p');
    if (params.get('category')) state.category = params.get('category');
    if (params.get('c')) state.compare = params.get('c').split(',').map(findRow).filter(Boolean).map(function (r) { return r.slug; }).slice(0, COMPARE_MAX);
  }
  function writeHash() {
    var params = new URLSearchParams();
    if (state.q) params.set('q', state.q);
    if (state.category !== 'all') params.set('category', state.category);
    if (state.selected) params.set('p', state.selected);
    if (state.compare.length) params.set('c', state.compare.join(','));
    var next = params.toString();
    var url = next ? '#' + next : window.location.pathname + window.location.search;
    window.history.replaceState(null, '', url);
  }

  // -- filtering and sorting ----------------------------------------------------
  function visibleRows() {
    var q = state.q.trim().toLowerCase();
    return DATA.rows.filter(function (r) {
      if (state.category !== 'all' && r.category !== state.category) return false;
      if (!q) return true;
      var hay = [r.name, r.slug, r.category, (r.chains || []).join(' ')].join(' ').toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }
  function sortKey(row, key) {
    if (key === 'name') return row.name.toLowerCase();
    if (key === 'tvl') return row.tvl_usd;
    if (key === 'growth') return row.change_7d === null ? -Infinity : row.change_7d;
    if (key === 'age') return row.age_days === null ? Infinity : row.age_days;
    return row.implied_value_usd;
  }
  function orderedRows(list) {
    return list.slice().sort(function (a, b) {
      var av = sortKey(a, state.sort);
      var bv = sortKey(b, state.sort);
      if (av < bv) return -state.dir;
      if (av > bv) return state.dir;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
  }
  function findRow(slug) {
    for (var i = 0; i < DATA.rows.length; i++) if (DATA.rows[i].slug === slug) return DATA.rows[i];
    return null;
  }

  // -- compare ------------------------------------------------------------------
  function inCompare(slug) { return state.compare.indexOf(slug) >= 0; }
  function toggleCompare(slug) {
    var at = state.compare.indexOf(slug);
    if (at >= 0) { state.compare.splice(at, 1); }
    else {
      state.compare.push(slug);
      while (state.compare.length > COMPARE_MAX) state.compare.shift();
    }
    writeHash();
  }

  // -- page sections -------------------------------------------------------------
  function buildHeader() {
    return el('header', { class: 'top' },
      el('div', { class: 'brand' },
        el('span', { class: 'mark' }),
        el('span', { class: 'brand-name', text: 'Token Radar' }),
        el('span', { class: 'badge', text: DATA.model_version + ' · calibrated' })),
      el('div', { class: 'top-meta' },
        el('span', { text: 'Snapshot ' + DATA.as_of }),
        el('span', { text: 'DefiLlama protocol index' }),
        el('span', { text: DATA.calibration.global_n + ' live tokens priced the model' }))
    );
  }

  function fact(label, value) {
    return el('div', { class: 'fact' }, el('span', { text: label }), el('b', { text: value }));
  }
  function buildLede() {
    var floorM = Math.round(DATA.floor_usd / 1e6);
    return el('section', { class: 'lede' },
      el('div', null,
        el('h1', { text: DATA.watchlist_size + ' watchlist protocols, ranked by implied value' }),
        el('p', { text: 'The watchlist sets the floor: every protocol holding at least $' + floorM + 'M of TVL with no token on record. Below it, the early radar adds ' + DATA.early_size + ' more pre-token protocols. A category is priced at the median market-cap / TVL of its live-token protocols in this very snapshot, so each dollar of TVL is worth what the market already pays for it elsewhere. The result is a model, not a promise.' })
      ),
      el('div', { class: 'facts' },
        fact('Watchlist covered', DATA.watchlist_size + ' / ' + DATA.watchlist_size),
        fact('Pre-token rows scored', String(DATA.board_size)),
        fact('Early rows below the floor', String(DATA.early_size)),
        fact('Global multiple (median)', fmt.mult(DATA.calibration.global_multiple)),
        fact('Live-token protocols set aside', String(DATA.live_size))
      )
    );
  }

  function buildControls() {
    var categories = Array.from(new Set(DATA.rows.map(function (r) { return r.category || 'Other'; }))).sort();
    var search = el('input', { type: 'search', id: 'q', placeholder: 'Search name, category or chain', value: state.q, 'aria-label': 'Search the board' });
    search.addEventListener('input', function () { state.q = search.value; writeHash(); render(); });
    var options = [el('option', { value: 'all', text: 'All categories' })];
    categories.forEach(function (c) {
      options.push(el('option', { value: c, text: c, selected: c === state.category ? 'selected' : null }));
    });
    var select = el('select', { id: 'category', 'aria-label': 'Filter by category' }, options);
    select.addEventListener('change', function () { state.category = select.value; writeHash(); render(); });
    var tabButton = function (tab, label) {
      return el('button', { type: 'button', 'aria-pressed': state.tab === tab ? 'true' : 'false', text: label, onclick: function () { state.tab = tab; render(); } });
    };
    var countText = state.tab === 'pre-token' ? visibleRows().length + ' rows shown' : DATA.live.length + ' live-token protocols';
    return el('div', { class: 'controls' },
      el('div', { class: 'field' }, el('label', { for: 'q', text: 'Search' }), search),
      el('div', { class: 'field' }, el('label', { for: 'category', text: 'Category' }), select),
      el('div', { class: 'field' }, el('span', { class: 'sub', text: 'Token status' }), el('div', { class: 'tabs' }, tabButton('pre-token', 'Pre-token'), tabButton('live', 'Live token'))),
      el('span', { class: 'count', text: countText })
    );
  }

  function sortHeader(key, label) {
    var marker = state.sort === key ? el('span', { 'aria-hidden': 'true', text: state.dir < 0 ? ' v' : ' ^' }) : null;
    var button = el('button', { type: 'button', onclick: function () {
      if (state.sort === key) state.dir = -state.dir;
      else { state.sort = key; state.dir = -1; }
      render();
    } }, label, marker);
    return el('th', { scope: 'col' }, button);
  }

  function rankBadge(rank) {
    if (rank <= 3) return el('td', { class: 'num' }, el('span', { class: 'rank-badge rank-' + rank, text: String(rank) }));
    return textCell(String(rank));
  }

  function protocolCell(row) {
    return el('td', null, el('div', { class: 'name' },
      el('b', { text: row.name }),
      el('span', { class: 'sub', text: (row.category || 'Other') + ' on ' + fmt.chains(row.chains, 2) })
    ));
  }

  function impliedCell(row, max) {
    var width = Math.max(3, Math.round((row.implied_value_usd / max) * 100));
    return el('td', null, el('div', { class: 'implied' },
      el('div', { class: 'bar', 'aria-hidden': 'true' }, el('i', { style: 'width:' + width + '%' })),
      el('span', { class: 'num', text: fmt.money(row.implied_value_usd) })
    ));
  }

  function boardTable() {
    var list = orderedRows(visibleRows());
    if (list.length === 0) {
      return el('div', { class: 'panel' }, el('div', { class: 'empty' },
        el('h2', { text: 'No protocol matches that filter' }),
        el('p', { text: 'Clear the search or pick another category to see the board again.' }),
        el('button', { class: 'button primary', type: 'button', text: 'Clear filters', onclick: function () { state.q = ''; state.category = 'all'; writeHash(); render(); } })
      ));
    }
    var max = list[0].implied_value_usd || 1;
    var tbody = el('tbody');
    list.forEach(function (r) {
      var growthClass = r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg';
      var tr = el('tr', {
        'data-selected': state.selected === r.slug ? 'true' : 'false',
        tabindex: '0',
        onclick: function () { openDetail(r.slug); },
        onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(r.slug); } }
      },
        rankBadge(r.rank),
        protocolCell(r),
        textCell(fmt.money(r.tvl_usd)),
        el('td', { class: 'num ' + growthClass, text: r.change_7d === null ? 'n/a' : fmt.pct(r.change_7d) }),
        textCell(fmt.age(r.age_days)),
        impliedCell(r, max),
        el('td', null, el('span', { class: 'status', text: 'no token' }))
      );
      tbody.appendChild(tr);
    });
    return el('div', { class: 'panel' },
      el('div', { class: 'table-wrap' },
        el('table', null,
          el('caption', { class: 'sub', text: 'Pre-token protocols, strongest implied value first. Select a row for its model and farm plan.' }),
          el('thead', null, el('tr', null,
            sortHeader('implied', 'Rank'),
            sortHeader('name', 'Protocol'),
            sortHeader('tvl', 'TVL'),
            sortHeader('growth', '7d'),
            sortHeader('age', 'Age'),
            sortHeader('implied', 'Implied value'),
            el('th', { scope: 'col', text: 'Token' })
          )),
          tbody
        )
      )
    );
  }

  function liveTable() {
    var tbody = el('tbody');
    DATA.live.forEach(function (r) {
      var cls = r.change_7d !== null && r.change_7d >= 0 ? 'pos' : 'neg';
      tbody.appendChild(el('tr', null,
        textCell('live'),
        protocolCell(r),
        textCell(fmt.money(r.tvl_usd)),
        el('td', { class: 'num ' + cls, text: fmt.pct(r.change_7d) }),
        textCell(fmt.money(r.mcap_usd)),
        el('td', null, el('span', { class: 'status', text: 'already trades' }))
      ));
    });
    return el('div', { class: 'panel' },
      el('div', { class: 'table-wrap' },
        el('table', null,
          el('caption', { class: 'sub', text: 'Token live: these protocols already trade, so their market cap is a fact, not a model. They are set aside from the pre-token ranking, and their market-cap / TVL ratios price the model.' }),
          el('thead', null, el('tr', null,
            el('th', { scope: 'col', text: 'Status' }),
            el('th', { scope: 'col', text: 'Protocol' }),
            el('th', { scope: 'col', text: 'TVL' }),
            el('th', { scope: 'col', text: '7d' }),
            el('th', { scope: 'col', text: 'Market cap' }),
            el('th', { scope: 'col', text: 'Token' })
          )),
          tbody
        )
      )
    );
  }

  function calibrationEntries() {
    return Object.keys(DATA.calibration.by_category).map(function (k) {
      var entry = DATA.calibration.by_category[k];
      return { category: k, multiple: entry.multiple, n: entry.n, source: entry.source };
    }).sort(function (a, b) { return b.multiple - a.multiple || (a.category < b.category ? -1 : 1); });
  }

  function calibrationTable() {
    var tbody = el('tbody');
    calibrationEntries().forEach(function (e) {
      tbody.appendChild(el('tr', null,
        el('td', { text: e.category }),
        textCell(fmt.mult(e.multiple)),
        textCell(String(e.n)),
        el('td', null, el('span', { class: 'sub', text: e.source === 'category' ? 'category median' : 'global median' }))
      ));
    });
    return el('div', { class: 'table-wrap calib-wrap' },
      el('table', { class: 'calib' },
        el('thead', null, el('tr', null,
          el('th', { scope: 'col', text: 'Category' }),
          el('th', { scope: 'col', text: 'Multiple' }),
          el('th', { scope: 'col', text: 'Live protocols' }),
          el('th', { scope: 'col', text: 'Source' })
        )),
        tbody
      )
    );
  }

  function modelPanel() {
    var m = DATA.model;
    var notes = DATA.methodology && DATA.methodology.length ? DATA.methodology : ['One function scores every row from the snapshot figures alone.'];
    var children = [
      el('h2', { text: 'How implied value is computed' }),
      el('p', { class: 'sub', text: notes[0] }),
      el('div', { class: 'formula' },
        'implied = round( tvl_usd x category_multiple x (1 + clamp(change_7d, ' + m.growth_floor + ', ' + m.growth_cap + ') / 100 x ' + m.growth_weight + ') x (' + m.maturity_floor + ' + min(age_days, ' + m.maturity_days + ') / ' + m.maturity_days + ' x ' + m.maturity_range + ') )'
      )
    ];
    for (var i = 1; i < notes.length; i++) children.push(el('p', { class: 'sub', text: notes[i] }));
    children.push(el('h3', { text: 'Calibration: the multiple per category' }));
    children.push(calibrationTable());
    children.push(el('p', { class: 'sub', text: 'The early radar is every pre-token protocol below the watchlist floor, by TVL, and the live-token protocols are set aside with their market caps shown.' }));
    return el('section', { class: 'panel model', id: 'model' }, children);
  }

  function compareCard(row) {
    var stat = function (label, value) {
      return el('div', null, el('span', { text: label }), el('b', { class: 'num', text: value }));
    };
    return el('article', { class: 'compare-card' },
      el('div', { class: 'compare-head' },
        el('div', null,
          el('b', { text: row.name }),
          el('span', { class: 'sub', text: 'Rank ' + row.rank + ' · ' + (row.category || 'Other') })
        ),
        el('button', { class: 'button', type: 'button', text: 'Remove', onclick: function () { toggleCompare(row.slug); render(); } })
      ),
      el('div', { class: 'equation' },
        stat('Implied value', fmt.money(row.implied_value_usd)),
        stat('TVL', fmt.money(row.tvl_usd)),
        stat('7d growth', fmt.pct(row.change_7d)),
        stat('Age', fmt.age(row.age_days)),
        stat('Multiple', fmt.mult(row.multiple) + (row.multiple_source === 'category' ? ' (' + row.calibration_n + ' live)' : ' (global)')),
        stat('Farm capital', row.farm_steps.length > 1 ? row.farm_steps[1].split(' Cost: ')[0] : 'n/a')
      ),
      el('button', { class: 'button primary', type: 'button', text: 'Open detail', onclick: function () { openDetail(row.slug); } })
    );
  }

  function compareSection() {
    if (state.compare.length === 0) return null;
    var picked = state.compare.map(findRow).filter(function (r) { return !!r; });
    if (picked.length === 0) return null;
    var cards = picked.map(compareCard);
    return el('section', { class: 'panel compare', id: 'compare' },
      el('div', { class: 'compare-head' },
        el('h2', { text: 'Compare (' + cards.length + ' of ' + COMPARE_MAX + ')' }),
        el('button', { class: 'button', type: 'button', text: 'Clear all', onclick: function () { state.compare = []; writeHash(); render(); } })
      ),
      el('p', { class: 'sub', text: 'Side by side, from the same shipped figures: the implied value, what drives it, and the opening farm move. Add protocols from their detail drawer.' }),
      el('div', { class: 'compare-grid' }, cards)
    );
  }

  function buildFooter() {
    return el('footer', { class: 'foot' },
      el('p', { class: 'sub', text: 'Token Radar ' + DATA.model_version + ' · Data: ' + DATA.source + ' · Implied value is a model built from the snapshot\'s own figures, not a price, a prediction or financial advice. Farm plans name concrete steps, costs and times; verify every link on the protocol\'s own official channels before you act.' })
    );
  }

  // -- detail drawer ---------------------------------------------------------------
  var dialog = el('dialog', { class: 'detail', id: 'detail', 'aria-labelledby': 'detail-title' });
  dialog.addEventListener('close', function () { state.selected = null; writeHash(); });

  function equationRow(label, value, cls) {
    return el('div', cls ? { class: cls } : null, el('span', { text: label }), el('b', { class: 'num', text: value }));
  }

  function openDetail(slug) {
    var row = findRow(slug);
    if (!row) return;
    state.selected = slug;
    writeHash();
    dialog.textContent = '';
    var recomputed = impliedOf(row, DATA.model);
    var multipleNote = fmt.mult(row.multiple) + (row.multiple_source === 'category' ? ' (' + row.calibration_n + ' live)' : ' (global fallback)');
    var verdict = recomputed === row.implied_value_usd
      ? ', the same number board.json carries.'
      : ', which differs from the board: the data would be stale.';
    var compareLabel = inCompare(slug) ? 'Remove from compare' : 'Add to compare';
    dialog.appendChild(el('div', { class: 'detail-head' },
      el('div', null,
        el('span', { class: 'brand-name', text: 'Rank ' + row.rank + ' of ' + DATA.board_size }),
        el('h2', { id: 'detail-title', text: row.name }),
        el('p', { class: 'sub', text: (row.category || 'Other') + ' on ' + fmt.chains(row.chains, 99) })
      ),
      el('div', { class: 'detail-actions' },
        el('button', { class: 'button', type: 'button', text: compareLabel, onclick: function () { toggleCompare(slug); render(); } }),
        el('button', { class: 'close', type: 'button', 'aria-label': 'Close details', text: 'Close', onclick: function () { dialog.close(); } })
      )
    ));
    dialog.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Implied value' }),
      el('div', { class: 'equation' },
        equationRow('TVL', fmt.money(row.tvl_usd)),
        equationRow('Category multiple', multipleNote),
        equationRow('Seven-day growth', fmt.pct(row.change_7d)),
        equationRow('Age with no token', fmt.age(row.age_days)),
        equationRow('Growth multiplier', String(row.growth_multiplier)),
        equationRow('Maturity multiplier', String(row.maturity_multiplier)),
        equationRow('Implied value', fmt.money(row.implied_value_usd), 'total')
      ),
      el('p', { class: 'sub', text: 'Model ' + DATA.model_version + ': the same function scores every protocol. The page recomputes this row as ' + fmt.money(recomputed) + verdict + ' This is an estimate, not a price.' })
    ));
    var items = (row.farm_steps || []).map(function (s) {
      var at = s.indexOf(' Cost: ');
      var action = at >= 0 ? s.slice(0, at) : s;
      var tail = at >= 0 ? s.slice(at + 1) : '';
      return el('li', null, el('b', { text: action }), el('span', { class: 'cost', text: tail }));
    });
    dialog.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Farm plan' }),
      el('ol', { class: 'steps' }, items)
    ));
    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
    }
  }

  // -- render -----------------------------------------------------------------------
  function render() {
    mount.textContent = '';
    var shell = el('div', { class: 'shell' });
    var sections = [buildHeader(), buildLede(), buildControls(), state.tab === 'pre-token' ? boardTable() : liveTable()];
    if (state.tab === 'pre-token') sections.push(modelPanel());
    var compare = compareSection();
    if (compare) sections.push(compare);
    sections.push(buildFooter());
    sections.forEach(function (s) { shell.appendChild(s); });
    mount.appendChild(shell);
    mount.setAttribute('aria-busy', 'false');
    if (!dialog.isConnected) mount.appendChild(dialog);
    if (state.selected) openDetail(state.selected);
  }

  readHash();
  render();
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && dialog.open) dialog.close();
  });
})();
