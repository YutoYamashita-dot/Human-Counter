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
 * Vercel Serverless Function エントリポイント
 */
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    // Vercel の設定次第で req.body が string のこともあるので吸収
    const body =
      typeof req.body === "string"
        ? JSON.parse(req.body || "{}")
        : (req.body || {});

    const {
      address,              // 住所文字列
      radius_m,             // 半径[m]
      local_time_iso,       // 現地時刻 ISO
      place_type,           // 場所タイプ（駅 / オフィス街 / 住宅街 / 観光地 など）
      features,             // 特徴（例:「黒い服を着ている」「芸能人」など）
      crowd_level,          // 「空いている」「普通」「混雑」など
      max_completion_tokens // フロントから来る max_tokens 相当
    } = body;

    // モデルに渡すための入力まとめ（null/undefined を整理）
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

    // max_completion_tokens に渡す値
    const DEFAULT_MAX_TOKENS = 400;
    const maxTokensForModel =
      typeof max_completion_tokens === "number" &&
      max_completion_tokens > 0 &&
      max_completion_tokens <= 4000
        ? max_completion_tokens
        : DEFAULT_MAX_TOKENS;

    // =========================
    // モデルへの指示
    // =========================
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
- 完全な正解は不要だが、現実的なオーダー感（桁）に収める。
  例: 半径500mの駅前 → 数千〜数万人など。

【出力フォーマット（重要）】
必ず次の JSON オブジェクト「だけ」を返してください。

{
  "count": number | null,       // 中心的な推定人数。わからなければ null でもよい。
  "range": {
    "min": number,              // 現実的な下限
    "max": number               // 現実的な上限（min <= count <= max を目安）
  },
  "confidence": number,         // 0〜1 の信頼度（だいたいの感覚でよい）
  "assumptions": string[],      // 前提条件・仮定（日本語）
  "notes": string[]             // 注意点・免責・補足（日本語）
}

【厳守ルール】
- この JSON 以外の文字（説明文、コメント、コードブロック \`\`\` 等）は一切出力しない。
- プロパティ名は必ず上記どおり（count / range / confidence / assumptions / notes）。
`;

    const userPrompt =
      "以下の条件で、人数を推定し、指定された JSON オブジェクトのみを返してください。\n\n" +
      JSON.stringify(inputForModel, null, 2);

    // Chat Completions API（gpt-5-mini）
    const completion = await client.chat.completions.create({
      model: OPENAI_MODEL,
      temperature: 1,
      // gpt-5 系は max_tokens ではなく max_completion_tokens
      max_completion_tokens: maxTokensForModel,
      messages: [
        { role: "system", content: systemPrompt.trim() },
        { role: "user", content: userPrompt },
      ],
    });

    const rawText =
      completion.choices?.[0]?.message?.content?.trim() || "";

    // --- モデル出力をパース ---
    let parsed;
    try {
      parsed = rawText ? JSON.parse(rawText) : null;
    } catch (_err) {
      parsed = null;
    }

    // --- 安全側で値を補完 ---
    const count =
      typeof parsed?.count === "number" && parsed.count >= 0
        ? parsed.count
        : null;

    const min =
      typeof parsed?.range?.min === "number" && parsed.range.min >= 0
        ? parsed.range.min
        : (count ?? 0);

    const max =
      typeof parsed?.range?.max === "number" && parsed.range.max >= min
        ? parsed.range.max
        : (count ?? min);

    const confRaw =
      typeof parsed?.confidence === "number" ? parsed.confidence : 0.0;

    // range 幅からざっくり信頼度補正（0.1〜0.99）
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
      Array.isArray(parsed?.assumptions)
        ? parsed.assumptions.map((x) => String(x))
        : [];

    const notes =
      Array.isArray(parsed?.notes)
        ? parsed.notes.map((x) => String(x))
        : [];

    const responsePayload = {
      // MainActivity / UiState が期待する形：
      // state.result.count
      // state.result.range.min / max
      // state.result.confidence
      // state.result.assumptions / notes
      count,
      range: {
        min,
        max,
      },
      confidence,
      assumptions,
      notes,
    };

    return res.status(200).json(responsePayload);
  } catch (err) {
    console.error("[estimate] error", err);

    // 失敗時でもフロントのデコードが落ちないよう、同じ構造で返す
    return res.status(200).json({
      count: null,
      range: {
        min: 0,
        max: 0,
      },
      confidence: 0.0,
      assumptions: [],
      notes: [
        err instanceof Error ? err.message : "Internal Server Error",
      ],
    });
  }
}
