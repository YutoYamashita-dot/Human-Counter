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
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    // Vercel の設定次第で req.body が string のこともあるので吸収
    const body =
      typeof req.body === "string"
        ? JSON.parse(req.body || "{}")
        : (req.body || {});

    const {
      address,              // 住所文字列（例: "東京都港区高輪3-26-27 品川駅周辺"）
      radius_m,             // 半径（メートル）
      local_time_iso,       // 現地時刻 ISO（例: "2025-11-30T20:15:00+09:00"）
      place_type,           // 場所タイプ（駅 / オフィス街 / 住宅街 / 観光地 などの自由入力）
      features,             // 人の特徴（「食事中の人」「電車待ちの人」など）
      crowd_level,          // UI側の混雑度（任意: "空いている" / "普通" / "混雑" など）
      max_completion_tokens // ← フロントから来る max_tokens 相当
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

    // max_tokens に渡す値（max_completion_tokens をそのまま使う）
    const DEFAULT_MAX_TOKENS = 400;
    const maxTokensForModel =
      typeof max_completion_tokens === "number" &&
      max_completion_tokens > 0 &&
      max_completion_tokens <= 4000
        ? max_completion_tokens
        : DEFAULT_MAX_TOKENS;

    // =========================
    // モデルへの指示（日本語）
    // temperature は 1 固定
    // max_tokens は max_completion_tokens をそのまま使用
    // JSON だけ返させるようにプロンプトで強制
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

【推定の考え方の一例】
- 大都市の駅前: 半径500mで数千〜数万人程度（時間帯・曜日・特徴によって変動）。
- 住宅街: 夜間は「住んでいる人」の人数が多く、昼間は外出して減る。
- 観光地: 休日や観光シーズンは平日より多い。
- crowd_level が「混雑」であれば、ベースの人数をやや増やすなど、直感的な補正のみ行う。

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

    // ★ Chat Completions API を使用（Responses API ではない）
    const completion = await client.chat.completions.create({
      model: OPENAI_MODEL,
      temperature: 1,
      max_tokens: maxTokensForModel, // ← ユーザー指定どおり max_completion_tokens をそのまま使用
      messages: [
        {
          role: "system",
          content: systemPrompt.trim(),
        },
        {
          role: "user",
          content: userPrompt,
        },
      ],
    });

    const rawText =
      completion.choices?.[0]?.message?.content?.trim() || "";

    let parsed;
    try {
      parsed = rawText ? JSON.parse(rawText) : null;
    } catch (e) {
      // JSON になっていなかった場合は、そのままデバッグ用情報を返す
      parsed = {
        parse_error: e instanceof Error ? e.message : "JSON parse error",
        raw: rawText,
      };
    }

    return res.status(200).json({
      ok: true,
      model: OPENAI_MODEL,
      input: inputForModel,
      estimate: parsed,
    });
  } catch (err) {
    console.error("[estimate] error", err);
    return res.status(500).json({
      ok: false,
      error: err instanceof Error ? err.message : "Internal Server Error",
    });
  }
}