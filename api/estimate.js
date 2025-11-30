// api/estimate.js
// Vercel Node.js (ESM)
// 人の「特徴」や場所情報から人数をざっくり推定して返す。
// OpenAI Chat Completions API (gpt-5-mini) を使用。

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

/**
 * モデルのテキスト出力から JSON 部分だけを抜き出してパース
 * （```json ... ``` などで返ってきても耐えるようにする）
 */
function safeParseJsonFromText(text) {
  if (!text) return null;

  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    return null;
  }
  const jsonPart = text.slice(firstBrace, lastBrace + 1);
  try {
    return JSON.parse(jsonPart);
  } catch {
    return null;
  }
}

/**
 * 入力情報からのシンプルなバックアップ推定ロジック
 * （モデル出力が使えない場合にのみ使用）
 */
function heuristicEstimate(input) {
  const radiusM = typeof input.radius_m === "number" ? input.radius_m : 500;
  const radiusKm = Math.max(0.05, radiusM / 1000); // 50m以上

  const placeText = (input.place_type || input.address || "").toString();
  const crowdText = (input.crowd_level || "").toString();
  const featuresText = (input.features || "").toString();

  // ベース人口密度 [人 / km^2]
  let baseDensity = 8000; // デフォルト: 都市近郊
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
    lowerPlace.includes("tourist") ||
    lowerPlace.includes("観光地")
  ) {
    baseDensity = 12000;
  } else if (
    lowerPlace.includes("公園") ||
    lowerPlace.includes("park")
  ) {
    baseDensity = 3000;
  }

  // 混雑度補正
  let crowdFactor = 1.0;
  if (crowdText.containsAny(["空いている", "空き", "すいて"])) {
    crowdFactor = 0.5;
  } else if (crowdText.containsAny(["混雑", "混んで"])) {
    crowdFactor = 1.5;
  }

  // 特徴補正（「食事中」「走っている」など → 全体の一部）
  let featureFactor = 1.0;
  if (featuresText.trim().length > 0) {
    featureFactor = 0.25; // デフォルトで全体の25%くらい
    const lowerFeat = featuresText.toLowerCase();
    if (lowerFeat.includes("芸能") || lowerFeat.includes("celebrity")) {
      featureFactor = 0.001; // 芸能人はかなり少なめ
    }
  }

  // 面積 [km^2]
  const areaKm2 = Math.PI * radiusKm * radiusKm;

  // 推定人数
  let estimated = Math.round(baseDensity * areaKm2 * crowdFactor * featureFactor);
  if (!Number.isFinite(estimated) || estimated < 0) {
    estimated = 0;
  }

  // 範囲と信頼度
  const min = Math.max(0, Math.round(estimated * 0.5));
  const max = Math.max(min, Math.round(estimated * 1.5));
  const confidence = estimated === 0 ? 0.3 : 0.7;

  const assumptions = [
    `半径${radiusKm.toFixed(2)}km、場所タイプと混雑度から単純な人口密度モデルで推定しました。`,
  ];
  const notes = [
    "この値はあくまで概算であり、実際の人数とは大きく異なる可能性があります。",
  ];

  return { count: estimated, range: { min, max }, confidence, assumptions, notes };
}

// String.prototype 拡張（簡易 containsAny）
String.prototype.containsAny = function (arr) {
  const lower = this.toString().toLowerCase();
  return arr.some((w) => lower.includes(w.toLowerCase()));
};

/**
 * Vercel Serverless Function エントリポイント
 */
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const body =
      typeof req.body === "string"
        ? JSON.parse(req.body || "{}")
        : (req.body || {});

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

    const systemPrompt = `
あなたは、位置情報・時間帯・場所の種類などから
「そのエリアに何人くらい人がいそうか」をラフに推定するアシスタントです。

【入力】
- address: 住所やランドマーク名
- radius_m: 半径[m]
- local_time_iso: 現地時刻（ISO形式）
- place_type: 駅 / オフィス街 / 住宅街 / 観光地 など
- features: 「黒い服を着ている」「食事中の人」など特徴
- crowd_level: 「空いている」「普通」「混雑」など（あれば）

【タスク】
- 半径内で「features に当てはまる人」がどのくらい居そうかを推定する。
- 現実的なオーダー感（桁）に収めること。

【出力フォーマット】
必ず次の JSON オブジェクト「だけ」を返してください。

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
※ この JSON 以外の文字（説明文、コメント、コードブロック \`\`\` 等）は一切出力しないこと。
`;

    const userPrompt =
      "以下の条件で人数を推定し、指定された JSON オブジェクトのみを返してください。\n\n" +
      JSON.stringify(inputForModel, null, 2);

    // モデル呼び出し
    const completion = await client.chat.completions.create({
      model: OPENAI_MODEL,
      temperature: 1,
      max_completion_tokens: maxTokensForModel,
      messages: [
        { role: "system", content: systemPrompt.trim() },
        { role: "user", content: userPrompt },
      ],
    });

    const rawText =
      completion.choices?.[0]?.message?.content?.trim() || "";

    // --- モデルからの JSON を解析 ---
    let parsed = safeParseJsonFromText(rawText);

    // parsed が使い物にならない場合はバックアップ推定
    let finalResult;
    if (
      !parsed ||
      typeof parsed.count !== "number" ||
      !parsed.range ||
      typeof parsed.range.min !== "number" ||
      typeof parsed.range.max !== "number"
    ) {
      finalResult = heuristicEstimate(inputForModel);
    } else {
      // モデル出力をそのまま使いつつ、最低限の補正
      const count =
        typeof parsed.count === "number" && parsed.count >= 0
          ? Math.round(parsed.count)
          : null;

      const min =
        typeof parsed.range.min === "number" && parsed.range.min >= 0
          ? Math.round(parsed.range.min)
          : 0;
      const max =
        typeof parsed.range.max === "number" && parsed.range.max >= min
          ? Math.round(parsed.range.max)
          : Math.max(min, count ?? min);

      const confRaw =
        typeof parsed.confidence === "number" ? parsed.confidence : 0.0;
      const autoConf =
        max > min
          ? Math.max(
              0.1,
              Math.min(0.99, 1 - (max - min) / (max + 1))
            )
          : 0.7;
      const confidence =
        confRaw > 0 && confRaw <= 1 ? confRaw : autoConf;

      const assumptions =
        Array.isArray(parsed.assumptions)
          ? parsed.assumptions.map((x) => String(x))
          : [];
      const notes =
        Array.isArray(parsed.notes)
          ? parsed.notes.map((x) => String(x))
          : [];

      // count が null なら、範囲の中心を使う
      const safeCount =
        count !== null ? count : Math.round((min + max) / 2);

      finalResult = {
        count: safeCount,
        range: { min, max },
        confidence,
        assumptions,
        notes,
      };
    }

    return res.status(200).json(finalResult);
  } catch (err) {
    console.error("[estimate] error", err);

    // 失敗時でもフロントのデコードが落ちないよう、同じ構造で返す
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
