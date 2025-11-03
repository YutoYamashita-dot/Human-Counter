// api/estimate.js  (Vercel Node.js Serverless Function)
import { z } from "zod";

export const config = { runtime: "nodejs" };

// xAI API エンドポイント＆モデル
const XAI_URL = "https://api.x.ai/v1/chat/completions";
const XAI_MODEL = "grok-4-fast-reasoning"; // 例: grok-2-latest / grok-2-mini 等
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
  return `You are an strict estimator.
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

// --- xAI呼び出し（JSONパラメータ差異にフォールバック対応・詳細ログ付き）
async function callXAIWithTimeout(messages, signal) {
  if (!process.env.XAI_API_KEY) throw new Error("Missing XAI_API_KEY");
  const headers = {
    "Authorization": `Bearer ${process.env.XAI_API_KEY}`,
    "Content-Type": "application/json"
  };

  // 1回目: max_output_tokens を優先（xAI推奨）
  const body1 = {
    model: XAI_MODEL,
    messages,
    temperature: 1,
    max_output_tokens: 400
  };
  console.log("[estimate] calling xAI (max_output_tokens)...");
  let resp = await fetch(XAI_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(body1),
    signal
  });

  // もし xAI 側がパラメータ非対応で 400 を返したら max_tokens に切替
  if (!resp.ok) {
    const txt = await resp.text();
    console.error("[estimate] xAI first call error:", txt);
    if (resp.status === 400 && /max_output_tokens/i.test(txt)) {
      const body2 = {
        model: XAI_MODEL,
        messages,
        temperature: 1,
        max_tokens: 400
      };
      console.log("[estimate] retry xAI (max_tokens)...");
      resp = await fetch(XAI_URL, {
        method: "POST",
        headers,
        body: JSON.stringify(body2),
        signal
      });
    }
  }

  const json = await resp.json().catch(() => ({}));
  console.log("[estimate] raw xAI response:", JSON.stringify(json)?.slice(0, 800));
  if (!resp.ok) {
    const msg = json?.error?.message || `xAI error: ${resp.status}`;
    throw new Error(msg);
  }
  return json;
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

    // APIキー未設定でも 200 で中立推定
    if (!process.env.XAI_API_KEY) {
      console.warn("[estimate] missing XAI_API_KEY");
      return res.status(200).json(neutralEstimate(input));
    }

    const prompt = buildPrompt(input);
    console.log("[estimate] prompt:", prompt);
    const messages = [
      { role: "system", content: "Return JSON only." },
      { role: "user", content: prompt }
    ];

    const execOnce = async (signal) => {
      const xres = await callXAIWithTimeout(messages, signal);
      const content = xres?.choices?.[0]?.message?.content ?? "";
      console.log("[estimate] content:", content);
      let data = tryParseJSON(content);
      console.log("[estimate] parsed data:", data);
      if (!data) data = tryParseJSON(String(content));
      if (!data) {
        console.warn("[estimate] parse failed, neutral estimate used");
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