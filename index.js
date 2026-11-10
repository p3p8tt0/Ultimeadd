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
