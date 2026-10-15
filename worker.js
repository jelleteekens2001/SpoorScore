// Spoorquiz – tussenserver voor live NS-tijden (Cloudflare Worker)
//
// Wat het doet: je app vraagt hier de haltes en tijden van één trein op.
// De Worker vraagt die aan de NS API met jouw geheime sleutel en geeft
// een simpele lijst terug. De sleutel staat NIET in deze code, maar in de
// Worker-instellingen als geheime variabele met de naam NS_KEY.
//
// Gebruik:  https://<jouw-worker>.workers.dev/journey?train=3541
// Ruw NS-antwoord bekijken (om te controleren):  ...&raw=1

const ALLOWED_ORIGINS = [
  "https://jelleteekens2001.github.io",
  "http://localhost:8000",
];

const NS_JOURNEY_URL =
  "https://gateway.apiportal.ns.nl/reisinformatie-api/api/v2/journey";

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
    if (url.pathname !== "/journey") return json({ error: "Onbekend adres. Gebruik /journey?train=1234" }, 404);

    const train = url.searchParams.get("train") || "";
    if (!/^\d{1,6}$/.test(train)) return json({ error: "Geef een geldig treinnummer (alleen cijfers)." }, 400);
    if (!env.NS_KEY) return json({ error: "De Worker mist de geheime variabele NS_KEY." }, 500);

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
