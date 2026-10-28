// Atlas de npm (es-atlas, world-atlas) → nombres válidos para `destacar` y trazados SVG en vertical.
// Los trazados se calculan aquí, en el servidor: la escena no descarga ni proyecta nada al renderizar.
import { createRequire } from "node:module";
import {
  geoAzimuthalEqualArea,
  geoCentroid,
  geoConicConformal,
  geoGraticule10,
  geoOrthographic,
  geoPath,
  type GeoProjection,
} from "d3-geo";
import { feature } from "topojson-client";
import type { Feature, FeatureCollection, Geometry } from "geojson";

const require = createRequire(import.meta.url);

export const REGIONES = ["espana", "europa", "mundo"] as const;
export type Region = (typeof REGIONES)[number];

type Rasgo = Feature<Geometry, { name: string }> & { id?: string | number };

export interface Zona {
  /** Nombre canónico del atlas. */
  nombre: string;
  /** Nombres que se aceptan en `destacar` (normalizados). */
  claves: string[];
  rasgo: Rasgo;
}

/** Minúsculas, sin acentos ni signos. */
export function normalizarNombre(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

// Alias en español → nombre del atlas. Los marcados con `aviso` no son equivalentes exactos.
const ALIAS_PAISES: Record<string, { nombre: string; aviso?: string }> = {
  england: { nombre: "United Kingdom", aviso: "England no está en el atlas; se usa Reino Unido entero." },
  scotland: { nombre: "United Kingdom", aviso: "Scotland no está en el atlas; se usa Reino Unido entero." },
  wales: { nombre: "United Kingdom", aviso: "Wales no está en el atlas; se usa Reino Unido entero." },
  inglaterra: { nombre: "United Kingdom", aviso: "Inglaterra no está en el atlas; se usa Reino Unido entero." },
  escocia: { nombre: "United Kingdom", aviso: "Escocia no está en el atlas; se usa Reino Unido entero." },
  gales: { nombre: "United Kingdom", aviso: "Gales no está en el atlas; se usa Reino Unido entero." },
  "irlanda del norte": { nombre: "United Kingdom", aviso: "Irlanda del Norte no está en el atlas; se usa Reino Unido entero." },
  "reino unido": { nombre: "United Kingdom" },
  espana: { nombre: "Spain" },
  alemania: { nombre: "Germany" },
  francia: { nombre: "France" },
  italia: { nombre: "Italy" },
  "paises bajos": { nombre: "Netherlands" },
  holanda: { nombre: "Netherlands" },
  belgica: { nombre: "Belgium" },
  suiza: { nombre: "Switzerland" },
  suecia: { nombre: "Sweden" },
  noruega: { nombre: "Norway" },
  dinamarca: { nombre: "Denmark" },
  finlandia: { nombre: "Finland" },
  irlanda: { nombre: "Ireland" },
  polonia: { nombre: "Poland" },
  grecia: { nombre: "Greece" },
  turquia: { nombre: "Turkey" },
  rusia: { nombre: "Russia" },
  ucrania: { nombre: "Ukraine" },
  croacia: { nombre: "Croatia" },
  serbia: { nombre: "Serbia" },
  hungria: { nombre: "Hungary" },
  rumania: { nombre: "Romania" },
  austria: { nombre: "Austria" },
  "republica checa": { nombre: "Czechia" },
  chequia: { nombre: "Czechia" },
  brasil: { nombre: "Brazil" },
  mexico: { nombre: "Mexico" },
  "estados unidos": { nombre: "United States of America" },
  eeuu: { nombre: "United States of America" },
  usa: { nombre: "United States of America" },
  japon: { nombre: "Japan" },
  "corea del sur": { nombre: "South Korea" },
  marruecos: { nombre: "Morocco" },
  egipto: { nombre: "Egypt" },
  "sudafrica": { nombre: "South Africa" },
  camerun: { nombre: "Cameroon" },
  "costa de marfil": { nombre: "Côte d'Ivoire" },
  peru: { nombre: "Peru" },
  "arabia saudi": { nombre: "Saudi Arabia" },
  "arabia saudita": { nombre: "Saudi Arabia" },
  catar: { nombre: "Qatar" },
};

// Nombres cortos y en castellano para las comunidades (además de los del atlas).
const ALIAS_ES: Record<string, string> = {
  asturias: "Principado de Asturias",
  baleares: "Illes Balears",
  "islas baleares": "Illes Balears",
  catalunya: "Cataluña/Catalunya",
  cataluna: "Cataluña/Catalunya",
  valencia: "Comunitat Valenciana",
  "comunidad valenciana": "Comunitat Valenciana",
  madrid: "Comunidad de Madrid",
  murcia: "Región de Murcia",
  navarra: "Comunidad Foral de Navarra",
  "pais vasco": "País Vasco/Euskadi",
  euskadi: "País Vasco/Euskadi",
  ceuta: "Ciudad Autónoma de Ceuta",
  melilla: "Ciudad Autónoma de Melilla",
  canarias: "Canarias",
  "islas canarias": "Canarias",
};

/** Países cuyo centro cae en la Europa que se dibuja (de Islandia a los Urales). */
function enEuropa(f: Feature<Geometry, { name: string }>): boolean {
  if (["Russia", "Turkey"].includes(f.properties.name)) return true;
  const [lon, lat] = geoCentroid(f);
  return lon > -25 && lon < 45 && lat > 34 && lat < 72;
}

interface Atlas {
  zonas: Zona[];
  coleccion: FeatureCollection<Geometry, { name: string }>;
}

const cache = new Map<Region, Atlas>();

function cargar(region: Region): Atlas {
  const enCache = cache.get(region);
  if (enCache) return enCache;
  let coleccion: FeatureCollection<Geometry, { name: string }>;
  if (region === "espana") {
    const topo = require("es-atlas/es/autonomous_regions.json");
    coleccion = feature(topo, topo.objects.autonomous_regions) as unknown as FeatureCollection<Geometry, { name: string }>;
    coleccion.features = coleccion.features.filter((f) => !/gibraltar/i.test(f.properties.name));
  } else {
    // Europa con más detalle; el globo del mundo se ve entero y basta con 110m.
    const topo = require(region === "europa" ? "world-atlas/countries-50m.json" : "world-atlas/countries-110m.json");
    coleccion = feature(topo, topo.objects.countries) as unknown as FeatureCollection<Geometry, { name: string }>;
    if (region === "europa") coleccion.features = coleccion.features.filter(enEuropa);
  }
  const zonas: Zona[] = coleccion.features.map((f) => {
    const nombre = f.properties.name;
    const claves = new Set([normalizarNombre(nombre), ...nombre.split("/").map(normalizarNombre)]);
    return { nombre, claves: [...claves], rasgo: f as Rasgo };
  });
  if (region === "espana") {
    for (const [alias, nombre] of Object.entries(ALIAS_ES)) zonas.find((z) => z.nombre === nombre)?.claves.push(normalizarNombre(alias));
  }
  const atlas = { zonas, coleccion };
  cache.set(region, atlas);
  return atlas;
}

export function nombresRegion(region: Region): string[] {
  return cargar(region).zonas.map((z) => z.nombre);
}

function distancia(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...new Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return d[m][n];
}

/** Los `n` nombres del atlas más parecidos a `texto`. */
export function parecidos(region: Region, texto: string, n = 10): string[] {
  const q = normalizarNombre(texto);
  return cargar(region)
    .zonas.map((z) => {
      const mejor = Math.min(...z.claves.map((k) => (k.includes(q) || q.includes(k) ? 0 : distancia(q, k) / Math.max(q.length, k.length))));
      return { nombre: z.nombre, d: mejor };
    })
    .sort((a, b) => a.d - b.d || a.nombre.localeCompare(b.nombre))
    .slice(0, n)
    .map((x) => x.nombre);
}

/** Resuelve un nombre de `destacar` a una zona del atlas (con alias en español). */
export function resolverZona(region: Region, texto: string): { zona?: Zona; aviso?: string } {
  const atlas = cargar(region);
  const q = normalizarNombre(texto);
  const directa = atlas.zonas.find((z) => z.claves.includes(q));
  if (directa) return { zona: directa };
  if (region !== "espana") {
    const alias = ALIAS_PAISES[q];
    if (alias) {
      const zona = atlas.zonas.find((z) => z.nombre === alias.nombre);
      if (zona) return { zona, aviso: alias.aviso ? `"${texto}": ${alias.aviso}` : undefined };
    }
  }
  return {};
}

// ---------- Trazados ----------

export interface MapaSvg {
  ancho: number;
  alto: number;
  /** Zonas de fondo (sin destacar). */
  base: { d: string }[];
  /** Zonas destacadas, en el orden de `destacar`. */
  destacadas: { nombre: string; d: string; cx: number; cy: number }[];
  /** Trazados auxiliares (esfera, retícula, marco del recuadro de Canarias). */
  extra: { d: string; clase: string }[];
}

// Coordenadas a enteros: a 1080 px de ancho no se nota y el HTML pesa mucho menos.
const r1 = (s: string | null) => (s ?? "").replace(/-?\d+\.\d+/g, (n) => String(Math.round(Number(n))));

/** Trazados SVG del mapa para una caja de ancho×alto px. */
export function trazarMapa(region: Region, destacar: string[], ancho = 1000, alto = 950): MapaSvg {
  const atlas = cargar(region);
  const zonasDestacadas = destacar.map((t) => resolverZona(region, t).zona).filter((z): z is Zona => !!z);
  const nombresDest = new Set(zonasDestacadas.map((z) => z.nombre));
  const extra: MapaSvg["extra"] = [];
  let proyeccion: GeoProjection;
  let rasgosBase: Rasgo[] = atlas.coleccion.features as Rasgo[];
  let proyCanarias: GeoProjection | undefined;

  if (region === "espana") {
    const peninsula = rasgosBase.filter((f) => f.properties.name !== "Canarias");
    proyeccion = geoConicConformal().rotate([3.5, 0]).center([0, 39.5]);
    proyeccion.fitExtent(
      [
        [20, 20],
        [ancho - 20, alto * 0.78],
      ],
      { type: "FeatureCollection", features: peninsula },
    );
    // Canarias en un recuadro abajo a la izquierda.
    const canarias = rasgosBase.find((f) => f.properties.name === "Canarias");
    if (canarias) {
      const caja: [[number, number], [number, number]] = [
        [30, alto * 0.82],
        [ancho * 0.45, alto - 10],
      ];
      proyCanarias = geoConicConformal().rotate([15.5, 0]).center([0, 28.3]).fitExtent(caja, canarias);
      extra.push({ d: `M${caja[0][0] - 10},${caja[0][1] - 10}H${caja[1][0] + 10}V${caja[1][1]}H${caja[0][0] - 10}Z`, clase: "marco" });
    }
  } else if (region === "europa") {
    proyeccion = geoAzimuthalEqualArea().rotate([-12, -52]).clipExtent([
      [0, 0],
      [ancho, alto],
    ]);
    proyeccion.fitExtent(
      [
        [0, 0],
        [ancho, alto],
      ],
      {
        type: "Feature",
        properties: {},
        geometry: {
          type: "Polygon",
          // En d3-geo el anillo exterior va en sentido horario: al revés sería "todo el globo menos Europa"
          // y el mapa salía diminuto y descentrado.
          coordinates: [
            [
              [-12, 35],
              [-12, 70],
              [36, 70],
              [36, 35],
              [-12, 35],
            ],
          ],
        },
      },
    );
  } else {
    // Mundo: un globo centrado en las zonas destacadas, que en vertical aprovecha mejor el espacio.
    let lon = 0;
    let lat = 20;
    if (zonasDestacadas.length) {
      const centros = zonasDestacadas.map((z) => geoCentroid(z.rasgo));
      lon = centros.reduce((s, c) => s + c[0], 0) / centros.length;
      lat = centros.reduce((s, c) => s + c[1], 0) / centros.length;
    }
    const lado = Math.min(ancho, alto) - 20;
    proyeccion = geoOrthographic()
      .rotate([-lon, -Math.max(-60, Math.min(60, lat))])
      .clipAngle(90)
      .fitExtent(
        [
          [(ancho - lado) / 2, (alto - lado) / 2],
          [(ancho + lado) / 2, (alto + lado) / 2],
        ],
        { type: "Sphere" },
      );
    const p = geoPath(proyeccion);
    extra.push({ d: r1(p({ type: "Sphere" })), clase: "esfera" });
    extra.push({ d: r1(p(geoGraticule10())), clase: "reticula" });
  }

  const camino = geoPath(proyeccion);
  const caminoCanarias = proyCanarias ? geoPath(proyCanarias) : undefined;
  const trazar = (f: Rasgo) => (f.properties.name === "Canarias" && caminoCanarias ? caminoCanarias : camino);
  const base = rasgosBase
    .filter((f) => !nombresDest.has(f.properties.name))
    .map((f) => ({ d: r1(trazar(f)(f)) }))
    .filter((x) => x.d.length > 0);
  const destacadas = zonasDestacadas
    .filter((z, i, arr) => arr.findIndex((o) => o.nombre === z.nombre) === i)
    .map((z) => {
      const c = trazar(z.rasgo).centroid(z.rasgo);
      return { nombre: z.nombre, d: r1(trazar(z.rasgo)(z.rasgo)), cx: Math.round(c[0] || ancho / 2), cy: Math.round(c[1] || alto / 2) };
    })
    .filter((x) => x.d.length > 0);
  return { ancho, alto, base, destacadas, extra };
}
