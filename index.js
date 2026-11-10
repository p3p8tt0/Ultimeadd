const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const REGION = "IT";
const PAGE_SIZE = 20;
const IMG = "https://image.tmdb.org/t/p/w500";

// ID dei provider TMDB (verifica con: /watch/providers/movie?watch_region=IT)
const PLATFORMS = {
  netflix: { name: "Netflix", id: 8 },
  prime: { name: "Prime Video", id: 119 },
  hbo: { name: "HBO Max", id: 1899 },
  disney: { name: "Disney+", id: 337 },
  apple: { name: "Apple TV+", id: 350 },
  paramount: { name: "Paramount+", id: 531 },
};

const app = express();
app.use(cors());
app.use(express.json());

const cache = new Map();
const fmt = (d) => d.toISOString().slice(0, 10);

async function tmdb(key, p, params = {}) {
  const qs = new URLSearchParams({ api_key: key, language: "it-IT", ...params });
  const res = await fetch(`https://api.themoviedb.org/3${p}?${qs}`);
  if (!res.ok) throw new Error(`TMDB ${res.status}`);
  return res.json();
}

function parseConfig(raw) {
  try {
    const c = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (!c.key || typeof c.key !== "string") return null;
    const days = Math.min(Math.max(parseInt(c.days, 10) || 30, 1), 90);
    const platforms = (Array.isArray(c.platforms) ? c.platforms : []).filter((p) => PLATFORMS[p]);
    return { key: c.key, days, platforms: platforms.length ? platforms : Object.keys(PLATFORMS) };
  } catch {
    return null;
  }
}

function buildManifest(cfg) {
  const catalogs = [];
  if (cfg) {
    for (const key of cfg.platforms) {
      const p = PLATFORMS[key];
      catalogs.push({ type: "movie", id: `novita-${key}-movie`, name: `${p.name} - Film ultimo mese` });
      catalogs.push({ type: "series", id: `novita-${key}-series`, name: `${p.name} - Serie ultimo mese` });
    }
  }
  return {
    id: "community.novita.streaming.it",
    version: "2.0.0",
    name: "Novità Streaming Italia",
    description: "Le uscite dell’ultimo periodo su Netflix, HBO Max, Prime Video e altre piattaforme in Italia.",
    resources: ["catalog"],
    types: ["movie", "series"],
    idPrefixes: ["tt"],
    catalogs,
    behaviorHints: { configurable: true, configurationRequired: !cfg },
  };
}

async function imdbId(cfg, kind, tmdbId) {
  const k = `imdb-${kind}-${tmdbId}`;
  if (cache.has(k)) return cache.get(k);
  try {
    const data = await tmdb(cfg.key, `/${kind}/${tmdbId}/external_ids`);
    cache.set(k, data.imdb_id || null);
    return data.imdb_id || null;
  } catch {
    return null;
  }
}

async function getCatalog(cfg, platformKey, type, skip) {
  const platform = PLATFORMS[platformKey];
  const kind = type === "movie" ? "movie" : "tv";
  const page = Math.floor(skip / PAGE_SIZE) + 1;
  const cacheKey = `cat-${platformKey}-${type}-${page}-${cfg.days}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.t < 6 * 3600 * 1000) return hit.v;

  const to = new Date();
  const from = new Date(Date.now() - cfg.days * 86400000);
  const params = {
    watch_region: REGION,
    with_watch_providers: String(platform.id),
    with_watch_monetization_types: "flatrate",
    sort_by: kind === "movie" ? "primary_release_date.desc" : "first_air_date.desc",
    page: String(page),
  };
  const field = kind === "movie" ? "primary_release_date" : "first_air_date";
  params[`${field}.gte`] = fmt(from);
  params[`${field}.lte`] = fmt(to);

  const data = await tmdb(cfg.key, `/discover/${kind}`, params);
  const metas = (
    await Promise.all(
      data.results.map(async (r) => {
        if (!r.poster_path) return null;
        const id = await imdbId(cfg, kind, r.id);
        if (!id) return null;
        return {
          id,
          type,
          name: r.title || r.name,
          poster: IMG + r.poster_path,
          description: r.overview,
          releaseInfo: (r.release_date || r.first_air_date || "").slice(0, 4),
        };
      })
    )
  ).filter(Boolean);

  cache.set(cacheKey, { t: Date.now(), v: metas });
  return metas;
}

// Pagina di configurazione
const sendConfigPage = (req, res) => res.sendFile(path.join(__dirname, "configure.html"));
app.get("/", sendConfigPage);
app.get("/configure", sendConfigPage);
app.get("/:config/configure", sendConfigPage);

// Verifica chiave TMDB dalla pagina
app.post("/api/check", async (req, res) => {
  try {
    const key = String(req.body?.key || "").trim();
    if (!key) return res.json({ ok: false });
    const r = await fetch(`https://api.themoviedb.org/3/configuration?api_key=${encodeURIComponent(key)}`);
    res.json({ ok: r.ok });
  } catch {
    res.json({ ok: false });
  }
});

// Manifest (senza config = richiede configurazione)
app.get("/manifest.json", (req, res) => res.json(buildManifest(null)));
app.get("/:config/manifest.json", (req, res) => {
  const cfg = parseConfig(req.params.config);
  if (!cfg) return res.status(400).json({ error: "Configurazione non valida" });
  res.json(buildManifest(cfg));
});

// Cataloghi
async function catalogHandler(req, res) {
  const cfg = parseConfig(req.params.config);
  const match = req.params.id.match(/^novita-(\w+)-(movie|series)$/);
  if (!cfg || !match || !PLATFORMS[match[1]]) return res.json({ metas: [] });
  const extra = new URLSearchParams(req.params.extra || "");
  const skip = parseInt(extra.get("skip") || "0", 10);
  try {
    const metas = await getCatalog(cfg, match[1], req.params.type, skip);
    res.json({ metas, cacheMaxAge: 3600 });
  } catch (e) {
    console.error(e.message);
    res.json({ metas: [] });
  }
}
app.get("/:config/catalog/:type/:id/:extra.json", catalogHandler);
app.get("/:config/catalog/:type/:id.json", catalogHandler);

const port = process.env.PORT || 7000;
app.listen(port, () => console.log(`Addon attivo sulla porta ${port}`));
