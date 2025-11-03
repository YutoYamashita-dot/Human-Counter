// api/estimate.js  (Vercel Node.js Serverless Function)
import { z } from "zod";

export const config = { runtime: "nodejs" };

// ChatGPT API エンドポイント
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const TIMEOUT_MS = 30000;

// --- スキーマ定義（変更なし） ---
const CrowdJp = z.enum(["空いている", "普通", "混雑"]);
const CrowdInternal = z.enum(["empty", "normal", "crowded"]);

const Schema = z.object({
  address: z.string().transform(s => (s ?? "").toString().trim()).pipe(z.string().min(1).max(300)),
  crowd: z.union([CrowdJp, CrowdInternal])
    .transform(v => (v === "空いている" ? "empty" : v === "普通" ? "normal" : v === "混雑" ? "crowded" : v)),
  feature: z.string().transform(s => (s ?? "").toString().trim()).pipe(z.string().min(1).max(140)),
  radius_m: z.coerce.number().int().min(10).max(40_075_000)
});

function looseNormalize(input = {}) {
  const addr = String(input?.address ?? "").trim() || "unknown";
  const c = input?.crowd;
  const crowd =
    c === "混雑" || c === "crowded" ? "crowded" :
    c === "普通" || c === "normal"   ? "normal"  :
    "empty";
  const feature = String(input?.feature ?? "").trim() || "people";
  const r = Number(input?.radius_m ?? input?.radius ?? 500);
  const radius_m = Number.isFinite(r) ? Math.round(Math.max(10, Math.min(r, 40_075_000))) : 500;
  return { address: addr, crowd, feature, radius_m };
}

function buildPrompt({ address, crowd, feature, radius_m }) {
  const crowdJP = { empty: "空いている", normal: "普通", crowded: "混雑" }[crowd];
  return `You are a strict estimator.
Output ONLY valid JSON with this structure:
{"count":number,"confidence":number,"range":{"min":number,"max":number},"assumptions":string[],"notes":string[]}

address="${address}"
crowd="${crowdJP}" (internal=${crowd})
feature="${feature}"
radius_m=${radius_m}

JSON only.`;
}

function normalizeResult(data) {
  const num = (v, d=0) => (Number.isFinite(Number(v)) ? Number(v) : d);
  const clamp = (v,min,max)=>Math.max(min,Math.min(max,v));
  const count = num(data?.count, 0);
  const conf  = clamp(num(data?.confidence, 0.6), 0, 1);
  const rmin = num(data?.range?.min, Math.max(0, Math.round(count * 0.7)));
  const rmax = num(data?.range?.max, Math.max(rmin, Math.round(count * 1.4)));
  const assumptions = Array.isArray(data?.assumptions) ? data.assumptions.slice(0, 8) : [];
  const notes       = Array.isArray(data?.notes)       ? data.notes.slice(0, 8)       : [];
  return {
    count: Math.max(0, Math.round(count)),
    confidence: conf,
    range: { min: Math.max(0, Math.round(rmin)), max: Math.max(0, Math.round(rmax)) },
    assumptions,
    notes
  };
}

function tryParseJSON(content = "") {
  if (typeof content !== "string") return null;
  const fenced = content.match(/```json([\s\S]*?)```/i);
  if (fenced && fenced[1]) {
    try { return JSON.parse(fenced[1].trim()); } catch {}
  }
  const first = content.indexOf("{");
  const last  = content.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) {
    const slice = content.slice(first, last + 1);
    try { return JSON.parse(slice); } catch {}
  }
  try { return JSON.parse(content); } catch {}
  return null;
}

function neutralEstimate({ radius_m, crowd }) {
  const r_km = Math.max(0, radius_m) / 1000;
  const area = Math.PI * r_km * r_km;
  const crowdFactor = crowd === "crowded" ? 1.8 : crowd === "normal" ? 1.0 : 0.5;
  const baseDensity = 400;
  const est = Math.max(0, Math.round(area * baseDensity * crowdFactor));
  const spread = Math.round(est * 0.35 + 15);
  return {
    count: est,
    confidence: 0.55,
    range: { min: Math.max(0, est - spread), max: est + spread },
    assumptions: ["Heuristic estimate used."],
    notes: ["Neutral estimate (no API value)."]
  };
}

