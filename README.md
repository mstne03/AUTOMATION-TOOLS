# kb-seo

Base de conocimiento local y vectorizada sobre SEO en redes sociales,
posicionamiento y algoritmos de YouTube, TikTok e Instagram. Claude Desktop la
consulta como herramienta MCP.

Todo corre en local. Postgres solo escucha en `127.0.0.1`, los embeddings los
genera Ollama en esta maquina y nada sale a internet salvo la descarga de las
fuentes que tu le indiques.

## Como funciona

```
sources.yaml  ->  ingesta  ->  Postgres + pgvector  ->  servidor MCP  ->  Claude Desktop
                     |                                        |
                 Ollama (bge-m3, 1024 dim)              rol kb_reader
                                                        (solo SELECT)
```

- **`documents`**: una fila por fuente, con fecha de publicacion, plataformas y
  un hash del contenido para no reingerir lo que no ha cambiado.
- **`chunks`**: trozos de ~600 tokens con su embedding y su `tsvector`.
- **Busqueda hibrida**: top 20 por similitud coseno + top 20 por full-text,
  fusionados con Reciprocal Rank Fusion (k=60).
- **`fuentes/`**: texto de paginas que solo se pueden leer con un navegador,
  guardado a mano e ingerido como `local`.

## Requisitos

| Que | Version | Para que |
|---|---|---|
| Docker Desktop | con backend WSL2 | Postgres 17 + pgvector |
| Ollama | corriendo en `:11434` | embeddings |
| uv | cualquiera reciente | entorno Python 3.12 |
| Node.js | opcional | solo para MCP Inspector |

## Puesta en marcha

```bash
cd ~/kb-seo

# 1. Configuracion. El .env ya viene generado con contrasenas al azar.
#    Si lo pierdes: copia .env.example y rellenalo.
cat .env

# 2. Levanta Postgres.
docker compose up -d
docker compose ps          # debe decir "healthy"

# 3. Modelo de embeddings (1,2 GB, solo la primera vez).
ollama pull bge-m3

# 4. Entorno Python.
uv sync --extra dev

# 5. Comprueba que todo habla entre si.
uv run pytest -q
```

Si `uv sync` se queja de `Missing expected target directory for Python minor
version link`, es un bug conocido de uv en Windows. Apunta al interprete a
mano:

```bash
uv sync --extra dev --python "$APPDATA/uv/python/cpython-3.12.14-windows-x86_64-none/python.exe"
```

## Anadir fuentes

`sources.yaml` es la fuente de verdad. Dos formas de anadir cosas:

**A mano**, editando el archivo:

```yaml
- url: https://ejemplo.com/guia-algoritmo-shorts
  type: web                    # web | youtube | pdf | local
  platforms: [youtube]         # youtube | tiktok | instagram | general
  published_at: 2025-01-15     # importante: permite filtrar consejos viejos
  author: Nombre del autor
  topics: [retencion, ctr, shorts]
```

y luego:

```bash
uv run ingest all
```

**Desde la linea de comandos**, que ademas lo apunta en `sources.yaml`:

```bash
uv run ingest url https://www.youtube.com/watch?v=XXXXXXXXXXX \
  --platform youtube --date 2025-03-02 --topic hooks --topic retencion
```

El `--type` se adivina de la URL; pasalo explicito si te equivoca.

### Ver que hay dentro

```bash
uv run ingest stats
```

### Reingerir

`uv run ingest all` es idempotente: compara el `content_hash` de cada fuente y
se salta las que no han cambiado. Si una cambio, reemplaza sus chunks (es un
reemplazo de filas en la base de datos, no borra ningun archivo tuyo).

### Paginas que se renderizan por JavaScript

trafilatura descarga HTML, no ejecuta JavaScript. Algunas paginas oficiales
(Centro de Transparencia de Meta, centro de seguridad y ayuda de TikTok) solo
devuelven el esqueleto y la ingesta las rechaza con "trafilatura no extrajo
texto".

La via para esas: abrirlas en un navegador, guardar el texto como `.md` en
`fuentes/` e ingerirlo como `type: local`. Hay cuatro asi en `sources.yaml`.
Ojo: **no se revisitan solas**. Si la plataforma actualiza la pagina, hay que
volver a capturarla a mano.

### Que hace con cada tipo

