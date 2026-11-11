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
  "広葉樹": "その他広葉樹", "広葉樹Ⅱ": "その他広葉樹", "針葉樹": "その他針葉樹" };
// まだ現地で記録していない木は、解析の候補 (針葉樹・広葉樹) で塗る
const CAND_COLORS = { "針葉樹 (候補)": "#2f7d4f", "広葉樹 (候補)": "#d98c00" };
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
  dbhMin: 10, dbhMax: Infinity, onlyTodo: false, onlySpCheck: false, layers: [], mag: ls.get("mag", 10), labels: ls.get("labels", true),
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
  if (t.sp === "針葉樹" || t.sp === "広葉樹") return `${t.sp} (候補)`;
  return SP_FROM_ANALYSIS[t.sp] || "";      // 前の版のデータ (樹種名が入っている)
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
function spColor(s) { return SP_COLORS[s] || CAND_COLORS[s] || UNKNOWN_COLOR; }

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
  if (S.onlySpCheck && !(t.spc === "低" && !r.sp)) return false;     // 樹種が要確認で、まだ記録していない木
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
  const base = drawBasemap(W, H, dpr);
  // 陰影図 (背景地図があれば少し透かして道などを見せる)
  if (S.img && ter) {
    const [x0, y0, x1, y1] = ter.bounds;
    ctx.imageSmoothingEnabled = true;
    ctx.globalAlpha = base ? 0.7 : 1;
    ctx.drawImage(S.img, sx(x0), sy(y1), (x1 - x0) * sc, (y1 - y0) * sc);
    ctx.globalAlpha = 1;
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
  // GPS の軌跡 (通った道)。白で縁取りした青い線。間が空いたところはつながない
  const [segs] = trackSegments();
  if (segs.length) {
    ctx.lineJoin = "round"; ctx.lineCap = "round";
    for (const [w, c] of [[6, "rgba(255,255,255,.9)"], [3, "#1a6fd6"]]) {
      ctx.strokeStyle = c; ctx.lineWidth = w; ctx.beginPath();
      for (const s of segs) { ctx.moveTo(sx(s[0][0]), sy(s[0][1])); for (const q of s.slice(1)) ctx.lineTo(sx(q[0]), sy(q[1])); }
      ctx.stroke();
    }
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
    if (t.spc === "低" && !r.sp) {     // 樹種の候補が要確認 (現地で樹種を記録すると消える)
      const q = Math.max(6, Math.min(9, R * 0.5));
      ctx.fillStyle = "#ef6c00"; ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(X - R * 0.75, Y - R * 0.75, q, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.fillStyle = "#fff"; ctx.font = `bold ${Math.round(q * 1.5)}px sans-serif`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText("?", X - R * 0.75, Y - R * 0.75 + 0.5); ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
    }
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
  if (base) {     // 地理院タイルの出典 (利用の条件)
    const txt = `出典: 地理院タイル (${BASEMAPS[S.base].label})`;
    ctx.font = "11px sans-serif"; const w = ctx.measureText(txt).width;
    ctx.fillStyle = "rgba(255,255,255,.85)"; ctx.fillRect(W - w - 10, 0, w + 10, 16);
    ctx.fillStyle = "#333"; ctx.fillText(txt, W - w - 5, 12);
  }
}

// ---------------------------------------------------------------- 背景地図 (地理院タイル)
// タイル (Web メルカトル) の角を開いているデータの座標系に直し、アフィン変換で貼る。見た・保存したタイルは
// Service Worker がキャッシュ (TILE_CACHE) に残すので、電波の無い所でも出る
const GSI = "https://cyberjapandata.gsi.go.jp/xyz";
const BASEMAPS = {
  none: { label: "なし" },
  std: { label: "標準地図", url: `${GSI}/std/{z}/{x}/{y}.png`, min: 5, max: 18 },
  pale: { label: "淡色地図", url: `${GSI}/pale/{z}/{x}/{y}.png`, min: 5, max: 18 },
  photo: { label: "航空写真", url: `${GSI}/seamlessphoto/{z}/{x}/{y}.jpg`, min: 2, max: 18 },
};
const TILE_CACHE = "forestfield-tiles";
S.base = ls.get("basemap", "std");
const tiles = new Map();     // url -> {img, ok}
const lon2tx = (lon, z) => (lon + 180) / 360 * 2 ** z;
const lat2ty = (lat, z) => (1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2 * 2 ** z;
const tx2lon = (x, z) => x / 2 ** z * 360 - 180;
const ty2lat = (y, z) => Math.atan(Math.sinh(Math.PI * (1 - 2 * y / 2 ** z))) * 180 / Math.PI;
const tileUrl = (b, z, x, y) => BASEMAPS[b].url.replace("{z}", z).replace("{x}", x).replace("{y}", y);
let llLocal = null;
/** 緯度経度 -> 基準点からの m (proj4 があれば正確に、無ければ線形近似) */
function llToLocal(lat, lon) {
  if (!llLocal || llLocal.site !== S.siteId) {
    let f = null;
    try { f = makeLocal("EPSG:4326"); } catch (e) { f = null; }
    llLocal = { site: S.siteId, f: f || (([lo, la]) => llToXY(la, lo)) };
  }
  return llLocal.f([lon, lat]);
}
function getTile(url) {
  let t = tiles.get(url);
  if (!t) {
    t = { img: new Image(), ok: false, fail: false };
    t.img.crossOrigin = "anonymous";
    t.img.onload = () => { t.ok = true; draw(); };
    t.img.onerror = () => { t.fail = true; };
    t.img.src = url;
    tiles.set(url, t);
    if (tiles.size > 600) tiles.delete(tiles.keys().next().value);   // 古いものから捨てる
  }
  return t;
}
function drawBasemap(W, H, dpr) {
  const B = BASEMAPS[S.base];
  if (!B || !B.url) return false;
  const lat0 = S.site.origin.lat;
  // 画面の 1 px ≒ タイルの 1 px になる拡大段階
  let z = Math.round(Math.log2(156543.034 * Math.cos(lat0 * Math.PI / 180) * S.view.scale));
  z = Math.max(B.min, Math.min(B.max, z));
  const corners = [[0, 0], [W, 0], [0, H], [W, H]].map(([px, py]) => xyToLL(wx(px), wy(py)));
  const lats = corners.map((c) => c[0]), lons = corners.map((c) => c[1]);
  let x0, x1, y0, y1;
  for (;;) {
    x0 = Math.floor(lon2tx(Math.min(...lons), z)); x1 = Math.floor(lon2tx(Math.max(...lons), z));
    y0 = Math.floor(lat2ty(Math.max(...lats), z)); y1 = Math.floor(lat2ty(Math.min(...lats), z));
    if ((x1 - x0 + 1) * (y1 - y0 + 1) <= 64 || z <= B.min) break;
    z--;     // 引いた表示ではタイルが多くなりすぎないように粗くする
  }
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      // そのタイルが無ければ (読み込み中・保存していない)、粗い段階のタイルの一部を拡大して代わりにする
      let t = null, k = 0;
      for (; k <= 6 && z - k >= B.min; k++) {
        const c = getTileIfReady(tileUrl(S.base, z - k, x >> k, y >> k), k === 0);
        if (c) { t = c; break; }
      }
      if (!t) continue;
      const s = 256 >> k, ox = (x - ((x >> k) << k)) * s, oy = (y - ((y >> k) << k)) * s;
      const P = (ix, iy) => { const [lx, ly] = llToLocal(ty2lat(iy, z), tx2lon(ix, z)); return [sx(lx), sy(ly)]; };
      const nw = P(x, y), ne = P(x + 1, y), sw = P(x, y + 1);
      ctx.setTransform(dpr * (ne[0] - nw[0]) / 256, dpr * (ne[1] - nw[1]) / 256, dpr * (sw[0] - nw[0]) / 256,
        dpr * (sw[1] - nw[1]) / 256, dpr * nw[0], dpr * nw[1]);
      ctx.drawImage(t.img, ox, oy, s, s, 0, 0, 256.6, 256.6);      // 少し重ねて継ぎ目を消す
    }
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return true;
}
function getTileIfReady(url, request) {
  const t = request ? getTile(url) : tiles.get(url);     // 粗い段階は、もう読んであるものだけ使う
  return t && t.ok ? t : null;
}
function renderBaseBtns() {
  $("baseBtns").innerHTML = Object.entries(BASEMAPS).map(([k, b]) =>
    `<button data-base="${k}" class="${k === S.base ? "on" : ""}">${b.label}</button>`).join("");
}
$("baseBtns").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-base]"); if (!b) return;
  S.base = b.dataset.base; ls.set("basemap", S.base); renderBaseBtns(); draw();
});

