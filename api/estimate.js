// api/estimate.js  (Vercel Node.js Serverless Function)
import { z } from "zod";

export const config = { runtime: "nodejs" };

// xAI API エンドポイント＆モデル
const XAI_URL = "https://api.x.ai/v1/chat/completions";
const XAI_MODEL = "grok-4-fast-reasoning"; // 例: grok-2-latest / grok-2-mini 等
const TIMEOUT_MS = 30000;

/* =========================
   スキーマ定義（拡張）
   - 互換性維持: 既存キーは変更なし
   - 追加: local_time_iso（現地ISO日時）/ radius は従来どおり radius_m に吸収
========================= */
const CrowdJp = z.enum(["空いている", "普通", "混雑"]);
const CrowdInternal = z.enum(["empty", "normal", "crowded"]);

const Schema = z.object({
  address: z.string().transform(s => (s ?? "").toString().trim()).pipe(z.string().min(1).max(300)),
  crowd: z.union([CrowdJp, CrowdInternal])
    .transform(v => (v === "空いている" ? "empty" : v === "普通" ? "normal" : v === "混雑" ? "crowded" : v)),
  feature: z.string().transform(s => (s ?? "").toString().trim()).pipe(z.string().min(1).max(140)),
  radius_m: z.coerce.number().int().min(10).max(40_075_000),
  // ★ 追加（任意）：UIから渡す現地時刻（ISO文字列: "YYYY-MM-DDTHH:mm:ss"）
  local_time_iso: z.string().optional().nullable()
});

/* =========================
   言語判定（変更なし）
========================= */
function hasJapanese(s = "") {
  return /[\u3040-\u30FF\u4E00-\u9FFF]/.test(String(s));
}
function detectTargetLang(req, body, input) {
  // 優先度: 明示指定 > ヘッダー > 入力文字種 > 既定
  const explicit = (body?.lang || body?.ui_lang || body?.locale || "").toString().toLowerCase();
  if (explicit === "ja" || explicit === "en") return explicit;

  const h = (req.headers?.["x-ui-lang"] || req.headers?.["accept-language"] || "").toString().toLowerCase();
  if (h.startsWith("ja")) return "ja";
  if (h.startsWith("en")) return "en";

  if (hasJapanese(body?.crowd) || hasJapanese(body?.feature) || hasJapanese(body?.address)) return "ja";
  if (hasJapanese(input?.address) || hasJapanese(input?.feature)) return "ja";

  return "en";
}

/* =========================
   緩い正規化（スキーマ失敗時のフォールバック）
========================= */
function looseNormalize(input = {}) {
  const addr = String(input?.address ?? "").trim() || "unknown";
  const c = input?.crowd;
  const crowd =
    c === "混雑" || c === "crowded" ? "crowded" :
    c === "普通" || c === "normal"   ? "normal"  :
    "empty";
  const feature = String(input?.feature ?? "").trim() || "people";
  const r = Number(input?.radius_m ?? input?.radius ?? 500);
  const radius_m = Number.isFinite(r) ? Math.round(Math.max(10, Math.min(r, 40_075_000))) : 500;
  const local_time_iso = (input?.local_time_iso && String(input.local_time_iso)) || null;
  return { address: addr, crowd, feature, radius_m, local_time_iso };
}

/* =========================
   国籍フィルタ（既存）
========================= */
function detectNationalityFilter(feature = "") {
  const s = String(feature).toLowerCase();
  if (/(non[-\s]?japanese|foreigner|foreigners|外国人)/.test(s)) return "foreigner_only";
  if (/(japanese( people)?|日本人)/.test(s)) return "japanese_only";
  return "all";
}

/* =========================
   現地時間の解釈（時間帯/曜日）
========================= */
function parseLocalTimeInfo(local_time_iso) {
  try {
    if (!local_time_iso) return { iso: null, hour: null, weekday: null, weekend: null, slot: "unknown" };
    const d = new Date(local_time_iso);
    if (isNaN(d.getTime())) return { iso: null, hour: null, weekday: null, weekend: null, slot: "unknown" };
    const hour = d.getHours();                // 0..23
    const weekday = d.getDay();               // 0=Sun..6=Sat
    const weekend = (weekday === 0 || weekday === 6);

    // 時間帯スロット
    let slot = "daytime";
    if (hour >= 7 && hour <= 9) slot = "morning_commute";
    else if (hour >= 11 && hour <= 13) slot = "lunch";
    else if (hour >= 17 && hour <= 20) slot = "evening_commute";
    else if (hour >= 22 || hour <= 4) slot = "night";
    else if (hour >= 5 && hour <= 6) slot = "early_morning";
    else if (hour >= 10 && hour <= 16) slot = "daytime";
    else slot = "other";

    return { iso: d.toISOString(), hour, weekday, weekend, slot };
  } catch {
    return { iso: null, hour: null, weekday: null, weekend: null, slot: "unknown" };
  }
}

