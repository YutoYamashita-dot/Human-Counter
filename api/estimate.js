// api/estimate.js
// Vercel Node.js (ESM)。人の「特徴」や場所情報から人数をざっくり推定して返す。
// バックエンドは OpenAI Chat Completions API（gpt-5-mini）を使用。

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
      radius_m,             // 半径（メートル）
      local_time_iso,       // 現地時刻 ISO
      place_type,           // 場所タイプ（駅 / 住宅街など）
      features,             // 人の特徴
      crowd_level,          // 「空いている」「普通」「混雑」など
      max_completion_tokens // フロントから来る max_tokens 相当
    } = body;

    // モデルに渡すための入力まとめ
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
    // モデルへの指示（日本語）
    // =========================
    const systemPrompt = `
あなたは、位置情報・時間帯・場所の種類などから
「そのエリアに何人くらい人がいそうか」をラフに推定するアシスタントです。

【タスク】
- 入力として与えられた:
  - address（住所・ランドマーク）
  - radius_m（半径[m]）
  - local_time_iso（現地時刻 ISO形式）
  - place_type（駅 / オフィス街 / 住宅街 / 観光地 などの説明）
  - features（例:「食事中の人」「電車待ちの人」「そのエリアに住んでいる人」など）
  - crowd_level（「空いている」「普通」「混雑」など、もしあれば）
- これらから、その半径内に「features に当てはまる人」がどのくらい居そうかを推定してください。
- 完全な正解は不要ですが、あまりに非現実的な桁（例: 半径100mで1億人など）は避け、現実的なオーダーに収めてください。

【出力フォーマット】
以下の JSON オブジェクト「1つだけ」を、余計な文字や説明なしで返してください。

{
  "estimated_count": number,     // features に該当する人の中心的な推定値（0以上の現実的な人数）
  "min_count": number,           // 現実的にあり得そうな下限
  "max_count": number,           // 現実的にあり得そうな上限（min_count ≦ estimated_count ≦ max_count を目安）
  "crowd_label_jp": string,      // 「空いている」「普通」「混雑」など、日本語の簡単なラベル
  "reason": string               // なぜその人数になったのか、日本語で1〜3文ほどの短い説明
}

【重要】
- 必ず有効な JSON のみを返してください。
- JSON の前後に説明文やコードブロック（\`\`\`json など）を絶対に付けないでください。
- キー名や構造は上記と完全に一致させてください。
`;

    const userPrompt =
      "以下の条件で、半径内にいる「features に当てはまる人」の人数を推定してください。" +
      "必ず上で指定した JSON オブジェクトのみを返してください。\n\n" +
      JSON.stringify(inputForModel, null, 2);

    // Chat Completions API（gpt-5-mini）
    const completion = await client.chat.completions.create({
      model: OPENAI_MODEL,
      temperature: 1,
      // gpt-5 系モデルは max_tokens ではなく max_completion_tokens
      max_completion_tokens: maxTokensForModel,
      messages: [
        { role: "system", content: systemPrompt.trim() },
        { role: "user", content: userPrompt },
      ],
    });

    const rawText =
      completion.choices?.[0]?.message?.content?.trim() || "";

    // モデルから返ってきた JSON をパース
    let parsed;
    try {
      parsed = rawText ? JSON.parse(rawText) : null;
    } catch (e) {
      // JSON になっていない場合は、とりあえず 0 人扱いで返す
      parsed = null;
    }

    // フロントのデータクラスに合わせて、
    // ルートに必要なフィールドをフラットに並べる
    const estimated = Number(parsed?.estimated_count) || 0;
    const minCount =
      typeof parsed?.min_count === "number"
        ? parsed.min_count
        : estimated;
    const maxCount =
      typeof parsed?.max_count === "number"
        ? parsed.max_count
        : estimated;

    const responsePayload = {
      // ここが重要: フロントが Required になっている confidence を必ず返す
      // とりあえず「推定レンジの狭さ」から簡易的に計算（0〜1の間くらい）
      confidence:
        maxCount > minCount
          ? Math.max(
              0.1,
              Math.min(
                0.99,
                1 - (maxCount - minCount) / (maxCount + 1)
              )
            )
          : 0.7,

      // 推定値関連
      estimated_count: estimated,
      min_count: minCount,
      max_count: maxCount,

      // 状況ラベルと理由
      crowd_label_jp: parsed?.crowd_label_jp || "",
      reason: parsed?.reason || "",
    };

    return res.status(200).json(responsePayload);
  } catch (err) {
    console.error("[estimate] error", err);
    // 失敗時もフロントのパーサが落ちないよう、必須フィールドを入れて返す
    return res.status(200).json({
      confidence: 0.0,
      estimated_count: 0,
      min_count: 0,
      max_count: 0,
      crowd_label_jp: "",
      reason:
        err instanceof Error ? err.message : "Internal Server Error",
    });
  }
}