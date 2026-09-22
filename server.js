// 入口层：只做 HTTP 收发、请求体解析、并发提交去重和路由编排。
// 业务判定在 rules.js，记录存储在 store.js。
import http from "node:http";
import { getDb, update } from "./store.js";
import {
  HttpError,
  addRace,
  amendVaccine,
  history,
  listView,
  registerPigeon,
  registerVaccine,
  relation,
  requestTransfer,
  today
} from "./rules.js";

const port = Number(process.env.PORT || 3024);

async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid_json");
  }
}
function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}

// 并发提交去重：同一 key 在首次请求落库前到达的并发提交，共用首次结果。
// 首次请求失败（如字段缺失 400）不缓存，允许修正后重新提交。
const inFlight = new Map();
function dedupe(key, producer) {
  const running = inFlight.get(key);
  if (running) return running.then(out => ({ ...out, concurrent: true }));
  const job = (async () => {
    try {
      return await producer();
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, job);
  return job;
}

const page = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>赛鸽疫苗登记与隔离转让台</title>
  <style>
    :root { --bg:#eff2f5; --panel:#fff; --ink:#1f2833; --muted:#697786; --line:#d3dce4; --accent:#315f83; --red:#9b3f35; --amber:#9a6b1f; --green:#2f6b45; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:22px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:16px; align-items:center; }
    h1 { margin:0; font-size:26px; } h2 { margin:0 0 12px; font-size:18px; } h3 { margin:0; }
    main { display:grid; grid-template-columns:380px 1fr; gap:22px; padding:22px 28px; }
    form,.panel,.card,.stat { background:#fff; border:1px solid var(--line); border-radius:8px; padding:16px; }
    .entry { display:grid; gap:14px; align-content:start; }
    label { display:block; margin:10px 0 5px; color:var(--muted); font-size:13px; } input,select { width:100%; border:1px solid var(--line); border-radius:6px; padding:9px; font:inherit; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:10px 13px; font-weight:700; cursor:pointer; margin-top:12px; }
    button[disabled] { opacity:.55; cursor:default; }
    .toolbar { display:grid; grid-template-columns:1fr auto; gap:10px; margin-bottom:14px; } .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(300px,1fr)); gap:12px; }
    .card { display:grid; gap:8px; } .meta { color:var(--muted); font-size:13px; }
    .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:3px 8px; font-size:12px; }
    .pill.quarantine { color:var(--amber); border-color:var(--amber); background:#fdf6e9; } .pill.free { color:var(--green); border-color:var(--green); background:#eef7f1; }
    .section { margin-top:14px; } .small { background:#f8fafb; border:1px solid var(--line); border-radius:8px; padding:10px; margin-bottom:8px; }
    .flash { border-radius:8px; padding:12px 14px; margin-bottom:14px; display:none; } .flash.show { display:block; } .flash.ok { background:#eef7f1; color:var(--green); border:1px solid var(--green); } .flash.err { background:#f9eeec; color:var(--red); border:1px solid var(--red); }
    .rowline { border-top:1px dashed var(--line); padding-top:8px; margin-top:6px; }
    .tag-ok { color:var(--green); font-size:12px; } .tag-conflict { color:var(--red); font-size:12px; } .tag-dup { color:var(--muted); font-size:12px; }
    @media (max-width:900px){ header{display:block;padding:18px 16px;} main{grid-template-columns:1fr;padding:16px;} }
  </style>
</head>
<body>
  <header><div><h1>赛鸽疫苗登记与隔离转让台</h1><div class="meta">疫苗登记 · 接种后二十一天隔离 · 隔离内禁转（鸽主不变、请求留档）</div></div><button id="reload" type="button">刷新</button></header>
  <main>
    <div class="entry">
      <form id="pigeonForm">
        <h2>① 创建鸽只档案</h2>
        <label>足环号</label><input name="ringNo" required>
        <label>鸽主</label><input name="owner" required>
        <label>父鸽足环号</label><input name="fatherRing">
        <label>母鸽足环号</label><input name="motherRing">
        <label>羽色</label><input name="color" required>
        <label>出生棚号</label><input name="loft" required>
        <button>保存档案</button>
      </form>
      <form id="vaccineForm" class="panel">
        <h2>② 疫苗登记（同羽同日同苗仅一次）</h2>
        <label>足环号</label><input name="ringNo" required>
        <label>接种日（留空为今天）</label><input name="date" type="date">
        <label>疫苗名</label><input name="name" placeholder="如 新城疫" required>
        <label>登记人</label><input name="registeredBy" required>
        <button>登记疫苗</button>
      </form>
      <form id="transferForm" class="panel">
        <h2>③ 转让请求</h2>
        <label>足环号</label><input name="ringNo" required>
        <label>转让日（留空为今天）</label><input name="date" type="date">
        <label>新鸽主</label><input name="to" required>
        <button>提交转让</button>
      </form>
    </div>
    <section>
      <div id="flash" class="flash"></div>
      <div class="toolbar"><input id="search" placeholder="输入足环号查询单鸽履历"><button id="searchBtn" type="button">查询</button></div>
      <div class="panel" id="detail"></div>
      <div class="section grid" id="cards"></div>
    </section>
  </main>
  <script>
    const cards = document.querySelector("#cards");
    const detail = document.querySelector("#detail");
    const search = document.querySelector("#search");
    const flash = document.querySelector("#flash");
    let pigeons = [];

    function esc(v) {
      return String(v == null ? "" : v).replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
    }
    function flashMsg(kind, text) {
      flash.className = "flash show " + kind;
      flash.textContent = text;
    }
    function api(path, options) {
      const opt = options && options.body ? Object.assign({}, options, { headers: { "Content-Type": "application/json" } }) : options;
      return fetch(path, opt).then(async res => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          const err = new Error(data.error || "请求失败");
          err.data = data; err.status = res.status;
          throw err;
        }
        return data;
      });
    }
    function qPill(q) {
      if (q.active) return '<span class="pill quarantine">隔离中 · 至 ' + esc(q.until) + '（剩 ' + q.daysLeft + ' 天，禁转）</span>';
      if (q.latestVaccine) return '<span class="pill free">可转让（最近接种 ' + esc(q.latestVaccine.date) + '，隔离已于 ' + esc(q.until) + ' 结束）</span>';
      return '<span class="pill free">可转让（尚无接种记录）</span>';
    }
    function renderCards() {
      cards.innerHTML = pigeons.map(p =>
        '<article class="card"><h3>' + esc(p.ringNo) + '</h3><div>' + qPill(p.quarantine) + '</div>'
        + '<span class="pill">' + esc(p.owner) + '</span><div class="meta">' + esc(p.color) + ' · ' + esc(p.loft) + '</div>'
        + '<div class="rowline"><b>疫苗记录</b></div>'
        + (p.vaccines.length ? p.vaccines.map(v =>
            '<div class="small">' + esc(v.date) + ' ' + esc(v.name) + '（登记人：' + esc(v.registeredBy || "—") + '）'
            + '<label>更正为：日期 / 疫苗名 / 登记人</label>'
            + '<input data-amend="' + encodeURIComponent(p.ringNo) + '" data-vid="' + encodeURIComponent(v.id) + '" '
            + 'value="' + esc(v.date) + '/' + esc(v.name) + '/' + esc(v.registeredBy || "") + '">'
            + '<button data-amendbtn data-ring="' + encodeURIComponent(p.ringNo) + '" data-vid="' + encodeURIComponent(v.id) + '">更正此条</button></div>'
          ).join("") : '<div class="meta">暂无疫苗</div>')
        + '<div class="rowline"><b>快捷转让</b></div><input data-to="' + encodeURIComponent(p.ringNo) + '" placeholder="新归属人">'
        + '<button data-transfer="' + encodeURIComponent(p.ringNo) + '">提交转让</button>'
        + '<div class="meta">已成功转让 ' + p.transfers.length + ' 次；冲突/请求留档 ' + p.transferRequests.length + ' 条</div>'
        + '</article>'
      ).join("");

      document.querySelectorAll("[data-transfer]").forEach(btn => btn.onclick = () => submitTransfer(btn));
      document.querySelectorAll("[data-amendbtn]").forEach(btn => btn.onclick = () => submitAmend(btn));
    }
    async function submitTransfer(btn) {
      const ringNo = btn.dataset.transfer;
      const to = document.querySelector('[data-to="' + ringNo + '"]').value;
      btn.disabled = true;
      try {
        const r = await api('/api/pigeons/' + ringNo + '/transfers', { method: 'POST', body: JSON.stringify({ to }) });
        if (r.duplicated) flashMsg("ok", "重复/并发提交，沿用首次结果；鸽主仍为 " + r.owner);
        else flashMsg("ok", "转让已通过并记录：" + r.request.from + " → " + r.request.to);
      } catch (e) {
        if (e.status === 409 && e.data.error === "transfer_quarantine_conflict") {
          flashMsg("err", "转让冲突：接种后二十一天隔离期内（" + e.data.quarantine.latestVaccine.date + " " + e.data.quarantine.latestVaccine.name + "，至 " + e.data.quarantine.until + " 解禁），鸽主仍为 " + e.data.owner + "，请求已留档");
        } else flashMsg("err", e.message);
      } finally { btn.disabled = false; await load(); }
    }
    async function submitAmend(btn) {
      const ringNo = btn.dataset.ring, vid = btn.dataset.vid;
      const input = document.querySelector('[data-amend="' + ringNo + '"][data-vid="' + vid + '"]');
      const parts = input.value.split("/");
      btn.disabled = true;
      try {
        const r = await api('/api/pigeons/' + ringNo + '/vaccines/' + vid, {
          method: 'PUT',
          body: JSON.stringify({ date: (parts[0] || "").trim(), name: (parts[1] || "").trim(), registeredBy: (parts[2] || "").trim() })
        });
        flashMsg("ok", "疫苗记录已更正；隔离期按新日期重算至 " + (r.quarantine.until || "—"));
      } catch (e) { flashMsg("err", e.status === 409 ? "更正后与同日同苗记录冲突，未修改" : e.message); }
      finally { btn.disabled = false; await load(); }
    }
    function tlLine(item) {
      const r = item.ref;
      if (item.kind === "vaccine") return '<div class="small">[' + esc(item.date) + '] 疫苗：' + esc(r.name) + '（登记人 ' + esc(r.registeredBy || "—") + '）</div>';
      if (item.kind === "amendment") return '<div class="small">[' + esc(item.date) + '] 疫苗更正：' + esc(r.before.date) + " " + esc(r.before.name) + " → " + esc(r.after.date) + " " + esc(r.after.name) + '（旧转让不动，隔离按新日期重算）</div>';
      if (item.kind === "transfer") return '<div class="small tag-ok">[' + esc(item.date) + '] 成功转让：' + esc(r.from) + " → " + esc(r.to) + '</div>';
      if (item.kind === "transfer_request") {
        if (r.status === "conflict") return '<div class="small tag-conflict">[' + esc(r.date) + '] 转让冲突（已留档，鸽主未变）：' + esc(r.from) + " ✕→ " + esc(r.to) + '，隔离至 ' + esc(r.conflict.until) + '</div>';
        if (r.status === "noop") return '<div class="small tag-dup">[' + esc(r.date) + '] 重复/空转请求（沿用首次结果）：' + esc(r.to) + '</div>';
        return '<div class="small tag-ok">[' + esc(r.date) + '] 转让请求通过：' + esc(r.from) + " → " + esc(r.to) + '</div>';
      }
      if (item.kind === "race") return '<div class="small">[' + esc(item.date) + '] 成绩：' + esc(r.event) + " 第 " + esc(r.rank) + " 名</div>";
      return "";
    }
    function renderHistory(data) {
      if (!data) { detail.innerHTML = '<h2>单鸽履历</h2><p class="meta">请输入足环号查看疫苗、隔离状态、转让与冲突留档。</p>'; return; }
      const p = data.pigeon;
      detail.innerHTML = '<h2>' + esc(p.ringNo) + ' 单鸽履历</h2>'
        + '<div style="margin-bottom:10px">' + qPill(data.quarantine) + ' <span class="pill">' + esc(p.owner) + '</span></div>'
        + '<div class="meta">当前鸽主：' + esc(p.owner) + ' · 羽色 ' + esc(p.color) + ' · ' + esc(p.loft) + '</div>'
        + '<div class="rowline"><b>时间线</b></div>'
        + (data.timeline.length ? data.timeline.map(tlLine).join("") : '<div class="meta">暂无记录</div>');
    }
    async function load() {
      pigeons = await api("/api/pigeons");
      renderCards();
      if (search.value.trim()) {
        try { renderHistory(await api('/api/pigeons/' + encodeURIComponent(search.value.trim()) + '/history')); }
        catch { renderHistory(null); }
      }
    }
    document.querySelector("#searchBtn").onclick = async () => {
      try { renderHistory(await api('/api/pigeons/' + encodeURIComponent(search.value.trim()) + '/history')); }
      catch (e) { renderHistory(null); flashMsg("err", e.message); }
    };
    document.querySelector("#reload").onclick = () => load().then(() => flashMsg("ok", "已刷新，状态与列表一致"));

    function errText(e) {
      if (e.data && e.data.fields) return "整条拒绝：缺少 " + e.data.fields.join("、");
      const map = {
        transfer_quarantine_conflict: "转让冲突：隔离期内不得转让（至 " + (e.data && e.data.quarantine && e.data.quarantine.until) + " 解禁），鸽主未变，请求已留档",
        duplicate_vaccine: "同羽同日同种疫苗已登记，不可重复",
        ring_exists: "该足环号档案已存在",
        pigeon_not_found: "查无此足环号",
        invalid_vaccine_date: "接种日期格式无效",
        invalid_transfer_date: "转让日期格式无效",
        invalid_json: "请求内容不是有效 JSON"
      };
      return (e.data && map[e.data.error]) || e.message;
    }
    function bindForm(id, submit) {
      const form = document.querySelector("#" + id);
      form.onsubmit = async event => {
        event.preventDefault();
        const btn = form.querySelector("button"); btn.disabled = true;
        try {
          await submit(Object.fromEntries(new FormData(form).entries()));
          form.reset();
        } catch (e) {
          flashMsg("err", errText(e));
        } finally { btn.disabled = false; await load(); }
      };
    }

    bindForm("pigeonForm", async o => {
      await api("/api/pigeons", { method: "POST", body: JSON.stringify(o) });
      flashMsg("ok", "档案已创建");
    });

    bindForm("vaccineForm", async o => {
      const r = await api('/api/pigeons/' + encodeURIComponent(o.ringNo) + '/vaccines', {
        method: "POST",
        body: JSON.stringify({ date: o.date || undefined, name: o.name, registeredBy: o.registeredBy })
      });
      flashMsg("ok", r.duplicated
        ? "重复或并发提交，沿用首次结果：" + r.vaccine.date + " " + r.vaccine.name
        : "疫苗已登记；隔离至 " + (r.quarantine.until || "—") + "，期内不得转让");
    });

    bindForm("transferForm", async o => {
      const r = await api('/api/pigeons/' + encodeURIComponent(o.ringNo) + '/transfers', {
        method: "POST",
        body: JSON.stringify({ to: o.to, date: o.date || undefined })
      });
      flashMsg("ok", r.duplicated ? "重复/并发提交，沿用首次结果" : "转让通过：" + r.request.from + " → " + r.request.to);
    });
    load();
  </script>
</body>
</html>`;

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const asOf = url.searchParams.get("asOf") || today();

    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(page);
    }

    if (req.method === "GET" && url.pathname === "/api/pigeons") {
      const db = await getDb();
      return sendJson(res, 200, listView(db, asOf));
    }

    if (req.method === "POST" && url.pathname === "/api/pigeons") {
      const input = await body(req);
      const out = await update(db => registerPigeon(db, input, asOf));
      return sendJson(res, 201, out.pigeon);
    }

    const historyMatch = url.pathname.match(/^\/api\/pigeons\/(.+)\/history$/);
    if (historyMatch && req.method === "GET") {
      const db = await getDb();
      const data = history(db, decodeURIComponent(historyMatch[1]), asOf);
      return data ? sendJson(res, 200, data) : sendJson(res, 404, { error: "pigeon_not_found" });
    }

    const relationMatch = url.pathname.match(/^\/api\/pigeons\/(.+)\/relation$/);
    if (relationMatch && req.method === "GET") {
      const db = await getDb();
      const data = relation(db, decodeURIComponent(relationMatch[1]));
      return data ? sendJson(res, 200, data) : sendJson(res, 404, { error: "pigeon_not_found" });
    }

    const amendMatch = url.pathname.match(/^\/api\/pigeons\/(.+)\/vaccines\/(.+)$/);
    if (amendMatch && req.method === "PUT") {
      const ringNo = decodeURIComponent(amendMatch[1]);
      const vaccineId = decodeURIComponent(amendMatch[2]);
      const input = await body(req);
      const out = await update(db => amendVaccine(db, ringNo, vaccineId, input, asOf));
      return sendJson(res, 200, out);
    }

    const actionMatch = url.pathname.match(/^\/api\/pigeons\/(.+)\/(transfers|races|vaccines)$/);
    if (actionMatch && req.method === "POST") {
      const ringNo = decodeURIComponent(actionMatch[1]);
      const kind = actionMatch[2];
      const input = await body(req);

      if (kind === "vaccines") {
        // key 只覆盖幂等性维度：同羽 + 日 + 苗。并发提交沿用首次结果。
        const date = input.date || asOf;
        const out = await dedupe(`vaccine:${ringNo}:${date}:${(input.name || "").trim()}`,
          () => update(db => registerVaccine(db, ringNo, input, asOf)));
        return sendJson(res, 200, out);
      }
      if (kind === "transfers") {
        const out = await dedupe(`transfer:${ringNo}:${input.date || asOf}:${(input.to || "").trim()}`,
          () => update(db => requestTransfer(db, ringNo, input, asOf)));
        if (!out.accepted) return sendJson(res, 409, { error: "transfer_quarantine_conflict", ...out });
        return sendJson(res, 200, out);
      }
      const out = await update(db => addRace(db, ringNo, input, asOf));
      return sendJson(res, 200, out);
    }

    sendJson(res, 404, { error: "not_found" });
  } catch (error) {
    if (error instanceof HttpError) return sendJson(res, error.status, error.payload);
    sendJson(res, 500, { error: error.message });
  }
});

server.listen(port, () => console.log(`Pigeon vaccine & quarantine transfer app listening on http://localhost:${port}`));
