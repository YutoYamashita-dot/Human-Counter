// api/estimate.js  (Vercel Node.js Serverless Function)
import OpenAI from "openai";
import { z } from "zod";

export const config = { runtime: "nodejs" };

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// --- タイムアウト（ms）
const TIMEOUT_MS = 20000;

// --- 寛容な入力バリデーション（coerce・許容範囲拡大・両表記対応）
const CrowdJp = z.enum(["空いている", "普通", "混雑"]);
const CrowdInternal = z.enum(["empty", "normal", "crowded"]);

const Schema = z.object({
  address: z.string().transform(s => (s ?? "").toString().trim()).pipe(z.string().min(1).max(300)),
  crowd: z.union([CrowdJp, CrowdInternal])
    .transform(v => (v === "空いている" ? "empty" : v === "普通" ? "normal" : v === "混雑" ? "crowded" : v)),
  feature: z.string().transform(s => (s ?? "").toString().trim()).pipe(z.string().min(1).max(140)),
  // radius or radius_m どちらでも可・文字→数値変換を許可
  radius_m: z.coerce.number().int().min(10).max(40_075_000)
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

// --- 失敗時のフォールバック（“timeout”などは表示しない）
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
    notes: ["Returned fallback due to upstream/validation issues."]
  };
}

async function callOpenAIWithTimeout(messages, signal) {
  const resp = await client.chat.completions.create({
    model: "gpt-5",
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
    // ボディ正規化（文字/オブジェクト両対応・radiusエイリアス対応）
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch { body = {}; }
    }
    if (!body || typeof body !== "object") body = {};
    const normalized = {
      ...body,
      radius_m: body?.radius_m ?? body?.radius // どちらでもOK
    };

    // safeParse（失敗しても 200 でフォールバック）
    const parsed = Schema.safeParse(normalized);
    if (!parsed.success) {
      console.warn("Validation failed:", parsed.error.issues);
      // address/feature が未入力等の時も、必ず 200 で返す
      const coerceCrowd =
        normalized?.crowd === "混雑" || normalized?.crowd === "crowded" ? "crowded" :
        normalized?.crowd === "普通" || normalized?.crowd === "normal" ? "normal" : "empty";
      const coerceRadius = Number(normalized?.radius_m ?? 500) || 500;
      return res.status(200).json(fallbackEstimate({ radius_m: coerceRadius, crowd: coerceCrowd }));
    }

    const { address, crowd, feature, radius_m } = parsed.data;

    if (!process.env.OPENAI_API_KEY) {
      return res.status(200).json(fallbackEstimate({ radius_m, crowd }));
    }

    const prompt = buildPrompt({ address, crowd, feature, radius_m });
    const messages = [
      { role: "system", content: "Return strict JSON only." },
      { role: "user", content: prompt }
    ];

    // タイムアウト制御 + 1回リトライ
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("timeout")), TIMEOUT_MS);
    try {
      const resp = await callOpenAIWithTimeout(messages, controller.signal);
      clearTimeout(timer);
      let data;
      try { data = JSON.parse(resp.choices[0].message.content); }
      catch { data = fallbackEstimate({ radius_m, crowd }); }
      return res.status(200).json(data);
    } catch (e) {
      clearTimeout(timer);
      // リトライ
      try {
        const resp2 = await callOpenAIWithTimeout(messages, undefined);
        let data2;
        try { data2 = JSON.parse(resp2.choices[0].message.content); }
        catch { data2 = fallbackEstimate({ radius_m, crowd }); }
        return res.status(200).json(data2);
      } catch {
        return res.status(200).json(fallbackEstimate({ radius_m, crowd }));
      }
    }
  } catch (err) {
    console.error("Handler error:", err);
    // 予期しない例外でも 200 + フォールバック
    try {
      const b = req?.body || {};
      const r = Number(b?.radius_m ?? b?.radius ?? 500) || 500;
      const c = (b?.crowd === "混雑" || b?.crowd === "crowded") ? "crowded"
            : (b?.crowd === "普通" || b?.crowd === "normal") ? "normal" : "empty";
      return res.status(200).json(fallbackEstimate({ radius_m: r, crowd: c }));
    } catch {
      return res.status(200).json(fallbackEstimate({ radius_m: 500, crowd: "normal" }));
    }
  }
}
