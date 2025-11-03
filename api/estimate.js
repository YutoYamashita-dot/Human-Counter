// api/estimate.js  (Vercel Node.js Serverless Function)
import OpenAI from "openai";
import { z } from "zod";

export const config = { runtime: "nodejs" };

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// --- タイムアウト（ms）: 20秒に延長
const TIMEOUT_MS = 20000;

// --- 入力バリデーション
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

// --- 失敗時のフォールバック（“timeout”文言は出さない）
function fallbackEstimate({ radius_m, crowd }) {
  const r_km = Math.max(0, radius_m) / 1000;
  const area = Math.PI * r_km * r_km;
  const crowdFactor = crowd === "crowded" ? 1.8 : crowd === "normal" ? 1.0 : 0.5;
  const baseDensity = 400;
  const est = Math.max(0, Math.round(area * baseDensity * crowdFactor));
  const spread = Math.round(est * 0.4 + 20);
  return {
    count: est,
    confidence: 0.35,
    range: { min: Math.max(0, est - spread), max: est + spread },
    assumptions: [
      "Heuristic fallback estimate.",
      "Uniform average density assumed.",
      `Crowd factor=${crowdFactor}`
    ],
    notes: ["Returned fallback due to upstream unavailability."]
  };
}

async function callOpenAIWithTimeout(messages, signal) {
  const resp = await client.chat.completions.create({
    model: "gpt-5",
    // temperature: 1 (デフォルト。明示指定不可モデルのため指定しない)
    response_format: { type: "json_object" },
    messages,
    max_tokens: 300
  }, { signal });
  return resp;
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
      return res.status(200).json(fallbackEstimate({ radius_m, crowd }));
    }

    const prompt = buildPrompt({ address, crowd, feature, radius_m });
    const messages = [
      { role: "system", content: "Return strict JSON only." },
      { role: "user", content: prompt }
    ];

    // ---- AbortController でハードタイムアウト
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("timeout")), TIMEOUT_MS);

    try {
      // 1回目
      const resp = await callOpenAIWithTimeout(messages, controller.signal);
      clearTimeout(timer);
      let data;
      try {
        data = JSON.parse(resp.choices[0].message.content);
      } catch {
        data = { count: 0, confidence: 0, range: { min: 0, max: 0 }, assumptions: [], notes: ["Parse error fallback."] };
      }
      return res.status(200).json(data);
    } catch (e) {
      clearTimeout(timer);

      // タイムアウトなら 1 回だけリトライ（少し長めの猶予）
      const isAbort = (e?.name === "AbortError") || String(e?.message || "").includes("timeout");
      if (isAbort) {
        const controller2 = new AbortController();
        const timer2 = setTimeout(() => controller2.abort(new Error("timeout")), TIMEOUT_MS);
        try {
          const resp2 = await callOpenAIWithTimeout(messages, controller2.signal);
          clearTimeout(timer2);
          let data2;
          try {
            data2 = JSON.parse(resp2.choices[0].message.content);
          } catch {
            data2 = { count: 0, confidence: 0, range: { min: 0, max: 0 }, assumptions: [], notes: ["Parse error fallback."] };
          }
          return res.status(200).json(data2);
        } catch {
          clearTimeout(timer2);
          return res.status(200).json(fallbackEstimate({ radius_m, crowd }));
        }
      }

      // タイムアウト以外の一時エラーは 1 回だけリトライ
      try {
        const resp3 = await callOpenAIWithTimeout(messages, undefined);
        let data3;
        try {
          data3 = JSON.parse(resp3.choices[0].message.content);
        } catch {
          data3 = { count: 0, confidence: 0, range: { min: 0, max: 0 }, assumptions: [], notes: ["Parse error fallback."] };
        }
        return res.status(200).json(data3);
      } catch {
        return res.status(200).json(fallbackEstimate({ radius_m, crowd }));
      }
    }
  } catch (err) {
    console.error("Handler error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}