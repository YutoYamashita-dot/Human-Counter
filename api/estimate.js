// api/estimate.js  (Vercel Node.js Serverless Function)
import { z } from "zod";

export const config = { runtime: "nodejs" };

// xAI API エンドポイント＆モデル
const XAI_URL = "https://api.x.ai/v1/chat/completions";
const XAI_MODEL = "grok-4-fast-reasoning"; // 例: grok-2-latest / grok-2-mini 等
const TIMEOUT_MS = 30000;

/* =========================
   スキーマ定義
========================= */
const CrowdJp = z.enum(["空いている", "普通", "混雑"]);
const CrowdInternal = z.enum(["empty", "normal", "crowded"]);

const Schema = z.object({
  address: z
    .string()
    .transform((s) => (s ?? "").toString().trim())
    .pipe(z.string().min(1).max(300)),
  crowd: z
    .union([CrowdJp, CrowdInternal])
    .transform((v) =>
      v === "空いている"
        ? "empty"
        : v === "普通"
        ? "normal"
        : v === "混雑"
        ? "crowded"
        : v
    ),
  feature: z
    .string()
    .transform((s) => (s ?? "").toString().trim())
    .pipe(z.string().min(1).max(140)),
  radius_m: z.coerce.number().int().min(10).max(40_075_000),
  // UIから渡す現地時刻（ISO文字列: "YYYY-MM-DDTHH:mm:ss"）
  local_time_iso: z.string().optional().nullable(),
});

/* =========================
   言語判定
========================= */
function hasJapanese(s = "") {
  return /[\u3040-\u30FF\u4E00-\u9FFF]/.test(String(s));
}
function detectTargetLang(req, body, input) {
  // 優先度: 明示指定 > ヘッダー > 入力文字種 > 既定
  const explicit = (
    body?.lang ||
    body?.ui_lang ||
    body?.locale ||
    ""
  )
    .toString()
    .toLowerCase();
  if (explicit === "ja" || explicit === "en") return explicit;

  const h = (
    req.headers?.["x-ui-lang"] ||
    req.headers?.["accept-language"] ||
    ""
  )
    .toString()
    .toLowerCase();
  if (h.startsWith("ja")) return "ja";
  if (h.startsWith("en")) return "en";

  if (
    hasJapanese(body?.crowd) ||
    hasJapanese(body?.feature) ||
    hasJapanese(body?.address)
  )
    return "ja";
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
    c === "混雑" || c === "crowded"
      ? "crowded"
      : c === "普通" || c === "normal"
      ? "normal"
      : "empty";
  const feature = String(input?.feature ?? "").trim() || "people";
  const r = Number(input?.radius_m ?? input?.radius ?? 500);
  const radius_m = Number.isFinite(r)
    ? Math.round(Math.max(10, Math.min(r, 40_075_000)))
    : 500;
  const local_time_iso =
    (input?.local_time_iso && String(input.local_time_iso)) || null;
  return { address: addr, crowd, feature, radius_m, local_time_iso };
}

/* =========================
   国籍フィルタ
========================= */
function detectNationalityFilter(feature = "") {
  const s = String(feature).toLowerCase();
  if (/(non[-\s]?japanese|foreigner|foreigners|外国人)/.test(s))
    return "foreigner_only";
  if (/(japanese( people)?|日本人)/.test(s)) return "japanese_only";
  return "all";
}