/** 調査地 (地形の範囲 + 周り 500 m) の背景地図を、拡大段階 13〜18 まで端末に保存する */
async function saveTiles() {
  const B = BASEMAPS[S.base];
  if (!B.url) { toast("背景地図を選んでから保存してください"); return; }
  const [bx0, by0, bx1, by1] = S.site.terrain ? S.site.terrain.bounds : [-100, -100, 100, 100];
  const m = 500, ll = [[bx0 - m, by0 - m], [bx1 + m, by1 + m]].map(([x, y]) => xyToLL(x, y));
  const urls = [];
  for (let z = Math.max(13, B.min); z <= B.max; z++) {
    const xa = Math.floor(lon2tx(ll[0][1], z)), xb = Math.floor(lon2tx(ll[1][1], z));
    const ya = Math.floor(lat2ty(ll[1][0], z)), yb = Math.floor(lat2ty(ll[0][0], z));
    for (let x = xa; x <= xb; x++) for (let y = ya; y <= yb; y++) urls.push(tileUrl(S.base, z, x, y));
  }
  if (!confirm(`${B.label}のタイル ${urls.length} 枚 (数 MB) を端末に保存します。電波のある所で行ってください。`)) return;
  const cache = await caches.open(TILE_CACHE);
  let done = 0, fail = 0, i = 0;
  const worker = async () => {
    while (i < urls.length) {
      const u = urls[i++];
      try {
        if (!(await cache.match(u))) {
          const r = await fetch(u, { mode: "cors" });
          if (r.ok) await cache.put(u, r); else fail++;
        }
      } catch (e) { fail++; }
      done++;
      if (done % 20 === 0) $("tileInfo").textContent = `保存中 ${done} / ${urls.length}`;
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);    // 地理院の負担にならないよう 4 本ずつ
  await renderTileInfo();
  toast(fail ? `保存しました (${urls.length - fail} 枚。${fail} 枚は取れませんでした)` : `${B.label}を保存しました (${urls.length} 枚)`);
}
async function renderTileInfo() {
  try {
    const n = (await (await caches.open(TILE_CACHE)).keys()).length;
    $("tileInfo").textContent = n ? `端末に保存した背景地図: ${n} 枚 (見た場所も自動で保存)` : "背景地図は、見た場所だけ端末に残ります";
  } catch (e) { $("tileInfo").textContent = ""; }
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
  const sp = [...Object.keys(CAND_COLORS), ...SP_CATS].filter((s) => used.has(s));
  if ([...used].some((s) => !SP_COLORS[s] && !CAND_COLORS[s])) sp.push("不明");
  $("legend").innerHTML = sp.map((s) => `<div><i style="background:${spColor(s)}"></i>${s}</div>`).join("") +
    `<div><i style="background:${FLAG_COLORS.bite}"></i>食痕</div><div><i style="background:${FLAG_COLORS.nara}"></i>ナラ枯れ</div>` +
    `<div><i style="background:${FLAG_COLORS.other}"></i>他の記録</div><div>✕ 枯死・倒木</div><div>⊘ 存在しない</div><div><i style="background:#ef6c00"></i>? 候補が要確認</div><div>太枠 = 確認済み</div>`;
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
  $("tInfo").textContent = t.added ? "現地で追加した木" :
    `解析: 胸高直径 ${t.dbh ?? "-"} cm ・ 樹高 ${t.h ?? "-"} m` +
    (t.conf != null && t.conf < 0.8 ? ` ・ 幹の確度 ${t.conf} (要確認)` : "");
  // 樹種の候補 (解析が幹の形と航空レーザから付けたもの)。確からしさ 低 = 現地で要確認
  const src = !t.spb && S.site.species_source ? ` (${S.site.species_source})` : "";
  $("tSp").innerHTML = t.added ? "" :
    `解析の候補 <b>${t.sp || "不明"}</b>${src}` + (t.spc ? ` ・ 確からしさ <b class="${t.spc === "低" ? "warn" : ""}">${t.spc}${t.spc === "低" ? " (要確認)" : ""}</b>` : "") +
    (t.spb ? `<br><span class="hint">${t.spb}</span>` : "");
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
    // 電波が弱いときのタイムアウト (code 3) は測位を続けるので知らせない
    if (err.code === 1) {
      toast("位置情報の利用が許可されていません。ブラウザ (iPhone は 設定 > プライバシー > 位置情報サービス) で許可してください", 6000);
      stopGps();
    } else if (err.code === 2) toast("現在地が取れません (屋内・谷底など)。測位を続けます", 3000);
    setGpsState();
  }, { enableHighAccuracy: true, maximumAge: 2000, timeout: 30000 });
  keepAwake();
  setGpsState();
}
// 画面が消えると端末が GPS を止めるので、GPS 中は画面を点けたままにする。アプリから離れると解除されるので戻ったら取り直す
function keepAwake() {
  if (!("wakeLock" in navigator) || S.watch === null || document.visibilityState !== "visible") return;
  navigator.wakeLock.request("screen").then((w) => { S.wake = w; }).catch(() => {});
}
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") keepAwake(); });
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
const TRACK_MAX_ACC = 50;     // これより誤差の大きい点は軌跡に残さない (m)
const TRACK_GAP_MS = 120000;  // これより間が空いたら線をつながない (アプリから離れていた・GPS を止めていた)
function recordTrack() {
  const g = S.gps, last = S.track[S.track.length - 1];
  if (g.acc > TRACK_MAX_ACC) { S.skipped = (S.skipped || 0) + 1; return; }
  if (last) {
    const [x0, y0] = llToXY(last.lat, last.lon), [x1, y1] = llToXY(g.lat, g.lon);
    if (Math.hypot(x1 - x0, y1 - y0) < 2 && g.t - last.t < 15000) return;
  }
  const p = { site: S.siteId, t: g.t, lat: g.lat, lon: g.lon, acc: g.acc };
  S.track.push(p); DB.put("tracks", p).catch(() => {});
}
/** 軌跡を、間の空いたところで切った線のリストにする (基準点からの m)。長さ (m) も返す */
function trackSegments() {
  const segs = []; let cur = [], len = 0, prev = null;
  for (const p of S.track) {
    const [x, y] = llToXY(p.lat, p.lon), q = [x + S.calib.dx, y + S.calib.dy, p.t];
    if (prev && q[2] - prev[2] > TRACK_GAP_MS) { if (cur.length > 1) segs.push(cur); cur = []; }
    else if (prev) len += Math.hypot(q[0] - prev[0], q[1] - prev[1]);
    cur.push(q); prev = q;
  }
  if (cur.length > 1) segs.push(cur);
  return [segs, len];
}
// GPS の表示をタップすると、測位と軌跡の記録の様子を出す (調査地から離れた場所での動作確認にも)
$("gpsState").addEventListener("click", () => {
  if (!S.site) return;
  const [segs, len] = trackSegments(), last = S.track[S.track.length - 1];
  const lines = [];
  if (S.watch === null) lines.push("GPS は止まっています (右下の ◎ で開始)");
  else if (!S.gps) lines.push("測位中… (屋外で数十秒かかることがあります)");
  else {
    const d = Math.hypot(...llToXY(S.gps.lat, S.gps.lon));
    lines.push(`現在地 ${S.gps.lat.toFixed(6)}, ${S.gps.lon.toFixed(6)} (誤差 ±${Math.round(S.gps.acc)} m)`,
      `調査地の中心から ${d < 1000 ? `${Math.round(d)} m` : `${(d / 1000).toFixed(1)} km`}`);
  }
  lines.push(`軌跡: ${S.track.length} 点・${len < 1000 ? `${Math.round(len)} m` : `${(len / 1000).toFixed(2)} km`}` +
    (last ? `・最後の記録 ${new Date(last.t).toLocaleTimeString("ja-JP")}` : ""));
  if (S.skipped) lines.push(`誤差 ${TRACK_MAX_ACC} m を超えて残さなかった点: ${S.skipped}`);
  lines.push("画面を消す・別のアプリに切り替えると記録が止まります");
  toast(lines.join("\n"), 8000);
});
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

