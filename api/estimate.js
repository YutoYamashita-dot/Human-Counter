// api/estimate.js
// Vercel Node.js (ESM)
// 人の「特徴」や場所情報から人数をざっくり推定して返す。
// OpenAI Chat Completions API (gpt-5-mini) を JSON モードで使用。

export const config = { runtime: "nodejs" };

import OpenAI from "openai";

/* =========================
   OpenAI クライアント設定
   - 必須: OPENAI_API_KEY
   - 任意: OPENAI_MODEL（未設定なら gpt-5-mini）
========================= */
const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5-mini";

/* ------------------------------------------------
 * バックアップ用の簡易推定ロジック
 * （モデル出力がどうしても使えないときだけ使用）
 * ------------------------------------------------ */
function heuristicEstimate(input) {
  const radiusM =
    typeof input.radius_m === "number" && input.radius_m > 0
      ? input.radius_m
      : 1000;
  const radiusKm = Math.max(0.05, radiusM / 1000); // 最低 50m

  const placeText = (input.place_type || input.address || "").toString();
  const crowdText = (input.crowd_level || "").toString();
  const featuresText = (input.features || "").toString();

  // ベース人口密度 [人/km^2]
  let baseDensity = 8000;
  const lowerPlace = placeText.toLowerCase();
  if (lowerPlace.includes("駅") || lowerPlace.includes("station")) {
    baseDensity = 20000;
  } else if (
    lowerPlace.includes("オフィス") ||
    lowerPlace.includes("office")
  ) {
    baseDensity = 15000;
  } else if (
    lowerPlace.includes("住宅") ||
    lowerPlace.includes("residential") ||
    lowerPlace.includes("住")
  ) {
    baseDensity = 8000;
  } else if (
    lowerPlace.includes("観光") ||
    lowerPlace.includes("tourist")
  ) {
    baseDensity = 12000;
  } else if (lowerPlace.includes("公園") || lowerPlace.includes("park")) {
    baseDensity = 3000;
  }

  // 混雑度補正
  const lowerCrowd = crowdText.toLowerCase();
  let crowdFactor = 1.0;
  if (
    lowerCrowd.includes("空いて") ||
    lowerCrowd.includes("すいて") ||
    lowerCrowd.includes("light")
  ) {
    crowdFactor = 0.5;
  } else if (
    lowerCrowd.includes("混雑") ||
    lowerCrowd.includes("混んで") ||
    lowerCrowd.includes("crowded")
  ) {
    crowdFactor = 1.5;
  }

  // 特徴補正
  let featureFactor = 1.0;
  if (featuresText.trim().length > 0) {
    featureFactor = 0.25;
    const lf = featuresText.toLowerCase();
    if (lf.includes("芸能") || lf.includes("celebrity")) {
      featureFactor = 0.001;
    }
  }

  const areaKm2 = Math.PI * radiusKm * radiusKm;
  let estimated = Math.round(
    baseDensity * areaKm2 * crowdFactor * featureFactor
  );
  if (!Number.isFinite(estimated) || estimated < 0) estimated = 0;

  const min = Math.max(0, Math.round(estimated * 0.5));
  const max = Math.max(min, Math.round(estimated * 1.5));
  const confidence = estimated === 0 ? 0.3 : 0.7;

  return {
    count: estimated,
    range: { min, max },
    confidence,
    assumptions: [
      `半径${radiusKm.toFixed(
        2
      )}km、場所タイプと混雑度から単純な人口密度モデルで概算しました。`,
    ],
    notes: [
      "この値はバックエンド側の簡易モデルによる概算であり、実際の人数とは大きく異なる可能性があります。",
    ],
  };
}

/* 数値っぽいものを number に正規化 */
function numOrNull(v) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

