/* 毎木確認 (現地用)。解析アプリが書き出した .forest.json を読み、地形図の上に木を描いて、
 * 木ごとの樹種・枯死木・食痕・ナラ枯れ・備考をこの端末 (IndexedDB) に記録する。何も送信しない。
 * 座標はデータの基準点からの m (東 = x、北 = y)。GPS の緯度経度は基準点での線形変換で m にする。 */
"use strict";

// 樹種の区分 (地図の色)。その他針葉樹・その他広葉樹は樹種名を選ぶか書いて残す
const SP_COLORS = { "スギ": "#1b7a3a", "ヒノキ": "#1f77b4", "アカマツ": "#d95f02", "その他針葉樹": "#00897b", "その他広葉樹": "#c99a00" };
const SP_CATS = Object.keys(SP_COLORS);
const SP_NAMES = {   // 近畿の山地でよく出る樹種 (一覧に無ければ書く)
  "その他針葉樹": ["モミ", "ツガ", "クロマツ", "カラマツ", "コウヤマキ", "カヤ", "イヌガヤ", "サワラ", "イチイ", "ネズミサシ"],
  "その他広葉樹": ["コナラ", "クヌギ", "アベマキ", "ミズナラ", "クリ", "ヤマザクラ", "ケヤキ", "ブナ", "イヌシデ", "アカシデ",
    "リョウブ", "ソヨゴ", "アラカシ", "シラカシ", "ウラジロガシ", "ツブラジイ", "ヤブツバキ", "ヒサカキ", "タカノツメ",
    "コシアブラ", "ホオノキ", "エゴノキ", "ネジキ", "ウリハダカエデ", "イロハモミジ", "クロモジ", "アオハダ", "ヤマウルシ"],
};
// 解析の樹種 (林相区分図・樹種区分のメッシュ = 林分単位の推定) -> 区分
const SP_FROM_ANALYSIS = { "スギ": "スギ", "ヒノキ": "ヒノキ", "アカマツ": "アカマツ", "マツ": "アカマツ", "クロマツ": "その他針葉樹",
  "広葉樹": "その他広葉樹", "広葉樹Ⅱ": "その他広葉樹" };
const UNKNOWN_COLOR = "#8a8a8a";
const FLAG_COLORS = { bite: "#e53935", nara: "#6d4c41", other: "#222" };
// 記録する項目 (毎木調査と、その後の解析 = 検出の検証・樹高曲線・材積・iLand で使うもの)。
// key は記録 (IndexedDB・バックアップ JSON) の名前なので変えない。bad = 地図で目立たせる
const FLAG_GROUPS = [
  { title: "状態", items: [["dead", "枯死木", 1], ["fallen", "倒木・根返り", 1], ["broken", "幹折れ"], ["topkill", "梢端折れ・枯れ"], ["lean", "傾斜木"]] },
  { title: "被害", items: [["bite", "食痕 (剥皮など)", 1], ["nara", "ナラ枯れ", 1], ["bore", "穿孔・フラス"], ["rot", "腐朽・キノコ"], ["vine", "つる被害"]] },
  { title: "形", items: [["multi", "株立ち・多幹"], ["fork", "二股 (胸高より下)"]] },
];
const FLAG_KEYS = FLAG_GROUPS.flatMap((g) => g.items.map((i) => i[0]));
const FLAG_LABEL = Object.fromEntries(FLAG_GROUPS.flatMap((g) => g.items.map((i) => [i[0], i[1]])));
const CROWN = ["優勢", "準優勢", "介在", "被圧"];
const STRATA = ["高木", "亜高木", "低木"];
const LAYER_COLORS = ["#c2185b", "#ef6c00", "#00897b", "#3949ab", "#6d4c41"];
const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- 保存 (IndexedDB)
const DB = {
  db: null,
  open() {
    if (this.db) return Promise.resolve(this.db);
    return new Promise((ok, ng) => {
      const r = indexedDB.open("forestfield", 1);
      r.onupgradeneeded = () => {
        const db = r.result;
        db.createObjectStore("sites", { keyPath: "id" });
        db.createObjectStore("records", { keyPath: "key" }).createIndex("site", "site");
        db.createObjectStore("tracks", { autoIncrement: true }).createIndex("site", "site");
      };
      r.onsuccess = () => { this.db = r.result; ok(this.db); };
      r.onerror = () => ng(r.error);
    });
  },
  async tx(store, mode, fn) {
    const db = await this.open();
    return new Promise((ok, ng) => {
      const t = db.transaction(store, mode);
      const s = t.objectStore(store);
      let out;
      Promise.resolve(fn(s)).then((v) => { out = v; });
      t.oncomplete = () => ok(out);
      t.onerror = () => ng(t.error);
    });
  },
  req(r) { return new Promise((ok, ng) => { r.onsuccess = () => ok(r.result); r.onerror = () => ng(r.error); }); },
  put(store, v) { return this.tx(store, "readwrite", (s) => { s.put(v); }); },
  del(store, key) { return this.tx(store, "readwrite", (s) => { s.delete(key); }); },
  get(store, key) { return this.tx(store, "readonly", (s) => this.req(s.get(key))); },
  all(store) { return this.tx(store, "readonly", (s) => this.req(s.getAll())); },
  bySite(store, site) { return this.tx(store, "readonly", (s) => this.req(s.index("site").getAll(site))); },
  async delBySite(store, site) {
    await this.tx(store, "readwrite", (s) => this.req(s.index("site").getAllKeys(site)).then((ks) => ks.forEach((k) => s.delete(k))));
  },
};
const ls = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* 保存できなくても動く */ } },
};

// ---------------------------------------------------------------- 状態
const S = {
  site: null, siteId: null, recs: new Map(), trees: [], img: null,
  view: { cx: 0, cy: 0, scale: 4 }, sel: null,
  dbhMin: 10, dbhMax: Infinity, onlyTodo: false, layers: [], mag: ls.get("mag", 10), labels: ls.get("labels", true),
  gps: null, watch: null, follow: false, me: null, acc: null, track: [], calib: { dx: 0, dy: 0 },
  addMode: false, wake: null,
};

