import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SECRET_KEYS = Deno.env.get("SUPABASE_SECRET_KEYS");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const HF006_OPERATOR_PIN = Deno.env.get("HF006_OPERATOR_PIN") ?? "";
const HF006_GESTAO_PIN = Deno.env.get("HF006_GESTAO_PIN") ?? "";
const HF006_PRODUCAO_PIN = Deno.env.get("HF006_PRODUCAO_PIN") ?? "";
const DEVICE_ID = Deno.env.get("HF006_DEVICE_ID") ?? "hf006-usina-concreto-01";

function adminKey() {
  if (SUPABASE_SECRET_KEYS) {
    try {
      const keys = JSON.parse(SUPABASE_SECRET_KEYS);
      if (keys?.default) return keys.default;
    } catch {}
  }
  return SUPABASE_SERVICE_ROLE_KEY ?? "";
}

const ADMIN_KEY = adminKey();
if (!SUPABASE_URL || !ADMIN_KEY) throw new Error("Configuracao Supabase incompleta.");

const supabase = createClient(SUPABASE_URL, ADMIN_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});

function originAllowed(origin: string | null) {
  if (!origin) return true;
  try {
    const u = new URL(origin);
    return u.protocol === "https:" &&
      (u.hostname === "horimetrosuc0012.vercel.app" ||
       u.hostname.startsWith("horimetrosuc0012-") && u.hostname.endsWith(".vercel.app"));
  } catch { return false; }
}

function cors(req: Request) {
  const origin = req.headers.get("origin");
  return {
    "Access-Control-Allow-Origin": originAllowed(origin) && origin ? origin : "https://horimetrosuc0012.vercel.app",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Operator-Pin",
    "Access-Control-Max-Age": "600",
    "Cache-Control": "no-store",
    "Vary": "Origin"
  };
}

function json(req: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors(req), "Content-Type": "application/json; charset=utf-8" }
  });
}

function secureEqual(a: string, b: string) {
  const enc = new TextEncoder();
  const aa = enc.encode(a), bb = enc.encode(b);
  const n = Math.max(aa.length, bb.length);
  let d = aa.length ^ bb.length;
  for (let i = 0; i < n; i++) d |= (aa[i] ?? 0) ^ (bb[i] ?? 0);
  return d === 0;
}

// Cada escopo tem o seu PIN. Enquanto o secret proprio nao existir,
// usa o HF006_OPERATOR_PIN, para o painel continuar funcionando na transicao.
const PIN_BY_SCOPE = new Map<string, string>([
  ["gestao", HF006_GESTAO_PIN || HF006_OPERATOR_PIN],
  ["producao", HF006_PRODUCAO_PIN || HF006_OPERATOR_PIN],
]);

// Acoes de gravacao e o escopo de PIN que cada uma exige.
const SCOPE_BY_KIND = new Map<string, string>([
  ["save_stop", "gestao"],
  ["save_day", "gestao"],
  ["save_production", "producao"],
  ["delete_production", "producao"],
]);

function authorized(req: Request, scope: string) {
  const pin = req.headers.get("x-operator-pin") ?? "";
  const expected = PIN_BY_SCOPE.get(scope) ?? "";
  return expected.length > 0 && secureEqual(pin, expected);
}

type Interval = { start: number; end: number; motor?: number };
type StopOverride = {
  segment_key: string;
  adjusted_start_at: string | null;
  adjusted_end_at: string | null;
  reason_code: string;
  note: string | null;
};

const TZ = "America/Sao_Paulo";
const OFFSET = "-03:00";
const fmtDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit"
});
const fmtHour = new Intl.DateTimeFormat("en-GB", {
  timeZone: TZ, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
});

function dateKey(ms: number) {
  return fmtDate.format(new Date(ms));
}

function localMinutes(ms: number) {
  const parts = fmtHour.formatToParts(new Date(ms));
  const h = Number(parts.find(p => p.type === "hour")?.value ?? 0);
  const m = Number(parts.find(p => p.type === "minute")?.value ?? 0);
  return h * 60 + m;
}

function dayStartMs(date: string) {
  return new Date(`${date}T00:00:00${OFFSET}`).getTime();
}

function addDays(date: string, amount: number) {
  const d = new Date(dayStartMs(date) + amount * 86400000);
  return dateKey(d.getTime());
}

