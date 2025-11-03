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

// --- 言語判定（変更なし） ---
function hasJapanese(s = "") {
  return /[\u3040-\u30FF\u4E00-\u9FFF]/.test(String(s));
}
function detectTargetLang(req, body, input) {
  // 優先度: 明示指定 > ヘッダー > 入力文字種 > 既定
  const explicit = (body?.lang || body?.ui_lang || body?.locale || "").toString().toLowerCase();
  if (explicit === "ja" || explicit === "en") return explicit;

  const h = (req.headers?.["x-ui-lang"] || req.headers?.["accept-language"] || "").toString().toLowerCase();
  if (h.startsWith("ja")) return "ja";
  if (h.startsWith("en")) return "en";

  if (hasJapanese(body?.crowd) || hasJapanese(body?.feature) || hasJapanese(body?.address)) return "ja";
  if (hasJapanese(input?.address) || hasJapanese(input?.feature)) return "ja";

  return "en";
}

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

// --- ★ 国籍フィルタの自動判定（追加） ---
// 「feature」に国籍を示す語が含まれる場合のみ絞り込み、それ以外は "all"（国籍で絞らない）
function detectNationalityFilter(feature = "") {
  const s = String(feature).toLowerCase();
  if (/(non[-\s]?japanese|foreigner|foreigners|外国人)/.test(s)) return "foreigner_only";
  if (/(japanese( people)?|日本人)/.test(s)) return "japanese_only";
  return "all";
}

// --- プロンプト（言語対応 & 英語入力でも“全員”を数える） ---
function buildPrompt({ address, crowd, feature, radius_m }, targetLang = "en", nationalityFilter = "all") {
  // crowd は internal ("empty" | "normal" | "crowded") をそのまま使う
  // assumptions / notes は targetLang で。JSONキーは固定・数値は実数。
  // ★ 重要ルールに「国籍で絞らない（all）」を明記。明示指定がある場合のみ絞り込み。
  return `You are a strict estimator. Output ONLY JSON, no prose.

JSON schema (keys and types are fixed):
{"count":number,"confidence":number,"range":{"min":number,"max":number},"assumptions":string[],"notes":string[]}

Rules:
- Count PEOPLE within the radius based on the "feature".
- Nationality rule:
  - If nationality_filter is "all", include everyone (Japanese and non-Japanese). DO NOT restrict by nationality.
  - If "japanese_only", include Japanese people only.
  - If "foreigner_only", include non-Japanese (foreigners) only.
- Do NOT infer nationality from input language. English input does NOT imply "foreigner".
- "crowd" is one of: "empty", "normal", "crowded" (no synonyms).
- "assumptions" and "notes" MUST be written in "${targetLang}".
- "confidence" is 0..1 float.
- Respond with JSON only.
- Use the inputs as-is. Do NOT translate "feature".

Inputs:
address=${JSON.stringify(address)}
crowd=${JSON.stringify(crowd)}  // internal code
feature=${JSON.stringify(feature)}
radius_m=${radius_m}
nationality_filter=${JSON.stringify(nationalityFilter)}
`;
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

  // 1回目: max_output_tokens を優先（xAI推奨） ★ 温度を下げて安定化
  const body1 = {
    model: XAI_MODEL,
    messages,
    temperature: 0.3,
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
        temperature: 0.3,
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
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-UI-Lang");
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

    // 返答言語の決定（ja/en）
    const targetLang = detectTargetLang(req, body, input);
    console.log("[estimate] targetLang:", targetLang);

    // ★ 国籍フィルタを判定（既定は all = 国籍で絞らない）
    const nationalityFilter = detectNationalityFilter(input.feature);
    console.log("[estimate] nationalityFilter:", nationalityFilter);

    // APIキー未設定でも 200 で中立推定（notes/assumptionsは言語切替）
    if (!process.env.XAI_API_KEY) {
      console.warn("[estimate] missing XAI_API_KEY");
      const neutral = neutralEstimate(input);
      if (targetLang === "ja") {
        neutral.assumptions = ["ヒューリスティック推定を使用。"];
        neutral.notes = ["中立推定（API未使用）。"];
      }
      return res.status(200).json(neutral);
    }

    const prompt = buildPrompt(input, targetLang, nationalityFilter);
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
        const n = neutralEstimate(input);
        if (targetLang === "ja") {
          n.assumptions = ["ヒューリスティック推定を使用。"];
          n.notes = ["中立推定（API未使用）。"];
        }
        return n;
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
        if (targetLang === "ja") {
          neutral.assumptions = ["ヒューリスティック推定を使用。"];
          neutral.notes = ["中立推定（API未使用）。"];
        }
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
    const targetLang = (b?.lang || b?.ui_lang || "").toString().toLowerCase().startsWith("ja")
      || hasJapanese(b?.feature) || hasJapanese(b?.address) ? "ja" : "en";
    if (targetLang === "ja") {
      neutral.assumptions = ["ヒューリスティック推定を使用。"];
      neutral.notes = ["中立推定（API未使用）。"];
    }
    console.log("[estimate] emergency neutral:", neutral);
    return res.status(200).json(neutral);
  }
}