function toast(msg, ms = 2500) {
  const t = $("toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.h); toast.h = setTimeout(() => { t.hidden = true; }, ms);
}

// ---------------------------------------------------------------- 座標
function llToXY(lat, lon) {
  const o = S.site.origin, m = o.m_per_deg, a = lon - o.lon, b = lat - o.lat;
  return [m[0][0] * a + m[0][1] * b, m[1][0] * a + m[1][1] * b];
}
function xyToLL(x, y) {
  const o = S.site.origin, m = o.m_per_deg, det = m[0][0] * m[1][1] - m[0][1] * m[1][0];
  const a = (m[1][1] * x - m[0][1] * y) / det, b = (-m[1][0] * x + m[0][0] * y) / det;
  return [o.lat + b, o.lon + a];
}
const DIRS = ["北", "北東", "東", "南東", "南", "南西", "西", "北西"];
function bearingText(dx, dy) {
  const deg = (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360;
  return DIRS[Math.round(deg / 45) % 8];
}

// ---------------------------------------------------------------- データの読み込み
async function loadSiteFile(file) {
  let d;
  try { d = JSON.parse(await file.text()); } catch (e) { toast("JSON として読めませんでした"); return; }
  if (d.format !== "forestscan-field") { toast("解析アプリの .forest.json ではありません"); return; }
  d.id = `${d.name}|${d.created}`;
  await DB.put("sites", d);
  await openSite(d.id);
  toast(`${d.name} を読み込みました (${d.trees.length} 本)`);
}

async function openSite(id) {
  const d = await DB.get("sites", id);
  if (!d) return;
  S.site = d; S.siteId = id; S.sel = null; closeSheet();
  ls.set("lastSite", id);
  S.recs = new Map((await DB.bySite("records", id)).map((r) => [r.id, r]));
  S.calib = d.calib || { dx: 0, dy: 0 };
  S.track = (await DB.bySite("tracks", id)).map((p) => p);
  rebuildTrees();
  S.img = null;
  if (d.terrain && d.terrain.hillshade) {
    const im = new Image(); im.onload = () => { S.img = im; draw(); }; im.src = d.terrain.hillshade;
  }
  $("siteName").textContent = d.name;
  $("empty").hidden = true;
  buildLayers(); setDbhScale();
  fitView();
  updateProgress(); renderLegend(); renderSiteList(); renderLayerList();
}

function rebuildTrees() {
  const base = S.site.trees.map((t) => ({ ...t, added: false }));
  const added = [...S.recs.values()].filter((r) => r.added).map((r) => ({ id: r.id, x: r.x, y: r.y, dbh: null, h: null, sp: "", added: true }));
  S.trees = base.concat(added);
}

function fitView() {
  const c = $("map"), b = S.site.terrain ? S.site.terrain.bounds : null;
  let x0, y0, x1, y1;
  if (b) [x0, y0, x1, y1] = b;
  else {
    x0 = Math.min(...S.trees.map((t) => t.x)); x1 = Math.max(...S.trees.map((t) => t.x));
    y0 = Math.min(...S.trees.map((t) => t.y)); y1 = Math.max(...S.trees.map((t) => t.y));
  }
  S.view.cx = (x0 + x1) / 2; S.view.cy = (y0 + y1) / 2;
  S.view.scale = Math.min(c.clientWidth / (x1 - x0 + 4), c.clientHeight / (y1 - y0 + 4));
  draw();
}

// ---------------------------------------------------------------- 記録
function rec(id) { return S.recs.get(id) || { key: `${S.siteId}|${id}`, site: S.siteId, id }; }
/** 地図の色に使う区分: 現地で記録した区分、無ければ解析の樹種を区分に直したもの */
function treeSp(t) {
  const r = S.recs.get(t.id);
  if (r && r.sp) return normSp(r).sp;
  return SP_FROM_ANALYSIS[t.sp] || "";
}
/** 前の版の記録 (広葉樹・その他 + spOther) を今の区分に読み替える */
function normSp(r) {
  if (r.sp === "広葉樹" || r.sp === "その他") return { sp: "その他広葉樹", name: r.spName || r.spOther || "" };
  return { sp: r.sp || "", name: r.spName || "" };
}
function spLabel(r) {
  const { sp, name } = normSp(r);
  return name ? name : sp;
}
function spColor(s) { return SP_COLORS[s] || UNKNOWN_COLOR; }

async function saveRec(r) {
  r.updated = new Date().toISOString();
  S.recs.set(r.id, r);
  await DB.put("records", r);
  $("saved").textContent = `保存しました ${new Date().toLocaleTimeString("ja-JP")}`;
  updateProgress(); draw();
}

function updateProgress() {
  if (!S.site) { $("progress").textContent = ""; return; }
  const vis = S.trees.filter(visible);
  const done = S.trees.filter((t) => (S.recs.get(t.id) || {}).checked).length;
  const doneVis = vis.filter((t) => (S.recs.get(t.id) || {}).checked).length;
  $("progress").textContent = `確認済み ${done} / ${S.trees.length} 本` +
    (vis.length < S.trees.length ? ` (表示中 ${doneVis} / ${vis.length})` : "");
}

function visible(t) {
  const r = S.recs.get(t.id) || {};
  const d = r.dbh || t.dbh;      // 実測があれば実測で絞る。胸高直径の無い追加木は常に出す
  if (d != null && (d < S.dbhMin || d > S.dbhMax)) return false;
  if (S.onlyTodo && r.checked) return false;
  return true;
}
function dbhText() {
  return `${S.dbhMin} cm 〜 ` + (S.dbhMax === Infinity ? "上限なし" : `${S.dbhMax} cm`);
}

// ---------------------------------------------------------------- 描画
const cv = $("map"), ctx = cv.getContext("2d");
let drawPending = false;
function draw() {
  if (drawPending) return;
  drawPending = true;
  requestAnimationFrame(() => { drawPending = false; render(); });
}
function sx(x) { return cv.clientWidth / 2 + (x - S.view.cx) * S.view.scale; }
function sy(y) { return cv.clientHeight / 2 - (y - S.view.cy) * S.view.scale; }
function wx(px) { return S.view.cx + (px - cv.clientWidth / 2) / S.view.scale; }
function wy(py) { return S.view.cy - (py - cv.clientHeight / 2) / S.view.scale; }

function render() {
  const dpr = window.devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight;
  if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = "#e9e7df"; ctx.fillRect(0, 0, W, H);
  if (!S.site) return;
  const sc = S.view.scale, ter = S.site.terrain;
  // 陰影図
  if (S.img && ter) {
    const [x0, y0, x1, y1] = ter.bounds;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(S.img, sx(x0), sy(y1), (x1 - x0) * sc, (y1 - y0) * sc);
  }
  // 等高線 (拡大が小さいときは太線だけ)
  if (ter && ter.contours) {
    for (const c of ter.contours) {
      if (!c.index && sc < 2) continue;
      ctx.strokeStyle = c.index ? "rgba(110,72,30,.85)" : "rgba(140,100,50,.55)";
      ctx.lineWidth = c.index ? 1.4 : 0.8;
      ctx.beginPath();
      for (const L of c.lines) {
        ctx.moveTo(sx(L[0]), sy(L[1]));
        for (let i = 2; i < L.length; i += 2) ctx.lineTo(sx(L[i]), sy(L[i + 1]));
      }
      ctx.stroke();
      if (c.index && sc >= 3 && c.lines.length) {
        const L = c.lines[0], k = 2 * Math.floor(L.length / 4);
        ctx.fillStyle = "rgba(110,72,30,.95)"; ctx.font = "11px sans-serif";
        ctx.fillText(`${Math.round(c.z)}`, sx(L[k]) + 2, sy(L[k + 1]) - 2);
      }
    }
  }
  // 調査範囲
  const B = S.site.boundary;
  if (B && B.length > 4) {
    ctx.setLineDash([6, 4]); ctx.strokeStyle = "rgba(40,40,40,.7)"; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(sx(B[0]), sy(B[1]));
    for (let i = 2; i < B.length; i += 2) ctx.lineTo(sx(B[i]), sy(B[i + 1]));
    ctx.closePath(); ctx.stroke(); ctx.setLineDash([]);
  }
  // 重ねたポリゴン・線・点
  for (const L of S.layers) {
    if (L.hidden) continue;
    ctx.strokeStyle = L.color; ctx.lineWidth = 2.5; ctx.fillStyle = L.color + "1f";
    for (const f of L.features) {
      if (f.rings && f.rings.length) {    // 穴のある面も 1 つのパスで (evenodd)
        ctx.beginPath();
        for (const ring of f.rings) {
          ctx.moveTo(sx(ring[0]), sy(ring[1]));
          for (let i = 2; i < ring.length; i += 2) ctx.lineTo(sx(ring[i]), sy(ring[i + 1]));
          ctx.closePath();
        }
        ctx.fill("evenodd"); ctx.stroke();
      }
      for (const line of f.lines || []) {
        ctx.beginPath(); ctx.moveTo(sx(line[0]), sy(line[1]));
        for (let i = 2; i < line.length; i += 2) ctx.lineTo(sx(line[i]), sy(line[i + 1]));
        ctx.stroke();
      }
      for (const p of f.points || []) {
        ctx.beginPath(); ctx.arc(sx(p[0]), sy(p[1]), 5, 0, Math.PI * 2); ctx.stroke();
      }
      if (f.name && f.label && sc >= 1) {
        ctx.fillStyle = L.color; ctx.font = "bold 12px sans-serif";
        ctx.fillText(f.name, sx(f.label[0]), sy(f.label[1])); ctx.fillStyle = L.color + "1f";
      }
    }
  }
  // GPS の軌跡
  if (S.track.length > 1) {
    ctx.strokeStyle = "rgba(26,111,214,.55)"; ctx.lineWidth = 2; ctx.beginPath();
    S.track.forEach((p, i) => {
      const [x, y] = llToXY(p.lat, p.lon), X = sx(x + S.calib.dx), Y = sy(y + S.calib.dy);
      i ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y);
    });
    ctx.stroke();
  }
  // 木: 円の面積 = 胸高断面積 (半径は胸高直径に比例、mag 倍に拡大)
  const showId = S.labels && sc >= 14;
  const list = S.trees.filter(visible).sort((a, b) => (b.dbh || 0) - (a.dbh || 0));
  for (const t of list) {
    const r = S.recs.get(t.id) || {};
    const d = r.dbh || t.dbh || 10;
    const R = Math.max(3, d / 200 * S.mag * sc), X = sx(t.x), Y = sy(t.y);
    if (X < -R || Y < -R || X > W + R || Y > H + R) continue;
    if (r.absent) {     // 存在しない (LiDAR の誤検出): 灰色の破線の円に斜線
      ctx.strokeStyle = "#555"; ctx.lineWidth = 1.5; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.arc(X, Y, R, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
      ctx.beginPath(); ctx.moveTo(X - R * 0.7, Y + R * 0.7); ctx.lineTo(X + R * 0.7, Y - R * 0.7); ctx.stroke();
      if (showId) { ctx.fillStyle = "#555"; ctx.font = "11px sans-serif"; ctx.textAlign = "center"; ctx.fillText(t.id, X, Y + R + 11); ctx.textAlign = "left"; }
      continue;
    }
    ctx.globalAlpha = r.checked ? 0.95 : 0.7;
    ctx.fillStyle = spColor(treeSp(t));
    ctx.beginPath(); ctx.arc(X, Y, R, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 1;
    ctx.lineWidth = r.checked ? 2.5 : 1; ctx.strokeStyle = r.checked ? "#111" : "#fff";
    if (t.added) ctx.setLineDash([3, 2]);
    ctx.stroke(); ctx.setLineDash([]);
    if (r.dead || r.fallen) {
      ctx.strokeStyle = "#000"; ctx.lineWidth = 2; const q = R * 0.7;
      ctx.beginPath(); ctx.moveTo(X - q, Y - q); ctx.lineTo(X + q, Y + q); ctx.moveTo(X + q, Y - q); ctx.lineTo(X - q, Y + q); ctx.stroke();
    }
    let mx = X + R * 0.75;
    const other = FLAG_KEYS.some((k) => r[k] && !["dead", "fallen", "bite", "nara"].includes(k));
    for (const f of ["bite", "nara", "other"]) {
      if (f === "other" ? !other : !r[f]) continue;
      ctx.fillStyle = FLAG_COLORS[f]; ctx.strokeStyle = "#fff"; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(mx, Y - R * 0.75, 4, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); mx += 9;
    }
    if (r.memo) { ctx.fillStyle = "#111"; ctx.font = "bold 11px sans-serif"; ctx.fillText("✎", X - R - 9, Y - R * 0.6); }
    if (showId) {
      ctx.fillStyle = "#111"; ctx.font = "11px sans-serif"; ctx.textAlign = "center";
      ctx.fillText(t.id, X, Y + R + 11); ctx.textAlign = "left";
    }
  }
  // 選んだ木
  if (S.sel) {
    const t = S.sel, r = S.recs.get(t.id) || {}, d = r.dbh || t.dbh || 10;
    const R = Math.max(3, d / 200 * S.mag * sc) + 5;
    ctx.strokeStyle = "#c2185b"; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(sx(t.x), sy(t.y), R, 0, Math.PI * 2); ctx.stroke();
  }
  // 現在地
  if (S.me) {
    const X = sx(S.me[0]), Y = sy(S.me[1]);
    ctx.fillStyle = "rgba(26,111,214,.15)"; ctx.strokeStyle = "rgba(26,111,214,.5)"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(X, Y, Math.max(8, S.acc * sc), 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = "#1a6fd6"; ctx.strokeStyle = "#fff"; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(X, Y, 7, 0, Math.PI * 2); ctx.stroke(); ctx.fill();
  }
  drawScale(W, H);
}

function drawScale(W, H) {
  const sc = S.view.scale, steps = [1, 2, 5, 10, 20, 50, 100, 200, 500];
  const m = steps.find((s) => s * sc >= 60) || 500, L = m * sc, x = 14, y = H - 14;
  ctx.fillStyle = "rgba(255,255,255,.85)"; ctx.fillRect(x - 6, y - 18, L + 40, 28);
  ctx.strokeStyle = "#111"; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(x, y - 5); ctx.lineTo(x, y); ctx.lineTo(x + L, y); ctx.lineTo(x + L, y - 5); ctx.stroke();
  ctx.fillStyle = "#111"; ctx.font = "12px sans-serif"; ctx.fillText(`${m} m`, x + L + 5, y + 1);
  ctx.fillText("北 ↑", x, y - 8);
}

function renderLegend() {
  const used = new Set(S.trees.map(treeSp));
  const sp = SP_CATS.filter((s) => used.has(s));
  if ([...used].some((s) => !SP_COLORS[s])) sp.push("不明");
  $("legend").innerHTML = sp.map((s) => `<div><i style="background:${spColor(s)}"></i>${s}</div>`).join("") +
    `<div><i style="background:${FLAG_COLORS.bite}"></i>食痕</div><div><i style="background:${FLAG_COLORS.nara}"></i>ナラ枯れ</div>` +
    `<div><i style="background:${FLAG_COLORS.other}"></i>他の記録</div><div>✕ 枯死・倒木</div><div>⊘ 存在しない</div><div>太枠 = 確認済み</div>`;
}

// ---------------------------------------------------------------- 操作 (ドラッグ・ピンチ・タップ)
const ptrs = new Map();
let gesture = null;
cv.addEventListener("pointerdown", (e) => {
  cv.setPointerCapture(e.pointerId);
  ptrs.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
  gesture = { start: Date.now(), moved: false, x: e.offsetX, y: e.offsetY, cx: S.view.cx, cy: S.view.cy, scale: S.view.scale,
    pinch: ptrs.size === 2 ? pinchInfo() : null };
});
cv.addEventListener("pointermove", (e) => {
  if (!ptrs.has(e.pointerId) || !gesture) return;
  ptrs.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
  if (ptrs.size === 2 && gesture.pinch) {
    const p = pinchInfo(), g = gesture.pinch;
    const s = Math.min(400, Math.max(0.3, gesture.scale * p.d / g.d));
    // ピンチの中心の地点を指の下に保つ
    const wxm = gesture.cx + (g.mx - cv.clientWidth / 2) / gesture.scale;
    const wym = gesture.cy - (g.my - cv.clientHeight / 2) / gesture.scale;
    S.view.scale = s;
    S.view.cx = wxm - (p.mx - cv.clientWidth / 2) / s;
    S.view.cy = wym + (p.my - cv.clientHeight / 2) / s;
    gesture.moved = true; setFollow(false); draw();
  } else if (ptrs.size === 1) {
    const dx = e.offsetX - gesture.x, dy = e.offsetY - gesture.y;
    if (Math.hypot(dx, dy) > 8) gesture.moved = true;
    if (gesture.moved) {
      S.view.cx = gesture.cx - dx / S.view.scale; S.view.cy = gesture.cy + dy / S.view.scale;
      setFollow(false); draw();
    }
  }
});
function endPtr(e) {
  if (!ptrs.has(e.pointerId)) return;
  ptrs.delete(e.pointerId);
  if (gesture && !gesture.moved && ptrs.size === 0 && Date.now() - gesture.start < 500) tap(e.offsetX, e.offsetY);
  if (ptrs.size === 1) {   // ピンチの後に残った指でそのまま動かせるように
    const [p] = ptrs.values();
    gesture = { start: 0, moved: true, x: p.x, y: p.y, cx: S.view.cx, cy: S.view.cy, scale: S.view.scale, pinch: null };
  } else if (ptrs.size === 0) gesture = null;
}
cv.addEventListener("pointerup", endPtr);
cv.addEventListener("pointercancel", endPtr);
function pinchInfo() {
  const [a, b] = [...ptrs.values()];
  return { d: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
}
cv.addEventListener("wheel", (e) => {
  e.preventDefault();
  const f = Math.exp(-e.deltaY * 0.0015), wxm = wx(e.offsetX), wym = wy(e.offsetY);
  S.view.scale = Math.min(400, Math.max(0.3, S.view.scale * f));
  S.view.cx = wxm - (e.offsetX - cv.clientWidth / 2) / S.view.scale;
  S.view.cy = wym + (e.offsetY - cv.clientHeight / 2) / S.view.scale;
  setFollow(false); draw();
}, { passive: false });

function tap(px, py) {
  if (!S.site || S.addMode) return;
  let best = null, bd = Infinity;
  for (const t of S.trees) {
    if (!visible(t)) continue;
    const r = S.recs.get(t.id) || {}, d = r.dbh || t.dbh || 10;
    const R = Math.max(3, d / 200 * S.mag * S.view.scale);
    const dd = Math.hypot(sx(t.x) - px, sy(t.y) - py);
    if (dd <= Math.max(18, R + 6) && dd - R < bd) { bd = dd - R; best = t; }
  }
  if (best) openSheet(best); else closeSheet();
}

// ---------------------------------------------------------------- 木の記録の画面
function openSheet(t) {
  S.sel = t;
  const r = rec(t.id);
  $("tId").textContent = t.id;
  $("tNew").hidden = !t.added; $("delNew").hidden = !t.added;
  const src = S.site.species_source ? ` (${S.site.species_source})` : "";
  $("tInfo").textContent = t.added ? "現地で追加した木" :
    `解析: 胸高直径 ${t.dbh ?? "-"} cm ・ 樹高 ${t.h ?? "-"} m ・ 樹種 ${t.sp || "不明"}${src}` +
    (t.conf != null && t.conf < 0.8 ? ` ・ 幹の確度 ${t.conf} (要確認)` : "");
  showSp(normSp(r));
  document.querySelectorAll("#strataBtns button").forEach((b) => b.classList.toggle("on", b.dataset.stratum === (r.stratum || "")));
  document.querySelectorAll("#crownBtns button").forEach((b) => b.classList.toggle("on", b.dataset.crown === (r.crown || "")));
  document.querySelectorAll("#flagGroups button").forEach((b) => b.classList.toggle("on", !!r[b.dataset.flag]));
  $("absentRow").querySelector(".absent").hidden = !!t.added;
  $("fAbsent").checked = !!r.absent; $("details").classList.toggle("off", !!r.absent);
  $("fDbh").value = r.dbh ?? ""; $("fHgt").value = r.hgt ?? ""; $("fTag").value = r.tag || "";
  $("fChecked").checked = !!r.checked; $("fMemo").value = r.memo || "";
  $("saved").textContent = r.updated ? `最終更新 ${new Date(r.updated).toLocaleString("ja-JP")}` : "変更は自動で保存されます";
  updateDist();
  $("sheet").hidden = false;
  // 選んだ木がシートに隠れるなら、シートの上の真ん中に来るよう地図を動かす
  const top = $("sheet").getBoundingClientRect().top - cv.getBoundingClientRect().top;
  if (sy(t.y) > top - 20) {
    S.view.cy = t.y - (cv.clientHeight / 2 - Math.max(40, top / 2)) / S.view.scale;
    S.view.cx = t.x; setFollow(false);
  }
  draw();
}
function closeSheet() { $("sheet").hidden = true; S.sel = null; draw(); }
function updateDist() {
  if (!S.sel) return;
  if (!S.me) { $("tDist").textContent = "現在地: GPS 停止中"; return; }
  const dx = S.sel.x - S.me[0], dy = S.sel.y - S.me[1], d = Math.hypot(dx, dy);
  $("tDist").textContent = `現在地から ${bearingText(dx, dy)} へ ${d.toFixed(d < 10 ? 1 : 0)} m (GPS 誤差 ±${Math.round(S.acc)} m)`;
}
function editSel(fn) {
  if (!S.sel) return;
  const r = rec(S.sel.id);
  fn(r);
  if (fn !== uncheck) r.checked = true;      // 何か記録したら確認済みにする (外すのはチェックで)
  $("fChecked").checked = !!r.checked;
  saveRec(r);
}
function uncheck(r) { r.checked = $("fChecked").checked; }

$("spBtns").innerHTML = SP_CATS.map((s) => `<button data-sp="${s}"><i style="background:${spColor(s)}"></i>${s}</button>`).join("");
/** 樹種のボタンの表示。その他針葉樹・その他広葉樹のときは樹種名の一覧と記入欄を出す */
function showSp({ sp, name }) {
  document.querySelectorAll("#spBtns button").forEach((b) => b.classList.toggle("on", b.dataset.sp === sp));
  const names = SP_NAMES[sp];
  $("spSubBox").hidden = !names;
  if (!names) return;
  $("spSub").innerHTML = names.map((n) => `<button data-name="${n}" class="${n === name ? "on" : ""}">${n}</button>`).join("");
  $("spName").value = name && !names.includes(name) ? name : "";
}
$("spBtns").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  const cur = normSp(rec(S.sel.id)), v = cur.sp === b.dataset.sp ? "" : b.dataset.sp;
  const name = v === cur.sp ? cur.name : "";      // 区分を変えたら樹種名は消す
  showSp({ sp: v, name });
  editSel((r) => { r.sp = v; r.spName = name; delete r.spOther; });
  renderLegend();
});
$("spSub").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-name]"); if (!b) return;
  const cur = normSp(rec(S.sel.id)), name = cur.name === b.dataset.name ? "" : b.dataset.name;
  showSp({ sp: cur.sp, name });
  editSel((r) => { r.sp = cur.sp; r.spName = name; delete r.spOther; });
});
$("spName").addEventListener("change", () => {
  const cur = normSp(rec(S.sel.id)), name = $("spName").value.trim();
  showSp({ sp: cur.sp, name });
  editSel((r) => { r.sp = cur.sp; r.spName = name; delete r.spOther; });
});
$("strataBtns").innerHTML = STRATA.map((c) => `<button data-stratum="${c}">${c}</button>`).join("");
$("strataBtns").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  const v = rec(S.sel.id).stratum === b.dataset.stratum ? "" : b.dataset.stratum;
  document.querySelectorAll("#strataBtns button").forEach((x) => x.classList.toggle("on", x.dataset.stratum === v));
  editSel((r) => { r.stratum = v; });
});
$("crownBtns").innerHTML = CROWN.map((c) => `<button data-crown="${c}">${c}</button>`).join("");
$("crownBtns").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  const v = rec(S.sel.id).crown === b.dataset.crown ? "" : b.dataset.crown;
  document.querySelectorAll("#crownBtns button").forEach((x) => x.classList.toggle("on", x.dataset.crown === v));
  editSel((r) => { r.crown = v; });
});
$("flagGroups").innerHTML = FLAG_GROUPS.map((g) => `<div class="row"><div class="lab">${g.title}</div><div class="chips flags">` +
  g.items.map(([k, label, bad]) => `<button data-flag="${k}" class="${bad ? "bad" : ""}">${label}</button>`).join("") + "</div></div>").join("");
