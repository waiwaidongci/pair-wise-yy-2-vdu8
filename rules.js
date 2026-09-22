// 业务判定层：纯函数式的规则中心。入口层与存储层都不在这里判定业务。
// 规则：
//   1. 同一羽、同一天、同一种疫苗只能登记一次；缺接种日/疫苗名/登记人整条拒绝。
//   2. 接种后 21 天内不得转让；冲突时鸽主不变，转让请求留档。
//   3. 更正疫苗日期后，未结束的隔离期按新日期重算（视图实时计算），旧转让留档不动。
//   4. 同 key 的并发提交共用首次结果（去重逻辑在入口层，最终判定仍走这里）。
import { randomUUID } from "node:crypto";

export const QUARANTINE_DAYS = 21;

export class HttpError extends Error {
  constructor(status, error, extra = {}) {
    super(error);
    this.status = status;
    this.payload = { error, ...extra };
  }
}

export function today() {
  return new Date().toISOString().slice(0, 10);
}
export function parseDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const d = new Date(`${value}T00:00:00Z`);
  if (isNaN(d.getTime())) return null;
  return d;
}
function addDays(value, days) {
  return new Date(parseDate(value).getTime() + days * 86400000).toISOString().slice(0, 10);
}
export function quarantineEnd(date) {
  return addDays(date, QUARANTINE_DAYS);
}
export function str(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function findPigeon(db, ringNo) {
  return db.pigeons.find(p => p.ringNo === ringNo) || null;
}

function latestVaccine(pigeon) {
  return pigeon.vaccines
    .filter(v => parseDate(v.date))
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))[0] || null;
}

// 当前（或 asOf 指定日）的隔离状态：最新一针决定隔离截止日。
// 截止日当天仍算隔离中（接种日 +21 天之内不得转让）。
export function quarantineInfo(pigeon, asOf = today()) {
  const latest = latestVaccine(pigeon);
  if (!latest) return { active: false, latestVaccine: null, until: null, daysLeft: 0, reason: "no_vaccine" };
  const until = quarantineEnd(latest.date);
  const daysLeft = Math.round((parseDate(until).getTime() - parseDate(asOf).getTime()) / 86400000);
  if (asOf <= until) return { active: true, latestVaccine: latest, until, daysLeft: Math.max(daysLeft, 0), reason: "within_quarantine" };
  return { active: false, latestVaccine: latest, until, daysLeft: 0, reason: "quarantine_over" };
}

function sameVaccine(list, date, name, exceptId = null) {
  return list.find(v => v.id !== exceptId && v.date === date && v.name === name) || null;
}

export function registerPigeon(db, input, now = today()) {
  const pigeon = {
    ringNo: str(input.ringNo),
    owner: str(input.owner),
    fatherRing: str(input.fatherRing),
    motherRing: str(input.motherRing),
    color: str(input.color),
    loft: str(input.loft),
    vaccines: [],
    transfers: [],
    transferRequests: [],
    amendments: [],
    races: [],
    createdAt: now
  };
  if (!pigeon.ringNo || !pigeon.owner || !pigeon.color || !pigeon.loft) {
    throw new HttpError(400, "missing_required_fields", { fields: ["ringNo", "owner", "color", "loft"] });
  }
  if (findPigeon(db, pigeon.ringNo)) throw new HttpError(409, "ring_exists");
  db.pigeons.unshift(pigeon);
  return { pigeon, duplicated: false };
}

// 疫苗登记：缺任一关键字段整条拒绝（不落任何记录）；同羽同日同苗沿用首次结果。
export function registerVaccine(db, ringNo, input, now = today()) {
  const pigeon = findPigeon(db, ringNo);
  if (!pigeon) throw new HttpError(404, "pigeon_not_found");

  const rawDate = str(input.date);
  const date = rawDate || now;
  const name = str(input.name);
  const registeredBy = str(input.registeredBy);
  // 题目明确要求：缺接种日、疫苗名或登记人整条拒绝。
  // 不传/留空日期时以当日补位；但显式传入非法日期仍拒绝。
  if (rawDate && !parseDate(rawDate)) {
    throw new HttpError(400, "invalid_vaccine_date", { fields: ["date"] });
  }
  if (!parseDate(date) || !name || !registeredBy) {
    throw new HttpError(400, "missing_required_fields", {
      fields: [
        ...(!parseDate(date) ? ["date"] : []),
        ...(!name ? ["name"] : []),
        ...(!registeredBy ? ["registeredBy"] : [])
      ]
    });
  }

  const existing = sameVaccine(pigeon.vaccines, date, name);
  if (existing) {
    // 重复提交（含并发后落库的那一条）：沿用首次结果，不再新增。
    return {
      pigeon,
      duplicated: true,
      vaccine: existing,
      quarantine: quarantineInfo(pigeon, now)
    };
  }

  const vaccine = { id: randomUUID(), date, name, registeredBy, createdAt: now };
  pigeon.vaccines.push(vaccine);
  return {
    pigeon,
    duplicated: false,
    vaccine,
    quarantine: quarantineInfo(pigeon, now)
  };
}