/* =========================
   現地時間の解釈（時間帯/曜日）
========================= */
function parseLocalTimeInfo(local_time_iso) {
  try {
    if (!local_time_iso)
      return { iso: null, hour: null, weekday: null, weekend: null, slot: "unknown" };
    const d = new Date(local_time_iso);
    if (isNaN(d.getTime()))
      return { iso: null, hour: null, weekday: null, weekend: null, slot: "unknown" };
    const hour = d.getHours(); // 0..23
    const weekday = d.getDay(); // 0=Sun..6=Sat
    const weekend = weekday === 0 || weekday === 6;

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
   ベースライン人数推定（サーバー側・シンプル）
   - ここで「現実的なオーダー」を決める
========================= */
function baselineEstimate(input, nationalityFilter = "all") {
  const time = parseLocalTimeInfo(input.local_time_iso);
  const placeType = detectPlaceType(input.address, input.feature);

  const baselineByPlace = {
    station: 12000,
    airport: 9000,
    mall: 6000,
    office: 4800,
    school: 3200,
    tourist: 4000,
    residential: 2000,
    park: 800,
    generic: 2400,
  };

  const timeFactorMap = {
    morning_commute: 1.6,
    lunch: 1.3,
    evening_commute: 1.7,
    daytime: 1.0,
    early_morning: 0.5,
    night: 0.3,
    other: 0.8,
    unknown: 0.8,
  };

  const radius_km = Math.max(0, input.radius_m) / 1000;
  const area_km2 = Math.PI * radius_km * radius_km;

  const baseDensity = baselineByPlace[placeType] ?? baselineByPlace.generic;
  const timeFactor = timeFactorMap[time.slot] ?? 0.8;
  const crowdFactor =
    input.crowd === "crowded" ? 2 : input.crowd === "normal" ? 1 : 0.5;

  let nationalityFactor = 1;
  if (nationalityFilter === "japanese_only") {
    nationalityFactor = 0.85; // 日本人のみ: だいたい全体の8〜9割
  } else if (nationalityFilter === "foreigner_only") {
    nationalityFactor = 0.15; // 外国人のみ: 都市部で1〜2割程度を想定
  }

  let expected =
    area_km2 * baseDensity * timeFactor * crowdFactor * nationalityFactor;
  expected = Math.max(0, expected);

  const bandMin = Math.round(expected * 0.6);
  const bandMax = Math.max(bandMin, Math.round(expected * 1.8));

  return {
    expected,
    bandMin,
    bandMax,
    area_km2,
    baseDensity,
    timeFactor,
    crowdFactor,
    placeType,
    timeSlot: time.slot,
    timeIso: time.iso,
  };
}

/* =========================
   プロンプト（できるだけ短い日本語プロンプト＋自己検証プロセス）
========================= */
function buildPrompt(input, targetLang, nationalityFilter, baseline) {
  const { address, crowd, feature, radius_m, local_time_iso } = input;

  const radius_km = radius_m / 1000;

  // おおまかなスケールヒント（日本全体・地球全体などをAIに伝える用、短く）
  let scaleHint = "local";
  if (radius_km >= 5000) {
    scaleHint = "earth";
  } else if (radius_km >= 800) {
    scaleHint = "country_or_large_region";
  }

  const area_km2 = baseline.area_km2;

  return `あなたは人数を推定するAIです。以下の条件に当てはまる「人の人数」を、現実世界であり得るオーダーで推定してください。

出力は必ず次のJSONのみとし、余計なテキストは一切書かないでください。
{"count":number,"confidence":number,"range":{"min":number,"max":number},"assumptions":string[],"notes":string[]}

条件:
- 対象: "feature" に当てはまる人。
- 範囲: "address" を中心とした半径 radius_m メートルの円内。
- crowd は混雑度の目安です（empty / normal / crowded）。
- nationality_filter:
  - "all": 国籍を問わず全員
  - "japanese_only": 日本人のみ
  - "foreigner_only": 日本人以外のみ
- 半径が非常に大きい場合（約1000km以上や地球全体相当など）は、国全体や地球全体の人口規模を考慮した現実的な人数にしてください。
- count は現実世界の人口を超えない範囲で、極端に小さすぎる値・大きすぎる値は避けてください。
- confidence は 0〜1 の間の値にしてください。
- assumptions と notes には、推定の理由や前提を簡潔に日本語で書いてください。

自己検証プロセス（数値チェック）:
- 半径 radius_m から計算される円の面積 area_km2（今回の概算: 約 ${area_km2.toFixed(
    3
  )} km^2）を用いて、人数密度 density = count / area_km2 を考え、駅前・住宅地・公園などとして極端に高すぎないか／低すぎないか確認してください。
- 半径が非常に大きい場合（scale_hint が country_or_large_region や earth の場合）、対象地域の総人口を大きく超えていないか確認してください。
- range.min ≤ count ≤ range.max になるよう、一貫した範囲になっているか確認してください。
- 上記チェックで不自然だと感じた場合は、count や range を修正し、その理由を notes に1行以上必ず書いてください。

入力情報:
- address: ${JSON.stringify(address)}
- feature: ${JSON.stringify(feature)}
- crowd: ${JSON.stringify(crowd)}
- radius_m: ${radius_m}
- local_time_iso: ${JSON.stringify(local_time_iso || baseline.timeIso || null)}
- nationality_filter: ${JSON.stringify(nationalityFilter)}
- scale_hint: ${JSON.stringify(scaleHint)}`;
}

/* =========================
   xAI返却の正規化
========================= */
function normalizeResult(data) {
  const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
  const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

  const count = num(data?.count, 0);
  const conf = clamp(num(data?.confidence, 0.6), 0, 1);
  const rmin = num(data?.range?.min, Math.max(0, Math.round(count * 0.7)));
  const rmax = num(
    data?.range?.max,
    Math.max(rmin, Math.round(count * 1.4))
  );
  const assumptions = Array.isArray(data?.assumptions)
    ? data.assumptions.slice(0, 8)
    : [];
  const notes = Array.isArray(data?.notes) ? data.notes.slice(0, 8) : [];

  return {
    count: Math.max(0, Math.round(count)),
    confidence: conf,
    range: {
      min: Math.max(0, Math.round(rmin)),
      max: Math.max(0, Math.round(rmax)),
    },
    assumptions,
    notes,
  };
}

/* =========================
   JSON抽出
========================= */
function tryParseJSON(content = "") {
  if (typeof content !== "string") return null;
  const fenced = content.match(/```json([\s\S]*?)```/i);
  if (fenced && fenced[1]) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {}
  }
  const first = content.indexOf("{");
  const last = content.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) {
    const slice = content.slice(first, last + 1);
    try {
      return JSON.parse(slice);
    } catch {}
  }
  try {
    return JSON.parse(content);
  } catch {}
  return null;
}