$("flagGroups").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-flag]"); if (!b) return;
  const k = b.dataset.flag, v = !rec(S.sel.id)[k];
  b.classList.toggle("on", v);
  editSel((r) => { r[k] = v; });
});
$("fAbsent").addEventListener("change", () => {
  const v = $("fAbsent").checked;
  $("details").classList.toggle("off", v);
  editSel((r) => { r.absent = v; });
});
const num = (id) => { const v = parseFloat($(id).value); return isFinite(v) && v > 0 ? v : null; };
$("fDbh").addEventListener("change", () => editSel((r) => { r.dbh = num("fDbh"); }));
$("fHgt").addEventListener("change", () => editSel((r) => { r.hgt = num("fHgt"); }));
$("fTag").addEventListener("change", () => editSel((r) => { r.tag = $("fTag").value.trim(); }));
$("fMemo").addEventListener("change", () => editSel((r) => { r.memo = $("fMemo").value; }));
$("fChecked").addEventListener("change", () => editSel(uncheck));
$("sheetClose").addEventListener("click", closeSheet);
$("delNew").addEventListener("click", async () => {
  if (!S.sel || !S.sel.added || !confirm(`追加した木 ${S.sel.id} を消しますか？`)) return;
  const r = rec(S.sel.id);
  S.recs.delete(r.id); await DB.del("records", r.key);
  rebuildTrees(); closeSheet(); updateProgress();
});
$("calib").addEventListener("click", async () => {
  if (!S.sel) return;
  if (!S.gps) { toast("先に GPS を開始してください (右下の ◎)"); return; }
  const [x, y] = llToXY(S.gps.lat, S.gps.lon);
  const dx = S.sel.x - x, dy = S.sel.y - y;
  if (!confirm(`GPS の位置を ${Math.hypot(dx, dy).toFixed(1)} m 動かして、木 ${S.sel.id} の位置に合わせますか？\n(GPS の誤差が大きいときに使います。メニューから消せます)`)) return;
  S.calib = { dx, dy };
  S.site.calib = S.calib; await DB.put("sites", S.site);
  onGps(); toast("GPS の位置を合わせました");
});

