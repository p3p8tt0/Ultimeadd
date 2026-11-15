const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const REGION = "IT";
const PAGE_SIZE = 20;
const IMG = "https://image.tmdb.org/t/p/w500";

// Mappatura delle piattaforme e dei relativi codici provider per JustWatch Italia
const PLATFORMS = {
  netflix: { name: "Netflix", id: 8, jwProvider: "nfx" },
  prime: { name: "Prime Video", id: 119, jwProvider: "amp" },
  hbo: { name: "HBO Max", id: 1899, jwProvider: "hbo" },
  disney: { name: "Disney+", id: 337, jwProvider: "dnp" },
  apple: { name: "Apple TV+", id: 350, jwProvider: "atv" },
  paramount: { name: "Paramount+", id: 531, jwProvider: "prt" },
  discovery: { name: "Discovery+", id: 524, jwProvider: "dtv" },
  now: { name: "NOW", id: 39, jwProvider: "now" },
  raiplay: { name: "RaiPlay", id: 222, jwProvider: "rai" },
  infinity: { name: "Mediaset Infinity", id: 359, jwProvider: "mds" },
  timvision: { name: "TIMvision", id: 109, jwProvider: "tsi" },
  crunchyroll: { name: "Crunchyroll", id: 283, jwProvider: "crn" },
};

const app = express();
app.use(cors());
app.use(express.json());

const cache = new Map();

async function tmdb(key, p, params = {}) {
  const qs = new URLSearchParams({ api_key: key, language: "it-IT", ...params });
  const res = await fetch(`https://api.themoviedb.org/3${p}?${qs}`);
  if (!res.ok) throw new Error(`TMDB ${res.status}`);
  return res.json();
}

// Funzione per interrogare JustWatch Italia via GraphQL (senza bisogno di chiavi)
async function fetchJustWatchCatalog(platformKey, type) {
  const platform = PLATFORMS[platformKey];
  if (!platform) return [];

  const jwContentType = type === "movie" ? "MOVIE" : "SHOW";

  const query = `
    query GetPopularTitles($country: Country!, $provider: String!, $contentType: ContentType!) {
      popularTitles(
        country: $country
        filter: {
          packages: [$provider]
          objectTypes: [$contentType]
        }
        sortBy: POPULARITY
        first: 50
      ) {
        edges {
          node {
            content {
              externalIds {
                imdbId
              }
            }
          }
        }
      }
    }
  `;

  try {
    const response = await fetch("https://apis.justwatch.com/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query,
        variables: {
          country: REGION,
          provider: platform.jwProvider,
          contentType: jwContentType
        }
      })
    });

    const json = await response.json();
    const edges = json?.data?.popularTitles?.edges || [];
    
    // Restituisce la lista degli ID IMDb puliti (es. "tt1234567")
    return edges.map(edge => edge?.node?.content?.externalIds?.imdbId).filter(Boolean);
  } catch (err) {
    console.error(`Errore JustWatch per ${platformKey}:`, err.message);
    return [];
  }
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
      catalogs.push({ type: "movie", id: `novita-${key}-movie`, name: `${p.name} - Film (Italia)` });
      catalogs.push({ type: "series", id: `novita-${key}-series`, name: `${p.name} - Serie (Italia)` });
    }
  }
  return {
    id: "community.novita.streaming.it.jw",
    version: "2.1.0",
    name: "Novità Streaming Italia (JustWatch)",
    description: "Uscite reali in Italia verificate tramite JustWatch e arricchite con TMDB.",
    resources: ["catalog"],
    types: ["movie", "series"],
    idPrefixes: ["tt"],
    catalogs,
    behaviorHints: { configurable: true, configurationRequired: !cfg },
  };
}

// Trova i dettagli grafici/testuali su TMDB partendo dall'IMDb ID di JustWatch
async function getTmdbMetaByImdb(cfg, imdbId, type) {
  const kind = type === "movie" ? "movie" : "tv";
  const cacheKey = `meta-${kind}-${imdbId}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  try {
    const findData = await tmdb(cfg.key, `/find/${imdbId}`, { external_source: "imdb_id" });
    const results = kind === "movie" ? findData.movie_results : findData.tv_results;
    
    if (!results || results.length === 0) return null;
    const r = results[0];

    if (!r.poster_path) return null;

    const meta = {
      id: imdbId,
      type,
      name: r.title || r.name,
      poster: IMG + r.poster_path,
      description: r.overview,
      releaseInfo: (r.release_date || r.first_air_date || "").slice(0, 4),
    };

    cache.set(cacheKey, meta);
    return meta;
  } catch {
    return null;
  }
}

async function getCatalog(cfg, platformKey, type, skip) {
  const cacheKey = `cat-jw-${platformKey}-${type}`;
  let cachedData = cache.get(cacheKey);

  // Cache dei risultati di JustWatch valida per 6 ore
  if (!cachedData || Date.now() - cachedData.t > 6 * 3600 * 1000) {
    const imdbIds = await fetchJustWatchCatalog(platformKey, type);
    cachedData = { t: Date.now(), v: imdbIds };
    cache.set(cacheKey, cachedData);
  }

  const imdbIds = cachedData.v;
  const paginatedIds = imdbIds.slice(skip, skip + PAGE_SIZE);

  // Arricchisce gli ID con le info di TMDB in parallelo
  const metas = (
    await Promise.all(
      paginatedIds.map(imdbId => getTmdbMetaByImdb(cfg, imdbId, type))
    )
  ).filter(Boolean);

  return metas;
}

// Pagina di configurazione
const sendConfigPage = (req, res) => res.sendFile(path.join(__dirname, "configure.html"));
app.get("/", sendConfigPage);
app.get("/configure", sendConfigPage);
app.get("/:config/configure", sendConfigPage);

// Verifica chiave TMDB
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

// Manifest
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
app.listen(port, () => console.log(`Addon JustWatch-powered attivo sulla porta ${port}`));