/* =========================
   ヒューリスティック推定（APIなし用）
========================= */
function neutralEstimate(input, nationalityFilter, targetLang) {
  const baseline = baselineEstimate(input, nationalityFilter);
  const est = Math.round(baseline.expected);
  const spread = Math.round(est * 0.35 + 15);
  const out = {
    count: Math.max(0, est),
    confidence: 0.55,
    range: {
      min: Math.max(0, est - spread),
      max: est + spread,
    },
    assumptions:
      targetLang === "ja"
        ? ["場所タイプ・時間帯・混雑度からの簡易推定。"]
        : ["Simple heuristic based on place type, time slot, and crowd level."],
    notes:
      targetLang === "ja"
        ? [
            `中立推定（API未使用）。期待値=${est}人、半径=${input.radius_m}m。`,
          ]
        : [
            `Neutral heuristic estimate (no API). expected≈${est} people, radius=${input.radius_m}m.`,
          ],
  };
  return { out, baseline };
}

/* =========================
   サーバー側の軽い補正
   - AI出力がベースラインから大きくズレていれば 0.5x〜2.0x の範囲に収める
========================= */
function serverAdjustWithBaseline(out, baseline, targetLang) {
  const bandLo = Math.round(baseline.expected * 0.5);
  const bandHi = Math.max(bandLo, Math.round(baseline.expected * 2.0));

  let adjusted = { ...out };
  let changed = false;

  if (adjusted.count < bandLo) {
    adjusted.count = bandLo;
    changed = true;
  } else if (adjusted.count > bandHi) {
    adjusted.count = bandHi;
    changed = true;
  }

  const spread = Math.round(adjusted.count * 0.35 + 10);
  adjusted.range = {
    min: Math.max(0, adjusted.count - spread),
    max: adjusted.count + spread,
  };

  const notes = adjusted.notes ?? [];
  const summaryLine =
    targetLang === "ja"
      ? `サーバー側簡易チェック: 期待オーダー≈${Math.round(
          baseline.expected
        )}人, 許容帯=[${bandLo}〜${bandHi}]`
      : `Server-side simple check: expected order≈${Math.round(
          baseline.expected
        )} people, allowed=[${bandLo}..${bandHi}]`;

  if (changed) {
    notes.push(
      summaryLine,
      targetLang === "ja"
        ? "AI推定値が許容帯から外れていたため、現実的な範囲に補正しました。"
        : "AI estimate was outside the allowed band and was adjusted into a more realistic range."
    );
  } else {
    notes.push(
      summaryLine,
      targetLang === "ja"
        ? "AI推定値は許容帯の範囲内と判断されました。"
        : "AI estimate was judged to be within the allowed band."
    );
  }

  adjusted.notes = notes.slice(0, 10);
  return adjusted;
}