/* =========================
   場所タイプ推定（address/feature からヒューリスティック）
========================= */
function detectPlaceType(address = "", feature = "") {
  const s = `${address} ${feature}`.toLowerCase();
  if (/(station|駅|train|metro|subway|terminal)/.test(s)) return "station";
  if (/(airport|空港)/.test(s)) return "airport";
  if (/(mall|shopping|ショッピング|百貨店|デパート|商業|plaza|outlet)/.test(s)) return "mall";
  if (/(park|公園|広場|square)/.test(s)) return "park";
  if (/(residential|住宅|団地|apartment|マンション|戸建)/.test(s)) return "residential";
  if (/(office|オフィス|ビジネス街|business district)/.test(s)) return "office";
  if (/(school|大学|campus|学校|高校|小学校|中学校)/.test(s)) return "school";
  if (/(temple|shrine|神社|寺|観光|tourist|観光地|観光客)/.test(s)) return "tourist";
  return "generic";
}

/* =========================
   プロンプト（時間・場所タイプを明示、自己検証手順を指示）
   ※ 値が小さすぎた問題に対処：基準密度を約4倍へ再キャリブレーション、
      妥当帯を [0.6×Expected, 1.8×Expected] にタイト化。
   ※ 「半径スケールの厳守」と「混在用途（MIXED LAND-USE）」を明示。
========================= */
function buildPrompt(input, targetLang = "en", nationalityFilter = "all") {
  const { address, crowd, feature, radius_m, local_time_iso } = input;
  const time = parseLocalTimeInfo(local_time_iso);
  const placeType = detectPlaceType(address, feature);

  // 「自己検証プロセス」をモデルに明示：JSONのみ返す制約は維持
  return `You are an estimator. Output ONLY JSON, no prose.

JSON schema (keys and types are fixed):
{"count":number,"confidence":number,"range":{"min":number,"max":number},"assumptions":string[],"notes":string[]}

Hard rules:
- Count PEOPLE within the circle based on "feature".
- Nationality rule:
  - If nationality_filter is "all", include everyone (Japanese and non-Japanese). DO NOT restrict by nationality.
  - If "japanese_only", include Japanese people only.
  - If "foreigner_only", include non-Japanese (foreigners) only.
- Do NOT infer nationality from input language. English input does NOT imply "foreigner".
- "crowd" is one of: "empty" | "normal" | "crowded".
- "assumptions" and "notes" MUST be written in "${targetLang}".
- "confidence" is 0..1 float.
- Respond with JSON only. No extra text.

Context (use as priors, not ground-truth):
- address: ${JSON.stringify(address)}
- local_time_iso: ${JSON.stringify(time.iso || local_time_iso || null)}
- local_hour: ${JSON.stringify(time.hour)}
- weekday_index: ${JSON.stringify(time.weekday)}   // 0=Sun..6=Sat
- weekend: ${JSON.stringify(time.weekend)}
- time_slot: ${JSON.stringify(time.slot)}          // morning_commute, lunch, evening_commute, night, etc.
- place_type: ${JSON.stringify(placeType)}         // station/airport/mall/park/residential/office/school/tourist/generic
- crowd: ${JSON.stringify(crowd)}
- feature: ${JSON.stringify(feature)}
- radius_m: ${radius_m}
- nationality_filter: ${JSON.stringify(nationalityFilter)}

CALIBRATED BASELINES (people/km^2):
  station~12000, airport~8800, mall~6000, office~4800, school~3200, tourist~4000, residential~1600, park~800, generic~2400.

TIME FACTORS:
  morning_commute ×1.6, lunch ×1.3, evening_commute ×1.7, daytime ×1.0, early_morning ×0.5, night ×0.3, other ×0.8.

CROWD FACTORS:
  empty ×0.4, normal ×1.0, crowded ×2.

MIXED LAND-USE ADJUSTMENT (the circle includes multiple building types):
- Derive a land-use mix vector W over {station, airport, mall, office, school, tourist, residential, park, generic} with ΣW=1.0.
- Heuristics:
  • Assign 0.6 to the detected place_type as primary.
  • Allocate the remaining 0.4 based on hints in address/feature and time_slot:
      - If hints include residential housing terms, add +0.2 to residential.
      - If business/office terms, add +0.2 to office.
      - If park/green words, add +0.2 to park.
      - Otherwise distribute +0.2 to residential and +0.2 to generic.
      - At morning/evening commute, shift +0.1 from park to station/office (split evenly if both apply).
      - At night, shift +0.15 from office to residential.
  • Clamp weights to [0,1] and renormalize so ΣW=1.0.
- Compute mixed_baseline = Σ_i (W_i × baseline_i).

RADIUS SCALING REQUIREMENT:
- Compute area_km2 = π × (radius_m/1000)^2 and use it multiplicatively.
- Do NOT cap or dampen by a fixed constant: larger radius_m must monotonically increase expected value (all else equal).

SELF-VALIDATION PROCESS (perform before finalizing JSON):
1) area_km2 = π × (radius_m/1000)^2.
2) mixed_baseline from MIXED LAND-USE ADJUSTMENT.
3) time_factor from TIME FACTORS.
4) crowd_factor from CROWD FACTORS.
5) Expected = area_km2 × mixed_baseline × time_factor × crowd_factor.
6) Plausibility band = [Expected × 0.6, Expected × 1.8] (rounded to ints, >=0).
7) If your "count" is outside this band, adjust it back into the band and add a note explaining the adjustment.
8) Set "range.min/max" around your "count" (~ -30% / +40%), but keep them within [0, count×2.5] and min<=max.
9) Append calculation lines to notes with prefix "calc:" in this exact format:
   calc: radius_m=${radius_m}, area_km2=<number>, mixed_baseline=<number>, time_factor=<number>, crowd_factor=<number>, expected=<number>, band=[<min>..<max>].
10) Also append a second "calc:" line showing your final W vector as JSON (keys present only for non-zero weights), e.g.:
   calc: W={"station":0.6,"residential":0.25,"generic":0.15}.

Return the final JSON after applying the SELF-VALIDATION PROCESS.`;
}

