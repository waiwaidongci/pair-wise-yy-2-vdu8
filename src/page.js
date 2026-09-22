// 页面：只做“入口”——提交登记/转让/更正请求，展示服务端返回的判定结果与存储记录。

export const page = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>赛鸽疫苗登记与隔离转让台</title>
  <style>
    :root { --bg:#eff2f5; --panel:#fff; --ink:#1f2833; --muted:#697786; --line:#d3dce4; --accent:#315f83; --red:#9b3f35; --green:#2f6d4b; --amber:#9a6b1f; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:22px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:16px; align-items:center; }
    h1 { margin:0; font-size:24px; } main { display:grid; grid-template-columns:360px 1fr; gap:22px; padding:22px 28px; }
    form,.panel,.card { background:#fff; border:1px solid var(--line); border-radius:8px; padding:16px; }
    h2 { margin:0 0 12px; font-size:17px; } h3 { margin:0; font-size:16px; }
    label { display:block; margin:10px 0 5px; color:var(--muted); font-size:13px; } input,select { width:100%; border:1px solid var(--line); border-radius:6px; padding:9px; font:inherit; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:9px 12px; font-weight:700; cursor:pointer; }
    button.mini { padding:6px 9px; font-size:12px; }
    .toolbar { display:grid; grid-template-columns:1fr auto; gap:10px; margin-bottom:14px; } .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(300px,1fr)); gap:12px; }
    .card { display:grid; gap:8px; } .meta { color:var(--muted); font-size:13px; }
    .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:3px 8px; font-size:12px; }
    .badge { display:inline-block; border-radius:6px; padding:4px 9px; font-size:12px; font-weight:700; }
    .badge.lock { background:#f6e4e1; color:var(--red); border:1px solid #d8a99f; }
    .badge.open { background:#e3f0e8; color:var(--green); border:1px solid #a9cdb6; }
    .section { margin-top:14px; } .relation { display:grid; grid-template-columns:repeat(3,1fr); gap:10px; margin:10px 0; }
    .small { background:#f8fafb; border:1px solid var(--line); border-radius:8px; padding:10px; font-size:13px; }
    table { width:100%; border-collapse:collapse; font-size:13px; } th,td { border-bottom:1px solid var(--line); padding:7px 6px; text-align:left; vertical-align:top; }
    th { color:var(--muted); font-weight:600; }
    .flash { margin:0 28px; border-radius:8px; padding:10px 14px; font-size:14px; display:none; }
    .flash.ok { display:block; background:#e3f0e8; color:var(--green); border:1px solid #a9cdb6; }
    .flash.err { display:block; background:#f6e4e1; color:var(--red); border:1px solid #d8a99f; }
    .row2 { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
    .inline-msg { font-size:12px; min-height:14px; }
    .inline-msg.err { color:var(--red); } .inline-msg.ok { color:var(--green); }
    .strike { color:var(--muted); text-decoration:line-through; }
    @media (max-width:900px){ header{display:block;padding:18px 16px;} main{grid-template-columns:1fr;padding:16px;} .relation{grid-template-columns:1fr;} .flash{margin:0 16px;} }
  </style>
</head>
<body>
  <header>
    <div><h1>赛鸽疫苗登记与隔离转让台</h1><div class="meta">环号档案 · 疫苗登记 · 隔离判定（接种后 21 天）· 转让留档</div></div>
    <button id="reload">刷新</button>
  </header>
  <div class="flash" id="flash"></div>
  <main>
    <form id="form">
      <h2>创建鸽只档案</h2>
      <label>足环号</label><input name="ringNo" required>
      <label>鸽主</label><input name="owner" required>
      <label>父鸽足环号</label><input name="fatherRing">
      <label>母鸽足环号</label><input name="motherRing">
      <label>羽色</label><input name="color" required>
      <label>出生棚号</label><input name="loft" required>
      <button>保存档案</button>
    </form>
    <section>
      <div class="toolbar"><input id="search" placeholder="输入足环号查询单鸽履历与血统"><button id="searchBtn">查询</button></div>
      <div class="panel" id="detail"></div>
      <div class="section grid" id="cards"></div>
    </section>
  </main>
  <script>
    const cards = document.getElementById("cards");
    const detail = document.getElementById("detail");
    const search = document.getElementById("search");
    const flash = document.getElementById("flash");
    const form = document.getElementById("form");
    let pigeons = [];
    let selectedRing = null;
    let flashTimer = null;

    function esc(value) {
      return String(value == null ? "" : value).replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
    }
    function todayStr() {
      const d = new Date(Date.now() - new Date().getTimezoneOffset() * 60000);
      return d.toISOString().slice(0, 10);
    }
    function showFlash(text, ok) {
      flash.textContent = text;
      flash.className = "flash " + (ok ? "ok" : "err");
      clearTimeout(flashTimer);
      flashTimer = setTimeout(() => { flash.className = "flash"; }, 4000);
    }
    async function api(path, options) {
      const res = await fetch(path, options && options.body ? Object.assign({}, options, { headers: { "Content-Type": "application/json" } }) : options);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const err = new Error(data.error || "请求失败");
        err.data = data;
        err.status = res.status;
        throw err;
      }
      return data;
    }
    function errText(err) {
      const map = {
        vaccine_date_required: "缺少接种日期，整条登记已拒绝",
        vaccine_name_required: "缺少疫苗名称，整条登记已拒绝",
        vaccine_registeredBy_required: "缺少登记人，整条登记已拒绝",
        to_required: "缺少新归属人，转让未提交",
        isolation_active: "隔离期内不得转让，鸽主未变更",
        ring_exists: "足环号已存在",
        pigeon_not_found: "未找到该足环号",
        vaccine_conflict: "更正后与同日同种疫苗重复"
      };
      let text = map[err.message] || err.message;
      if (err.data && err.data.isolation && err.data.isolation.transferableFrom) {
        text += "，" + err.data.isolation.transferableFrom + " 起可转让";
      }
      return text;
    }
    function badge(isolation) {
      return isolation.isolated
        ? '<span class="badge lock">隔离中 · 余 ' + isolation.remaining + ' 天 · ' + esc(isolation.transferableFrom) + ' 起可转让</span>'
        : '<span class="badge open">非隔离 · 可转让</span>';
    }

    function renderCards() {
      cards.innerHTML = pigeons.map(p => {
        const ring = esc(p.ringNo);
        return '<article class="card">'
          + '<h3>' + ring + '</h3>'
          + '<span class="pill">鸽主：' + esc(p.owner) + '</span>'
          + badge(p.isolation)
          + '<div class="meta">' + esc(p.color) + ' · ' + esc(p.loft) + '</div>'
          + '<div class="meta">父：' + esc(p.fatherRing || "未登记") + ' / 母：' + esc(p.motherRing || "未登记") + '</div>'
          + '<div class="meta">已登记疫苗 ' + (p.vaccines || []).length + ' 次 · 转让记录 ' + (p.transfers || []).length + ' 条</div>'
          + '<label>疫苗登记（接种日 / 疫苗名 / 登记人）</label>'
          + '<div class="row2"><input id="vd-' + ring + '" type="date" value="' + todayStr() + '"><input id="vn-' + ring + '" placeholder="疫苗名，如新城疫"></div>'
          + '<input id="vr-' + ring + '" placeholder="登记人">'
          + '<button data-action="vaccine" data-ring="' + ring + '">登记疫苗</button>'
          + '<label>转让请求（转让日 / 新归属人）</label>'
          + '<div class="row2"><input id="td-' + ring + '" type="date" value="' + todayStr() + '"><input id="tt-' + ring + '" placeholder="新归属人"></div>'
          + '<button data-action="transfer" data-ring="' + ring + '">请求转让</button>'
          + '<label>归巢成绩（赛事/距离/名次）</label>'
          + '<input id="rr-' + ring + '" placeholder="如 200公里/200/6">'
          + '<button data-action="race" data-ring="' + ring + '">保存成绩</button>'
          + '<button class="mini" data-action="history" data-ring="' + ring + '">查看单鸽履历</button>'
          + '<div class="inline-msg" id="msg-' + ring + '"></div>'
          + '</article>';
      }).join("");
    }

    async function load(keepDetail) {
      pigeons = await api("/api/pigeons");
      renderCards();
      if (keepDetail && selectedRing) renderDetail(selectedRing);
      else if (!keepDetail) detail.innerHTML = '<h2>单鸽履历</h2><p class="meta">请输入足环号查询，或在卡片上点“查看单鸽履历”。</p>';
    }

    function cardMsg(ring, text, ok) {
      const el = document.getElementById("msg-" + ring);
      if (el) { el.textContent = text; el.className = "inline-msg " + (ok ? "ok" : "err"); }
    }

    cards.addEventListener("click", async ev => {
      const btn = ev.target.closest("button[data-action]");
      if (!btn) return;
      const ring = btn.dataset.ring;
      const action = btn.dataset.action;
      try {
        if (action === "vaccine") {
          const body = { date: document.getElementById("vd-" + ring).value, name: document.getElementById("vn-" + ring).value, registeredBy: document.getElementById("vr-" + ring).value };
          const data = await api("/api/pigeons/" + encodeURIComponent(ring) + "/vaccines", { method: "POST", body: JSON.stringify(body) });
          cardMsg(ring, data.deduplicated ? "该日同种疫苗已登记，沿用首次记录" : "疫苗已登记，隔离期按新记录判定", true);
          showFlash(data.deduplicated ? "重复登记，沿用首次结果" : "疫苗登记成功", true);
        } else if (action === "transfer") {
          const body = { date: document.getElementById("td-" + ring).value, to: document.getElementById("tt-" + ring).value };
          const data = await api("/api/pigeons/" + encodeURIComponent(ring) + "/transfers", { method: "POST", body: JSON.stringify(body) });
          cardMsg(ring, data.deduplicated ? "同日同归属转让已存在，沿用首次记录" : "转让成功：" + esc(data.transfer.from) + " → " + esc(data.transfer.to), true);
          showFlash(data.deduplicated ? "重复转让请求，沿用首次结果" : "转让成功", true);
        } else if (action === "race") {
          const raw = document.getElementById("rr-" + ring).value.split("/");
          await api("/api/pigeons/" + encodeURIComponent(ring) + "/races", { method: "POST", body: JSON.stringify({ event: raw[0] || "未命名赛事", distance: Number(raw[1] || 0), rank: Number(raw[2] || 0) }) });
          cardMsg(ring, "成绩已保存", true);
        } else if (action === "history") {
          selectedRing = ring;
        }
        await load(true);
      } catch (err) {
        cardMsg(ring, errText(err), false);
        showFlash(errText(err), false);
        await load(true);
      }
    });

    function vaccineRows(h) {
      if (!h.vaccines.length) return '<tr><td colspan="5" class="meta">暂无疫苗记录</td></tr>';
      return h.vaccines.map(v => {
        const iso = v.isolation;
        const state = iso.active
          ? '<span class="badge lock">隔离中，余 ' + iso.remaining + ' 天</span>'
          : '<span class="meta">' + esc(iso.end) + ' 到期</span>';
        const corrected = v.correctedFrom
          ? '<div class="meta">已由 ' + esc(v.correctedFrom.date) + ' ' + esc(v.correctedFrom.name) + ' 更正，隔离按新日期重算</div>'
          : "";
        return '<tr>'
          + '<td>' + esc(v.date) + '</td>'
          + '<td>' + esc(v.name) + corrected + '</td>'
          + '<td>' + esc(v.registeredBy || "（旧档案未记录）") + '</td>'
          + '<td>' + esc(iso.end) + '<br>' + state + '</td>'
          + '<td><div class="row2"><input type="date" id="cd-' + esc(v.id) + '" value="' + esc(v.date) + '"><input id="cn-' + esc(v.id) + '" placeholder="新疫苗名（留空沿用）"></div>'
          + '<button class="mini" data-action="correct" data-ring="' + esc(h.ringNo) + '" data-vid="' + esc(v.id) + '">更正并重算隔离</button></td>'
          + '</tr>';
      }).join("");
    }

    async function renderDetail(ring) {
      try {
        const [rel, h] = await Promise.all([
          api("/api/pigeons/" + encodeURIComponent(ring) + "/relation"),
          api("/api/pigeons/" + encodeURIComponent(ring) + "/history")
        ]);
        const p = rel.pigeon;
        const transfers = h.transfers.length
          ? h.transfers.map(t => '<li>' + esc(t.date) + '：' + esc(t.from) + ' → ' + esc(t.to) + (t.registeredBy ? '（登记人：' + esc(t.registeredBy) + '）' : '') + '</li>').join("")
          : '<li class="meta">暂无转让记录（隔离冲突的请求不落档、不改鸽主）</li>';
        const races = h.races.length
          ? h.races.map(r => '<li>' + esc(r.date) + ' ' + esc(r.event) + ' ' + esc(r.distance) + '公里 第' + esc(r.rank) + '名</li>').join("")
          : '<li class="meta">暂无成绩</li>';
        detail.innerHTML = '<h2>' + esc(p.ringNo) + ' 单鸽履历</h2>'
          + '<div>' + badge(h.isolation) + ' <span class="pill">鸽主：' + esc(p.owner) + '</span></div>'
          + '<div class="relation">'
          + '<div class="small"><b>父鸽</b><br>' + esc(rel.father ? rel.father.ringNo : (p.fatherRing || "未登记")) + '</div>'
          + '<div class="small"><b>本鸽</b><br>' + esc(p.owner) + ' · ' + esc(p.color) + ' · ' + esc(p.loft) + '</div>'
          + '<div class="small"><b>母鸽</b><br>' + esc(rel.mother ? rel.mother.ringNo : (p.motherRing || "未登记")) + '</div>'
          + '</div>'
          + '<div class="meta"><b>子代</b>：' + esc(rel.children.map(c => c.ringNo).join("、") || "暂无") + '</div>'
          + '<div class="section"><h3>疫苗与隔离</h3><table><tr><th>接种日</th><th>疫苗</th><th>登记人</th><th>隔离结束</th><th>更正</th></tr>' + vaccineRows(h) + '</table></div>'
          + '<div class="section"><h3>转让留档（旧记录不删除）</h3><ul>' + transfers + '</ul></div>'
          + '<div class="section"><h3>归巢成绩</h3><ul>' + races + '</ul></div>';
      } catch (err) {
        detail.innerHTML = '<h2>单鸽履历</h2><p class="meta">' + esc(errText(err)) + '</p>';
      }
    }

    detail.addEventListener("click", async ev => {
      const btn = ev.target.closest("button[data-action='correct']");
      if (!btn) return;
      const ring = btn.dataset.ring;
      const vid = btn.dataset.vid;
      const date = document.getElementById("cd-" + vid).value;
      const nameInput = document.getElementById("cn-" + vid).value;
      const current = (await api("/api/pigeons/" + encodeURIComponent(ring) + "/history")).vaccines.find(v => v.id === vid);
      const body = { date, name: nameInput.trim() || (current ? current.name : "") };
      try {
        await api("/api/pigeons/" + encodeURIComponent(ring) + "/vaccines/" + encodeURIComponent(vid), { method: "PATCH", body: JSON.stringify(body) });
        showFlash("疫苗记录已更正，未结束的隔离期按新日期重算；旧转让留档不变", true);
      } catch (err) {
        showFlash(errText(err), false);
      }
      await load(true);
    });

    document.getElementById("searchBtn").onclick = async () => {
      selectedRing = search.value.trim();
      if (selectedRing) renderDetail(selectedRing);
    };
    document.getElementById("reload").onclick = () => load(true);
    form.onsubmit = async event => {
      event.preventDefault();
      try {
        await api("/api/pigeons", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(form).entries())) });
        showFlash("档案已保存", true);
        form.reset();
      } catch (err) {
        showFlash(errText(err), false);
      }
      await load(true);
    };
    load(false);
  </script>
</body>
</html>`;