function listDates(start: string, end: string) {
  const out: string[] = [];
  let cur = start;
  for (let i = 0; i < 370 && cur <= end; i++) {
    out.push(cur);
    cur = addDays(cur, 1);
  }
  return out;
}

function mergeIntervals(input: Interval[], gapSeconds = 0) {
  const arr = input
    .filter(x => Number.isFinite(x.start) && Number.isFinite(x.end) && x.end > x.start)
    .sort((a, b) => a.start - b.start);
  const out: Interval[] = [];
  const gap = gapSeconds * 1000;
  for (const it of arr) {
    const last = out[out.length - 1];
    if (!last || it.start > last.end + gap) out.push({ start: it.start, end: it.end });
    else last.end = Math.max(last.end, it.end);
  }
  return out;
}

function clipIntervals(input: Interval[], start: number, end: number) {
  return input
    .map(x => ({ start: Math.max(start, x.start), end: Math.min(end, x.end) }))
    .filter(x => x.end > x.start);
}

function seconds(input: Interval[]) {
  return input.reduce((s, x) => s + (x.end - x.start) / 1000, 0);
}

function segmentKey(date: string, start: number, _end: number) {
  // O inicio identifica de forma estavel a mesma parada.
  // O fim de uma parada aberta muda a cada refresh e nao pode fazer parte da chave.
  return `${date}|${new Date(start).toISOString()}`;
}

function gapSegments(start: number, end: number, runs: Interval[]) {
  const out: Interval[] = [];
  let cursor = start;
  for (const r of runs) {
    if (r.start > cursor) out.push({ start: cursor, end: r.start });
    cursor = Math.max(cursor, r.end);
  }
  if (cursor < end) out.push({ start: cursor, end });
  return out.filter(x => x.end > x.start);
}

function choosePastEnd(runs: Interval[]) {
  if (!runs.length) return null;
  let end = runs[runs.length - 1].end;
  for (let i = 0; i < runs.length - 1; i++) {
    const gap = runs[i + 1].start - runs[i].end;
    if (gap < 60 * 60 * 1000) continue;
    if (localMinutes(runs[i].end) < 16 * 60) continue;
    const laterSeconds = seconds(runs.slice(i + 1));
    if (laterSeconds <= 10 * 60) {
      end = runs[i].end;
      break;
    }
  }
  return end;
}

function autoMealIndex(gaps: Interval[], runs: Interval[]) {
  let best = -1;
  let bestDur = 0;
  for (let i = 0; i < gaps.length; i++) {
    const g = gaps[i];
    const dur = (g.end - g.start) / 1000;
    const min = localMinutes(g.start);
    const hasRunAfter = runs.some(r => r.start >= g.end - 1000);
    if (dur >= 30 * 60 && dur <= 120 * 60 &&
        min >= 10 * 60 + 30 && min <= 13 * 60 + 15 && hasRunAfter &&
        dur > bestDur) {
      best = i;
      bestDur = dur;
    }
  }
  return best;
}

