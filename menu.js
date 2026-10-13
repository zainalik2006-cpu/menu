/* Halal 4 All TV menu.
 * Reads the menu from a Google Sheet, draws one screen, and re-checks the sheet
 * every minute. If the sheet cannot be reached it keeps showing the last prices
 * it saw and turns the small dot in the top bar amber.
 *
 * Text size is adjustable per TV by choosing how many pages the screen may
 * use. One page shows everything at once. More pages means bigger text, and
 * the pages rotate.
 *
 * Sheet columns, in this order: Screen, Column, Section, Item, Price, Tag, Show
 */
(function () {
  "use strict";

  var VERSION = window.MENU_VERSION || "";   // the site version this page loaded with

  var CFG = window.MENU_CONFIG || {};
  var SCREEN = Number(window.MENU_SCREEN) || 1;
  var REFRESH_MS = Math.max(15, Number(CFG.refreshSeconds) || 60) * 1000;
  var STALE_AFTER_MS = 5 * 60 * 1000;
  var VERSION_CHECK_MS = 5 * 60 * 1000;
  var CACHE_KEY = "h4a-menu-rows";

  /* Geometry of the fixed 1920x1080 canvas. These match menu.css. */
  var STAGE_W = 1920, STAGE_H = 1080;
  var BODY_W = 1864;         // stage width minus side padding
  var BODY_H = 976;          // stage height minus top bar and bottom padding
  var COL_GAP = 14;          // space between column panels
  var PANEL_PAD = 10;        // padding inside a column panel
  var ITEM_PAD = 12;         // padding at each end of an item row

  /* Vertical rhythm, measured in rows. */
  var U_HEAD = 1.4;          // section heading: 1.2 tall + 0.2 gap below
  var U_GAP = 0.45;          // gap between two sections
  var TIGHT = 0.8;           // text size / row height when space is short
  var LOOSE = 0.58;          // text size / row height when there is room
  var NAME_GAP = 0.8;        // least space between a name and its price, in em

  var MAX_PAGES = 6;
  var MAX_TEXT = 96;         // largest text size the search will try, in px

  var NAME_FONT = '600 100px "Barlow Semi Condensed"';
  var PRICE_FONT = '700 100px "Barlow Semi Condensed"';
  var SMALL_FONT = '600 100px "Barlow Semi Condensed"';
  var TITLE_FONT = '700 100px "Zilla Slab"';

  var stage = document.getElementById("stage");
  var colsEl = document.getElementById("cols");
  var msgEl = document.getElementById("msg");
  var syncEl = document.getElementById("sync");
  var pipsEl = document.getElementById("pips");
  var progressEl = document.getElementById("progress");
  var barContact = document.getElementById("bar-contact");

  var lastGood = 0;          // time of the last successful sheet read
  var shownKey = null;       // fingerprint of what is on screen now
  var currentRows = null;
  var pages = [];            // [{el, hasCard}]
  var pageIndex = 0;
  var pageTimer = null;
  var sizeLevel = 0;         // 0 = one page, 1 = up to two pages, and so on
  var maxLevel = 0;          // highest level that still makes the text bigger
  var pageSeconds = 12;
  var layoutInfo = { fs: 0, pages: 1 };
  var titleCache = {};

  /* ---------- small helpers ---------- */

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function store(key, value) {
    try {
      if (value === undefined) return window.localStorage.getItem(key);
      window.localStorage.setItem(key, String(value));
    } catch (e) { /* storage blocked: carry on without it */ }
    return null;
  }

  function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

  var measureCtx = null;
  function em(text, font) {
    if (!measureCtx) measureCtx = document.createElement("canvas").getContext("2d");
    measureCtx.font = font;
    return measureCtx.measureText(text).width / 100;
  }

  /* ---------- reading the sheet ---------- */

  function sheetUrl(handler) {
    var tqx = "out:json" + (handler ? ";responseHandler:" + handler : "");
    return "https://docs.google.com/spreadsheets/d/" + encodeURIComponent(CFG.sheetId) +
      "/gviz/tq?headers=1&tqx=" + tqx + "&_=" + Date.now();
  }

  function tableToRows(resp) {
    if (!resp || resp.status === "error" || !resp.table || !resp.table.rows) {
      throw new Error("Sheet did not return a table");
    }
    var out = [];
    var rows = resp.table.rows;
    for (var i = 0; i < rows.length; i++) {
      var c = (rows[i] && rows[i].c) || [];
      var r = [];
      for (var j = 0; j < 7; j++) r.push(c[j] && c[j].v != null ? c[j].v : null);
      out.push(r);
    }
    return out;
  }

  function viaFetch() {
    return fetch(sheetUrl(null), { cache: "no-store", credentials: "omit" })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.text();
      })
      .then(function (text) {
        var a = text.indexOf("{"), b = text.lastIndexOf("}");
        if (a < 0 || b < 0) throw new Error("Not a sheet response");
        return tableToRows(JSON.parse(text.slice(a, b + 1)));
      });
  }

  function viaScript() {
    return new Promise(function (resolve, reject) {
      var name = "h4aSheet" + Date.now();
      var tag = document.createElement("script");
      var timer = setTimeout(function () { done(new Error("Timed out")); }, 15000);
      function done(err, rows) {
        clearTimeout(timer);
        try { delete window[name]; } catch (e) { window[name] = undefined; }
        if (tag.parentNode) tag.parentNode.removeChild(tag);
        if (err) reject(err); else resolve(rows);
      }
      window[name] = function (resp) {
        try { done(null, tableToRows(resp)); } catch (e) { done(e); }
      };
      tag.onerror = function () { done(new Error("Could not load sheet")); };
      tag.src = sheetUrl(name);
      document.head.appendChild(tag);
    });
  }

  function readSheet() {
    if (!CFG.sheetId) return Promise.reject(new Error("No sheet set in config.js"));
    var first = window.fetch ? viaFetch() : Promise.reject(new Error("no fetch"));
    return first.catch(function () { return viaScript(); });
  }

  /* ---------- turning sheet rows into a menu ---------- */

  function parsePrice(v, tag) {
    var out = { amount: null, word: "", unit: "" };
    tag = tag == null ? "" : String(tag).trim();
    if (typeof v === "number" && isFinite(v)) {
      out.amount = v;
    } else if (v != null && String(v).trim() !== "") {
      var s = String(v).trim().replace(/^\$\s*/, "");
      var m = s.match(/^(\d+(?:\.\d+)?)\s*(?:\/\s*(.+))?$/);
      if (m) {
        out.amount = Number(m[1]);
        if (m[2] && !tag) tag = m[2];
      } else {
        out.word = s;                      // e.g. someone typed MP in the Price cell
      }
    }
    if (out.amount == null) {
      if (!out.word) out.word = tag;       // Price empty, Tag says MP
    } else {
      out.unit = tag;
    }
    return out;
  }

  function isHidden(v) {
    return v != null && /^(no|n|false|0|hide|hidden|off|x)$/i.test(String(v).trim());
  }

  // Returns one entry per used sheet column: [[{title, items: [{name, price}]}]]
  function buildMenu(rows) {
    var cols = {}, order = [], lastCol = 1;
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (Number(r[0]) !== SCREEN) continue;           // also skips a stray header row
      var name = r[3] == null ? "" : String(r[3]).trim();
      if (!name || isHidden(r[6])) continue;
      var col = Math.round(Number(r[1]));
      if (!(col >= 1 && col <= 4)) col = lastCol;
      lastCol = col;
      var title = r[2] == null ? "" : String(r[2]).trim();
      if (!cols[col]) { cols[col] = { sections: [], byTitle: {} }; order.push(col); }
      var c = cols[col];
      if (!c.byTitle["s:" + title]) {
        c.byTitle["s:" + title] = { title: title, items: [] };
        c.sections.push(c.byTitle["s:" + title]);
      }
      var price = parsePrice(r[4], r[5]);
      c.byTitle["s:" + title].items.push({ name: name, price: price, need: itemNeed(name, price) });
    }
    order.sort(function (a, b) { return a - b; });
    var out = [];
    for (var k = 0; k < order.length; k++) out.push(cols[order[k]].sections);
    return out;
  }

  // Width an item needs, in em of the item text size (padding is added later).
  function itemNeed(name, p) {
    var w = em(name, NAME_FONT) + NAME_GAP;
    if (p.amount != null) {
      w += 0.72 * em("$", SMALL_FONT) + em(p.amount.toFixed(2), PRICE_FONT) + 0.06;
      if (p.unit) w += 0.68 * em("/" + p.unit.toLowerCase(), SMALL_FONT) + 0.1;
    } else if (p.word) {
      w += em(p.word, PRICE_FONT) + 0.08;
    }
    return w * 1.02;                                   // small safety margin
  }

  /* ---------- layout: sizes, columns, pages ---------- */

  function sectionUnits(sec) { return (sec.title ? U_HEAD : 0) + sec.items.length; }

  function columnUnits(sections) {
    var u = 0;
    for (var i = 0; i < sections.length; i++) u += sectionUnits(sections[i]) + (i ? U_GAP : 0);
    return u;
  }

  function titleNeed(text) {
    if (titleCache[text] == null) titleCache[text] = em(text, TITLE_FONT) * 1.2 + 1.3;
    return titleCache[text];
  }

  // Width a column needs: {em: part that grows with text size, px: fixed part}
  function columnNeed(sections) {
    var widest = 0;
    for (var i = 0; i < sections.length; i++) {
      var t = sections[i].title ? titleNeed(sections[i].title + (sections[i].cont ? " (cont.)" : "")) : 0;
      if (t > widest) widest = t;
      for (var k = 0; k < sections[i].items.length; k++) {
        if (sections[i].items[k].need > widest) widest = sections[i].items[k].need;
      }
    }
    return { em: widest, px: 2 * PANEL_PAD + 2 * ITEM_PAD };
  }

  // Split one sheet column into as many on-screen columns as its length needs.
  // `cap` is the hard limit in rows; `soft` is the length to aim for so the
  // pieces come out even.
  function splitColumn(sections, cap, soft) {
    var out = [[]], used = 0;
    for (var s = 0; s < sections.length; s++) {
      var sec = sections[s];
      var head = sec.title ? U_HEAD : 0;
      var items = sec.items.slice();
      var first = true;
      while (items.length) {
        var cur = out[out.length - 1];
        var gap = cur.length ? U_GAP : 0;
        var room = Math.floor(cap - used - gap - head + 1e-6);   // items that can fit
        var aim = Math.floor(soft - used - gap - head + 1e-6);   // items to aim for
        var n = items.length;
        var take;
        if (n <= aim || (n <= room && n - aim <= 2)) take = n;
        else take = Math.min(room, Math.max(aim, 2));
        // Never leave a single item on its own in the next column.
        if (take < n && n - take === 1) take = take + 1 <= room ? n : take - 1;
        // A section that has to be split should not start with just a few items
        // at the foot of a column: start it at the top of the next one instead.
        var stub = first && take < n && take < Math.min(5, n);
        if (take < Math.min(2, n) || stub) {
          if (cur.length) { out.push([]); used = 0; continue; }
          take = Math.max(1, Math.min(n, room));
        }
        cur.push({ title: sec.title, cont: !first, items: items.splice(0, take) });
        used += gap + head + take;
        first = false;
        if (items.length) { out.push([]); used = 0; }
      }
    }
    return out;
  }

  function splitAll(menu, cap) {
    var cols = [];
    for (var i = 0; i < menu.length; i++) {
      var hard = splitColumn(menu[i], cap, cap);
      var pieces = hard;
      if (hard.length > 1) {
        // Second pass: aim for even pieces, allowing for the repeated headings.
        var total = 0;
        for (var h = 0; h < hard.length; h++) total += columnUnits(hard[h]);
        var even = splitColumn(menu[i], cap, total / hard.length + 0.5);
        if (even.length <= hard.length) pieces = even;
      }
      for (var p = 0; p < pieces.length; p++) cols.push(pieces[p]);
    }
    return cols;
  }

  function widthOf(needs, from, to, fs) {
    var w = 0;
    for (var i = from; i < to; i++) w += needs[i].em * fs + needs[i].px;
    return w + (to - from - 1) * COL_GAP;
  }

  // Group columns into pages that fit the screen width, as evenly as possible.
  function paginate(needs, fs) {
    var greedy = [], start = 0, i;
    for (i = 1; i <= needs.length; i++) {
      if (i === needs.length || widthOf(needs, start, i + 1, fs) > BODY_W) {
        greedy.push([start, i]);
        start = i;
      }
    }
    var P = greedy.length, n = needs.length;
    if (P < 2) return greedy;
    var even = [], at = 0;
    for (i = 0; i < P; i++) {
      var size = Math.floor(n / P) + (i < n % P ? 1 : 0);
      if (widthOf(needs, at, at + size, fs) > BODY_W) return greedy;
      even.push([at, at + size]);
      at += size;
    }
    return even;
  }

  // Work out columns and pages for one text size. Returns null if a column
  // would be wider than the screen at that size.
  function plan(menu, fs, usableH) {
    var cols = splitAll(menu, usableH / (fs / TIGHT));
    var needs = [];
    for (var i = 0; i < cols.length; i++) {
      needs.push(columnNeed(cols[i]));
      if (needs[i].em * fs + needs[i].px > BODY_W) return null;
    }
    return { cols: cols, needs: needs, ranges: paginate(needs, fs), fs: fs };
  }

  // Biggest text that keeps the whole menu within `limit` pages.
  function bestPlan(menu, limit, fitFs, usableH) {
    var best = plan(menu, fitFs, usableH);
    var lo = fitFs, hi = MAX_TEXT;
    for (var i = 0; i < 16; i++) {
      var mid = (lo + hi) / 2;
      var p = plan(menu, mid, usableH);
      if (p && p.ranges.length <= limit) { best = p; lo = mid; } else { hi = mid; }
    }
    return best;
  }

  function layout() {
    if (!currentRows) return;
    var menu = buildMenu(currentRows);
    clearPages();

    if (!menu.length) {
      msgEl.hidden = false;
      msgEl.textContent = "Nothing is set to show on Screen " + SCREEN +
        ". Check the Screen and Show columns in the menu sheet.";
      barContact.hidden = false;
      layoutInfo = { fs: 0, pages: 0 };
      maxLevel = 0;
      drawPips();
      updateControls();
      return;
    }
    msgEl.hidden = true;

    var usableH = BODY_H - 2 * PANEL_PAD;
    var i;

    // 1. One page: the sheet's own columns, with the biggest text that fits.
    var maxUnits = 1, sumEm = 0, sumPx = (menu.length - 1) * COL_GAP, needs0 = [];
    for (i = 0; i < menu.length; i++) {
      maxUnits = Math.max(maxUnits, columnUnits(menu[i]));
      needs0.push(columnNeed(menu[i]));
      sumEm += needs0[i].em; sumPx += needs0[i].px;
    }
    var fitFs = Math.min((usableH / maxUnits) * TIGHT, (BODY_W - sumPx) / sumEm);
    var plans = [{ cols: menu, needs: needs0, ranges: [[0, menu.length]], fs: fitFs }];

    // 2. More pages: each extra page is only offered if it makes the text bigger.
    for (i = 1; i < MAX_PAGES; i++) {
      var p = bestPlan(menu, i + 1, fitFs, usableH);
      if (!p || p.fs < plans[plans.length - 1].fs * 1.04) break;
      plans.push(p);
    }
    maxLevel = plans.length - 1;
    var chosen = plans[Math.min(sizeLevel, maxLevel)];
    var fs = chosen.fs, cols = chosen.cols;

    // 3. Row height: fill the screen height, without letting rows get too airy.
    var longest = 1;
    for (i = 0; i < cols.length; i++) longest = Math.max(longest, columnUnits(cols[i]));
    var row = Math.min(fs / LOOSE, usableH / longest);
    row = Math.floor(row * 100) / 100;

    setSizes(fs, row);
    for (i = 0; i < chosen.ranges.length; i++) drawPage(cols, chosen.needs, chosen.ranges[i], fs);

    // 4. Safety net: if any row is still too wide on the real screen, shrink the text.
    var worst = 1;
    var items = colsEl.querySelectorAll(".item");
    for (i = 0; i < items.length; i++) {
      if (items[i].scrollWidth > items[i].clientWidth + 0.5) {
        worst = Math.min(worst, items[i].clientWidth / items[i].scrollWidth);
      }
    }
    if (worst < 1) { fs = fs * worst * 0.985; setSizes(fs, row); }

    for (i = 0; i < pages.length; i++) placeCard(pages[i], row);

    layoutInfo = { fs: fs, pages: pages.length };
    drawPips();
    showPage(Math.min(pageIndex, pages.length - 1), true);
    updateControls();
  }

  function setSizes(fs, row) {
    stage.style.setProperty("--row", row + "px");
    stage.style.setProperty("--fs", fs + "px");
    stage.style.setProperty("--ts", Math.min(row * 0.8, fs * 1.2) + "px");
  }

  function clearPages() {
    for (var i = 0; i < pages.length; i++) {
      if (pages[i].el.parentNode) pages[i].el.parentNode.removeChild(pages[i].el);
    }
    pages = [];
  }

  function priceNode(p) {
    var n = el("span", "price");
    if (p.amount != null) {
      n.appendChild(el("span", "cur", "$"));
      n.appendChild(document.createTextNode(p.amount.toFixed(2)));
      if (p.unit) n.appendChild(el("span", "unit", "/" + p.unit.toLowerCase()));
    } else if (p.word) {
      n.className = "price word";
      n.textContent = p.word;
    }
    return n;
  }

  function drawPage(cols, needs, range, fs) {
    var pageEl = el("div", "page");
    var count = range[1] - range[0];
    var spare = Math.max(0, BODY_W - widthOf(needs, range[0], range[1], fs)) / count;
    var widths = [];
    for (var i = range[0]; i < range[1]; i++) {
      widths.push((needs[i].em * fs + needs[i].px + spare).toFixed(2) + "px");
      var colEl = el("div", "col");
      for (var s = 0; s < cols[i].length; s++) {
        var sec = cols[i][s];
        var secEl = el("div", "section");
        if (sec.title) {
          var t = el("div", "section-title", sec.title);
          if (sec.cont) t.appendChild(el("span", "cont", " (cont.)"));
          secEl.appendChild(t);
        }
        for (var k = 0; k < sec.items.length; k++) {
          var rowEl = el("div", k % 2 ? "item alt" : "item");
          rowEl.appendChild(el("span", "name", sec.items[k].name));
          rowEl.appendChild(priceNode(sec.items[k].price));
          secEl.appendChild(rowEl);
        }
        colEl.appendChild(secEl);
      }
      pageEl.appendChild(colEl);
    }
    pageEl.style.gridTemplateColumns = widths.join(" ");
    colsEl.appendChild(pageEl);
    pages.push({ el: pageEl, hasCard: false });
  }

  function shrinkToFit(node, size) {
    while (node.scrollWidth > node.clientWidth && size > 22) {
      size -= 1;
      node.style.fontSize = size + "px";
    }
  }

  // Put the website and phone number in the column with the most empty room.
  // If no column on the page has room, they show in the top bar instead.
  function placeCard(page, row) {
    if (!(CFG.website || CFG.phone)) return;
    var colEls = page.el.querySelectorAll(".col");
    var best = -1, bestFree = 0;
    for (var i = 0; i < colEls.length; i++) {
      var last = colEls[i].lastElementChild;
      var free = colEls[i].clientHeight - PANEL_PAD - (last ? last.offsetTop + last.offsetHeight : 0);
      if (free >= bestFree) { bestFree = free; best = i; }
    }
    if (best < 0) return;

    var card = el("div", "card");
    card.appendChild(el("div", "lbl", "Order online"));
    var site = el("div", "site", CFG.website || "");
    card.appendChild(site);
    if (CFG.phone) card.appendChild(el("div", "phone", CFG.phone));
    colEls[best].appendChild(card);

    shrinkToFit(site, 42);
    if (card.lastChild !== site) shrinkToFit(card.lastChild, 38);
    if (card.offsetHeight + row * 1.2 > bestFree) {
      card.parentNode.removeChild(card);
    } else {
      page.hasCard = true;
    }
  }

  /* ---------- pages ---------- */

  function drawPips() {
    pipsEl.textContent = "";
    pipsEl.hidden = pages.length < 2;
    for (var i = 0; i < pages.length && pages.length > 1; i++) pipsEl.appendChild(el("i", ""));
  }

  function showPage(index, instant) {
    if (!pages.length) return;
    pageIndex = ((index % pages.length) + pages.length) % pages.length;
    for (var i = 0; i < pages.length; i++) {
      pages[i].el.className = "page" + (i === pageIndex ? " on" : "") + (instant ? " instant" : "");
      if (pipsEl.children[i]) pipsEl.children[i].className = i === pageIndex ? "on" : "";
    }
    barContact.hidden = pages[pageIndex].hasCard;

    clearTimeout(pageTimer);
    progressEl.className = "";
    if (pages.length > 1) {
      void progressEl.offsetWidth;                     // restart the progress bar
      progressEl.style.setProperty("--secs", pageSeconds + "s");
      progressEl.className = "run";
      pageTimer = setTimeout(function () { showPage(pageIndex + 1); }, pageSeconds * 1000);
    }
  }

  /* ---------- text size controls (move the cursor or press OK to show) ---------- */

  var controls = null, controlsTimer = null, sizeLabel = null, secsLabel = null;

  function button(label, title, fn) {
    var b = el("button", "", label);
    b.type = "button";
    b.setAttribute("aria-label", title);
    b.addEventListener("click", function (e) { e.stopPropagation(); fn(); wakeControls(); });
    return b;
  }

  function buildControls() {
    controls = el("div", "");
    controls.id = "controls";

    var g1 = el("div", "group");
    g1.appendChild(el("span", "cap", "Text size"));
    g1.appendChild(button("−", "Smaller text", function () { bumpSize(-1); }));
    sizeLabel = el("span", "val", "");
    g1.appendChild(sizeLabel);
    g1.appendChild(button("+", "Bigger text", function () { bumpSize(1); }));

    var g2 = el("div", "group");
    g2.appendChild(el("span", "cap", "Seconds per page"));
    g2.appendChild(button("−", "Fewer seconds per page", function () { setSeconds(pageSeconds - 2); }));
    secsLabel = el("span", "val", "");
    g2.appendChild(secsLabel);
    g2.appendChild(button("+", "More seconds per page", function () { setSeconds(pageSeconds + 2); }));

    var g3 = el("div", "group");
    g3.appendChild(button("Full screen", "Full screen", goFullScreen));

    controls.appendChild(g1);
    controls.appendChild(g2);
    controls.appendChild(g3);
    stage.appendChild(controls);
  }

  function updateControls() {
    if (!controls) return;
    var n = layoutInfo.pages;
    sizeLabel.textContent = n <= 1 ? "1 page" : n + " pages, rotating";
    secsLabel.textContent = pageSeconds + "s";
  }

  function wakeControls() {
    if (!controls) return;
    controls.className = "on";
    document.documentElement.className = "pointing";
    clearTimeout(controlsTimer);
    controlsTimer = setTimeout(function () {
      controls.className = "";
      document.documentElement.className = "";
    }, 6000);
  }

  function bumpSize(by) { setSize(Math.min(sizeLevel, maxLevel) + by); }

  function setSize(level) {
    level = clamp(level, 0, maxLevel);
    if (level === Math.min(sizeLevel, maxLevel)) return;
    sizeLevel = level;
    store("h4a-size-" + SCREEN, level);
    pageIndex = 0;
    layout();
  }

  function setSeconds(s) {
    pageSeconds = clamp(s, 6, 40);
    store("h4a-page-seconds", pageSeconds);
    updateControls();
    showPage(pageIndex, true);
  }

  function loadSettings() {
    var q = window.location.search;
    var m = q.match(/[?&]pages=(\d+)/);
    var saved = store("h4a-size-" + SCREEN);
    var level = m ? Number(m[1]) - 1 : saved != null ? Number(saved) : Number(CFG.pages || 1) - 1;
    sizeLevel = clamp(isFinite(level) ? Math.round(level) : 0, 0, MAX_PAGES - 1);
    if (m) store("h4a-size-" + SCREEN, sizeLevel);

    var secs = Number(store("h4a-page-seconds")) || Number(CFG.pageSeconds) || 12;
    pageSeconds = clamp(Math.round(secs), 6, 40);
  }

  /* ---------- top bar ---------- */

  var DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  function tick() {
    var d = new Date();
    var h = d.getHours(), m = d.getMinutes();
    var hh = h % 12 === 0 ? 12 : h % 12;
    document.getElementById("time").textContent =
      hh + ":" + (m < 10 ? "0" + m : m) + (h < 12 ? " AM" : " PM");
    document.getElementById("date").textContent =
      DAYS[d.getDay()] + ", " + MONTHS[d.getMonth()] + " " + d.getDate();

    syncEl.className = Date.now() - lastGood > STALE_AFTER_MS ? "stale" : "";

    // Fresh start once a night so a TV that is never turned off stays healthy.
    var today = d.toDateString();
    if (h === 4 && m === 30 && navigator.onLine !== false && store("h4a-reloaded") !== today) {
      store("h4a-reloaded", today);
      window.location.reload();
    }
  }

  function fillBar() {
    document.getElementById("brand").textContent = CFG.storeName || "";
    document.getElementById("bar-note").textContent = CFG.note || "";
    barContact.textContent = "";
    if (CFG.website) barContact.appendChild(el("span", "", CFG.website));
    if (CFG.phone) barContact.appendChild(el("span", "", CFG.phone));
  }

  /* ---------- fitting the 1920x1080 canvas to the TV ---------- */

  function scaleStage() {
    var s = Math.min(window.innerWidth / STAGE_W, window.innerHeight / STAGE_H);
    stage.style.transform = "translate(-50%, -50%) scale(" + s + ")";
  }

  /* ---------- keeping the TV awake, full screen ---------- */

  function stayAwake() {
    try {
      if (navigator.wakeLock && document.visibilityState === "visible") {
        navigator.wakeLock.request("screen").catch(function () {});
      }
    } catch (e) { /* not supported on this browser */ }
  }

  function goFullScreen() {
    try {
      var d = document.documentElement;
      var req = d.requestFullscreen || d.webkitRequestFullscreen;
      if (req && !(document.fullscreenElement || document.webkitFullscreenElement)) {
        var p = req.call(d);
        if (p && p.catch) p.catch(function () {});
      }
    } catch (e) { /* ignore */ }
    stayAwake();
  }

  /* ---------- picking up new versions of the site without touching the TV ---------- */

  function checkVersion() {
    if (!window.fetch) return;
    fetch("../version.txt?_=" + Date.now(), { cache: "no-store" })
      .then(function (res) { return res.ok ? res.text() : ""; })
      .then(function (text) {
        var latest = text.replace(/\s+/g, "");
        if (!latest || latest === VERSION || !/^[\w.-]{1,40}$/.test(latest)) return;
        var tried = null;
        try { tried = window.sessionStorage.getItem("h4a-tried"); } catch (e) { /* ignore */ }
        if (tried === latest) return;                  // already tried this one: do not loop
        try { window.sessionStorage.setItem("h4a-tried", latest); } catch (e) { /* ignore */ }
        window.location.replace(window.location.pathname + "?r=" + Date.now());
      })
      .catch(function () {});
  }

  /* ---------- main loop ---------- */

  function show(rows) {
    var key = JSON.stringify(rows);
    currentRows = rows;
    if (key !== shownKey) {
      shownKey = key;
      layout();
    }
    stage.className = "ready";
  }

  function refresh() {
    return readSheet().then(function (rows) {
      lastGood = Date.now();
      store(CACHE_KEY, JSON.stringify(rows));
      show(rows);
      tick();
    }).catch(function () {
      // Keep whatever is on screen. On a first-ever load with no saved copy,
      // fall back to the menu that shipped with the page.
      if (!currentRows && window.MENU_BACKUP) show(window.MENU_BACKUP);
      tick();
    });
  }

  function fontsReady() {
    if (!document.fonts || !document.fonts.load) return Promise.resolve();
    var all = Promise.all([
      document.fonts.load(NAME_FONT), document.fonts.load(PRICE_FONT), document.fonts.load(TITLE_FONT)
    ]).catch(function () {});
    var giveUp = new Promise(function (resolve) { setTimeout(resolve, 4000); });
    return Promise.race([all, giveUp]);
  }

  function start() {
    loadSettings();
    fillBar();
    buildControls();
    scaleStage();
    tick();

    window.addEventListener("resize", scaleStage);
    document.addEventListener("mousemove", wakeControls);
    document.addEventListener("click", function () { goFullScreen(); wakeControls(); });
    document.addEventListener("keydown", function (e) {
      var k = e.key;
      if (k === "ArrowUp" || k === "+" || k === "=") bumpSize(1);
      else if (k === "ArrowDown" || k === "-") bumpSize(-1);
      else if (k === "ArrowRight") showPage(pageIndex + 1);
      else if (k === "ArrowLeft") showPage(pageIndex - 1);
      else if (k === "Enter" || e.keyCode === 13) goFullScreen();
      wakeControls();
    });
    document.addEventListener("visibilitychange", stayAwake);
    stayAwake();

    // Text is measured to plan the layout, so wait for the fonts first.
    fontsReady().then(function () {
      var saved = store(CACHE_KEY);
      if (saved) {
        try { show(JSON.parse(saved)); } catch (e) { /* bad saved copy: ignore */ }
      }
      refresh();
      setInterval(refresh, REFRESH_MS);
      setInterval(tick, 5000);
      setInterval(checkVersion, VERSION_CHECK_MS);
      setTimeout(checkVersion, 20000);
    });
  }

  start();
})();