// ---------------------------------------------------------------- 木の追加
function setAddMode(on) {
  S.addMode = on;
  $("addBar").hidden = !on; $("cross").hidden = !on; $("addBtn").classList.toggle("active", on);
  if (on) closeSheet();
}
$("addBtn").addEventListener("click", () => { if (S.site) setAddMode(!S.addMode); });
$("addCancel").addEventListener("click", () => setAddMode(false));
$("addHere").addEventListener("click", () => addTree(S.view.cx, S.view.cy));
$("addMe").addEventListener("click", () => {
  if (!S.me) { toast("GPS を開始してください"); return; }
  addTree(S.me[0], S.me[1]);
});
async function addTree(x, y) {
  const used = new Set(S.trees.map((t) => t.id));
  let n = 1; while (used.has(`N${n}`)) n++;
  const r = { key: `${S.siteId}|N${n}`, site: S.siteId, id: `N${n}`, added: true, x: +x.toFixed(2), y: +y.toFixed(2) };
  await saveRec(r);
  rebuildTrees(); setAddMode(false);
  openSheet(S.trees.find((t) => t.id === r.id));
  toast(`木 N${n} を追加しました。胸高直径などを入れてください`);
}

// ---------------------------------------------------------------- GPS
function setFollow(on) { S.follow = on; $("locBtn").classList.toggle("follow", on); }
function startGps() {
  if (!("geolocation" in navigator)) { toast("この端末・ブラウザでは位置情報が使えません"); return; }
  if (!window.isSecureContext) { toast("位置情報は https で開いたときだけ使えます"); return; }
  S.watch = navigator.geolocation.watchPosition((p) => {
    S.gps = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy, t: p.timestamp };
    onGps(true);
  }, (err) => {
    toast(err.code === 1 ? "位置情報の利用が許可されていません (ブラウザの設定で許可してください)" : `GPS: ${err.message}`, 4000);
    setGpsState();
  }, { enableHighAccuracy: true, maximumAge: 2000, timeout: 30000 });
  if ("wakeLock" in navigator) navigator.wakeLock.request("screen").then((w) => { S.wake = w; }).catch(() => {});
  setGpsState();
}
function stopGps() {
  if (S.watch !== null) navigator.geolocation.clearWatch(S.watch);
  S.watch = null; S.gps = null; S.me = null; setFollow(false);
  if (S.wake) { S.wake.release().catch(() => {}); S.wake = null; }
  setGpsState(); draw(); updateDist();
}
function setGpsState() {
  const el = $("gpsState");
  if (S.watch === null) { el.textContent = "GPS 停止"; el.className = "gps off"; return; }
  if (!S.gps) { el.textContent = "GPS 測位中…"; el.className = "gps weak"; return; }
  el.textContent = `GPS ±${Math.round(S.gps.acc)} m`; el.className = S.gps.acc <= 10 ? "gps on" : "gps weak";
}
function onGps(fresh) {
  if (!S.gps || !S.site) return;
  const [x, y] = llToXY(S.gps.lat, S.gps.lon);
  S.me = [x + S.calib.dx, y + S.calib.dy]; S.acc = S.gps.acc;
  if (fresh) recordTrack();
  if (S.follow) { S.view.cx = S.me[0]; S.view.cy = S.me[1]; }
  setGpsState(); updateDist(); draw();
}
function recordTrack() {
  const g = S.gps, last = S.track[S.track.length - 1];
  if (g.acc > 50) return;
  if (last) {
    const [x0, y0] = llToXY(last.lat, last.lon), [x1, y1] = llToXY(g.lat, g.lon);
    if (Math.hypot(x1 - x0, y1 - y0) < 2 && g.t - last.t < 15000) return;
  }
  const p = { site: S.siteId, t: g.t, lat: g.lat, lon: g.lon, acc: g.acc };
  S.track.push(p); DB.put("tracks", p).catch(() => {});
}
$("locBtn").addEventListener("click", () => {
  if (!S.site) return;
  if (S.watch === null) { startGps(); setFollow(true); toast("GPS を開始しました (もう一度押すと現在地を追従)"); return; }
  if (!S.me) { toast("測位中です"); return; }
  setFollow(!S.follow);
  if (S.follow) { S.view.cx = S.me[0]; S.view.cy = S.me[1]; if (S.view.scale < 6) S.view.scale = 8; draw(); }
});