/* =========================
   xAI返却の正規化（既存）
========================= */
function normalizeResult(data) {
  const num = (v, d=0) => (Number.isFinite(Number(v)) ? Number(v) : d);
  const clamp = (v,min,max)=>Math.max(min,Math.min(max,v));
  const count = num(data?.count, 0);
  const conf  = clamp(num(data?.confidence, 0.6), 0, 1);
  const rmin = num(data?.range?.min, Math.max(0, Math.round(count * 0.7)));
  const rmax = num(data?.range?.max, Math.max(rmin, Math.round(count * 1.4)));
  const assumptions = Array.isArray(data?.assumptions) ? data.assumptions.slice(0, 8) : [];
  const notes       = Array.isArray(data?.notes)       ? data.notes.slice(0, 8)       : [];
  return {
    count: Math.max(0, Math.round(count)),
    confidence: conf,
    range: { min: Math.max(0, Math.round(rmin)), max: Math.max(0, Math.round(rmax)) },
    assumptions,
    notes
  };
}

/* =========================
   JSON抽出（既存）
========================= */
function tryParseJSON(content = "") {
  if (typeof content !== "string") return null;
  const fenced = content.match(/```json([\s\S]*?)```/i);
  if (fenced && fenced[1]) {
    try { return JSON.parse(fenced[1].trim()); } catch {}
  }
  const first = content.indexOf("{");
  const last  = content.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) {
    const slice = content.slice(first, last + 1);
    try { return JSON.parse(slice); } catch {}
  }
  try { return JSON.parse(content); } catch {}
  return null;
}

/* =========================
   中立推定（既存）※基準密度を4倍（400→1600）に補正
========================= */
function neutralEstimate({ radius_m, crowd }) {
  const r_km = Math.max(0, radius_m) / 1000;
  const area = Math.PI * r_km * r_km;
  const crowdFactor = crowd === "crowded" ? 1.8 : crowd === "normal" ? 1.0 : 0.5;
  const baseDensity = 1600; // ★ 再キャリブレーション（従来400）
  const est = Math.max(0, Math.round(area * baseDensity * crowdFactor));
  const spread = Math.round(est * 0.35 + 15);
  return {
    count: est,
    confidence: 0.55,
    range: { min: Math.max(0, est - spread), max: est + spread },
    assumptions: ["Heuristic estimate used."],
    notes: ["Neutral estimate (no API value)."]
  };
}

