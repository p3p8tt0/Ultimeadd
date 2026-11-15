const express = require("express");
const cors = require("cors");
const path = require("path");

const REGION = "IT";
const LANG = "it";
const PAGE_SIZE = 20;
const IMG = "https://image.tmdb.org/t/p/w500";
const TTL = 6 * 3600 * 1000;

// id = provider TMDB (fallback) | jw = codice pacchetto JustWatch (verifica se una piattaforma non restituisce nulla)
const PLATFORMS = {
  netflix: { name: "Netflix", id: 8, jw: "nfx" },
  prime: { name: "Prime Video", id: 119, jw: "amp" },
  hbo: { name: "HBO Max", id: 1899, jw: "hbm" },
  disney: { name: "Disney+", id: 337, jw: "dnp" },
  apple: { name: "Apple TV+", id: 350, jw: "atp" },
  paramount: { name: "Paramount+", id: 531, jw: "pmp" },
  discovery: { name: "Discovery+", id: 524, jw: "dpe" },
  now: { name: "NOW", id: 39, jw: "nw" },
  raiplay: { name: "RaiPlay", id: 222, jw: "rai" },
  infinity: { name: "Mediaset Infinity", id: 359, jw: "mfi" },
  timvision: { name: "TIMvision", id: 109, jw: "tvi" },
  crunchyroll: { name: "Crunchyroll", id: 283, jw: "cru" },
};

const app = express();
app.use(cors());
app.use(express.json());

const cache = new Map();
const fmt = (d) => d.toISOString().slice(0, 10);
const getC = (k) => {
  const h = cache.get(k);
  return h && Date.now() - h.t < TTL ? h.v : undefined;
};
const setC = (k, v) => cache.set(k, { t: Date.now(), v });

// ---------- TMDB ----------
async function tmdb(key, p, params = {}) {
  const qs = new URLSearchParams({ api_key: key, language: "it-IT", ...params });
  const res = await fetch(`https://api.themoviedb.org/3${p}?${qs}`);
  if (!res.ok) throw new Error(`TMDB ${res.status}`);
  return res.json();
}

// Dettagli + IMDb id in una sola chiamata
async function tmdbDetails(cfg, kind, tmdbId) {
  const k = `det-${kind}-${tmdbId}`;
  const hit = getC(k);
  if (hit !== undefined) return hit;
  try {
    const d = await tmdb(cfg.key, `/${kind}/${tmdbId}`, { append_to_response: "external_ids" });
    const v = {
      imdb: d.external_ids?.imdb_id || null,
      name: d.title || d.name,
      poster: d.poster_path ? IMG + d.poster_path : null,
      overview: d.overview || "",
      year: (d.release_date || d.first_air_date || "").slice(0, 4),
      rating: d.vote_average ? d.vote_average.toFixed(1) : undefined,
    };
    setC(k, v);
    return v;
  } catch {
    return null;
  }
}

async function toMeta(cfg, type, kind, tmdbId, knownImdb) {
  const d = await tmdbDetails(cfg, kind, tmdbId);
  const id = d?.imdb || knownImdb;
  if (!d || !id || !d.poster) return null;
  return {
    id,
    type,
    name: d.name,
    poster: d.poster,
    description: d.overview,
    releaseInfo: d.year,
    imdbRating: d.rating,
  };
}

// ---------- JustWatch (endpoint non ufficiale) ----------
const JW_QUERY = `
query GetNewTitles($country: Country!, $date: Date!, $language: Language!, $filter: TitleFilter, $first: Int!, $after: String) {
  newTitles(country: $country, date: $date, filter: $filter, first: $first, after: $after) {
    pageInfo { hasNextPage endCursor }
    edges {
      node {
        id
        objectType
        content(country: $country, language: $language) {
          title
          externalIds { imdbId tmdbId }
        }
      }
    }
  }
}`;

async function jwNewTitles(platform, type, days, page) {
  const k = `jw-${platform.jw}-${type}-${days}-${page}`;
  const hit = getC(k);
  if (hit) return hit;

  const from = fmt(new Date(Date.now() - days * 86400000));
  const objectType = type === "movie" ? "MOVIE" : "SHOW";
  const res = await fetch("https://apis.justwatch.com/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "Mozilla/5.0" },
    body: JSON.stringify({
      query: JW_QUERY,
      variables: {
        country: REGION,
        language: LANG,
        date: from,
        first: PAGE_SIZE * 2,
        filter: { packages: [platform.jw], objectTypes: [objectType] },
      },
    }),
  });
  if (!res.ok) throw new Error(`JustWatch ${res.status}`);
  const json = await res.json();
  if (json.errors) throw new Error(`JustWatch: ${json.errors[0]?.message}`);
  const edges = json.data?.newTitles?.edges || [];
  const items = edges
    .map((e) => e.node?.content?.externalIds)
    .filter((x) => x && (x.tmdbId || x.imdbId))
    .map((x) => ({ tmdbId: x.tmdbId, imdbId: x.imdbId }));
  setC(k, items);
  return items;
}

