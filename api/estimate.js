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
   プロンプト（シンプル版・大半径対応＆現実的スケール強調）
========================= */
function buildPrompt(input, targetLang, nationalityFilter, baseline) {
  const { address, crowd, feature, radius_m, local_time_iso } = input;

  const radius_km = radius_m / 1000;
  const addressLower = String(address || "").toLowerCase();

  // スケール判定: ローカル / 日本全体 / 地球全体 など
  let scaleHint = "local"; // "local" | "large_region" | "japan_country" | "global_earth"
  if (radius_km >= 5000) {
    // ほぼ地球全体
    scaleHint = "global_earth";
  } else if (radius_km >= 800 && radius_km <= 3000) {
    // 1000km 前後 → 日本全体レベルを想定
    if (/日本|japan/.test(addressLower) || targetLang === "ja") {
      scaleHint = "japan_country";
    } else {
      scaleHint = "large_region";
    }
  }

  // 人口の現実的な上限（おおよそ、2020年代中盤）
  const japanTotalPopulationApprox = 1.23e8; // 約 1.23 億人
  const worldTotalPopulationApprox = 8.2e9;  // 約 82 億人

  return `You are an estimator. Output ONLY JSON, no prose.

JSON schema (keys and types are fixed):
{"count":number,"confidence":number,"range":{"min":number,"max":number},"assumptions":string[],"notes":string[]}

Rules:
- Estimate how many PEOPLE match the description "feature" within a circle of radius_m meters around the address.
- Nationality:
  - If nationality_filter = "all": include everyone (Japanese and non-Japanese). Do NOT infer nationality from language.
  - If "japanese_only": include only Japanese people.
  - If "foreigner_only": include only non-Japanese (foreigners).
- "crowd" is one of "empty" | "normal" | "crowded".
- "assumptions" and "notes" MUST be written in "${targetLang}".
- "confidence" is a float 0..1.
- Respond with JSON only. No extra text.

Scale handling:
- scale_hint = "local": treat this as a local area (city block, neighborhood, station area, etc.).
- scale_hint = "large_region": treat this as a several-hundred-kilometer region (multiple cities or a large region).
- scale_hint = "japan_country":
  - Treat the circle as roughly covering the whole of Japan.
  - Use a realistic total population for Japan in the mid-2020s: about ${Math.round(
    japanTotalPopulationApprox
  )} people.
  - Your "count" MUST NEVER exceed this total population.
  - When the feature is a subset (e.g. people eating, people wearing red clothes), your "count" should usually be a reasonable fraction of the total population (often a few percent or less), unless there is a very strong reason.
- scale_hint = "global_earth":
  - Treat the circle as covering almost the entire Earth.
  - Use a realistic total world population in the mid-2020s: about ${Math.round(
    worldTotalPopulationApprox
  )} people.
  - Your "count" MUST NEVER exceed this world population.
  - For specific features, estimate a reasonable subset of the world population.

Important realism guidance:
- Use the baseline numbers below as a realistic ORDER OF MAGNITUDE.
- Do NOT arbitrarily shrink the count far below the baseline without a clear, concrete reason.
- If you are unsure, avoid obviously underestimating: it is better to stay around the baseline_expected_people or slightly above it than to output unrealistically small numbers.
- Ensure that "range.min" and "range.max" remain consistent with realistic human populations for the given scale (local, country, global).

Context:
- address: ${JSON.stringify(address)}
- local_time_iso: ${JSON.stringify(local_time_iso || baseline.timeIso || null)}
- time_slot: ${JSON.stringify(
    baseline.timeSlot
  )}  // morning_commute, lunch, evening_commute, night, etc.
- place_type: ${JSON.stringify(
    baseline.placeType
  )} // station/airport/mall/park/residential/office/school/tourist/generic
- crowd: ${JSON.stringify(crowd)}
- feature: ${JSON.stringify(feature)}
- radius_m: ${radius_m}
- radius_km: ${radius_km.toFixed(3)}
- scale_hint: ${JSON.stringify(
    scaleHint
  )} // "local" | "large_region" | "japan_country" | "global_earth"
- nationality_filter: ${JSON.stringify(nationalityFilter)}
- japan_total_population_approx: ${japanTotalPopulationApprox}
- world_total_population_approx: ${worldTotalPopulationApprox}

Simple heuristic baseline (for your reference):
- area_km2 ≈ ${baseline.area_km2.toFixed(4)}
- base_density_people_per_km2 ≈ ${baseline.baseDensity}
- time_factor ≈ ${baseline.timeFactor}
- crowd_factor ≈ ${baseline.crowdFactor}
- baseline_expected_people ≈ ${Math.round(
    baseline.expected
  )} (plausible band ${baseline.bandMin}〜${baseline.bandMax})

Self-check guideline:
- For local or regional scales ("local", "large_region"):
  - Your "count" should normally stay within about 0.8x〜2.5x of baseline_expected_people.
  - If you go outside that range, clearly explain the specific reasons in "notes".
- For "japan_country" and "global_earth":
  - First check that "count" is well below the total population when you are estimating a subset (specific activity, clothing, etc.).
  - Then check that the order of magnitude is reasonable (for example, it would be unrealistic if only a tiny number of people matched a very common condition).
- Set "range.min/max" so that most realistic values are covered (for example, roughly -30% / +40% around your count, adjusted if necessary for scale).`;
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
    temperature: 0.4,
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
