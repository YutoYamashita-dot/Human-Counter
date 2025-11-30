// api/estimate.js
// Vercel Node.js (ESM)。人の「特徴」や場所情報から人数をざっくり推定して返す。
// バックエンドは OpenAI gpt-5-mini（Responses API）を使用。

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

const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5-mini"; // 公式モデルID 0

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
        : req.body || {};

    const {
      address,              // 住所文字列（例: "東京都港区高輪3-26-27 品川駅周辺"）
      radius_m,             // 半径（メートル）
      local_time_iso,       // 現地時刻 ISO（例: "2025-11-30T20:15:00+09:00"）
      place_type,           // 場所タイプ（駅 / オフィス街 / 住宅街 / 観光地 などの自由入力）
      features,             // 人の特徴（「食事中の人」「電車待ちの人」など）
      crowd_level,          // UI側の混雑度（任意: "空いている" / "普通" / "混雑" など）
      max_completion_tokens // フロントから来る「max_tokens」の指定値として利用
    } = body;

    // モデルに渡すための入力まとめ（null/undefined を少し整理）
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

    const defaultMaxTokens = 400;
    const maxTokensForModel =
      typeof max_completion_tokens === "number" &&
      max_completion_tokens > 0 &&
      max_completion_tokens <= 4000
        ? max_completion_tokens
        : defaultMaxTokens;

    // =========================
    // モデルへの指示（日本語）
    // temperature は 1 固定
    // max_tokens は「max_completion_tokens」として body から受け取り、
    // OpenAI の max_output_tokens にそのまま渡す。
    // =========================
    const systemPrompt = `
あなたは、位置情報・時間帯・場所の種類などから「そのエリアに何人くらい人がいそうか」をラフに推定するアシスタントです。

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
- 出力は必ず JSON 形式のみ、かつ指定のスキーマに従ってください（余計なキーを追加しない）。

【推定の考え方の一例】
- 大都市の駅前: 半径500mで数千〜数万人程度（時間帯・曜日・特徴によって変動）。
- 住宅街: 夜間は「住んでいる人」の人数が多く、昼間は外出して減る。
- 観光地: 休日や観光シーズンは平日より多い。
- crowd_level が「混雑」であれば、ベースの人数をやや増やすなど、直感的な補正のみ行う。

【出力スキーマ】
- estimated_count: number
    - features に該当する人の「中心的な推定値」。0以上の現実的な人数。
- min_count: number
    - 現実的にあり得そうな下限。
- max_count: number
    - 現実的にあり得そうな上限（min_count ≦ estimated_count ≦ max_count を目安に）。
- crowd_label_jp: string
    - 「空いている」「普通」「混雑」など、日本語で簡単に状況をまとめたラベル。
- reason: string
    - なぜその人数になったのか、日本語で1〜3文ほどの短い説明。

数値は大きめでも小さめでも構いませんが、
- 半径、場所タイプ、時間帯、特徴 から、人間レベルで「まあありそう」と思える範囲にしてください。
`;

    // Responses API + Structured Outputs（JSON Schema） 1
    const response = await client.responses.create({
      model: OPENAI_MODEL,
      temperature: 1, // ユーザー指定
      max_output_tokens: maxTokensForModel, // 「max_tokens」は max_completion_tokens として扱う
      input: [
        {
          role: "system",
          content: systemPrompt.trim(),
        },
        {
          role: "user",
          content:
            "以下の条件で、半径内にいる「features に当てはまる人」の人数を推定してください。" +
            "必ず JSON のみを返してください。\n\n" +
            JSON.stringify(inputForModel, null, 2),
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "EstimateResponse",
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              estimated_count: {
                type: "number",
                description: "推定人数（0以上の現実的な値）",
              },
              min_count: {
                type: "number",
                description: "現実的な下限値",
              },
              max_count: {
                type: "number",
                description: "現実的な上限値",
              },
              crowd_label_jp: {
                type: "string",
                description: "混雑状況を示す日本語ラベル",
              },
              reason: {
                type: "string",
                description: "人数の根拠となる簡単な説明（日本語）",
              },
            },
            required: [
              "estimated_count",
              "min_count",
              "max_count",
              "crowd_label_jp",
              "reason",
            ],
          },
        },
      },
    });

    // Structured Outputs でも JSON 文字列が text として返ってくるのでパース
    const rawText =
      response.output?.[0]?.content?.[0]?.text ?? response.output_text ?? "";

    let parsed;
    try {
      parsed = rawText ? JSON.parse(rawText) : null;
    } catch (e) {
      // 万が一 JSON で返ってこなかった場合、デバッグ用に rawText を含めて返す
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