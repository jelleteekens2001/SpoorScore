// Spoorquiz – tussenserver voor live NS-tijden (Cloudflare Worker)
//
// Wat het doet: je app vraagt hier de haltes en tijden van één trein op.
// De Worker vraagt die aan de NS API met jouw geheime sleutel en geeft
// een simpele lijst terug. De sleutel staat NIET in deze code, maar in de
// Worker-instellingen als geheime variabele met de naam NS_KEY.
//
// Gebruik:
//   /journey?train=3541          haltes en tijden van één trein
//   /nearby?lat=52.09&lng=5.11   treinen in de buurt van een locatie
//   /vehicles?raw=1              controle: wat de Virtual Train API terugstuurt
// Ruw NS-antwoord bekijken bij /journey:  ...&raw=1

const ALLOWED_ORIGINS = [
  "https://jelleteekens2001.github.io",
  "http://localhost:8000",
];

const NS_JOURNEY_URL =
  "https://gateway.apiportal.ns.nl/reisinformatie-api/api/v2/journey";

// Mogelijke adressen van de Virtual Train API voor alle treinposities.
// De eerste die werkt wordt gebruikt. Je kunt er ook zelf één vastzetten
// met een (gewone, niet-geheime) variabele VT_PATH in de Worker-instellingen.
const VT_BASE = "https://gateway.apiportal.ns.nl";
const VT_PATHS = [
  "/virtual-train-api/api/vehicle",
  "/virtual-train-api/v1/vehicle",
  "/virtual-train-api/api/v1/vehicle",
  "/virtual-train-api/v1/vehicles",
];

function haversineM(aLat, aLng, bLat, bLng) {
  const r = Math.PI / 180, R = 6371000;
  const dLa = (bLat - aLat) * r, dLo = (bLng - aLng) * r;
  const x = Math.sin(dLa / 2) ** 2 + Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

// Zoekt in het antwoord de eerste lijst met objecten die een positie hebben,
// en zet de velden om naar vaste namen. Zo werkt het ook als NS veldnamen anders noemt.
function extractVehicles(data) {
  const pick = (o, keys) => { for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k]; return undefined; };
  const hasPos = (o) => o && typeof o === "object" && pick(o, ["lat", "latitude", "breedtegraad"]) !== undefined && pick(o, ["lng", "lon", "longitude", "lengtegraad"]) !== undefined;
  const queue = [data];
  while (queue.length) {
    const v = queue.shift();
    if (Array.isArray(v)) {
      if (v.length && hasPos(v[0])) {
        return v.filter(hasPos).map((o) => {
          const nr = pick(o, ["treinNummer", "ritId", "ritnummer", "ritNummer", "trainNumber", "journeyNumber", "number"]);
          return {
            train: nr === undefined ? null : String(nr).replace(/\D/g, "") || null,
            lat: +pick(o, ["lat", "latitude", "breedtegraad"]),
            lng: +pick(o, ["lng", "lon", "longitude", "lengtegraad"]),
            speed: pick(o, ["snelheid", "speed"]) ?? null,
            dir: pick(o, ["richting", "direction", "heading", "koers"]) ?? null,
            type: pick(o, ["type", "treinType", "category"]) ?? null,
          };
        });
      }
      queue.push(...v);
    } else if (v && typeof v === "object") {
      queue.push(...Object.values(v));
    }
  }
  return [];
}