// ---- 座標系の変換: 重ねるファイルの座標系 (src) から、開いているデータの座標系の基準点からの m へ
const siteCode = () => `EPSG:${S.site.crs_epsg}`;
const hasProj = () => typeof proj4 === "function" && !!proj4.defs(siteCode());
/** src ("EPSG:xxxx" か proj4 に渡せる定義) -> 基準点からの m に直す関数 */
function makeLocal(src) {
  const o = S.site.origin;
  if (!src || src === siteCode()) return ([a, b]) => [a - o.x, b - o.y];
  if (hasProj()) {
    const tr = proj4(src, siteCode());
    return (c) => { const [x, y] = tr.forward([c[0], c[1]]); return [x - o.x, y - o.y]; };
  }
  if (src === "EPSG:4326") return ([lon, lat]) => llToXY(lat, lon);    // 変換の定義が無いときは基準点での線形近似
  throw new Error(`座標系 ${src} を変換できません`);
}
function isLonLat(c) { return Math.abs(c[0]) <= 180 && Math.abs(c[1]) <= 90; }
/** 座標系の情報が無い平面座標: 調査地のそばに来る座標系を探す (同じ座標系を優先)。戻り値: [code, 調査地からの距離 m] */
function guessCrs(c) {
  const o = S.site.origin;
  const dist = (code) => { try { const [x, y] = makeLocal(code)(c); return Math.hypot(x, y); } catch (e) { return Infinity; } };
  const own = dist(siteCode());
  if (own < 20000 || !hasProj()) return [siteCode(), own];
  let best = [null, Infinity];
  for (const code of Object.keys(CRS_JP)) {
    if (!/\+proj=(tmerc|utm)/.test(CRS_JP[code][1])) continue;
    const d = dist(code);
    if (d < best[1]) best = [code, d];
  }
  return best;
}
const crsName = (code) => (typeof CRS_JP !== "undefined" && CRS_JP[code] ? `${CRS_JP[code][0]} (${code})` : code);
/** .prj (WKT) -> proj4 に渡す定義。旧日本測地系で TOWGS84 が無ければ、同梱の定義と同じ 3 パラメータを足す */
function prjToDef(wkt) {
  if (!wkt) return null;
  if (/tokyo/i.test(wkt) && !/TOWGS84/i.test(wkt)) {
    const tw = (CRS_JP["EPSG:4301"][1].match(/\+towgs84=([-\d.,]+)/) || [])[1];
    if (tw) wkt = wkt.replace(/(SPHEROID\[[^\]]*\])/i, `$1,TOWGS84[${tw}]`);
  }
  return wkt;
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
function parseGPX(text, toLocal) {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  const pt = (e) => [+e.getAttribute("lon"), +e.getAttribute("lat")];
  const out = [];
  for (const trk of [...doc.getElementsByTagName("trk"), ...doc.getElementsByTagName("rte")]) {
    const nm = trk.getElementsByTagName("name")[0];
    const segs = [...trk.getElementsByTagName("trkseg")];
    const lines = segs.length ? segs.map((s) => [...s.getElementsByTagName("trkpt")].map(pt)) : [[...trk.getElementsByTagName("rtept")].map(pt)];
    out.push(featureFrom(nm ? nm.textContent.trim() : "", [], lines.filter((l) => l.length > 1), [], toLocal));
  }
  for (const w of doc.getElementsByTagName("wpt")) {
    const nm = w.getElementsByTagName("name")[0];
    out.push(featureFrom(nm ? nm.textContent.trim() : "", [], [], [pt(w)], toLocal));
  }
  return out;
}