/* ------------------------------------------------
 * Vercel Serverless Function
 * ------------------------------------------------ */
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const body =
      typeof req.body === "string"
        ? JSON.parse(req.body || "{}")
        : req.body || {};

    const {
      address,
      radius_m,
      local_time_iso,
      place_type,
      features,
      crowd_level,
      max_completion_tokens,
    } = body;

    const inputForModel = {
      address: address || "",
      radius_m:
        typeof radius_m === "number" && !Number.isNaN(radius_m)
          ? radius_m
          : null,
      local_time_iso: local_time_iso || null,
      place_type: place_type || null,
      features: features || "",
      crowd_level: crowd_level || null,
    };

    const DEFAULT_MAX_TOKENS = 400;
    const maxTokensForModel =
      typeof max_completion_tokens === "number" &&
      max_completion_tokens > 0 &&
      max_completion_tokens <= 4000
        ? max_completion_tokens
        : DEFAULT_MAX_TOKENS;

    /* ===== モデルへの指示（JSONモード） ===== */
    const systemPrompt = `
あなたは、位置情報・時間帯・場所の種類などから
「そのエリアに何人くらい人がいそうか」をラフに推定するアシスタントです。

【入力】
- address: 住所やランドマーク名
- radius_m: 半径[m]
- local_time_iso: 現地時刻（ISO形式）
- place_type: 駅 / オフィス街 / 住宅街 / 観光地 など
- features: 「食事中の人」「黒い服を着ている人」など特徴
- crowd_level: 「空いている」「普通」「混雑」など（任意）

【タスク】
- 半径内で「features に当てはまる人」がどのくらい居そうかを推定する。
- 現実的なオーダー感（桁）に収めること。

【出力フォーマット】
必ず次の JSON オブジェクトだけを返してください:

{
  "count": number | null,
  "range": {
    "min": number,
    "max": number
  },
  "confidence": number,
  "assumptions": string[],
  "notes": string[]
}

※ 日本語で書くのは assumptions / notes だけで構いません。
`;

    const userPrompt =
      "以下の条件で人数を推定し、指定された JSON オブジェクトのみを返してください。\n\n" +
      JSON.stringify(inputForModel, null, 2);

    // Chat Completions API（JSON モード）
    const completion = await client.chat.completions.create({
      model: OPENAI_MODEL,
      temperature: 1,
      max_completion_tokens: maxTokensForModel,
      response_format: { type: "json_object" }, // ★ JSON 強制モード
      messages: [
        { role: "system", content: systemPrompt.trim() },
        { role: "user", content: userPrompt },
      ],
    });

    const raw = completion.choices?.[0]?.message?.content ?? "";
    let parsed = null;

    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      parsed = null;
    }

    let finalResult;

    if (!parsed || typeof parsed !== "object") {
      // JSON 自体が取れなかったときだけバックアップロジック
      finalResult = heuristicEstimate(inputForModel);
    } else {
      // === モデルの値を最大限利用しつつ補正 ===
      let count = numOrNull(parsed.count);

      let min = parsed.range ? numOrNull(parsed.range.min) : null;
      let max = parsed.range ? numOrNull(parsed.range.max) : null;

      if (min === null && max === null && count !== null) {
        // 範囲が無い場合は count ±30% で作る
        min = Math.max(0, Math.round(count * 0.7));
        max = Math.max(min, Math.round(count * 1.3));
      }

      if (count === null && min !== null && max !== null) {
        // count が無い場合は範囲の中心を count にする
        count = Math.round((min + max) / 2);
      }

      // まだ決まらない／完全におかしい場合はバックアップに切り替え
      if (
        count === null ||
        min === null ||
        max === null ||
        max < min
      ) {
        finalResult = heuristicEstimate(inputForModel);
      } else {
        const confRaw = Number(parsed.confidence);
        const autoConf =
          max > min
            ? Math.max(
                0.1,
                Math.min(0.99, 1 - (max - min) / (max + 1))
              )
            : 0.7;
        const confidence =
          Number.isFinite(confRaw) && confRaw > 0 && confRaw <= 1
            ? confRaw
            : autoConf;

        const assumptions = Array.isArray(parsed.assumptions)
          ? parsed.assumptions.map((x) => String(x))
          : [];
        const notes = Array.isArray(parsed.notes)
          ? parsed.notes.map((x) => String(x))
          : [];

        finalResult = {
          count: Math.round(count),
          range: {
            min: Math.round(min),
            max: Math.round(max),
          },
          confidence,
          assumptions,
          notes,
        };
      }
    }

    return res.status(200).json(finalResult);
  } catch (err) {
    console.error("[estimate] error", err);
    // 失敗時もフロントの JSON 形を維持
    return res.status(200).json({
      count: 0,
      range: { min: 0, max: 0 },
      confidence: 0.0,
      assumptions: [],
      notes: [
        err instanceof Error ? err.message : "Internal Server Error",
      ],
    });
  }
}