async function getVehicles(env) {
  const paths = env.VT_PATH ? [env.VT_PATH] : VT_PATHS;
  const tried = [];
  for (const p of paths) {
    let res;
    try {
      res = await fetch(VT_BASE + p, {
        headers: { "Ocp-Apim-Subscription-Key": env.NS_KEY },
        cf: { cacheTtl: 15, cacheEverything: true },
      });
    } catch { tried.push(`${p}: geen verbinding`); continue; }
    if (!res.ok) { tried.push(`${p}: status ${res.status}`); continue; }
    const raw = await res.json().catch(() => null);
    const list = extractVehicles(raw);
    if (list.length) return { path: p, list, raw };
    tried.push(`${p}: geen posities gevonden`);
  }
  return { error: "Geen treinposities gevonden. Geprobeerd: " + tried.join("; ") };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const cors = {
      "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Vary": "Origin",
    };
    const json = (body, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { ...cors, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
      });

    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    if (!env.NS_KEY) return json({ error: "De Worker mist de geheime variabele NS_KEY." }, 500);

    if (url.pathname === "/vehicles") {
      const v = await getVehicles(env);
      if (v.error) return json(v, 502);
      return json({ path: v.path, count: v.list.length, sample: v.list.slice(0, 3), ...(url.searchParams.has("raw") ? { rawStart: JSON.stringify(v.raw).slice(0, 3000) } : {}) });
    }

    if (url.pathname === "/nearby") {
      const lat = parseFloat(url.searchParams.get("lat")), lng = parseFloat(url.searchParams.get("lng"));
      if (!(lat > 50 && lat < 54 && lng > 2.5 && lng < 7.5)) return json({ error: "Geef een locatie in Nederland mee (lat en lng)." }, 400);
      const v = await getVehicles(env);
      if (v.error) return json(v, 502);
      const candidates = v.list
        .filter((t) => t.train)
        .map((t) => ({ train: t.train, type: t.type, speed: t.speed, dir: t.dir, distM: Math.round(haversineM(lat, lng, t.lat, t.lng)) }))
        .filter((t) => t.distM < 5000)
        .sort((a, b) => a.distM - b.distM)
        .slice(0, 5);
      return json({ candidates });
    }

    if (url.pathname !== "/journey") return json({ error: "Onbekend adres. Gebruik /journey, /nearby of /vehicles." }, 404);

    const train = url.searchParams.get("train") || "";
    if (!/^\d{1,6}$/.test(train)) return json({ error: "Geef een geldig treinnummer (alleen cijfers)." }, 400);

    let res;
    try {
      res = await fetch(`${NS_JOURNEY_URL}?train=${train}`, {
        headers: { "Ocp-Apim-Subscription-Key": env.NS_KEY },
        cf: { cacheTtl: 30, cacheEverything: true },
      });
    } catch {
      return json({ error: "NS is niet bereikbaar." }, 502);
    }
    if (res.status === 401 || res.status === 403) return json({ error: "NS weigert de sleutel. Controleer NS_KEY en je abonnement." }, 502);
    if (res.status === 404) return json({ error: `Trein ${train} niet gevonden.` }, 404);
    if (!res.ok) return json({ error: `NS gaf status ${res.status}.` }, 502);

    const data = await res.json();
    if (url.searchParams.has("raw")) return json(data);

    // NS-tijden zoals "2026-10-15T21:04:00+0200" omzetten naar "…+02:00",
    // zodat alle browsers (ook Safari op iPhone) ze kunnen lezen.
    const t = (v) => (typeof v === "string" ? v.replace(/([+-]\d\d)(\d\d)$/, "$1:$2") : null);

    const stops = (data?.payload?.stops || []).map((s) => {
      const a = (s.arrivals && s.arrivals[0]) || {};
      const d = (s.departures && s.departures[0]) || {};
      const delaySec = a.delayInSeconds ?? d.delayInSeconds ?? 0;
      return {
        name: s.stop?.name ?? null,
        lat: s.stop?.lat ?? null,
        lng: s.stop?.lng ?? null,
        passing: s.status === "PASSING",
        arrPlanned: t(a.plannedTime),
        arrActual: t(a.actualTime || a.plannedTime),
        depPlanned: t(d.plannedTime),
        depActual: t(d.actualTime || d.plannedTime),
        delayMin: Math.round(delaySec / 60),
        cancelled: !!(a.cancelled || d.cancelled),
      };
    });

    return json({ train, fetchedAt: new Date().toISOString(), stops });
  },
};
