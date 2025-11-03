// /api/geocode.js
export const config = { runtime: "nodejs" };

export default async function handler(req, res) {
  try {
    const { address } = (typeof req.body === "string" ? JSON.parse(req.body) : req.body) || {};
    if (!address) return res.status(400).json({ error: "address required" });

    const key = process.env.GEOCODING_API_KEY;            // ← サーバー用キー
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${key}`;

    const r = await fetch(url);
    const json = await r.json();
    const loc = json?.results?.[0]?.geometry?.location;
    if (!loc) return res.status(404).json({ error: "not found" });

    res.status(200).json({ lat: loc.lat, lng: loc.lng });
  } catch (e) {
    res.status(500).json({ error: "server error" });
  }
}