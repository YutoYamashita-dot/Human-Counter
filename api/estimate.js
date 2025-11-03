// api/estimate.js  (Vercel Node.js Serverless Function)
import OpenAI from "openai";
import { z } from "zod";

export const config = { runtime: "nodejs" };

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---- 入力バリデーション（Zod）
const Schema = z.object({
  address: z.string().min(2).max(200),
  crowd: z.enum(["空いている", "普通", "混雑"]).transform(v =>
    v === "空いている" ? "empty" : v === "普通" ? "normal" : "crowded"
  ),
  feature: z.string().min(1).max(50),
  radius_m: z.number().int().min(10).max(40_075_000) // ~地球全周(40,075km)を上限
});

// ---- プロンプト
function buildPrompt({ address, crowd, feature, radius_m }) {
  const crowdJP = { empty: "空いている", normal: "普通", crowded: "混雑" }[crowd];
  return `You are a careful estimator. The user gives a location (coarse), crowd level, a neutral human "feature", and a radius in meters.
Estimate how many people within the radius might match that feature **without** tracking real individuals.
Use only general, public, harmless heuristics (time of day unspecified, assume average).
Never output harmful or sensitive content. If input seems sensitive or unsafe, return safety:true with reason and count:null.

Return strict JSON with keys:
- "count": number | null
- "confidence": number
- "range": { "min": number, "max": number }
- "assumptions": string[]
- "notes": string[]
- "safety": boolean
- "reason": string

Inputs:
address="${address}"
crowd="${crowdJP}" (internal=${crowd})
feature="${feature}"
radius_m=${radius_m}

Make the estimate conservative. Prefer under-claiming to over-claiming. Output JSON only.`;
}

// ---- 追加：センシティブ判定（既存前提）
function isSensitiveFeature(txt = "") {
  const t = String(txt).toLowerCase();
  // ここは適宜調整：属性・疾病・政治など個人特性に触れる可能性があるキーワードを網羅
  return /race|ethnicity|religion|sexual|gender identity|political|disease|medical|disability/.test(t);
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

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Use POST" });
  }

  try {
    // 1) ボディを安全にパース（文字列/オブジェクト両方に対応）
    let rawBody = req.body;
    if (typeof rawBody === "string") {
      try { rawBody = JSON.parse(rawBody || "{}"); }
      catch { rawBody = {}; }
    }
    if (rawBody == null || typeof rawBody !== "object") rawBody = {};

    // 2) radius / radius_m の両対応（どちらか来たら m に正規化）
    const normalized = {
      ...rawBody,
      radius_m: Number(
        rawBody?.radius_m ?? rawBody?.radius
      )
    };

    const parsed = Schema.safeParse(normalized);
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

    if (!process.env.OPENAI_API_KEY) {
      // OpenAIキー未設定でも 200 を返し、クライアントに安全通知
      return res.status(200).json({
        count: null, confidence: 0, range: { min: 0, max: 0 },
        assumptions: [], notes: ["Server missing OPENAI_API_KEY."],
        safety: true, reason: "Temporarily unavailable."
      });
    }

    const prompt = buildPrompt({ address, crowd, feature, radius_m });

    // 3) OpenAI 失敗時でも 200 で安全レスポンス（500を避ける）
    let data;
    try {
      const resp = await client.chat.completions.create({
        model: "gpt-5",
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: "Answer safely and return strict JSON only." },
          { role: "user", content: prompt }
        ]
      });

      try {
        data = JSON.parse(resp.choices[0].message.content);
      } catch {
        data = {
          count: null, confidence: 0,
          range: { min: 0, max: 0 },
          assumptions: [],
          notes: ["Parsing error. Returned fallback."],
          safety: true, reason: "Model did not return valid JSON."
        };
      }
    } catch (e) {
      console.error("OpenAI error:", e?.message || e);
      data = {
        count: null, confidence: 0,
        range: { min: 0, max: 0 },
        assumptions: [],
        notes: ["Upstream model error. Returned fallback."],
        safety: true, reason: "Upstream unavailable."
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
    console.error("Handler error:", err);
    // 最後の砦として 500 は残す（予期しない例外）
    return res.status(500).json({ error: "Server error" });
  }
}