| `type` | Extractor | Troceado |
|---|---|---|
| `web` | trafilatura | ~600 tokens respetando parrafos, 15% de solape |
| `pdf` | pypdf | igual |
| `local` | `.md` y `.txt` | igual |
| `youtube` | youtube-transcript-api (espanol, si no ingles) | ventanas de tiempo con 15% de solape |

Las transcripciones van por tiempo y no por parrafos porque no tienen parrafos
ni puntuacion fiable. Cada chunk lleva su rango temporal en la cabecera para
poder citarlo. Si un video no tiene transcripcion ni en espanol ni en ingles,
la ingesta avisa y salta esa fuente sin tumbar el resto del lote.

## Cambiar el esquema de la base de datos

`sql/init.sql` **solo se ejecuta la primera vez que se crea el volumen**. Si ya
tienes datos, editarlo no hace absolutamente nada. Los cambios posteriores van
en `sql/migrate.sql` con sentencias idempotentes:

```sql
ALTER TABLE documents ADD COLUMN IF NOT EXISTS notes TEXT;
```

y se aplican con:

```bash
uv run kb-migrate
```

## Conectar con Claude Desktop

Anade esta entrada a `mcpServers` en
`%APPDATA%\Claude\claude_desktop_config.json`:

```json
"kb-seo": {
  "command": "C:\\Users\\Pau\\AppData\\Local\\Microsoft\\WinGet\\Packages\\astral-sh.uv_Microsoft.Winget.Source_8wekyb3d8bbwe\\uv.exe",
  "args": ["run", "--directory", "C:\\Users\\Pau\\kb-seo", "kb-mcp"]
}
```

Reinicia Claude Desktop del todo (que no quede en la bandeja del sistema).

### Herramientas que expone

| Herramienta | Que hace |
|---|---|
| `buscar_kb(query, plataforma, desde, fuente, max_chars, k)` | Busqueda hibrida. Devuelve bloques con titulo, fecha y URL para que Claude pueda citarlos. |
| `listar_fuentes(plataforma)` | Que documentos hay ingeridos. |
| `estado_kb()` | Totales y fecha de la fuente mas reciente por plataforma. |

### Apuntar a documentos concretos y acortar la respuesta

`buscar_kb` devolvia mucho texto por consulta. Tres parametros lo controlan:

- **`fuente`**: limita la busqueda a documentos cuyo titulo o URL contengan ese
  texto, sin distinguir mayusculas. Acepta una lista, y entonces basta con que
  coincida uno. El filtro entra en el `WHERE` **antes** de las ramas vectorial y
  full-text, asi que los candidatos se eligen ya solo dentro de esos documentos.

  ```
  buscar_kb("hashtags", fuente="buffer.com")
  buscar_kb("etiquetas", fuente=["metricool", "howyoutubeworks"])
  ```

  `listar_fuentes()` muestra entre `<>` el identificador de cada documento,
  listo para copiar y pegar como `fuente`. En los archivos locales de
  `fuentes/` vale tambien la url de la pagina original.

- **`max_chars`**: tope para el texto de cada bloque (la linea de cabecera no
  cuenta). Si el bloque es mas largo, el recorte se **centra en el parrafo mas
  parecido a la consulta** (coseno con bge-m3, una llamada a Ollama en lote por
  bloque) y se amplia hacia los lados en parrafos o frases completas. `[…]`
  marca donde se ha quitado texto. Si Ollama falla en ese paso, recorta desde el
  principio en vez de romper la busqueda.

- **`k`**: cuenta **fragmentos antes de fusionar**, y por defecto es 3. Los
  fragmentos contiguos de un mismo documento se unen en un solo bloque, asi que
  puedes recibir menos bloques que `k`.

Ademas la respuesta se compacta sola: cabecera de una linea (`titulo | fecha |
URL`), sin la linea de autor y plataformas, y sin el bloque
`[titulo | plataforma | fecha]` que la ingesta graba dentro de cada chunk. Ese
bloque se sigue guardando en la base (sirve para que el chunk se entienda suelto
en la busqueda); solo se oculta al mostrarlo.

Tampoco sale la cabecera del documento (el `# titulo` y el blockquote inicial
con las notas de captura de los archivos de `fuentes/`). Para esos archivos, la
cabecera del resultado muestra la url original sacada de la linea
`> Original: ...` en vez de la ruta local. Todo esto es solo de salida: la base
y el troceado no cambian, no hace falta reingerir.