function parseIso(value: unknown) {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function num(value: unknown, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

async function audit(action: string, operationDate: string | null, entityType: string, entityId: string | null, beforeData: unknown, afterData: unknown) {
  const { error } = await supabase.from("plant_management_audit").insert({
    device_id: DEVICE_ID,
    action,
    operation_date: operationDate,
    entity_type: entityType,
    entity_id: entityId,
    before_data: beforeData,
    after_data: afterData
  });
  if (error) console.error("audit:", error);
}

async function overview(startDate: string, endDate: string) {
  const firstMs = dayStartMs(startDate);
  const lastMs = dayStartMs(addDays(endDate, 1));
  const queryEnd = new Date(lastMs + 86400000).toISOString();

  const cfgReq = await supabase.from("plant_hourmeter_config")
    .select("official_started_at,initial_offset_seconds,mixer_motor_ids")
    .eq("device_id", DEVICE_ID).maybeSingle();

  if (cfgReq.error) throw cfgReq.error;

  const cfg = cfgReq.data;
  const officialStart = cfg?.official_started_at ? Date.parse(cfg.official_started_at) : firstMs;
  const queryStart = new Date(Math.min(firstMs - 86400000, officialStart - 86400000)).toISOString();

  const [eventsReq, stateReq, reasonsReq, dayReq, stopReq, prodReq, mixReq] = await Promise.all([
    supabase.from("equipment_events")
      .select("event_type,motor_id,event_time,received_at,duration_seconds")
      .eq("device_id", DEVICE_ID)
      .eq("simulation", false)
      .in("motor_id", [0,1,2])
      .eq("event_type", "DESLIGOU")
      .gte("received_at", queryStart)
      .lte("received_at", queryEnd)
      .order("received_at", { ascending: true }),
    supabase.from("equipment_state")
      .select("motor_id,name,running,hourmeter_seconds,current_run_seconds,current_stop_seconds,starts_total,stops_total,last_seen")
      .eq("device_id", DEVICE_ID).in("motor_id", [0,1,2]).order("motor_id"),
    supabase.from("plant_management_reason_catalog")
      .select("reason_code,label,display_order,affects_availability,is_meal,color_hex")
      .eq("enabled", true).order("display_order"),
    supabase.from("plant_day_overrides")
      .select("operation_date,start_at,end_at,note")
      .eq("device_id", DEVICE_ID).gte("operation_date", startDate).lte("operation_date", endDate),
    supabase.from("plant_stop_overrides")
      .select("id,operation_date,segment_key,original_start_at,original_end_at,adjusted_start_at,adjusted_end_at,reason_code,note,updated_at")
      .eq("device_id", DEVICE_ID).gte("operation_date", startDate).lte("operation_date", endDate),
    supabase.from("plant_production_records")
      .select("id,operation_date,mix_name,volume_m3,trucks_count,loads_count,note,updated_at")
      .eq("device_id", DEVICE_ID).gte("operation_date", startDate).lte("operation_date", endDate)
      .order("operation_date").order("id"),
    supabase.from("plant_mix_catalog")
      .select("id,mix_name,is_primary,display_order").eq("enabled", true).order("display_order")
  ]);

  const errors = [eventsReq.error, stateReq.error, reasonsReq.error, dayReq.error, stopReq.error, prodReq.error, mixReq.error].filter(Boolean);
  if (errors.length) throw errors[0];
  const officialOffset = num(cfg?.initial_offset_seconds);
  const officialDate = dateKey(officialStart);
  const mixerIds = new Set<number>((cfg?.mixer_motor_ids ?? [0,1]).map((x: unknown) => Number(x)));

  const byMotor = new Map<number, Interval[]>();
  for (const id of [0,1,2]) byMotor.set(id, []);

  for (const e of eventsReq.data ?? []) {
    const id = Number(e.motor_id);
    const end = Date.parse(e.event_time ?? e.received_at);
    const dur = num(e.duration_seconds);
    if (!byMotor.has(id) || !Number.isFinite(end) || dur <= 0) continue;
    byMotor.get(id)!.push({ start: end - dur * 1000, end, motor: id });
  }

  for (const s of stateReq.data ?? []) {
    const id = Number(s.motor_id);
    if (!s.running || !byMotor.has(id)) continue;
    const end = Date.parse(s.last_seen);
    const dur = num(s.current_run_seconds);
    if (Number.isFinite(end) && dur > 0) byMotor.get(id)!.push({ start: end - dur * 1000, end, motor: id });
  }

  const mixerRaw: Interval[] = [];
  for (const id of mixerIds) mixerRaw.push(...(byMotor.get(id) ?? []));
  const officialIntervals = mergeIntervals(
    mixerRaw.map(x => ({ start: Math.max(x.start, officialStart), end: x.end })).filter(x => x.end > officialStart),
    0
  );
  const officialSeconds = officialOffset + seconds(officialIntervals);

  const reasons = reasonsReq.data ?? [];
  const reasonMap = new Map(reasons.map((r: any) => [r.reason_code, r]));
  const dayOverrideMap = new Map((dayReq.data ?? []).map((x: any) => [x.operation_date, x]));
  const stopOverrideMap = new Map<string, StopOverride>();
  for (const x of stopReq.data ?? []) stopOverrideMap.set(x.segment_key, x as StopOverride);

  const now = Date.now();
  const today = dateKey(now);
  const dates = listDates(startDate, endDate);
  const days: any[] = [];

  for (const date of dates) {
    const ds = dayStartMs(date);
    const de = dayStartMs(addDays(date, 1));

    if (date < officialDate) {
      days.push({
        date,
        has_activity: false,
        before_official_start: true,
        detected_start_at: null,
        detected_end_at: null,
        scheduled_seconds: 0,
        running_seconds: 0,
        downtime_seconds: 0,
        meal_seconds: 0,
        availability_percent: null,
        timeline: [],
        production: []
      });
      continue;
    }

    const plantRunsRaw = clipIntervals(mixerRaw, Math.max(ds, officialStart), de);
    const plantRuns = mergeIntervals(plantRunsRaw, 60);
    if (!plantRuns.length) {
      days.push({
        date, has_activity: false, detected_start_at: null, detected_end_at: null,
        scheduled_seconds: 0, running_seconds: 0, downtime_seconds: 0,
        meal_seconds: 0, availability_percent: null, timeline: [],
        production: (prodReq.data ?? []).filter((p:any)=>p.operation_date===date)
      });
      continue;
    }

    let start = plantRuns[0].start;
    let end = date === today && now > start ? Math.min(now, de) : choosePastEnd(plantRuns)!;

    const dov: any = dayOverrideMap.get(date);
    if (dov?.start_at) start = Date.parse(dov.start_at);
    if (dov?.end_at) end = Date.parse(dov.end_at);
    if (!(end > start)) end = plantRuns[plantRuns.length - 1].end;

    const clippedRuns = mergeIntervals(clipIntervals(plantRuns, start, end), 60);
    const gaps = gapSegments(start, end, clippedRuns);
    const mealIdx = autoMealIndex(gaps, clippedRuns);

    const timeline: any[] = [];
    for (const r of clippedRuns) {
      timeline.push({
        type: "RUNNING",
        start_at: new Date(r.start).toISOString(),
        end_at: new Date(r.end).toISOString(),
        duration_seconds: (r.end-r.start)/1000,
        reason_code: null,
        reason_label: "Produção",
        source: "AUTO",
        color_hex: "#30c878"
      });
    }

    for (let i = 0; i < gaps.length; i++) {
      const g = gaps[i];
      const key = segmentKey(date, g.start, g.end);
      const ov = stopOverrideMap.get(key);
      const reasonCode = ov?.reason_code ?? (i === mealIdx ? "MEAL" : "UNCLASSIFIED");
      const reason: any = reasonMap.get(reasonCode) ?? reasonMap.get("UNCLASSIFIED");
      const adjStart = ov?.adjusted_start_at ? Date.parse(ov.adjusted_start_at) : g.start;
      const adjEnd = ov?.adjusted_end_at ? Date.parse(ov.adjusted_end_at) : g.end;
      timeline.push({
        type: "STOPPED",
        segment_key: key,
        original_start_at: new Date(g.start).toISOString(),
        original_end_at: new Date(g.end).toISOString(),
        start_at: new Date(adjStart).toISOString(),
        end_at: new Date(adjEnd).toISOString(),
        duration_seconds: Math.max(0,(adjEnd-adjStart)/1000),
        reason_code: reasonCode,
        reason_label: reason?.label ?? "Não classificada",
        affects_availability: reason?.affects_availability !== false,
        is_meal: reason?.is_meal === true,
        source: ov ? "MANUAL" : (i === mealIdx ? "AUTO_MEAL" : "AUTO"),
        note: ov?.note ?? null,
        color_hex: reason?.color_hex ?? "#f6bd41"
      });
    }

    timeline.sort((a,b)=>Date.parse(a.start_at)-Date.parse(b.start_at));

    const mealSeconds = timeline
      .filter(x=>x.type==="STOPPED" && x.is_meal)
      .reduce((s,x)=>s+num(x.duration_seconds),0);

    const excludedAvailabilitySeconds = timeline
      .filter(x=>x.type==="STOPPED" && x.affects_availability===false)
      .reduce((s,x)=>s+num(x.duration_seconds),0);

    const runningSeconds = seconds(clippedRuns);
    const totalWindow = Math.max(0,(end-start)/1000);
    const scheduledSeconds = Math.max(0,totalWindow-excludedAvailabilitySeconds);
    const downtimeSeconds = Math.max(0,scheduledSeconds-runningSeconds);
    const availability = scheduledSeconds > 0
      ? Math.max(0,Math.min(100,runningSeconds/scheduledSeconds*100))
      : null;

    days.push({
      date, has_activity: true,
      detected_start_at: new Date(start).toISOString(),
      detected_end_at: new Date(end).toISOString(),
      auto_start_at: new Date(plantRuns[0].start).toISOString(),
      auto_end_at: new Date((date===today&&now>plantRuns[0].start)?Math.min(now,de):choosePastEnd(plantRuns)!).toISOString(),
      day_override: dov ?? null,
      scheduled_seconds: scheduledSeconds,
      running_seconds: runningSeconds,
      downtime_seconds: downtimeSeconds,
      meal_seconds: mealSeconds,
      excluded_availability_seconds: excludedAvailabilitySeconds,
      availability_percent: availability,
      timeline,
      production: (prodReq.data ?? []).filter((p:any)=>p.operation_date===date)
    });
  }

  const totalScheduled = days.reduce((s,d)=>s+num(d.scheduled_seconds),0);
  const totalRunning = days.reduce((s,d)=>s+num(d.running_seconds),0);
  const totalDowntime = Math.max(0,totalScheduled-totalRunning);
  const availability = totalScheduled>0 ? totalRunning/totalScheduled*100 : null;

  const paretoMap = new Map<string,{reason_code:string,label:string,seconds:number,count:number,color_hex:string}>();
  for (const d of days) {
    for (const seg of d.timeline ?? []) {
      if (seg.type !== "STOPPED" || seg.affects_availability===false) continue;
      const key = seg.reason_code ?? "UNCLASSIFIED";
      const cur = paretoMap.get(key) ?? { reason_code:key, label:seg.reason_label, seconds:0, count:0, color_hex:seg.color_hex };
      cur.seconds += num(seg.duration_seconds);
      cur.count += 1;
      paretoMap.set(key,cur);
    }
  }
  const pareto = Array.from(paretoMap.values()).sort((a,b)=>b.seconds-a.seconds);

  const componentStats: any[] = [];
  for (const id of [0,1,2]) {
    let run = 0, scheduled = 0;
    for (const d of days) {
      if (!d.has_activity) continue;
      const s = Date.parse(d.detected_start_at), e = Date.parse(d.detected_end_at);
      const componentRuns = mergeIntervals(clipIntervals(byMotor.get(id) ?? [], s, e), 60);
      let compRun = seconds(componentRuns);
      for (const excluded of (d.timeline ?? []).filter((x:any)=>x.affects_availability===false)) {
        const ms = Date.parse(excluded.start_at), me = Date.parse(excluded.end_at);
        compRun -= seconds(clipIntervals(componentRuns, ms, me));
      }
      run += Math.max(0,compRun);
      scheduled += num(d.scheduled_seconds);
    }
    const state = (stateReq.data ?? []).find((x:any)=>Number(x.motor_id)===id);
    componentStats.push({
      motor_id:id,
      name: state?.name ?? (id===0?"Misturador A":id===1?"Misturador B":"Correia Transportadora"),
      running: state?.running ?? false,
      hourmeter_seconds: num(state?.hourmeter_seconds),
      current_run_seconds: num(state?.current_run_seconds),
      current_stop_seconds: num(state?.current_stop_seconds),
      starts_total: num(state?.starts_total),
      stops_total: num(state?.stops_total),
      period_running_seconds: run,
      period_scheduled_seconds: scheduled,
      availability_percent: scheduled>0 ? Math.max(0,Math.min(100,run/scheduled*100)) : null
    });
  }

  const production = (prodReq.data ?? []).filter((p:any) => String(p.operation_date) >= officialDate);
  const productionTotal = production.reduce((s:any,p:any)=>s+num(p.volume_m3),0);
  const trucksByDay = new Map<string,number>();
  for (const p of production) {
    const d = String(p.operation_date);
    trucksByDay.set(d, Math.max(trucksByDay.get(d) ?? 0, num(p.trucks_count)));
  }
  const trucksTotal = Array.from(trucksByDay.values()).reduce((s,n)=>s+n,0);
  const loadsTotal = production.reduce((s:any,p:any)=>s+num(p.loads_count),0);

  return {
    ok:true,
    kind:"overview",
    timezone:TZ,
    official_hourmeter_seconds:officialSeconds,
    official_started_at:cfg?.official_started_at ?? null,
    period:{
      start:startDate,end:endDate,
      scheduled_seconds:totalScheduled,
      running_seconds:totalRunning,
      downtime_seconds:totalDowntime,
      availability_percent:availability
    },
    reasons,
    mix_catalog:mixReq.data ?? [],
    days,
    pareto,
    components:componentStats,
    production,
    production_summary:{
      total_m3:productionTotal,
      trucks_count:trucksTotal,
      loads_count:loadsTotal,
      m3_per_running_hour: totalRunning>0 ? productionTotal/(totalRunning/3600) : null
    }
  };
}

Deno.serve(async (req: Request) => {
  try {
    const origin = req.headers.get("origin");
    if (!originAllowed(origin)) return json(req,{ok:false,error:"Origem nao permitida"},403);
    if (req.method === "OPTIONS") return new Response(null,{status:204,headers:cors(req)});
    if (req.method !== "POST") return json(req,{ok:false,error:"Metodo nao permitido"},405);

    const raw = await req.text();
    if (new TextEncoder().encode(raw).byteLength > 65536) return json(req,{ok:false,error:"Payload muito grande"},413);
    let body:any;
    try { body = JSON.parse(raw); } catch { return json(req,{ok:false,error:"JSON invalido"},400); }
    if (!body || typeof body !== "object") return json(req,{ok:false,error:"Payload invalido"},400);

    if (body.kind === "overview") {
      const start = typeof body.start === "string" ? body.start : "";
      const end = typeof body.end === "string" ? body.end : "";
      if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || start > end)
        return json(req,{ok:false,error:"Periodo invalido"},400);
      return json(req, await overview(start,end));
    }

    const scope = SCOPE_BY_KIND.get(String(body.kind ?? ""));
    if (!scope) return json(req,{ok:false,error:"kind invalido"},400);
    if (!authorized(req, scope)) {
      const msg = scope === "gestao" ? "PIN da gestão inválido" : "PIN da produção inválido";
      return json(req,{ok:false,error:msg},401);
    }

    if (body.kind === "save_stop") {
      const date = String(body.operation_date ?? "");
      const key = String(body.segment_key ?? "");
      const originalStart = parseIso(body.original_start_at);
      const originalEnd = parseIso(body.original_end_at);
      const adjustedStart = parseIso(body.adjusted_start_at ?? body.original_start_at);
      const adjustedEnd = parseIso(body.adjusted_end_at ?? body.original_end_at);
      const reason = String(body.reason_code ?? "");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !key || originalStart===null || originalEnd===null ||
          adjustedStart===null || adjustedEnd===null || adjustedEnd<=adjustedStart)
        return json(req,{ok:false,error:"Intervalo invalido"},400);
      const { data:reasonRow } = await supabase.from("plant_management_reason_catalog")
        .select("reason_code").eq("reason_code",reason).eq("enabled",true).maybeSingle();
      if (!reasonRow) return json(req,{ok:false,error:"Motivo invalido"},400);

      const { data:before } = await supabase.from("plant_stop_overrides")
        .select("*").eq("device_id",DEVICE_ID).eq("operation_date",date).eq("segment_key",key).maybeSingle();

      const startFoiAlterado =
        Math.abs(adjustedStart - originalStart) > 1500;
      const endFoiAlterado =
        Math.abs(adjustedEnd - originalEnd) > 1500;

      const payload = {
        device_id:DEVICE_ID, operation_date:date, segment_key:key,
        original_start_at:new Date(originalStart).toISOString(),
        original_end_at:new Date(originalEnd).toISOString(),
        // Null significa usar o limite detectado da parada.
        // Assim uma parada ainda aberta continua crescendo sem perder o motivo.
        adjusted_start_at:startFoiAlterado ? new Date(adjustedStart).toISOString() : null,
        adjusted_end_at:endFoiAlterado ? new Date(adjustedEnd).toISOString() : null,
        reason_code:reason,
        note: typeof body.note==="string" ? body.note.slice(0,1000) : null,
        updated_at:new Date().toISOString()
      };
      const { data:saved,error } = await supabase.from("plant_stop_overrides")
        .upsert(payload,{onConflict:"device_id,operation_date,segment_key"}).select("*").single();
      if (error) throw error;
      await audit("SAVE_STOP",date,"stop_override",String(saved.id),before,saved);
      return json(req,{ok:true,kind:"stop_saved",record:saved});
    }

    if (body.kind === "save_day") {
      const date = String(body.operation_date ?? "");
      const start = parseIso(body.start_at), end = parseIso(body.end_at);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || start===null || end===null || end<=start)
        return json(req,{ok:false,error:"Jornada invalida"},400);
      const { data:before } = await supabase.from("plant_day_overrides")
        .select("*").eq("device_id",DEVICE_ID).eq("operation_date",date).maybeSingle();
      const payload = {
        device_id:DEVICE_ID,operation_date:date,
        start_at:new Date(start).toISOString(),end_at:new Date(end).toISOString(),
        note: typeof body.note==="string" ? body.note.slice(0,1000) : null,
        updated_at:new Date().toISOString()
      };
      const { data:saved,error } = await supabase.from("plant_day_overrides")
        .upsert(payload,{onConflict:"device_id,operation_date"}).select("*").single();
      if (error) throw error;
      await audit("SAVE_DAY",date,"day_override",date,before,saved);
      return json(req,{ok:true,kind:"day_saved",record:saved});
    }

    if (body.kind === "save_production") {
      const date = String(body.operation_date ?? "");
      const mix = String(body.mix_name ?? "").trim().slice(0,120);
      const volume = Number(body.volume_m3);
      const trucks = body.trucks_count==null || body.trucks_count==="" ? null : Number(body.trucks_count);
      const loads = body.loads_count==null || body.loads_count==="" ? null : Number(body.loads_count);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !mix || !Number.isFinite(volume) || volume<0 ||
          (trucks!==null && (!Number.isInteger(trucks)||trucks<0)) ||
          (loads!==null && (!Number.isInteger(loads)||loads<0)))
        return json(req,{ok:false,error:"Dados de producao invalidos"},400);

      await supabase.from("plant_mix_catalog").upsert({
        mix_name:mix,is_primary:mix.toLowerCase()==="pavimento rígido".toLowerCase(),
        enabled:true,display_order:mix.toLowerCase()==="pavimento rígido".toLowerCase()?10:100,
        updated_at:new Date().toISOString()
      },{onConflict:"mix_name"});

      let before:any = null, saved:any = null, error:any = null;
      const common = {
        device_id:DEVICE_ID,operation_date:date,mix_name:mix,volume_m3:volume,
        trucks_count:trucks,loads_count:loads,
        note:typeof body.note==="string"?body.note.slice(0,1000):null,
        updated_at:new Date().toISOString()
      };
      if (body.id) {
        const id = Number(body.id);
        const b = await supabase.from("plant_production_records").select("*").eq("id",id).eq("device_id",DEVICE_ID).maybeSingle();
        before = b.data;
        const u = await supabase.from("plant_production_records").update(common).eq("id",id).eq("device_id",DEVICE_ID).select("*").single();
        saved=u.data; error=u.error;
      } else {
        const i = await supabase.from("plant_production_records").insert(common).select("*").single();
        saved=i.data; error=i.error;
      }
      if (error) throw error;
      await audit("SAVE_PRODUCTION",date,"production",String(saved.id),before,saved);
      return json(req,{ok:true,kind:"production_saved",record:saved});
    }

    if (body.kind === "delete_production") {
      const id = Number(body.id);
      if (!Number.isInteger(id) || id<=0) return json(req,{ok:false,error:"ID invalido"},400);
      const { data:before } = await supabase.from("plant_production_records").select("*").eq("id",id).eq("device_id",DEVICE_ID).maybeSingle();
      const { error } = await supabase.from("plant_production_records").delete().eq("id",id).eq("device_id",DEVICE_ID);
      if (error) throw error;
      await audit("DELETE_PRODUCTION",before?.operation_date ?? null,"production",String(id),before,null);
      return json(req,{ok:true,kind:"production_deleted"});
    }

    return json(req,{ok:false,error:"kind invalido"},400);
  } catch (err) {
    console.error(err);
    return json(req,{ok:false,error:"Erro interno"},500);
  }
});