// --- ChatGPT呼び出し：モデル強制＆多段フォールバック（gpt-4o-mini → gpt-4o × RFあり/なし）
async function callChatGPTWithTimeout(messages, signal) {
  if (!process.env.OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");
  const headers = {
    "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
    "Content-Type": "application/json"
  };

  // 試行バリエーション（順に試す）
  const variants = [
    { model: "gpt-5", withRF: true  },
    { model: "gpt-5", withRF: false },
    { model: "gpt-4o-mini", withRF: true  },
    { model: "gpt-4o-mini", withRF: false }
  ];

  let lastJson = null;
  for (const v of variants) {
    const body = {
      model: v.model,
      messages,
      temperature: 1,
      max_completion_tokens: 400,
      ...(v.withRF ? { response_format: { type: "json_object" } } : {})
    };
    console.log(`[estimate] calling ChatGPT (${v.model}, RF=${v.withRF})...`);

    const resp = await fetch(OPENAI_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal
    });

    const json = await resp.json().catch(() => ({}));
    lastJson = json;
    console.log("[estimate] raw ChatGPT response:", JSON.stringify(json)?.slice(0, 800));

    // HTTPエラー → 次バリアントへ
    if (!resp.ok) {
      console.error("[estimate] ChatGPT error:", json?.error?.message || resp.status);
      continue;
    }

    const content = json?.choices?.[0]?.message?.content ?? "";
    console.log("[estimate] content:", content);
    if (typeof content === "string" && content.trim().length > 0) {
      return content; // ここで content を返す（上位でJSON化）
    }

    // content 空 → 次のバリアント
    console.warn("[estimate] empty content, trying next variant...");
  }

  // 全部ダメなら null を返す（上位で中立推定へ）
  console.warn("[estimate] all variants failed; returning null");
  return null;
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
    // 入力整形
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch { body = {}; }
    }
    if (!body || typeof body !== "object") body = {};
    const incoming = { ...body, radius_m: body?.radius_m ?? body?.radius };

    let parsed = Schema.safeParse(incoming);
    const input = parsed.success ? parsed.data : looseNormalize(incoming);
    console.log("[estimate] input:", input);

    if (!process.env.OPENAI_API_KEY) {
      console.warn("[estimate] missing OPENAI_API_KEY");
      return res.status(200).json(neutralEstimate(input));
    }

    const prompt = buildPrompt(input);
    console.log("[estimate] prompt:", prompt);
    const messages = [
      { role: "system", content: "Return JSON only." },
      { role: "user", content: prompt }
    ];

    const execOnce = async (signal) => {
      const content = await callChatGPTWithTimeout(messages, signal);
      let data = content ? tryParseJSON(content) : null;
      console.log("[estimate] parsed data:", data);
      if (!data) {
        console.warn("[estimate] parse failed or empty content, neutral estimate used");
        return neutralEstimate(input);
      }
      const normalized = normalizeResult(data);
      console.log("[estimate] normalized result:", normalized);
      return normalized;
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("timeout")), TIMEOUT_MS);
    try {
      const out1 = await execOnce(controller.signal);
      clearTimeout(timer);
      console.log("[estimate] final result:", out1);
      return res.status(200).json(out1);
    } catch (e1) {
      clearTimeout(timer);
      console.error("[estimate] first try error:", e1);
      try {
        const out2 = await execOnce(undefined);
        console.log("[estimate] retry result:", out2);
        return res.status(200).json(out2);
      } catch (e2) {
        console.error("[estimate] retry error:", e2);
        const neutral = neutralEstimate(input);
        console.log("[estimate] final neutral result:", neutral);
        return res.status(200).json(neutral);
      }
    }
  } catch (err) {
    console.error("[estimate] handler fatal:", err);
    const b = req?.body || {};
    const r = Number(b?.radius_m ?? b?.radius ?? 500) || 500;
    const c = (b?.crowd === "混雑" || b?.crowd === "crowded") ? "crowded"
          : (b?.crowd === "普通" || b?.crowd === "normal") ? "normal" : "empty";
    const neutral = neutralEstimate({ radius_m: r, crowd: c });
    console.log("[estimate] emergency neutral:", neutral);
    return res.status(200).json(neutral);
  }
}