Medido contra la base real, el ahorro va del 64% al 97% segun la consulta.

### Probar con MCP Inspector

```bash
npx @modelcontextprotocol/inspector .venv/Scripts/kb-mcp.exe
```

Pasale el ejecutable directamente y no `uv run --directory ...`: el Inspector se
come el `--directory` como si fuera suyo y la conexion se cae con
`{"error":{"code":"error","message":"Connection closed"}}`.

En modo CLI, sin abrir el navegador:

```bash
npx @modelcontextprotocol/inspector --cli .venv/Scripts/kb-mcp.exe --method tools/list
npx @modelcontextprotocol/inspector --cli .venv/Scripts/kb-mcp.exe --method tools/call --tool-name estado_kb
```

## Seguridad

- Postgres escucha **solo** en `127.0.0.1:5433`. Nada expuesto a la red.
- Dos roles: `kb_writer` (lectura y escritura, lo usa la ingesta) y `kb_reader`
  (**solo SELECT**, lo usa el servidor MCP). El MCP no puede escribir en la base
  ni aunque se lo pidan.
- Las contrasenas viven en `.env`, que esta en `.gitignore`. Nunca en el codigo.
- El repositorio es local, sin remoto.

## Troubleshooting

**`uv run ingest all` falla con "No se pudo obtener embeddings de Ollama"**

Ollama no esta corriendo o no tiene el modelo:

```bash
curl http://localhost:11434/api/tags     # deberia responder
ollama list                              # deberia aparecer bge-m3
ollama pull bge-m3
```

**Las busquedas tardan ~2 segundos en vez de ~25 ms**

Mira que `OLLAMA_URL` en `.env` sea `http://127.0.0.1:11434` y no
`http://localhost:11434`. `localhost` resuelve tambien a `::1`, Ollama solo
escucha en IPv4, y cada conexion nueva se come unos 2 s esperando a que falle
el intento por IPv6.

**El puerto 5433 esta ocupado**

```bash
netstat -ano | findstr :5433             # mira que PID lo tiene
```

Si es otro Postgres tuyo, cambia `PGPORT` en `.env` y el mapeo de puertos en
`docker-compose.yml` (manten el prefijo `127.0.0.1:`).

**`buscar_kb` no aparece en Claude Desktop**

1. Comprueba que el JSON es valido: una coma de mas rompe el archivo entero y
   Claude Desktop no carga *ningun* servidor MCP.
2. Cierra Claude Desktop del todo, incluida la bandeja del sistema. Un reinicio
   de ventana no basta.
3. Prueba el comando a mano. Deberia quedarse esperando sin imprimir nada, que
   es lo normal en un servidor stdio:
   ```bash
   uv run --directory ~/kb-seo kb-mcp
   ```
4. Mira los logs en `%APPDATA%\Claude\logs\`.

**`buscar_kb` responde pero sin resultados**

Llama a `estado_kb()`. Si dice 0 documentos, la base esta vacia: anade fuentes
a `sources.yaml` y ejecuta `uv run ingest all`.

**El contenedor no arranca o se queda "unhealthy"**

```bash
docker compose logs db
```

Si cambiaste las contrasenas del `.env` despues de crear el volumen, los roles
siguen con las viejas: `init.sql` ya no se vuelve a ejecutar. O revierte el
`.env`, o cambia las contrasenas con `ALTER ROLE` via `sql/migrate.sql`.

**Los tests y tus datos**

La suite ingiere una copia temporal del fixture con una url unica por ejecucion
y la etiqueta con la plataforma `test-suite`. Ejecutar `pytest` no toca ninguna
de tus fuentes. Hay un test de regresion (`test_no_toca_documentos_ajenos`) que
lo comprueba.

**Los tests se saltan solos**

Es a proposito. Los tests que necesitan Postgres u Ollama se marcan como
`skipped` si el servicio no responde, en vez de fallar. `uv run pytest -q -rs`
te dice el motivo de cada salto.

## Mejoras futuras (fuera de alcance por ahora)

- **Exponer el MCP a claude.ai web/movil** mediante un tunel. Hoy el servidor es
  stdio y solo funciona en esta maquina.
- **Ingesta automatica de exports de YouTube Studio**, para cruzar la teoria de
  la base de conocimiento con los datos reales de Candisito y Smooth.
- **Re-ranking con un cross-encoder** despues del RRF, para afinar el orden de
  los 8 resultados finales.
