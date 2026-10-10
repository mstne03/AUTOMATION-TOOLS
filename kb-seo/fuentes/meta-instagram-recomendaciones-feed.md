# Sistema de IA de recomendaciones del feed de Instagram (Meta, Centro de Transparencia)

> Capturado el 2026-09-27. Ultima actualizacion declarada por Meta: 29 jun 2026.
> Original: https://transparency.meta.com/features/explaining-ranking/ig-feed-recommendations/
> Se renderiza por JavaScript y trafilatura no la puede leer, por eso se guarda
> aqui como archivo local.
>
> Es la fuente oficial mas reciente de las que hay en esta base.

Cubre el **contenido sugerido** en el feed: cuentas, publicaciones o reels que
no sigues. No cubre el contenido conectado (de cuentas que si sigues) ni los
anuncios, que usan otros sistemas.

## Como funciona

1. **Reunir un inventario.** Recopila parte del contenido publico de Instagram:
   fotos y videos que cumplan las reglas de calidad e integridad.
2. **Analizar senales.** Evalua senales sobre el contenido, como la forma en que
   interactuaste con contenido similar o con tus intereses.
3. **Clasificar.** El contenido con mayor valor predicho aparece antes.

## Las predicciones del modelo y sus senales

### Que tan informativa es una publicacion

- Esta senal **se genera exclusivamente mediante un LLM** para evaluar la
  calidad del contenido de la publicacion.

> Dato relevante: Meta declara aqui que usa un modelo de lenguaje para juzgar
> calidad de contenido como senal de clasificacion.

### Probabilidad de que marques "Me interesa"

- La lista de archivos multimedia que volviste a compartir.
- Impresiones que hiciste en contenido recomendado, dentro del feed y al final
  del feed.
- Cuantas veces otros espectadores visitaron el perfil del autor despues de ver
  la publicacion.
- Plataformas de Instagram que visitaste antes de la publicacion actual.

### Tiempo que pasaras en Reels tras hacer clic en una publicacion de Reels desde el feed

- Contador de proporcion de interaccion a VPVD.
- Cuantas veces entras al feed de Reels en siete dias.
- Plataforma del dispositivo (iOS o Android).
- Cuantas veces ves un video con sonido activado en siete dias.
- **Tiempo que dedicaste a un autor en los ultimos 84 dias.**

### Probabilidad de que sigas desplazandote tras ver la publicacion en posicion superior

- Plataforma del dispositivo.
- Impresiones sobre contenido de antiguedad especifica (1-3 dias, 8-14 dias,
  14-21 dias) en periodos de 7 dias.
- Cantidad de reels vistos en 12 horas.

### Probabilidad de que te desplaces a la siguiente publicacion

- Cuantas veces otras personas se desplazaron a la siguiente tras ver esta.
- Cuantas veces viste la siguiente publicacion o te desplazaste a ella.

### Probabilidad de que hagas clic en el perfil del autor

- Cuantas veces viste el perfil del autor y sus publicaciones.
- Cuantas veces los seguidores hicieron clic en su perfil.
- Cuantas veces otras personas hicieron clic en su perfil.

### Probabilidad de que hagas clic para comentar

- Cuantas veces hiciste clic en "Ver todos los comentarios".
- Cuantas veces hiciste clic para comentar publicaciones.

### Probabilidad de que omitas la primera publicacion del feed

- Cuantas veces abriste la app en los ultimos siete dias.
- Cuantas veces viste videos de seguidores en una posicion concreta del feed.
- Cuantas veces viste historias.
- Cuantas veces viste videos en una posicion concreta del feed.

### Probabilidad de que hagas clic en un reel para verlo en pantalla completa

- Cuantas veces abriste la app en los ultimos siete dias.
- Cuantos reels abriste en pantalla completa.
- Plataforma del dispositivo (web, Android o iOS).

### Probabilidad de que actives el audio de un video

- Cuantas veces reprodujiste en bucle otras publicaciones con video.
- **Cuantas veces otras personas activaron el audio en esa publicacion.**
- Cuantas veces activaste el audio en otras publicaciones.
- Tiempo que dedicaste a otras publicaciones con video.

## Controles del espectador

"No me interesa" (deja de mostrar publicaciones de ese autor y degrada contenido
similar), administrar contenido sugerido, reportar, ocultar, ver contenido no
personalizado con la pestana "Seguidos", y guardar en una coleccion, que ayuda
al sistema a mostrar contenido similar.