// 疫苗更正：改接种日/苗名/登记人。重复冲突拒绝，更正留档；隔离期由视图按新日期实时重算。
export function amendVaccine(db, ringNo, vaccineId, input, now = today()) {
  const pigeon = findPigeon(db, ringNo);
  if (!pigeon) throw new HttpError(404, "pigeon_not_found");
  const vaccine = pigeon.vaccines.find(v => v.id === vaccineId);
  if (!vaccine) throw new HttpError(404, "vaccine_not_found");

  const next = {
    date: input.date === undefined ? vaccine.date : str(input.date),
    name: input.name === undefined ? vaccine.name : str(input.name),
    registeredBy: input.registeredBy === undefined ? vaccine.registeredBy : str(input.registeredBy)
  };
  if (!parseDate(next.date)) throw new HttpError(400, "invalid_vaccine_date", { fields: ["date"] });
  if (!next.name || !next.registeredBy) {
    throw new HttpError(400, "missing_required_fields", {
      fields: [...(!next.name ? ["name"] : []), ...(!next.registeredBy ? ["registeredBy"] : [])]
    });
  }
  const clash = sameVaccine(pigeon.vaccines, next.date, next.name, vaccine.id);
  if (clash) throw new HttpError(409, "duplicate_vaccine", { existing: clash });

  const before = { date: vaccine.date, name: vaccine.name, registeredBy: vaccine.registeredBy };
  if (before.date === next.date && before.name === next.name && before.registeredBy === next.registeredBy) {
    return { pigeon, vaccine, duplicated: true, quarantine: quarantineInfo(pigeon, now) };
  }
  Object.assign(vaccine, next, { amendedAt: now });
  pigeon.amendments.push({
    id: randomUUID(),
    vaccineId: vaccine.id,
    date: now,
    before,
    after: { date: next.date, name: next.name, registeredBy: next.registeredBy },
    amendedBy: str(input.amendedBy) || next.registeredBy
  });
  return { pigeon, vaccine, quarantine: quarantineInfo(pigeon, now) };
}

// 转让请求：21 天隔离期内冲突拒绝、鸽主不变；无论成败整条留档。
export function requestTransfer(db, ringNo, input, now = today()) {
  const pigeon = findPigeon(db, ringNo);
  if (!pigeon) throw new HttpError(404, "pigeon_not_found");

  const date = str(input.date) || now;
  const to = str(input.to);
  if (!parseDate(date)) throw new HttpError(400, "invalid_transfer_date", { fields: ["date"] });
  if (!to) throw new HttpError(400, "missing_required_fields", { fields: ["to"] });

  const info = quarantineInfo(pigeon, date);
  const request = {
    id: randomUUID(),
    date,
    from: pigeon.owner,
    to,
    requestedAt: now,
    status: "accepted",
    conflict: null
  };

  if (to === pigeon.owner) {
    // 鸽主未变的重复/空转请求：幂等沿用，不写转让记录。
    request.status = "noop";
    request.conflict = { reason: "same_owner" };
    pigeon.transferRequests.push(request);
    return { pigeon, accepted: true, duplicated: true, request, quarantine: info };
  }

  // 串行重复提交：同日期、同去向、鸽主未变且首次为冲突，则沿用首次冲突结果，不再新增留档。
  const firstConflict = pigeon.transferRequests.find(
    rq => rq.date === date && rq.to === to && rq.from === pigeon.owner && rq.status === "conflict"
  );
  if (firstConflict) {
    return {
      pigeon,
      accepted: false,
      duplicated: true,
      request: firstConflict,
      quarantine: info,
      owner: pigeon.owner
    };
  }

  if (info.active) {
    request.status = "conflict";
    request.conflict = {
      reason: "within_quarantine",
      vaccineDate: info.latestVaccine.date,
      vaccineName: info.latestVaccine.name,
      until: info.until
    };
    pigeon.transferRequests.push(request); // 冲突也留档，鸽主不变
    // 不抛错——档案已变更，必须落盘；入口层据 accepted=false 返回 409。
    return { pigeon, accepted: false, duplicated: false, request, quarantine: info, owner: pigeon.owner };
  }

  pigeon.transferRequests.push(request);
  pigeon.transfers.push({ id: request.id, date, from: pigeon.owner, to, requestId: request.id });
  pigeon.owner = to; // 只有通过隔离判定才改鸽主
  return { pigeon, accepted: true, duplicated: false, request, quarantine: info };
}

export function addRace(db, ringNo, input, now = today()) {
  const pigeon = findPigeon(db, ringNo);
  if (!pigeon) throw new HttpError(404, "pigeon_not_found");
  const race = {
    id: randomUUID(),
    date: str(input.date) || now,
    event: str(input.event) || "未命名赛事",
    distance: Number(input.distance || 0),
    returnTime: str(input.returnTime),
    rank: Number(input.rank || 0)
  };
  pigeon.races.push(race);
  return { pigeon, race };
}

export function relation(db, ringNo) {
  const pigeon = findPigeon(db, ringNo);
  if (!pigeon) return null;
  return {
    pigeon,
    father: findPigeon(db, pigeon.fatherRing),
    mother: findPigeon(db, pigeon.motherRing),
    children: db.pigeons.filter(p => p.fatherRing === ringNo || p.motherRing === ringNo)
  };
}

// 单鸽履历：疫苗（含更正留档）、转让、转让请求（含冲突）、成绩合成时间线。
export function history(db, ringNo, asOf = today()) {
  const pigeon = findPigeon(db, ringNo);
  if (!pigeon) return null;
  const items = [];
  for (const v of pigeon.vaccines) items.push({ date: v.date, kind: "vaccine", ref: v });
  for (const a of pigeon.amendments) items.push({ date: a.date, kind: "amendment", ref: a });
  for (const t of pigeon.transfers) items.push({ date: t.date, kind: "transfer", ref: t });
  for (const rq of pigeon.transferRequests) items.push({ date: rq.date, kind: "transfer_request", ref: rq });
  for (const r of pigeon.races) items.push({ date: r.date, kind: "race", ref: r });
  items.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return {
    pigeon,
    asOf,
    quarantine: quarantineInfo(pigeon, asOf),
    timeline: items,
    transferRequests: pigeon.transferRequests,
    amendments: pigeon.amendments
  };
}

export function listView(db, asOf = today()) {
  return db.pigeons.map(p => ({ ...p, quarantine: quarantineInfo(p, asOf) }));
}