/* =========================
   サーバー側「自己検証プロセス」
   - 返答を再チェックし、妥当帯から外れていれば補正
   - 結果を notes に追記（ja/enに対応）
   - 計算式（calc: ...）も必ず notes に追加
========================= */
function serverSideSelfValidate(out, input, targetLang) {
  const t = parseLocalTimeInfo(input.local_time_iso);
  const place = detectPlaceType(input.address, input.feature);
  const r_km = Math.max(0, input.radius_m) / 1000;
  const area = Math.PI * r_km * r_km;

  // ★ 再キャリブレーション済み基準密度（約4倍）
  const baselineByPlace = {
    station: 12000, airport: 8800, mall: 6000, office: 4800,
    school: 3200, tourist: 4000, residential: 1600, park: 800, generic: 2400
  };
  const timeFactor = {
    morning_commute: 1.6, lunch: 1.3, evening_commute: 1.7,
    daytime: 1.0, early_morning: 0.5, night: 0.3, other: 0.8, unknown: 0.8
  };
  const crowdFactor = input.crowd === "crowded" ? 1.8 : input.crowd === "normal" ? 1.0 : 0.5;

  const base = baselineByPlace[place] ?? 2400;
  const tf = timeFactor[t.slot] ?? 0.8;
  const expected = area * base * tf * crowdFactor;

  // ★ 妥当帯をタイト化（0.6x〜1.8x）
  const bandMin = Math.max(0, Math.round(expected * 0.6));
  const bandMax = Math.max(bandMin, Math.round(expected * 1.8));

  let adjusted = { ...out };
  let changed = false;

  if (adjusted.count < bandMin) {
    adjusted.count = bandMin;
    changed = true;
  } else if (adjusted.count > bandMax) {
    adjusted.count = bandMax;
    changed = true;
  }

  // range再調整（安全側）
  const minRange = Math.max(0, Math.round(adjusted.count * 0.7));
  const maxRange = Math.max(minRange, Math.round(adjusted.count * 1.4));
  adjusted.range = { min: minRange, max: maxRange };

  // 注記追記（多言語）＋ 計算式（calc）行の明示
  const notes = adjusted.notes ?? [];
  const calcLine = `calc: area_km2=${Number(area.toFixed(6))}, baseline=${base}, time_factor=${tf}, crowd_factor=${crowdFactor}, expected=${Math.round(expected)}, band=[${bandMin}..${bandMax}]`;

  if (targetLang === "ja") {
    notes.push(
      `自己検証: 期待値=${Math.round(expected)}, 妥当帯=[${bandMin}〜${bandMax}]`,
      changed ? "自己検証により推定値を妥当帯へ調整しました。" : "自己検証により推定値は妥当と判断されました。",
      calcLine
    );
  } else {
    notes.push(
      `Self-check: expected=${Math.round(expected)}, plausible=[${bandMin}..${bandMax}]`,
      changed ? "Adjusted into plausible band based on self-validation." : "Estimate passed self-validation.",
      calcLine
    );
  }
  adjusted.notes = notes.slice(0, 10); // ノートは最大10件程度に制限
  return adjusted;
}

/* =========================
   xAI呼び出し（既存・詳細ログ）
========================= */
async function callXAIWithTimeout(messages, signal) {
  if (!process.env.XAI_API_KEY) throw new Error("Missing XAI_API_KEY");
  const headers = {
    "Authorization": `Bearer ${process.env.XAI_API_KEY}`,
    "Content-Type": "application/json"
  };

  const body1 = {
    model: XAI_MODEL,
    messages,
    temperature: 0.1,
    max_output_tokens: 400
  };
  console.log("[estimate] calling xAI (max_output_tokens)...");
  let resp = await fetch(XAI_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(body1),
    signal
  });

  if (!resp.ok) {
    const txt = await resp.text();
    console.error("[estimate] xAI first call error:", txt);
    if (resp.status === 400 && /max_output_tokens/i.test(txt)) {
      const body2 = { model: XAI_MODEL, messages, temperature: 0.1, max_tokens: 400 };
      console.log("[estimate] retry xAI (max_tokens)...");
      resp = await fetch(XAI_URL, {
        method: "POST",
        headers,
        body: JSON.stringify(body2),
        signal
      });
    }
  }

  const json = await resp.json().catch(() => ({}));
  console.log("[estimate] raw xAI response:", JSON.stringify(json)?.slice(0, 800));
  if (!resp.ok) {
    const msg = json?.error?.message || `xAI error: ${resp.status}`;
    throw new Error(msg);
  }
  return json;
}

