// js/catalog.js - Catalog loading and management

let catalogData = null;
let anunciosData = null;
let interactivosData = null;

export async function loadCatalog() {
  if (catalogData) return catalogData;
  try {
    const [catRes, adRes, intRes] = await Promise.all([
      fetch('peliculas.json'),
      fetch('anuncios.json'),
      fetch('interactivos.json')
    ]);
    catalogData = await catRes.json();
    anunciosData = await adRes.json().catch(() => []);
    interactivosData = await intRes.json().catch(() => ({ interactivos: [], proximamente_interactivos: [] }));
    return catalogData;
  } catch (err) {
    console.error('Error loading catalog:', err);
    catalogData = { peliculas: [], series: [], proximamente: [], banners: [] };
    anunciosData = [];
    interactivosData = { interactivos: [], proximamente_interactivos: [] };
    return catalogData;
  }
}

export function getAnuncios() {
  if (!anunciosData) return [];
  if (!Array.isArray(anunciosData)) return [];
  return anunciosData.filter(a => a.activo !== false);
}

// ─── INTERACTIVOS ──────────────────────────────────────────────────────────────
export function getInteractivos() {
  return (interactivosData?.interactivos || []).map(normalise);
}

export function getInteractivoById(id) {
  const found = (interactivosData?.interactivos || []).find(i => i.id === id);
  return found ? normalise(found) : null;
}

export function getUpcomingInteractivos() {
  return (interactivosData?.proximamente_interactivos || []).map(normalise);
}

// Looks up a specific video node inside an interactivo by its video id.
export function getInteractivoVideo(interactivoId, videoId) {
  const interactivo = getInteractivoById(interactivoId);
  if (!interactivo) return null;
  return (interactivo.videos || []).find(v => v.id === videoId) || null;
}

export function getAllContent() {
  if (!catalogData) return [];
  const all = [
    ...(catalogData.peliculas || []),
    ...(catalogData.series || []),
    ...getInteractivos()
  ];
  const seen = new Set();
  return all.filter(item => {
    if (!item.id || seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

// Same as getAllContent but also includes "proximamente" items, tagged
// with _upcoming:true so callers (search, etc.) can tell them apart.
export function getAllContentIncludingUpcoming() {
  const released = getAllContent();
  const seen = new Set(released.map(i => i.id));
  const upcoming = (catalogData?.proximamente || [])
    .filter(item => item.id && !seen.has(item.id))
    .map(item => ({ ...item, _upcoming: true }));
  return [...released, ...upcoming];
}

// Normalise: if no banner, use poster; if no description, use empty string
export function normalise(item) {
  if (!item) return item;
  return {
    ...item,
    banner: item.banner || item.poster || null,
    descripcion: item.descripcion || '',
  };
}

export function searchContent(query) {
  const all = getAllContentIncludingUpcoming().map(normalise);
  const q = query.toLowerCase();
  return all.filter(item =>
    item.titulo.toLowerCase().includes(q) ||
    (item.descripcion || '').toLowerCase().includes(q) ||
    (item.genero || '').toLowerCase().includes(q) ||
    (item.categorias || []).some(c => c.toLowerCase().includes(q))
  );
}

export function getContentById(id) {
  const found = getAllContent().find(item => item.id === id);
  if (found) return normalise(found);
  const up = (catalogData?.proximamente || []).find(item => item.id === id);
  if (up) return normalise(up);
  const upInt = getUpcomingInteractivos().find(item => item.id === id);
  if (upInt) return upInt;
  // Also search banners (used as upcoming previews)
  return normalise((catalogData?.banners || []).find(item => item.id === id)) || null;
}

export function getContentBySlug(slug) {
  return getAllContentIncludingUpcoming().map(normalise).find(item => titleToSlug(item.titulo) === slug) || null;
}

export function titleToSlug(titulo) {
  return titulo
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

export function getByCategory(category) {
  return getAllContent().map(normalise).filter(item =>
    (item.categorias || []).includes(category) || item.genero === category
  );
}

export function getUpcoming() {
  const regular = catalogData?.proximamente || [];
  const interactivos = getUpcomingInteractivos();
  const all = [...regular, ...interactivos];
  return all.map(normalise).sort((a, b) => {
    if (!a.fecha) return 1;
    if (!b.fecha) return -1;
    return new Date(a.fecha) - new Date(b.fecha);
  });
}

export function getUpcomingInteractivosOnly() {
  return getUpcomingInteractivos().map(normalise);
}

export function getUpcomingSeries() {
  return getUpcoming().filter(i => i.tipo === 'serie');
}

export function getUpcomingMovies() {
  return getUpcoming().filter(i => i.tipo === 'pelicula');
}

export function getBanners() {
  return (catalogData?.banners || []).map(normalise);
}

export function getMovies() {
  return (catalogData?.peliculas || []).map(normalise);
}

export function getSeries() {
  return (catalogData?.series || []).map(normalise);
}

export function getFeatured() {
  return getAllContent().map(normalise).filter(item => item.destacado);
}

export function getNewContent() {
  return getAllContent().map(normalise).filter(item => item.nuevo);
}

// "Nuevo esta semana" — uses an optional `publishedAt` field (ISO date or
// timestamp) on catalog items for a real date-based window. Items without
// that field fall back to the manual `nuevo` flag so existing catalog data
// keeps working without edits.
export function getNewThisWeek() {
  const oneWeekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  return getAllContent().map(normalise).filter(item => {
    if (item.publishedAt) {
      const ts = new Date(item.publishedAt).getTime();
      return !isNaN(ts) && ts >= oneWeekAgo;
    }
    return !!item.nuevo;
  });
}

export function getTop10() {
  return getAllContent().map(normalise)
    .filter(item => item.top10 != null)
    .sort((a, b) => (a.top10 || 999) - (b.top10 || 999))
    .slice(0, 10);
}

export function getSeriesGenres() {
  const genres = new Set();
  getSeries().forEach(s => {
    if (s.genero) genres.add(s.genero);
    (s.categorias || []).forEach(c => genres.add(c));
  });
  return Array.from(genres);
}

export function getMoviesGenres() {
  const genres = new Set();
  getMovies().forEach(m => {
    if (m.genero) genres.add(m.genero);
    (m.categorias || []).forEach(c => genres.add(c));
  });
  return Array.from(genres);
}

export function getRecommendations(currentId, watchedIds = []) {
  const current = getContentById(currentId);
  if (!current) return getAllContent().map(normalise).slice(0, 10);
  const all = getAllContent().map(normalise).filter(item => item.id !== currentId);
  const scored = all.map(item => {
    let score = 0;
    if (item.tipo === current.tipo) score += 1;
    if (item.genero === current.genero) score += 3;
    (item.categorias || []).forEach(cat => {
      if ((current.categorias || []).includes(cat)) score += 2;
    });
    if (watchedIds.includes(item.id)) score -= 5;
    return { item, score };
  });
  return scored.sort((a, b) => b.score - a.score).slice(0, 10).map(s => s.item);
}
