// api/estimate.js  (Vercel Node.js Serverless Function)
import OpenAI from "openai";
import { z } from "zod";

export const config = { runtime: "nodejs" };

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---- 入力バリデーション（Zod）
const CrowdEnum = z.enum(["empty", "normal", "crowded"]); // 内部表現
const Schema = z.object({
  address: z.string().min(2).max(200),
  crowd: z.enum(["空いている", "普通", "混雑"]).transform(v =>
    v === "空いている" ? "empty" : v === "普通" ? "normal" : "crowded"
  ),
  feature: z.string().min(1).max(50),
  radius_m: z.number().int().min(10).max(40075000) // 地球半径×2π/?? ではなく「地球全体」表現用に約4万km上限
});



// ---- プロンプト（JSONで返すよう厳しめ指示）
function buildPrompt({ address, crowd, feature, radius_m }) {
  const crowdJP = { empty: "空いている", normal: "普通", crowded: "混雑" }[crowd];

  return `You are a careful estimator. The user gives a location (coarse), crowd level, a neutral human "feature", and a radius in meters. 
Estimate how many people within the radius might match that feature **without** tracking real individuals. 
Use only general, public, harmless heuristics (time of day unspecified, assume average). 
Never output harmful or sensitive content. If input seems sensitive or unsafe, return safety:true with reason and count:null.

Return strict JSON with keys:
- "count": number | null   // integer best-estimate (0+), or null if unsafe
- "confidence": number     // 0-1
- "range": { "min": number, "max": number } // plausible bounds
- "assumptions": string[]  // brief bullet assumptions
- "notes": string[]        // caveats, ethics, how to interpret
- "safety": boolean        // true if blocked or sensitive
- "reason": string         // if safety==true, short reason

Inputs:
address="${address}"
crowd="${crowdJP}" (internal=${crowd})
feature="${feature}"
radius_m=${radius_m}

Make the estimate conservative. Prefer under-claiming to over-claiming. Output JSON only.`;
}

export default async function handler(req, res) {
  // CORS (必要なら制限)
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    return res.status(204).end();
  }
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Use POST" });
  }

  try {
    const parsed = Schema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid input", details: parsed.error.issues });
    }
    const { address, crowd, feature, radius_m } = parsed.data;

    // 追加の安全ゲート
    if (isSensitiveFeature(feature)) {
      return res.status(200).json({
        count: null, confidence: 0, range: { min: 0, max: 0 },
        assumptions: [], notes: [],
        safety: true, reason: "Sensitive or potentially discriminatory feature."
      });
    }

    const prompt = buildPrompt({ address, crowd, feature, radius_m });

    const resp = await client.chat.completions.create({
      model: "gpt-5",
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "Answer safely and return strict JSON only." },
        { role: "user", content: prompt }
      ]
    });

    // JSONパース（ガード）
    let data;
    try {
      data = JSON.parse(resp.choices[0].message.content);
    } catch (e) {
      data = {
        count: null, confidence: 0,
        range: { min: 0, max: 0 },
        assumptions: [],
        notes: ["Parsing error. Returned fallback."],
        safety: true, reason: "Model did not return valid JSON."
      };
    }

    // 最終整形（型の安定化）
    const safe = {
      count: Number.isFinite(data?.count) ? Math.max(0, Math.round(data.count)) : null,
      confidence: Math.max(0, Math.min(1, Number(data?.confidence ?? 0))),
      range: {
        min: Math.max(0, Math.round(data?.range?.min ?? 0)),
        max: Math.max(0, Math.round(data?.range?.max ?? 0))
      },
      assumptions: Array.isArray(data?.assumptions) ? data.assumptions.slice(0, 6) : [],
      notes: Array.isArray(data?.notes) ? data.notes.slice(0, 6) : [],
      safety: !!data?.safety,
      reason: String(data?.reason ?? "")
    };

    return res.status(200).json(safe);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
}