/** zip の中身を取り出す (shp・dbf・prj・cpg だけ)。圧縮は deflate を DecompressionStream で戻す */
async function unzip(buf) {
  const v = new DataView(buf), out = {};
  let e = buf.byteLength - 22;
  while (e >= 0 && v.getUint32(e, true) !== 0x06054b50) e--;           // 中央ディレクトリの終わり
  if (e < 0) throw new Error("zip ではありません");
  let p = v.getUint32(e + 16, true);
  const n = v.getUint16(e + 10, true);
  for (let i = 0; i < n; i++) {
    const method = v.getUint16(p + 10, true), size = v.getUint32(p + 20, true);
    const nl = v.getUint16(p + 28, true), xl = v.getUint16(p + 30, true), cl = v.getUint16(p + 32, true);
    const off = v.getUint32(p + 42, true);
    const name = new TextDecoder().decode(new Uint8Array(buf, p + 46, nl));
    p += 46 + nl + xl + cl;
    if (!/\.(shp|dbf|prj|cpg)$/i.test(name) || /__MACOSX/.test(name)) continue;
    const lnl = v.getUint16(off + 26, true), lxl = v.getUint16(off + 28, true);
    const data = new Uint8Array(buf, off + 30 + lnl + lxl, size);
    let raw;
    if (method === 0) raw = data.slice().buffer;
    else if (method === 8) raw = await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer();
    else throw new Error("この圧縮形式の zip は読めません");
    out[name] = raw;
  }
  return out;
}
/** shp の zip -> 地物。座標系は .prj から (無ければ調査地のそばに来るものを探す) */
async function parseShpZip(buf) {
  const files = await unzip(buf), names = Object.keys(files);
  const shps = names.filter((n) => /\.shp$/i.test(n));
  if (!shps.length) throw new Error("zip の中に .shp がありません");
  const feats = [], notes = [];
  for (const s of shps) {
    const base = s.slice(0, -4), get = (ext) => names.find((n) => n.toLowerCase() === (base + ext).toLowerCase());
    const prj = get(".prj") ? new TextDecoder().decode(files[get(".prj")]) : "";
    const cpg = get(".cpg") ? new TextDecoder().decode(files[get(".cpg")]).trim() : "";
    const geoms = shp.parseShp(files[s]);
    let props = geoms.map(() => ({}));
    if (get(".dbf")) {
      // 日本の shp は .cpg が無いと Shift_JIS のことが多い。UTF-8 で読めなければ Shift_JIS で読み直す
      props = shp.parseDbf(files[get(".dbf")], cpg || "utf-8");
      if (!cpg && JSON.stringify(props).includes("�")) props = shp.parseDbf(files[get(".dbf")], "shift_jis");
    }
    const gj = shp.combine([geoms, props]);
    const first = firstCoord(gj);
    let src;
    if (prj) src = prjToDef(prj);
    else if (first && isLonLat(first)) src = "EPSG:4326";
    else { const [code] = guessCrs(first); src = code; notes.push(`${s} に .prj が無いため ${crsName(code)} とみなしました`); }
    feats.push(...parseGeoJSON(gj, makeLocal(src)));
  }
  return [feats, notes];
}
function firstCoord(gj) {
  const fs = gj.type === "FeatureCollection" ? gj.features : [gj];
  for (const f of fs) {
    let c = (f.geometry || f).coordinates;
    while (Array.isArray(c) && Array.isArray(c[0])) c = c[0];
    if (Array.isArray(c) && c.length >= 2) return c;
  }
  return null;
}