// ---------------------------------------------------------------- 書き出し
function csvCell(v) {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function exportCsv() {
  const o = S.site.origin;
  const head = ["tree_id", "追加した木", "存在しない", "X_m", "Y_m", "緯度", "経度", "胸高直径_解析_cm", "樹高_解析_m", "樹種_解析",
    "実測胸高直径_cm", "実測樹高_m", "テープ番号", "樹種区分_現地", "樹種名_現地", "階層", "樹冠の位置", ...FLAG_KEYS.map((k) => FLAG_LABEL[k]),
    "備考", "確認済み", "更新日時"];
  const rows = [head];
  for (const t of S.trees) {
    const r = S.recs.get(t.id) || {}, [lat, lon] = xyToLL(t.x, t.y);
    rows.push([t.id, t.added ? 1 : 0, r.absent ? 1 : 0, (o.x + t.x).toFixed(2), (o.y + t.y).toFixed(2), lat.toFixed(7), lon.toFixed(7),
      t.dbh ?? "", t.h ?? "", t.sp || "", r.dbh ?? "", r.hgt ?? "", r.tag || "",
      normSp(r).sp, spLabel(r) === normSp(r).sp ? normSp(r).sp : spLabel(r), r.stratum || "", r.crown || "",
      ...FLAG_KEYS.map((k) => (r[k] ? 1 : 0)),
      r.memo || "", r.checked ? 1 : 0, r.updated ? new Date(r.updated).toLocaleString("ja-JP") : ""]);
  }
  const body = "﻿" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n");
  saveFile(body, `${fileBase()}_毎木記録.csv`, "text/csv");
}
function exportJson() {
  const d = { format: "forestscan-field-records", version: 1, site: S.siteId, name: S.site.name,
    crs_epsg: S.site.crs_epsg, origin: S.site.origin, calib: S.calib, exported: new Date().toISOString(),
    records: [...S.recs.values()] };
  saveFile(JSON.stringify(d, null, 1), `${fileBase()}_記録.json`, "application/json");
}
function exportGpx() {
  if (!S.track.length) { toast("GPS の軌跡がありません"); return; }
  const pts = S.track.map((p) => `<trkpt lat="${p.lat.toFixed(7)}" lon="${p.lon.toFixed(7)}"><time>${new Date(p.t).toISOString()}</time></trkpt>`).join("\n");
  const gpx = `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="forestscan field" xmlns="http://www.topografix.com/GPX/1/1">\n` +
    `<trk><name>${S.site.name}</name><trkseg>\n${pts}\n</trkseg></trk></gpx>\n`;
  saveFile(gpx, `${fileBase()}_軌跡.gpx`, "application/gpx+xml");
}
function fileBase() {
  const d = new Date(), p = (n) => String(n).padStart(2, "0");
  return `${S.site.name.replace(/[\\/:*?"<>|\s]+/g, "_")}_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}
async function saveFile(text, name, type) {
  const blob = new Blob([text], { type });
  const file = new File([blob], name, { type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return; } catch (e) { if (e.name === "AbortError") return; }
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
async function importBackup(file) {
  let d;
  try { d = JSON.parse(await file.text()); } catch (e) { toast("JSON として読めませんでした"); return; }
  if (d.format !== "forestscan-field-records") { toast("この画面で書き出した記録 (JSON) ではありません"); return; }
  if (d.name !== S.site.name && !confirm(`別のデータ (${d.name}) の記録です。いま開いている ${S.site.name} に読み込みますか？`)) return;
  let n = 0;
  for (const r of d.records) {
    const cur = S.recs.get(r.id);
    if (cur && cur.updated && r.updated && cur.updated >= r.updated) continue;   // 新しい方を残す
    const v = { ...r, key: `${S.siteId}|${r.id}`, site: S.siteId };
    S.recs.set(v.id, v); await DB.put("records", v); n++;
  }
  rebuildTrees(); updateProgress(); renderLegend(); draw();
  toast(`${n} 本の記録を読み込みました (この端末の方が新しい記録はそのまま)`);
}

// ---------------------------------------------------------------- 重ねるポリゴン
// 地物は {name, rings: [[x, y, x, y, ...]], lines: [...], points: [[x, y]], label: [x, y]} (基準点からの m)。
// 解析アプリが入れたもの (site.layers) と、ここで読み込んだもの (site.userLayers) がある
function buildLayers() {
  const hidden = S.site.layerHidden || {};
  const all = [...(S.site.layers || []).map((l) => ({ ...l, fromApp: true })), ...(S.site.userLayers || [])];
  S.layers = all.map((l, i) => ({ ...l, color: LAYER_COLORS[i % LAYER_COLORS.length], hidden: !!hidden[l.name] }));
}
function renderLayerList() {
  $("layerList").innerHTML = S.layers.map((l, i) =>
    `<div class="lyr"><input type="checkbox" data-lyr="${i}" ${l.hidden ? "" : "checked"}>` +
    `<span style="color:${l.color}">■ ${l.name}</span>` +
    (l.fromApp ? `<span class="sub">解析アプリから</span>` : `<button data-lyrdel="${i}">消す</button>`) + "</div>").join("");
}
$("layerList").addEventListener("change", async (e) => {
  const i = e.target.dataset.lyr; if (i === undefined) return;
  const L = S.layers[+i]; L.hidden = !e.target.checked;
  S.site.layerHidden = { ...(S.site.layerHidden || {}), [L.name]: L.hidden };
  await DB.put("sites", S.site); draw();
});
$("layerList").addEventListener("click", async (e) => {
  const i = e.target.dataset.lyrdel; if (i === undefined) return;
  const L = S.layers[+i];
  if (!confirm(`重ねた「${L.name}」を消しますか？`)) return;
  S.site.userLayers = (S.site.userLayers || []).filter((u) => u.name !== L.name);
  await DB.put("sites", S.site); buildLayers(); renderLayerList(); draw();
});

function makeLocal() {
  // 緯度経度 (GeoJSON・KML の標準) か、データと同じ平面直角座標 (m) かを値の大きさで見分ける
  const o = S.site.origin;
  return ([a, b]) => {
    if (Math.abs(a) <= 180 && Math.abs(b) <= 90) return llToXY(b, a);
    return [a - o.x, b - o.y];
  };
}
function featureFrom(name, polys, lines, points, toLocal) {
  const flat = (cs) => cs.flatMap((c) => toLocal(c).map((v) => +v.toFixed(2)));
  const f = { name, rings: polys.flatMap((p) => p.map(flat)), lines: lines.map(flat), points: points.map((c) => toLocal(c)) };
  const first = f.rings[0] || f.lines[0];
  if (first) {
    let x = 0, y = 0; const n = first.length / 2;
    for (let i = 0; i < first.length; i += 2) { x += first[i]; y += first[i + 1]; }
    f.label = [x / n, y / n];
  } else if (f.points[0]) f.label = f.points[0];
  return f;
}
function parseGeoJSON(d, toLocal) {
  const out = [];
  const feats = d.type === "FeatureCollection" ? d.features : d.type === "Feature" ? [d] : [{ type: "Feature", geometry: d, properties: {} }];
  for (const ft of feats) {
    const g = ft.geometry; if (!g) continue;
    const p = ft.properties || {};
    const name = String(p.name ?? p.NAME ?? p.名称 ?? p.title ?? "");
    const geoms = g.type === "GeometryCollection" ? g.geometries : [g];
    const polys = [], lines = [], points = [];
    for (const q of geoms) {
      if (q.type === "Polygon") polys.push(q.coordinates);
      else if (q.type === "MultiPolygon") polys.push(...q.coordinates);
      else if (q.type === "LineString") lines.push(q.coordinates);
      else if (q.type === "MultiLineString") lines.push(...q.coordinates);
      else if (q.type === "Point") points.push(q.coordinates);
      else if (q.type === "MultiPoint") points.push(...q.coordinates);
    }
    out.push(featureFrom(name, polys, lines, points, toLocal));
  }
  return out;
}
function parseKML(text, toLocal) {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  const coords = (el) => el.textContent.trim().split(/\s+/).map((s) => s.split(",").map(Number)).filter((c) => c.length >= 2 && c.every(isFinite));
  return [...doc.getElementsByTagName("Placemark")].map((pm) => {
    const nm = pm.getElementsByTagName("name")[0];
    const polys = [...pm.getElementsByTagName("Polygon")].map((pg) =>
      [...pg.getElementsByTagName("LinearRing")].map((lr) => coords(lr.getElementsByTagName("coordinates")[0])));
    const lines = [...pm.getElementsByTagName("LineString")].map((ls_) => coords(ls_.getElementsByTagName("coordinates")[0]));
    const points = [...pm.getElementsByTagName("Point")].map((pt) => coords(pt.getElementsByTagName("coordinates")[0])[0]).filter(Boolean);
    return featureFrom(nm ? nm.textContent.trim() : "", polys, lines, points, toLocal);
  });
}
async function loadLayerFile(file) {
  const text = await file.text(), toLocal = makeLocal();
  let feats;
  try {
    if (/\.kml$/i.test(file.name) || /^\s*<\?xml|<kml/i.test(text.slice(0, 200))) feats = parseKML(text, toLocal);
    else {
      const d = JSON.parse(text);
      const crs = d.crs && d.crs.properties && String(d.crs.properties.name || "");
      const m = crs && crs.match(/EPSG:{1,2}(\d+)/);
      if (m && !["4326", "6668", "4612", String(S.site.crs_epsg)].includes(m[1])) {
        toast(`座標系 EPSG:${m[1]} のファイルは読めません。緯度経度か EPSG:${S.site.crs_epsg} で書き出すか、解析アプリで読み込んでください`, 6000);
        return;
      }
      feats = parseGeoJSON(d, toLocal);
    }
  } catch (e) { toast("ポリゴンのファイルとして読めませんでした (GeoJSON・KML に対応)"); return; }
  feats = feats.filter((f) => f.rings.length || f.lines.length || f.points.length);
  if (!feats.length) { toast("ポリゴン・線・点が見つかりませんでした"); return; }
  // 調査地から遠すぎるもの (座標系の取り違え) は読まない
  const far = feats.every((f) => f.label && Math.hypot(f.label[0], f.label[1]) > 20000);
  if (far) { toast("調査地から 20 km 以上離れています。座標系が違う可能性があります", 6000); return; }
  const name = file.name.replace(/\.[^.]+$/, "");
  S.site.userLayers = [...(S.site.userLayers || []).filter((l) => l.name !== name), { name, features: feats }];
  await DB.put("sites", S.site); buildLayers(); renderLayerList(); draw();
  toast(`${name} を重ねました (${feats.length} 件)`);
}
$("fileLayer").addEventListener("change", (e) => { const f = e.target.files[0]; if (f) loadLayerFile(f); e.target.value = ""; });

// ---------------------------------------------------------------- メニュー
async function renderSiteList() {
  const sites = await DB.all("sites");
  $("siteList").innerHTML = sites.length > 1 ? `<div class="sub">端末に入っているデータ</div>` +
    sites.map((s) => `<button data-site="${encodeURIComponent(s.id)}" class="${s.id === S.siteId ? "cur" : ""}">${s.name}<br><span class="sub">${s.trees.length} 本・${s.created.slice(0, 10)}</span></button>`).join("") : "";
}
$("siteList").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-site]"); if (!b) return;
  openSite(decodeURIComponent(b.dataset.site)); $("menu").hidden = true;
});
$("menuBtn").addEventListener("click", () => { renderSiteList(); if (S.site) renderLayerList(); $("menu").hidden = false; });
document.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-act]"); if (!b) return;
  const act = b.dataset.act;
  const needSite = ["csv", "json", "gpx", "import", "clearTrack", "deleteSite", "resetCalib", "gps", "layer"];
  if (needSite.includes(act) && !S.site) { toast("先にデータを開いてください"); return; }
  if (act !== "open" && act !== "import") $("menu").hidden = true;
  if (act === "layer") { $("fileLayer").click(); return; }
  if (act === "closeMenu") $("menu").hidden = true;
  else if (act === "open") { $("menu").hidden = true; $("fileData").click(); }
  else if (act === "gps") S.watch === null ? startGps() : stopGps();
  else if (act === "resetCalib") { S.calib = { dx: 0, dy: 0 }; S.site.calib = S.calib; await DB.put("sites", S.site); onGps(); toast("GPS の補正を消しました"); }
  else if (act === "csv") exportCsv();
  else if (act === "json") exportJson();
  else if (act === "gpx") exportGpx();
  else if (act === "import") { $("menu").hidden = true; $("fileBackup").click(); }
  else if (act === "clearTrack") {
    if (!confirm("GPS の軌跡を消しますか？")) return;
    await DB.delBySite("tracks", S.siteId); S.track = []; draw();
  } else if (act === "deleteSite") {
    if (!confirm(`${S.site.name} のデータと、この端末の記録 (${S.recs.size} 本分) を消します。元に戻せません。先に書き出しましたか？`)) return;
    await DB.delBySite("records", S.siteId); await DB.delBySite("tracks", S.siteId); await DB.del("sites", S.siteId);
    S.site = null; S.siteId = null; S.trees = []; S.recs = new Map(); closeSheet();
    $("siteName").textContent = "データ未読込"; $("empty").hidden = false; updateProgress(); draw();
  }
});
$("fileData").addEventListener("change", (e) => { const f = e.target.files[0]; if (f) loadSiteFile(f); e.target.value = ""; });
$("fileBackup").addEventListener("change", (e) => { const f = e.target.files[0]; if (f) importBackup(f); e.target.value = ""; });
$("mag").value = S.mag; $("magVal").textContent = S.mag;
$("mag").addEventListener("input", () => { S.mag = +$("mag").value; $("magVal").textContent = S.mag; ls.set("mag", S.mag); draw(); });
$("showLabels").checked = S.labels;
$("showLabels").addEventListener("change", () => { S.labels = $("showLabels").checked; ls.set("labels", S.labels); draw(); });
// 胸高直径の範囲: 1 本のバーに下限と上限の 2 つのつまみ。バーの左端 = 0 cm、右端 = 上限なし (全木)
function onDbhRange(e) {
  const inf = +$("dbhMax").max;
  let lo = +$("dbhMin").value, hi = +$("dbhMax").value;
  if (lo > hi) {        // つまみが追い越さないように、動かした方を止める
    if (e && e.target.id === "dbhMin") { lo = hi; $("dbhMin").value = lo; } else { hi = lo; $("dbhMax").value = hi; }
  }
  // 2 つが右端で重なったら下限を上に (動かせるように)
  $("dbhMin").style.zIndex = lo >= inf - 1 ? 3 : 1; $("dbhMax").style.zIndex = 2;
  S.dbhMin = lo; S.dbhMax = hi >= inf ? Infinity : hi;
  $("dbhFill").style.left = `${lo / inf * 100}%`; $("dbhFill").style.right = `${100 - hi / inf * 100}%`;
  $("dbhVal").textContent = dbhText();
  ls.set("dbhRange", [lo, hi >= inf ? null : hi]);
  if (S.sel && !visible(S.sel)) closeSheet();
  updateProgress(); draw();
}
function setDbhScale() {
  // 右端 (上限なし) は、データの一番太い木より 5 cm 刻みで上
  const mx = Math.max(10, ...S.trees.map((t) => t.dbh || 0));
  const inf = Math.ceil(mx / 5) * 5 + 5;
  const [lo, hi] = ls.get("dbhRange", [10, null]);     // 既定: 10 cm 〜 上限なし
  for (const id of ["dbhMin", "dbhMax"]) $(id).max = inf;
  $("dbhMin").value = Math.min(lo, inf); $("dbhMax").value = hi == null ? inf : Math.min(hi, inf);
  onDbhRange();
}
$("dbhMin").addEventListener("input", onDbhRange);
$("dbhMax").addEventListener("input", onDbhRange);
$("onlyTodo").addEventListener("change", () => { S.onlyTodo = $("onlyTodo").checked; updateProgress(); draw(); });
window.addEventListener("resize", draw);

// ---------------------------------------------------------------- 起動
(async function init() {
  setDbhScale();
  if ("serviceWorker" in navigator && window.isSecureContext) navigator.serviceWorker.register("sw.js").catch(() => {});
  try {
    const last = ls.get("lastSite", null), sites = await DB.all("sites");
    const id = sites.find((s) => s.id === last) ? last : (sites[0] && sites[0].id);
    if (id) await openSite(id);
  } catch (e) { toast("端末の保存領域が使えません (プライベートブラウズでは記録が残りません)", 5000); }
  draw();
})();
