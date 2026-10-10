# Pendiente

Estado a 2026-09-28. Lo que quedo sin hacer, por que, y como retomarlo.

---

## 1. Activar el scope `youtube.force-ssl` (RESUELTO 2026-09-29)

Scope anadido y reautorizados los dos canales (`token-candisito.json`,
`token-smooth.json`; `token.json` es el activo). Verificado contra la API real:
`captions.list` OK en `TG_gkik8c_U` (Smooth) y `SlFvN6eJy68` (Candisito), y
`youtube_get_transcript` por stdio devuelve `source: official_api`.

Lo de abajo queda como referencia por si hay que repetirlo.

**Es lo unico que falta.** Todo el codigo de la via oficial esta escrito, probado
con mocks y listo. No funciona en vivo porque el token OAuth actual no tiene el
scope necesario.

### Que se comprobo

Contra la API real, con el token actual:

```
_es_video_propio("TG_gkik8c_U")  ->  (True, None)      OK, sin scope nuevo
captions().list(videoId=...)     ->  403 insufficientPermissions
```

**Dato importante:** `captions.list` tambien exige `force-ssl`, no solo
`captions.download`. La via oficial esta bloqueada entera, no a medias.

Scopes que tiene el token hoy (`~/.youtube-mcp/token.json`):

```
youtube.readonly · youtube · youtube.upload
yt-analytics.readonly · yt-analytics-monetary.readonly
```

### Como activarlo

1. Anadir a `SCOPES` en `src/youtube_mcp/auth.py`:

   ```python
   "https://www.googleapis.com/auth/youtube.force-ssl",
   ```

   `force-ssl` es superconjunto de `youtube`, asi que se podria sustituir. Se
   recomienda **sumarlo sin quitar nada**, para no arriesgar una regresion en
   las demas herramientas.

   **HECHO el 2026-09-29.** Ojo: desde este cambio, un token sin `force-ssl`
   ya no se puede refrescar (Google responde `invalid_scope`, comprobado), y
   `authenticate()` lanza entonces el flujo de navegador desde dentro del
   servidor MCP. No reiniciar Claude Desktop hasta haber reautorizado.

2. **Reautorizar.** El `token.json` actual se queda corto de scopes: hay que
   renovarlo pasando otra vez por el consentimiento de Google en el navegador.
   **Ejecutar `youtube_auth` sin mas NO basta:** `authenticate()` reutiliza el
   token si es valido o refrescable y no abre el navegador. Hay que apartar
   antes `~/.youtube-mcp/token.json` (renombrarlo a `.bak`) para forzar el
   flujo de consentimiento.

3. Reiniciar Claude Desktop.

### Que empieza a funcionar al activarlo

- `youtube_get_transcript` sobre videos **privados, ocultos o programados** del
  canal propio. Hoy devuelve la transcripcion solo si el video es publicamente
  reproducible.
- `youtube_get_transcript(use_official_api=True)`, que hoy falla siempre.
- `youtube_list_captions`, que hoy tambien da 403.

**No hay que tocar ni una linea de codigo.** El flujo ya intenta la via oficial
primero para videos propios y cae al scraping; en cuanto el scope exista, la
primera dejara de fallar y se usara sola.

### Como verificar que quedo bien

```python
from youtube_mcp.tools.transcripts import youtube_get_transcript
r = youtube_get_transcript("<ID de un short tuyo en privado>", "es")
print(r["source"])   # debe decir "official_api", no "youtube-transcript-api"
```

Si sigue cayendo al scraping, mirar `r["notes"]`: lleva el motivo exacto del
fallo de la via oficial.

---

## 2. Cosas menores que quedaron fuera

### Resuelto el 2026-09-29

- **`requirements.txt` borrado.** Era un `pip freeze` del Python global en
  UTF-16 que duplicaba `pyproject.toml` + `uv.lock`. Las dependencias se
  declaran solo en `pyproject.toml`.
- **`.venv/` del repo borrado.** Solo tenia `youtube-transcript-api 0.6.2` y no
  lo usaba nadie. El servidor corre desde el Python global
  (`pythoncore-3.14-64`), con el paquete instalado en modo editable. Cualquier
  `pip install` para el servidor va a ese Python. `pytest` tambien esta ahi.
- **Aviso `file_cache is only supported with oauth2client<4.0.0` eliminado.**
  Los `build()` de `auth.py` usan `cache_discovery=False`, asi que ya no se
  intenta la cache. Verificado por stdio contra la API real: 1 aviso antes y
  0 despues.

### Quota del camino nuevo

`youtube_get_transcript` sobre un video propio gasta ahora un poco mas de cuota
que antes: `videos.list` + `channels.list` (esta segunda cacheada por proceso)
para decidir si el video es tuyo, mas `captions.list`. Son operaciones de
lectura, 1 unidad cada una. Si alguna vez molesta, se puede saltar la deteccion
cuando el llamante ya sabe que el video no es suyo.

---

## 3. Hecho en esta tanda, para contexto

- **Bug `'status'` en `youtube_update_video`**: arreglado. La causa era pedir
  `part="snippet"` en el `update` cuando no se pasaba `privacy_status`, lo que
  hacia que YouTube no devolviera el bloque `status` y que
  `response["status"]["privacyStatus"]` reventara **despues** de haber aplicado
  el cambio. Ahora se pide siempre `snippet,status` y se lee todo con `.get()`.
  Se devuelve ademas `updated_fields` con lo que se toco de verdad.
- Mismo blindaje defensivo en `youtube_upload_video` y `youtube_create_playlist`.
- **`youtube_get_transcript` reordenado**: via oficial primero para videos
  propios, scraping como plan B, y mensajes claros cuando los subtitulos
  automaticos aun no existen.
- SRT convertido a `full_text` + `segments`, para que las dos vias devuelvan el
  mismo formato.
- 26 tests nuevos (`tests/test_transcripts.py`, `tests/test_update_video_status.py`).
  Suite completa: **99 passed**.