// Candidati JustWatch: titoli arrivati di recente sulla piattaforma
async function jwCandidates(cfg, platformKey, type) {
  const items = await jwNewTitles(PLATFORMS[platformKey], type, cfg.days, 0);
  return items.filter((it) => it.tmdbId).map((it) => ({ tmdbId: String(it.tmdbId), imdbId: it.imdbId }));
}

// Candidati TMDB: titoli usciti nel periodo e disponibili sulla piattaforma
async function tmdbCandidates(cfg, platformKey, type) {
  const platform = PLATFORMS[platformKey];
  const kind = type === "movie" ? "movie" : "tv";
  const to = new Date();
  const from = new Date(Date.now() - cfg.days * 86400000);
  const base = {
    watch_region: REGION,
    with_watch_providers: String(platform.id),
    with_watch_monetization_types: "flatrate|free|ads",
    sort_by: "popularity.desc",
    "vote_count.gte": "5",
  };
  if (kind === "movie") {
    base.region = REGION;
    base.with_release_type = "3|4|6";
    base["release_date.gte"] = fmt(from);
    base["release_date.lte"] = fmt(to);
  } else {
    base["first_air_date.gte"] = fmt(from);
    base["first_air_date.lte"] = fmt(to);
  }
  const pages = await Promise.all(
    [1, 2].map((p) => tmdb(cfg.key, `/discover/${kind}`, { ...base, page: String(p) }).catch(() => ({ results: [] })))
  );
  return pages
    .flatMap((d) => d.results)
    .filter((r) => r.poster_path && r.overview)
    .map((r) => ({ tmdbId: String(r.id) }));
}

// Unisce le due fonti: prima i titoli presenti in entrambe, poi alterna "aggiunti" e "usciti"
function mergeLists(added, released) {
  const addedIds = new Set(added.map((x) => x.tmdbId));
  const relIds = new Set(released.map((x) => x.tmdbId));
  const both = added.filter((x) => relIds.has(x.tmdbId));
  const onlyAdded = added.filter((x) => !relIds.has(x.tmdbId));
  const onlyRel = released.filter((x) => !addedIds.has(x.tmdbId));
  const out = [...both];
  for (let i = 0; i < Math.max(onlyAdded.length, onlyRel.length); i++) {
    if (onlyAdded[i]) out.push(onlyAdded[i]);
    if (onlyRel[i]) out.push(onlyRel[i]);
  }
  return out;
}

async function getCatalog(cfg, platformKey, type, skip) {
  const kind = type === "movie" ? "movie" : "tv";
  const listKey = `list-${platformKey}-${type}-${cfg.days}`;
  let list = getC(listKey);
  if (!list) {
    const [jw, tm] = await Promise.allSettled([
      jwCandidates(cfg, platformKey, type),
      tmdbCandidates(cfg, platformKey, type),
    ]);
    if (jw.status === "rejected") console.warn(`[${platformKey}/${type}] JustWatch: ${jw.reason.message}`);
    if (tm.status === "rejected") console.warn(`[${platformKey}/${type}] TMDB: ${tm.reason.message}`);
    list = mergeLists(jw.value || [], tm.value || []);
    if (list.length) setC(listKey, list);
  }
  const slice = list.slice(skip, skip + PAGE_SIZE);
  const metas = await Promise.all(slice.map((it) => toMeta(cfg, type, kind, it.tmdbId, it.imdbId)));
  return metas.filter(Boolean);
}

// ---------- Config / manifest ----------
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
      catalogs.push({ type: "movie", id: `novita-${key}-movie`, name: `${p.name} - Film novità`, extra: [{ name: "skip" }] });
      catalogs.push({ type: "series", id: `novita-${key}-series`, name: `${p.name} - Serie novità`, extra: [{ name: "skip" }] });
    }
  }
  return {
    id: "community.novita.streaming.it",
    version: "3.1.0",
    name: "Novità Streaming Italia",
    description: "Le ultime novità arrivate su Netflix, HBO Max, Prime Video e altre piattaforme in Italia.",
    resources: ["catalog"],
    types: ["movie", "series"],
    idPrefixes: ["tt"],
    catalogs,
    behaviorHints: { configurable: true, configurationRequired: !cfg },
  };
}

// ---------- Routes ----------
const sendConfigPage = (req, res) => res.sendFile(path.join(__dirname, "configure.html"));
app.get("/", sendConfigPage);
app.get("/configure", sendConfigPage);
app.get("/:config/configure", sendConfigPage);

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

app.get("/manifest.json", (req, res) => res.json(buildManifest(null)));
app.get("/:config/manifest.json", (req, res) => {
  const cfg = parseConfig(req.params.config);
  if (!cfg) return res.status(400).json({ error: "Configurazione non valida" });
  res.json(buildManifest(cfg));
});

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
