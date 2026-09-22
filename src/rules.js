// 判定层：纯函数，不读写文件、不处理 HTTP。
// 规则：每羽同一天同种疫苗只能登记一次；接种后隔离 21 天（接种当天计第 0 天，
// 满 21 天当天起可转让）；更正疫苗日期后，尚未结束的隔离期按新日期重算。

export const ISOLATION_DAYS = 21;

// ---------- 日期 ----------

// 把任意输入规范化为 YYYY-MM-DD；非法（含空值）返回 null。
export function normalizeDate(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const stamp = Date.parse(`${text}T00:00:00Z`);
  if (Number.isNaN(stamp)) return null;
  // 回填校验，防止 2026-02-31 之类的日期。
  const d = new Date(stamp);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}` === text ? text : null;
}

export function todayStamp(now = new Date()) {
  const d = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 10);
}

// b - a 的整天数（同一日期为 0）。
export function dateSpan(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

export function addDays(date, days) {
  const d = new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000);
  return d.toISOString().slice(0, 10);
}

// ---------- 疫苗登记 ----------

// 校验疫苗登记/更正输入。date、name、registeredBy 任一缺失即整条拒绝。
// 返回 { ok:false, field } 或 { ok:true, value }。
export function validateVaccineInput(input = {}, { requireRegisteredBy = true } = {}) {
  const date = normalizeDate(input.date);
  if (!date) return { ok: false, field: "date" };

  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) return { ok: false, field: "name" };

  if (requireRegisteredBy) {
    const registeredBy = typeof input.registeredBy === "string" ? input.registeredBy.trim() : "";
    if (!registeredBy) return { ok: false, field: "registeredBy" };
    return { ok: true, value: { date, name, registeredBy } };
  }
  return { ok: true, value: { date, name } };
}

// 同一天、同一种疫苗（名称按去空格后比较，不区分大小写）。
export function isSameVaccine(a, b) {
  return a.date === b.date && a.name.trim().toLowerCase() === b.name.trim().toLowerCase();
}

export function findVaccine(pigeon, candidate) {
  return (pigeon.vaccines || []).find(v => isSameVaccine(v, candidate));
}

// 隔离判定默认只看今天及之前接种的疫苗；更正重算时可显式传入基准日。
export function vaccineIsolation(vaccine, onDate) {
  const start = vaccine.date;
  const end = addDays(start, ISOLATION_DAYS);
  const elapsed = dateSpan(start, onDate);
  const active = elapsed >= 0 && elapsed < ISOLATION_DAYS;
  return { vaccineId: vaccine.id, date: start, name: vaccine.name, end, remaining: active ? ISOLATION_DAYS - elapsed : 0, active };
}

function activeVaccineIsolations(pigeon, onDate) {
  return (pigeon.vaccines || [])
    .filter(v => dateSpan(v.date, onDate) >= 0)
    .map(v => vaccineIsolation(v, onDate))
    .filter(item => item.active);
}

// 一羽鸽子在某日的隔离状态：active 表示隔离中，最早可转让日取各隔离期结束日的最大值。
export function isolationStatus(pigeon, onDate = todayStamp()) {
  const blocks = activeVaccineIsolations(pigeon, onDate);
  if (!blocks.length) return { isolated: false, blocks: [], transferableFrom: onDate, remaining: 0 };
  const transferableFrom = blocks.reduce((max, b) => (b.end > max ? b.end : max), blocks[0].end);
  return {
    isolated: true,
    blocks,
    transferableFrom,
    remaining: dateSpan(onDate, transferableFrom)
  };
}

// 转让判定：隔离中返回冲突，并指出阻断的疫苗及最早可转让日。
export function checkTransfer(pigeon, { date = todayStamp(), to = "", from = null } = {}) {
  const target = typeof to === "string" ? to.trim() : "";
  if (!target) return { ok: false, status: 400, code: "to_required" };

  const onDate = normalizeDate(date) ? normalizeDate(date) : todayStamp();
  const status = isolationStatus(pigeon, onDate);
  if (status.isolated) {
    return {
      ok: false,
      status: 409,
      code: "isolation_active",
      error: `隔离期内不得转让，${status.transferableFrom} 起可转让`,
      isolation: status
    };
  }

  const currentOwner = pigeon.owner;
  if (from != null && from !== currentOwner) {
    return { ok: false, status: 409, code: "owner_changed", currentOwner };
  }
  return { ok: true, date: onDate, to: target };
}
