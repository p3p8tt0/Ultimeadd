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
      date: d.release_date || d.first_air_date || "",
      pop: d.popularity || 0,
      seasons: (d.seasons || []).map((x) => x.air_date).filter(Boolean),
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
    _pop: d.pop,
    _date: d.date,
    _seasons: d.seasons,
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

// Classifica di popolarità in Italia per la piattaforma (JustWatch, sortBy POPULAR)
const JW_POPULAR_QUERY = `
query GetPopular($country: Country!, $language: Language!, $filter: TitleFilter, $first: Int!) {
  popularTitles(country: $country, filter: $filter, first: $first, sortBy: POPULAR) {
    edges {
      node {
        id
        content(country: $country, language: $language) {
          externalIds { tmdbId }
        }
      }
    }
  }
}`;

async function jwPopularRanks(platform, type) {
  const k = `jwpop-${platform.jw}-${type}`;
  const hit = getC(k);
  if (hit) return hit;
  const res = await fetch("https://apis.justwatch.com/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "Mozilla/5.0" },
    body: JSON.stringify({
      query: JW_POPULAR_QUERY,
      variables: {
        country: REGION,
        language: LANG,
        first: 150,
        filter: { packages: [platform.jw], objectTypes: [type === "movie" ? "MOVIE" : "SHOW"] },
      },
    }),
  });
  if (!res.ok) throw new Error(`JustWatch popular ${res.status}`);
  const json = await res.json();
  if (json.errors) throw new Error(`JustWatch popular: ${json.errors[0]?.message}`);
  const ranks = new Map();
  (json.data?.popularTitles?.edges || []).forEach((e, i) => {
    const id = e.node?.content?.externalIds?.tmdbId;
    if (id && !ranks.has(String(id))) ranks.set(String(id), i + 1);
  });
  setC(k, ranks);
  return ranks;
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
  const to = fmt(new Date());
  const from = fmt(new Date(Date.now() - cfg.days * 86400000));
  const base = {
    watch_region: REGION,
    with_watch_providers: String(platform.id),
    with_watch_monetization_types: "flatrate|free|ads",
    sort_by: "popularity.desc",
  };
  const queries = [];
  if (kind === "movie") {
    queries.push({
      ...base,
      region: REGION,
      with_release_type: "3|4|6",
      "release_date.gte": from,
      "release_date.lte": to,
      "vote_count.gte": "3",
      _rel: true,
    });
  } else {
    // 1) serie nuove (prima puntata nel periodo)
    queries.push({ ...base, "first_air_date.gte": from, "first_air_date.lte": to, _rel: true });
    // 2) nuove stagioni / puntate andate in onda nel periodo (es. reality e show)
    queries.push({ ...base, "air_date.gte": from, "air_date.lte": to });
  }
  const results = await Promise.all(
    queries.map((q) => {
      const { _rel, ...params } = q;
      return Promise.all(
        [1, 2, 3].map((p) =>
          tmdb(cfg.key, `/discover/${kind}`, { ...params, page: String(p) }).catch(() => ({ results: [] }))
        )
      ).then((pages) => pages.flatMap((d) => d.results.map((r) => ({ ...r, _rel: !!_rel }))));
    })
  );
  // serie nuove prima, poi nuove stagioni; senza doppioni
  const seen = new Set();
  const out = [];
  for (const r of results.flat()) {
    if (!r.poster_path || seen.has(r.id)) continue;
    seen.add(r.id);
    out.push({ tmdbId: String(r.id), rel: r._rel });
  }
  return out;
}

// Unisce le due fonti senza doppioni (conserva il flag "uscito nel periodo")
function mergeLists(added, released) {
  const map = new Map();
  for (const x of [...released, ...added]) {
    const prev = map.get(x.tmdbId);
    map.set(x.tmdbId, { ...prev, ...x, rel: !!(prev?.rel || x.rel) });
  }
  return [...map.values()];
}

// Catalogo ordinato: prima le uscite del periodo (le più popolari in Italia in cima),
// poi i titoli solo aggiunti alla piattaforma (anch'essi per popolarità)
async function buildCatalog(cfg, platformKey, type) {
  const kind = type === "movie" ? "movie" : "tv";
  const from = fmt(new Date(Date.now() - cfg.days * 86400000));
  const to = fmt(new Date());
  const inWindow = (d) => !!d && d >= from && d <= to;
  const [jw, tm, rk] = await Promise.allSettled([
    jwCandidates(cfg, platformKey, type),
    tmdbCandidates(cfg, platformKey, type),
    jwPopularRanks(PLATFORMS[platformKey], type),
  ]);
  if (jw.status === "rejected") console.warn(`[${platformKey}/${type}] JustWatch: ${jw.reason.message}`);
  if (tm.status === "rejected") console.warn(`[${platformKey}/${type}] TMDB: ${tm.reason.message}`);
  if (rk.status === "rejected") console.warn(`[${platformKey}/${type}] Popolarità IT non disponibile: ${rk.reason.message}`);
  const ranks = rk.value || new Map();
  const list = mergeLists(jw.value || [], tm.value || []);
  const metas = (
    await Promise.all(
      list.map(async (it) => {
        const m = await toMeta(cfg, type, kind, it.tmdbId, it.imdbId);
        if (!m) return null;
        // recente = uscito nel periodo, oppure (serie) nuova stagione partita nel periodo
        m._rank = ranks.get(String(it.tmdbId)) ?? Infinity;
        m._recent = it.rel || inWindow(m._date) || (kind === "tv" && (m._seasons || []).some(inWindow));
        return m;
      })
    )
  ).filter(Boolean);
  const seenIds = new Set();
  return metas
    .filter((m) => !seenIds.has(m.id) && seenIds.add(m.id))
    // finestra rigida: solo titoli usciti negli ultimi N giorni (salvo includeAdded)
    .filter((m) => cfg.includeAdded || m._recent)
    .sort(
      (a, b) =>
        Number(b._recent) - Number(a._recent) ||
        (a._rank === b._rank ? 0 : a._rank < b._rank ? -1 : 1) ||
        b._pop - a._pop ||
        (b._date || "").localeCompare(a._date || "")
    );
}

async function getCatalog(cfg, platformKey, type, skip) {
  const listKey = `sorted-${platformKey}-${type}-${cfg.days}-${cfg.includeAdded}`;
  let all = getC(listKey);
  if (!all) {
    all = await buildCatalog(cfg, platformKey, type);
    if (all.length) setC(listKey, all);
  }
  return all.slice(skip, skip + PAGE_SIZE).map(({ _pop, _date, _seasons, _recent, _rank, ...meta }) => meta);
}

// ---------- Config / manifest ----------
function parseConfig(raw) {
  try {
    const c = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (!c.key || typeof c.key !== "string") return null;
    const days = Math.min(Math.max(parseInt(c.days, 10) || 30, 1), 90);
    const platforms = (Array.isArray(c.platforms) ? c.platforms : []).filter((p) => PLATFORMS[p]);
    return { key: c.key, days, includeAdded: c.includeAdded === true, platforms: platforms.length ? platforms : Object.keys(PLATFORMS) };
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
    version: "3.6.0",
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
