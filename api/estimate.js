// api/estimate.js  (Vercel Node.js Serverless Function)
import OpenAI from "openai";
import { z } from "zod";

export const config = { runtime: "nodejs" };

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// --- タイムアウト（ms）
const TIMEOUT_MS = 6000;

const Schema = z.object({
  address: z.string().min(1).max(200),
  crowd: z.enum(["空いている", "普通", "混雑"]).transform(v =>
    v === "空いている" ? "empty" : v === "普通" ? "normal" : "crowded"
  ),
  feature: z.string().min(1).max(100),
  radius_m: z.number().int().min(10).max(40_075_000)
});

function buildPrompt({ address, crowd, feature, radius_m }) {
  const crowdJP = { empty: "空いている", normal: "普通", crowded: "混雑" }[crowd];
  return `You are a witty entertainment estimator. 
This is for a fun app — give lighthearted, imaginative, but numerically consistent responses.
Estimate roughly how many people within a radius might match the given feature.

Return JSON with:
{
 "count": number,
 "confidence": number (0-1),
 "range": {"min":number,"max":number},
 "assumptions": string[],
 "notes": string[]
}

address="${address}"
crowd="${crowdJP}"
feature="${feature}"
radius_m=${radius_m}

Be humorous and plausible, output strict JSON only.`;
}

// --- 失敗/タイムアウト時のフォールバック（超簡易ヒューリスティック）
function fallbackEstimate({ radius_m, crowd }) {
  // 半径[m]から面積[km^2]を概算 → 密度に crowd 係数
  const r_km = Math.max(0, radius_m) / 1000;
  const area = Math.PI * r_km * r_km;
  const crowdFactor = crowd === "crowded" ? 2 : crowd === "normal" ? 1.0 : 0.4;
  const baseDensity = 400; // 便宜的な基準人/km^2（エンタメ用途の仮数）
  const est = Math.max(0, Math.round(area * baseDensity * crowdFactor));
  const spread = Math.round(est * 0.4 + 20); // ざっくり±40%幅

  return {
    count: est,
    confidence: 0.35,
    range: { min: Math.max(0, est - spread), max: est + spread },
    assumptions: [
      "Fallback estimate (timeout).",
      "Uniform average density assumed.",
      `Crowd factor=${crowdFactor}`
    ],
    notes: ["Result returned without model due to timeout."]
  };
}

export default async function handler(req, res) {
  // CORS
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    return res.status(204).end();
  }
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

  try {
    // ボディ正規化
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch { body = {}; }
    }
    const normalized = {
      ...body,
      radius_m: Number(body?.radius_m ?? body?.radius)
    };
    const parsed = Schema.safeParse(normalized);
    if (!parsed.success)
      return res.status(400).json({ error: "Invalid input", details: parsed.error.issues });

    const { address, crowd, feature, radius_m } = parsed.data;

    // APIキー未設定 → 即フォールバック
    if (!process.env.OPENAI_API_KEY) {
      const fb = fallbackEstimate({ radius_m, crowd });
      return res.status(200).json(fb);
    }

    const prompt = buildPrompt({ address, crowd, feature, radius_m });

    // ---- タイムアウト制御（AbortController）
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(new Error("timeout")), TIMEOUT_MS);

    let data;
    try {
      const resp = await client.chat.completions.create({
        model: "gpt-5",
        // temperature: 1 (デフォルト) — このモデルは明示指定不可
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: "Return strict JSON only." },
          { role: "user", content: prompt }
        ],
        max_tokens: 300
      }, { signal: controller.signal }); // ← ここで中断可能
      clearTimeout(timeoutId);

      try {
        data = JSON.parse(resp.choices[0].message.content);
      } catch {
        data = { count: 0, confidence: 0, range: { min: 0, max: 0 }, assumptions: [], notes: ["Parse error fallback."] };
      }
      return res.status(200).json(data);
    } catch (e) {
      clearTimeout(timeoutId);
      // タイムアウト or 途中失敗 → フォールバックで 200
      const fb = fallbackEstimate({ radius_m, crowd });
      return res.status(200).json(fb);
    }
  } catch (err) {
    console.error("Handler error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}