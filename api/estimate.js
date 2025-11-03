// api/estimate.js  (Vercel Node.js Serverless Function)
import OpenAI from "openai";
import { z } from "zod";

export const config = { runtime: "nodejs" };

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    return res.status(204).end();
  }
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

  try {
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
    if (!process.env.OPENAI_API_KEY)
      return res.status(200).json({ count: 0, confidence: 0, range: {min:0,max:0}, assumptions: [], notes: [] });

    const prompt = buildPrompt({ address, crowd, feature, radius_m });
    const resp = await client.chat.completions.create({
      model: "gpt-5",
      temperature: 0.4,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "Return strict JSON only." },
        { role: "user", content: prompt }
      ]
    });

    let data;
    try { data = JSON.parse(resp.choices[0].message.content); }
    catch {
      data = { count: 0, confidence: 0, range: { min: 0, max: 0 }, assumptions: [], notes: ["Parse error fallback."] };
    }

    return res.status(200).json(data);
  } catch (err) {
    console.error("Handler error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}