async function loadLayerFile(file) {
  const name = file.name.replace(/\.[^.]+$/, "");
  let feats, notes = [];
  try {
    if (/\.zip$/i.test(file.name)) [feats, notes] = await parseShpZip(await file.arrayBuffer());
    else {
      const text = await file.text();
      if (/\.gpx$/i.test(file.name) || /<gpx/i.test(text.slice(0, 500))) feats = parseGPX(text, makeLocal("EPSG:4326"));
      else if (/\.kml$/i.test(file.name) || /^\s*<\?xml|<kml/i.test(text.slice(0, 200))) feats = parseKML(text, makeLocal("EPSG:4326"));
      else {
        // GeoJSON: crs があればそれ、無ければ緯度経度 (標準) か、調査地のそばに来る平面直角座標
        const d = JSON.parse(text);
        const crs = d.crs && d.crs.properties && String(d.crs.properties.name || "");
        const m = crs && crs.match(/EPSG:{1,2}(\d+)/), first = firstCoord(d);
        let src;
        if (m) src = m[1] === "4326" || /CRS84/i.test(crs) ? "EPSG:4326" : `EPSG:${m[1]}`;
        else if (/CRS84/i.test(crs) || (first && isLonLat(first))) src = "EPSG:4326";
        else { const [code] = guessCrs(first); src = code; notes.push(`座標系の情報が無いため ${crsName(code)} とみなしました`); }
        if (src !== "EPSG:4326" && hasProj() && !proj4.defs(src)) throw new Error(`座標系 ${src} は対応していません`);
        if (src !== siteCode()) notes.push(`${crsName(src)} から ${crsName(siteCode())} に変換しました`);
        feats = parseGeoJSON(d, makeLocal(src));
      }
    }
  } catch (e) {
    toast(`読めませんでした: ${e.message || e} (shp の zip・GeoJSON・KML・GPX に対応)`, 6000); return;
  }
  feats = feats.filter((f) => f.rings.length || f.lines.length || f.points.length);
  if (!feats.length) { toast("ポリゴン・線・点が見つかりませんでした"); return; }
  // 調査地から遠すぎるもの (座標系の取り違え) は読まない
  const far = feats.every((f) => f.label && Math.hypot(f.label[0], f.label[1]) > 20000);
  if (far) { toast("調査地から 20 km 以上離れています。座標系が違う可能性があります", 6000); return; }
  S.site.userLayers = [...(S.site.userLayers || []).filter((l) => l.name !== name), { name, features: feats }];
  await DB.put("sites", S.site); buildLayers(); renderLayerList(); draw();
  toast([`${name} を重ねました (${feats.length} 件)`, ...notes].join("\n"), notes.length ? 6000 : 2500);
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
$("menuBtn").addEventListener("click", () => {
  renderSiteList(); renderBaseBtns(); renderTileInfo(); if (S.site) renderLayerList(); $("menu").hidden = false;
});
document.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-act]"); if (!b) return;
  const act = b.dataset.act;
  const needSite = ["csv", "json", "gpx", "import", "clearTrack", "deleteSite", "resetCalib", "gps", "layer", "saveTiles"];
  if (needSite.includes(act) && !S.site) { toast("先にデータを開いてください"); return; }
  if (act === "saveTiles") { saveTiles(); return; }      // 進み具合をメニューに出すので閉じない
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
$("onlySpCheck").addEventListener("change", () => { S.onlySpCheck = $("onlySpCheck").checked; updateProgress(); draw(); });
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
