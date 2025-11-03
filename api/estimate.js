// api/estimate.js  (Vercel Node.js Serverless Function)
import OpenAI from "openai";
import { z } from "zod";

export const config = { runtime: "nodejs" };

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// --- タイムアウト（ms）: APIの返答を待つため延長
const TIMEOUT_MS = 30000;

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

// --- 入力を極力APIに流すためのゆるい正規化（safeParse失敗時に使用）
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
  return `You are an entertainment estimator.
Return strict JSON only with the shape:
{"count":number,"confidence":number,"range":{"min":number,"max":number},"assumptions":string[],"notes":string[]}

address="${address}"
crowd="${crowdJP}" (internal=${crowd})
feature="${feature}"
radius_m=${radius_m}

Keep it playful but plausible. JSON only.`;
}

// --- “最終整形” ユーティリティ（欠損を静かに補完）
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

// --- JSONレスキュー：```json フェンス → 最外 {…} 抽出 → 逐次パース
function tryParseJSON(content = "") {
  if (typeof content !== "string") return null;

  // ```json ... ``` ブロックを優先
  const fenced = content.match(/```json([\s\S]*?)```/i);
  if (fenced && fenced[1]) {
    try { return JSON.parse(fenced[1].trim()); } catch {}
  }

  // 最初の { から最後の } までを抽出して試す
  const first = content.indexOf("{");
  const last  = content.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) {
    const slice = content.slice(first, last + 1);
    try { return JSON.parse(slice); } catch {}
  }

  // そのまま
  try { return JSON.parse(content); } catch {}
  return null;
}

// --- 失敗時の最後の保険（“fallback” 文言は使わない）
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
    notes: ["Upstream result unavailable; provided a neutral estimate."]
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
    const incoming = { ...body, radius_m: body?.radius_m ?? body?.radius };

    // まず厳格に
    let parsed = Schema.safeParse(incoming);
    // 失敗しても API にできるだけ投げる（緩い補完で再構成）
    const input = parsed.success ? parsed.data : looseNormalize(incoming);

    // APIキー未設定 → それでも数値を返す（“fallback”文言なし）
    if (!process.env.OPENAI_API_KEY) {
      return res.status(200).json(neutralEstimate(input));
    }

    const prompt = buildPrompt(input);
    const messages = [
      { role: "system", content: "Return strict JSON only." },
      { role: "user", content: prompt }
    ];

    // タイムアウト制御 + 最大2回リトライ
    const execOnce = async (signal) => {
      const resp = await callOpenAIWithTimeout(messages, signal);
      const content = resp?.choices?.[0]?.message?.content ?? "";
      // まず通常パース（json_object指定の想定）
      let data = tryParseJSON(content);
      if (!data) {
        // モデルが余計な説明を返した場合でも拾う
        data = tryParseJSON(String(content));
      }
      if (!data) {
        // それでもダメなら最終保険（ただし“fallback”語は使わない）
        return neutralEstimate(input);
      }
      return normalizeResult(data);
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("timeout")), TIMEOUT_MS);
    try {
      const out1 = await execOnce(controller.signal);
      clearTimeout(timer);
      return res.status(200).json(out1);
    } catch (e1) {
      clearTimeout(timer);
      // タイムアウト/一時エラーはリトライ（別Signal）
      try {
        const out2 = await execOnce(undefined);
        return res.status(200).json(out2);
      } catch (e2) {
        // どうしても無理なら中立推定（“fallback”は書かない）
        return res.status(200).json(neutralEstimate(input));
      }
    }
  } catch (err) {
    console.error("Handler error:", err);
    // 予期しない例外でも 200 + 中立推定
    try {
      const b = req?.body || {};
      const r = Number(b?.radius_m ?? b?.radius ?? 500) || 500;
      const c = (b?.crowd === "混雑" || b?.crowd === "crowded") ? "crowded"
            : (b?.crowd === "普通" || b?.crowd === "normal") ? "normal" : "empty";
      return res.status(200).json(neutralEstimate({ radius_m: r, crowd: c, address: "", feature: "" }));
    } catch {
      return res.status(200).json(neutralEstimate({ radius_m: 500, crowd: "normal", address: "", feature: "" }));
    }
  }
}