/* =========================
   ハンドラ
========================= */
export default async function handler(req, res) {
  // CORS
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-UI-Lang");
    return res.status(204).end();
  }
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

  try {
    // 入力整形
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch { body = {}; }
    }
    if (!body || typeof body !== "object") body = {};
    const incoming = {
      ...body,
      radius_m: body?.radius_m ?? body?.radius,
      local_time_iso: body?.local_time_iso ?? body?.time ?? body?.localTime
    };

    let parsed = Schema.safeParse(incoming);
    const input = parsed.success ? parsed.data : looseNormalize(incoming);
    console.log("[estimate] input:", input);

    // 返答言語の決定（ja/en）
    const targetLang = detectTargetLang(req, body, input);
    console.log("[estimate] targetLang:", targetLang);

    // 国籍フィルタ
    const nationalityFilter = detectNationalityFilter(input.feature);
    console.log("[estimate] nationalityFilter:", nationalityFilter);

    // APIキー未設定 → 中立推定 + サーバー側自己検証
    if (!process.env.XAI_API_KEY) {
      console.warn("[estimate] missing XAI_API_KEY");
      let neutral = neutralEstimate(input);
      if (targetLang === "ja") {
        neutral.assumptions = ["ヒューリスティック推定を使用。"];
        neutral.notes = ["中立推定（API未使用）。"];
      }
      neutral = serverSideSelfValidate(neutral, input, targetLang);
      return res.status(200).json(neutral);
    }

    // プロンプト
    const prompt = buildPrompt(input, targetLang, nationalityFilter);
    console.log("[estimate] prompt:", prompt);
    const messages = [
      { role: "system", content: "Return JSON only." },
      { role: "user", content: prompt }
    ];

    const execOnce = async (signal) => {
      const xres = await callXAIWithTimeout(messages, signal);
      const content = xres?.choices?.[0]?.message?.content ?? "";
      console.log("[estimate] content:", content);
      let data = tryParseJSON(content);
      console.log("[estimate] parsed data:", data);
      if (!data) data = tryParseJSON(String(content));
      let normalized;
      if (!data) {
        console.warn("[estimate] parse failed, neutral estimate used");
        normalized = neutralEstimate(input);
        if (targetLang === "ja") {
          normalized.assumptions = ["ヒューリスティック推定を使用。"];
          normalized.notes = ["中立推定（API未使用）。"];
        }
      } else {
        normalized = normalizeResult(data);
      }

      // ★ サーバー側「自己検証プロセス」適用（最終の妥当性チェック＆必要なら補正）
      const validated = serverSideSelfValidate(normalized, input, targetLang);
      console.log("[estimate] validated result:", validated);
      return validated;
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("timeout")), TIMEOUT_MS);
    try {
      const out1 = await execOnce(controller.signal);
      clearTimeout(timer);
      console.log("[estimate] final result:", out1);
      return res.status(200).json(out1);
    } catch (e1) {
      clearTimeout(timer);
      console.error("[estimate] first try error:", e1);
      try {
        const out2 = await execOnce(undefined);
        console.log("[estimate] retry result:", out2);
        return res.status(200).json(out2);
      } catch (e2) {
        console.error("[estimate] retry error:", e2);
        let neutral = neutralEstimate(input);
        if (targetLang === "ja") {
          neutral.assumptions = ["ヒューリスティック推定を使用。"];
          neutral.notes = ["中立推定（API未使用）。"];
        }
        neutral = serverSideSelfValidate(neutral, input, targetLang);
        console.log("[estimate] final neutral result:", neutral);
        return res.status(200).json(neutral);
      }
    }
  } catch (err) {
    console.error("[estimate] handler fatal:", err);
       // フェイルセーフ
    const b = req?.body || {};
    const r = Number(b?.radius_m ?? b?.radius ?? 500) || 500;
    const c = (b?.crowd === "混雑" || b?.crowd === "crowded") ? "crowded"
          : (b?.crowd === "普通" || b?.crowd === "normal") ? "normal" : "empty";
    let neutral = neutralEstimate({ radius_m: r, crowd: c });
    const targetLang = (b?.lang || b?.ui_lang || "").toString().toLowerCase().startsWith("ja")
      || hasJapanese(b?.feature) || hasJapanese(b?.address) ? "ja" : "en";
    if (targetLang === "ja") {
      neutral.assumptions = ["ヒューリスティック推定を使用。"];
      neutral.notes = ["中立推定（API未使用）。"];
    }
    // 可能なら追加情報で自己検証
    const inputLite = looseNormalize({
      address: b?.address, crowd: c, feature: b?.feature,
      radius_m: r, local_time_iso: b?.local_time_iso ?? b?.time ?? b?.localTime
    });
    neutral = serverSideSelfValidate(neutral, inputLite, targetLang);
    console.log("[estimate] emergency neutral:", neutral);
    return res.status(200).json(neutral);
  }
}