/* =========================
   xAI呼び出し（シンプル版）
========================= */
async function callXAIWithTimeout(messages, signal) {
  if (!process.env.XAI_API_KEY) throw new Error("Missing XAI_API_KEY");
  const headers = {
    Authorization: `Bearer ${process.env.XAI_API_KEY}`,
    "Content-Type": "application/json",
  };

  const body = {
    model: XAI_MODEL,
    messages,
    temperature: 0,
    max_output_tokens: 400,
  };

  const resp = await fetch(XAI_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  });

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
  if (req.method !== "POST")
    return res.status(405).json({ error: "Use POST" });

  try {
    // 入力整形
    let body = req.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        body = {};
      }
    }
    if (!body || typeof body !== "object") body = {};

    const incoming = {
      ...body,
      radius_m: body?.radius_m ?? body?.radius,
      local_time_iso: body?.local_time_iso ?? body?.time ?? body?.localTime,
    };

    let parsed = Schema.safeParse(incoming);
    const input = parsed.success ? parsed.data : looseNormalize(incoming);
    console.log("[estimate] input:", input);

    const targetLang = detectTargetLang(req, body, input);
    console.log("[estimate] targetLang:", targetLang);

    const nationalityFilter = detectNationalityFilter(input.feature);
    console.log("[estimate] nationalityFilter:", nationalityFilter);

    // APIキー未設定 → 完全にヒューリスティックで返す
    if (!process.env.XAI_API_KEY) {
      console.warn("[estimate] missing XAI_API_KEY");
      const { out, baseline } = neutralEstimate(
        input,
        nationalityFilter,
        targetLang
      );
      const adjusted = serverAdjustWithBaseline(out, baseline, targetLang);
      return res.status(200).json(adjusted);
    }

    // ベースラインを先に計算
    const baseline = baselineEstimate(input, nationalityFilter);

    // プロンプト
    const prompt = buildPrompt(
      input,
      targetLang,
      nationalityFilter,
      baseline
    );
    console.log("[estimate] prompt:", prompt);

    const messages = [
      { role: "system", content: "Return JSON only." },
      { role: "user", content: prompt },
    ];

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error("timeout")),
      TIMEOUT_MS
    );

    try {
      const xres = await callXAIWithTimeout(messages, controller.signal);
      clearTimeout(timer);

      const content = xres?.choices?.[0]?.message?.content ?? "";
      console.log("[estimate] content:", content);

      let data = tryParseJSON(content);
      if (!data) data = tryParseJSON(String(content));
      let normalized;

      if (!data) {
        console.warn("[estimate] parse failed, use neutral baseline");
        const fallback = neutralEstimate(input, nationalityFilter, targetLang);
        normalized = fallback.out;
        baseline.expected = fallback.baseline.expected;
      } else {
        normalized = normalizeResult(data);
      }

      const finalResult = serverAdjustWithBaseline(
        normalized,
        baseline,
        targetLang
      );
      console.log("[estimate] final result:", finalResult);
      return res.status(200).json(finalResult);
    } catch (e1) {
      clearTimeout(timer);
      console.error("[estimate] xAI error:", e1);
      const { out, baseline } = neutralEstimate(
        input,
        nationalityFilter,
        targetLang
      );
      const adjusted = serverAdjustWithBaseline(out, baseline, targetLang);
      return res.status(200).json(adjusted);
    }
  } catch (err) {
    console.error("[estimate] handler fatal:", err);
    // フェイルセーフ: できるだけ入力からヒューリスティックで返す
    const b = req?.body || {};
    const r = Number(b?.radius_m ?? b?.radius ?? 500) || 500;
    const c =
      b?.crowd === "混雑" || b?.crowd === "crowded"
        ? "crowded"
        : b?.crowd === "普通" || b?.crowd === "normal"
        ? "normal"
        : "empty";

    const rawInput = looseNormalize({
      address: b?.address,
      crowd: c,
      feature: b?.feature,
      radius_m: r,
      local_time_iso: b?.local_time_iso ?? b?.time ?? b?.localTime,
    });

    const targetLang =
      (b?.lang || b?.ui_lang || "")
        .toString()
        .toLowerCase()
        .startsWith("ja") ||
      hasJapanese(b?.feature) ||
      hasJapanese(b?.address)
        ? "ja"
        : "en";

    const nationalityFilter = detectNationalityFilter(rawInput.feature);
    const { out, baseline } = neutralEstimate(
      rawInput,
      nationalityFilter,
      targetLang
    );
    const adjusted = serverAdjustWithBaseline(out, baseline, targetLang);
    console.log("[estimate] emergency neutral:", adjusted);
    return res.status(200).json(adjusted);
  }
}

