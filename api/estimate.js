// api/estimate.js
// Vercel Node.js (ESM)。人の特徴・場所情報から人数推定。
// Chat Completions API(gpt-5-mini) + max_completion_tokens 使用。

export const config = { runtime: "nodejs" };

import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5-mini";

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
      max_completion_tokens
    } = body;

    const inputForModel = {
      address: address || "",
      radius_m: typeof radius_m === "number" ? radius_m : null,
      local_time_iso: local_time_iso || null,
      place_type: place_type || null,
      features: features || "",
      crowd_level: crowd_level || null,
    };

    const DEFAULT_MAX = 400;
    const maxTokens =
      typeof max_completion_tokens === "number"
        ? max_completion_tokens
        : DEFAULT_MAX;

    const systemPrompt = `
あなたは場所情報から人数を推定するアシスタントです。
必ず次の JSON だけ返してください：

{
  "estimated_count": number,
  "min_count": number,
  "max_count": number,
  "crowd_label_jp": string,
  "reason": string
}

他の説明文やコードブロックは禁止です。`;

    const userPrompt =
      "下記データを使って人数推定を行い、指定の JSON のみ返してください：\n" +
      JSON.stringify(inputForModel, null, 2);

    const completion = await client.chat.completions.create({
      model: OPENAI_MODEL,
      temperature: 1,
      max_completion_tokens: maxTokens,
      messages: [
        { role: "system", content: systemPrompt.trim() },
        { role: "user", content: userPrompt },
      ],
    });

    const raw = completion.choices?.[0]?.message?.content?.trim() || "";
    let parsed;

    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      parsed = null;
    }

    const est = Number(parsed?.estimated_count) || 0;
    const min = Number(parsed?.min_count) || est;
    const max = Number(parsed?.max_count) || est;

    const responsePayload = {
      // ★新規追加：フロント要求
      range: max - min,

      confidence:
        max > min
          ? Math.max(
              0.1,
              Math.min(0.99, 1 - (max - min) / (max + 1))
            )
          : 0.7,

      estimated_count: est,
      min_count: min,
      max_count: max,
      crowd_label_jp: parsed?.crowd_label_jp || "",
      reason: parsed?.reason || "",
    };

    return res.status(200).json(responsePayload);

  } catch (err) {
    console.error("[estimate] error", err);

    return res.status(200).json({
      // ★失敗時も必須フィールド必ず返す
      range: 0,
      confidence: 0.0,
      estimated_count: 0,
      min_count: 0,
      max_count: 0,
      crowd_label_jp: "",
      reason: err?.message || "Internal Error",
    });
  }
}