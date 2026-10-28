# SEO Studio

Aplicación de escritorio para Windows con un agente de IA que analiza tu canal de YouTube, consulta
una base de conocimiento sobre SEO y algoritmos de redes sociales y publica vídeos rellenando
título, descripción y metadatos.

| Carpeta | Qué es |
|---|---|
| [`app-ui/`](app-ui/) | Interfaz de escritorio (Tauri 2 + React) |
| [`app-backend/`](app-backend/) | Sidecar local (FastAPI) con el agente y el gate de aprobación |
| [`kb-seo/`](kb-seo/) | Base de conocimiento: ingesta, búsqueda híbrida y servidor MCP |
| [`youtube-mcp-server/`](youtube-mcp-server/) | Herramientas de YouTube Data, Analytics y Reporting API |

## Licencia

El código es **source-available, no open source**: se distribuye bajo
[PolyForm Shield 1.0.0](LICENSE). Puedes leerlo, usarlo, modificarlo y redistribuirlo para
cualquier fin, también comercial (por ejemplo, para gestionar un canal monetizado), **excepto
para ofrecer un producto que compita con SEO Studio**, sea de pago o gratuito.

Excepciones:

- `youtube-mcp-server/` parte de
  [pauling-ai/youtube-studio-mcp](https://github.com/pauling-ai/youtube-studio-mcp), bajo licencia
  MIT (Copyright (c) 2026 Pauling Inc., aviso en
  [`youtube-mcp-server/LICENSE`](youtube-mcp-server/LICENSE)). Los cambios hechos en este
  repositorio están bajo PolyForm Shield 1.0.0.
- Las dependencias de terceros conservan sus propias licencias.

## Seguridad

Si encuentras una vulnerabilidad, no abras una issue pública: usa
[Report a vulnerability](https://github.com/mstne03/AUTOMATION-TOOLS/security/advisories/new).
