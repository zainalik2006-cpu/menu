/* Halal 4 All TV menu.
 * Reads the menu from a Google Sheet, draws one screen, and re-checks the sheet
 * every minute. If the sheet cannot be reached it keeps showing the last prices
 * it saw and turns the small dot in the top bar amber.
 *
 * Sheet columns, in this order: Screen, Column, Section, Item, Price, Tag, Show
 */
(function () {
  "use strict";

  var CFG = window.MENU_CONFIG || {};
  var SCREEN = Number(window.MENU_SCREEN) || 1;
  var REFRESH_MS = Math.max(15, Number(CFG.refreshSeconds) || 60) * 1000;
  var STALE_AFTER_MS = 5 * 60 * 1000;
  var CACHE_KEY = "h4a-menu-rows";
  var STAGE_W = 1920, STAGE_H = 1080;
  var MAX_ROW = 46;          // tallest a row is allowed to get, in px
  var FONT_RATIO = 0.72;     // text size as a share of row height

  var stage = document.getElementById("stage");
  var colsEl = document.getElementById("cols");
  var msgEl = document.getElementById("msg");
  var syncEl = document.getElementById("sync");
  var barContact = document.getElementById("bar-contact");

  var lastGood = 0;          // time of the last successful sheet read
  var shownKey = null;       // fingerprint of what is on screen now
  var currentRows = null;

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
      window.localStorage.setItem(key, value);
    } catch (e) { /* storage blocked: carry on without it */ }
    return null;
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

  /* ---------- turning sheet rows into a screen ---------- */

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

  // Returns [{sections: [{title, items: [{name, price}]}]}], one entry per used column.
  function buildScreen(rows) {
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
      c.byTitle["s:" + title].items.push({ name: name, price: parsePrice(r[4], r[5]) });
    }
    order.sort(function (a, b) { return a - b; });
    var out = [];
    for (var k = 0; k < order.length; k++) out.push({ sections: cols[order[k]].sections });
    return out;
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

  function render(rows) {
    var screen = buildScreen(rows);
    colsEl.textContent = "";
    msgEl.hidden = true;

    if (!screen.length) {
      msgEl.hidden = false;
      msgEl.textContent = "Nothing is set to show on Screen " + SCREEN +
        ". Check the Screen and Show columns in the menu sheet.";
      barContact.hidden = false;
      return;
    }

    for (var i = 0; i < screen.length; i++) {
      var colEl = el("div", "col");
      for (var s = 0; s < screen[i].sections.length; s++) {
        var sec = screen[i].sections[s];
        var secEl = el("div", "section");
        if (sec.title) secEl.appendChild(el("div", "section-title", sec.title));
        for (var k = 0; k < sec.items.length; k++) {
          var row = el("div", "item");
          row.appendChild(el("span", "name", sec.items[k].name));
          row.appendChild(el("span", "lead"));
          row.appendChild(priceNode(sec.items[k].price));
          secEl.appendChild(row);
        }
        colEl.appendChild(secEl);
      }
      colsEl.appendChild(colEl);
    }
    fit();
  }

  /* ---------- sizing: biggest text that fits every row on one screen ---------- */

  function colUnits(colEl) {
    var secs = colEl.querySelectorAll(".section");
    var u = 0;
    for (var i = 0; i < secs.length; i++) {
      u += secs[i].querySelectorAll(".item").length;
      if (secs[i].querySelector(".section-title")) u += 1.35;
      if (i > 0) u += 0.5;
    }
    return u;
  }

  function colNeed(colEl, index, count) {
    var widest = 0;
    var items = colEl.querySelectorAll(".item");
    for (var i = 0; i < items.length; i++) {
      var w = items[i].querySelector(".name").offsetWidth +
              items[i].querySelector(".price").offsetWidth + 16 + 14;
      if (w > widest) widest = w;
    }
    var titles = colEl.querySelectorAll(".section-title");
    for (var t = 0; t < titles.length; t++) {
      if (titles[t].scrollWidth > widest) widest = titles[t].scrollWidth;
    }
    var pad = (index === 0 ? 0 : 22) + (index === count - 1 ? 0 : 22) + (index === 0 ? 0 : 2);
    return widest + pad;
  }

  function fit() {
    var colEls = colsEl.querySelectorAll(".col");
    var n = colEls.length;
    if (!n) return;

    var old = document.getElementById("card");
    if (old) old.parentNode.removeChild(old);

    var availH = colsEl.clientHeight, availW = colsEl.clientWidth;
    var maxUnits = 1, i;
    for (i = 0; i < n; i++) maxUnits = Math.max(maxUnits, colUnits(colEls[i]));

    var row = Math.min(MAX_ROW, Math.floor((availH / maxUnits) * 100) / 100);
    var fs = row * FONT_RATIO;
    var needs = [], total = 0, pass;

    colsEl.style.gridTemplateColumns = "repeat(" + n + ", max-content)";
    for (pass = 0; pass < 5; pass++) {
      stage.style.setProperty("--row", row + "px");
      stage.style.setProperty("--fs", fs + "px");
      stage.style.setProperty("--ts", Math.min(row * 0.86, fs * 1.3) + "px");
      needs = []; total = 0;
      for (i = 0; i < n; i++) { needs.push(colNeed(colEls[i], i, n)); total += needs[i]; }
      if (total <= availW) break;
      fs = fs * (availW / total) * 0.99;      // too wide: shrink the text, keep the rows
    }

    var spare = Math.max(0, availW - total) / n;
    var widths = [];
    for (i = 0; i < n; i++) widths.push((needs[i] + spare).toFixed(2) + "px");
    colsEl.style.gridTemplateColumns = widths.join(" ");

    placeCard(colEls, availH, row);
  }

  function shrinkToFit(node, size) {
    while (node.scrollWidth > node.clientWidth && size > 22) {
      size -= 1;
      node.style.fontSize = size + "px";
    }
  }

  // Put the website and phone number in the column with the most empty room.
  // If no column has room, they go in the top bar instead.
  function placeCard(colEls, availH, row) {
    var best = -1, bestFree = 0;
    for (var i = 0; i < colEls.length; i++) {
      var last = colEls[i].lastElementChild;
      var free = availH - (last ? last.offsetTop + last.offsetHeight : 0);
      if (free >= bestFree) { bestFree = free; best = i; }
    }
    barContact.hidden = false;
    if (best < 0 || !(CFG.website || CFG.phone)) return;

    var card = el("div", "");
    card.id = "card";
    card.appendChild(el("div", "lbl", "Order online"));
    var site = el("div", "site", CFG.website || "");
    card.appendChild(site);
    if (CFG.phone) card.appendChild(el("div", "phone", CFG.phone));
    colEls[best].appendChild(card);

    shrinkToFit(site, 44);
    if (card.lastChild !== site) shrinkToFit(card.lastChild, 40);
    if (card.offsetHeight + row * 1.5 > bestFree) {
      card.parentNode.removeChild(card);       // not enough room: keep it in the top bar
    } else {
      barContact.hidden = true;
    }
  }

  /* ---------- top bar ---------- */

  var DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
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

  /* ---------- keeping the TV awake, full screen on OK button ---------- */

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
      if (req && !(document.fullscreenElement || document.webkitFullscreenElement)) req.call(d);
    } catch (e) { /* ignore */ }
    stayAwake();
  }

  /* ---------- main loop ---------- */

  function show(rows) {
    var key = JSON.stringify(rows);
    currentRows = rows;
    if (key !== shownKey) {
      shownKey = key;
      render(rows);
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

  function start() {
    fillBar();
    scaleStage();
    tick();

    var saved = store(CACHE_KEY);
    if (saved) {
      try { show(JSON.parse(saved)); } catch (e) { /* bad saved copy: ignore */ }
    }

    refresh();
    setInterval(refresh, REFRESH_MS);
    setInterval(tick, 5000);

    window.addEventListener("resize", scaleStage);
    document.addEventListener("click", goFullScreen);
    document.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.keyCode === 13) goFullScreen();
    });
    document.addEventListener("visibilitychange", stayAwake);
    stayAwake();

    // Text is measured to size the layout, so measure again once the fonts are in.
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(function () { if (currentRows) fit(); });
    }
  }

  start();
})();
