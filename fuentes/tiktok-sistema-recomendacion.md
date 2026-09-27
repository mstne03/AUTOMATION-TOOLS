# Introduccion al sistema de recomendacion de TikTok

> Capturado el 2026-09-27 del centro de seguridad de TikTok.
> Original: https://www.tiktok.com/safety/en/policies-and-engagement/recommendation-system
> Esta pagina se renderiza por JavaScript y trafilatura no la puede leer, por eso
> se guarda aqui como archivo local. Documento vivo: TikTok lo va editando.

## Criterios de diseno del sistema

Mas de mil millones de personas usan TikTok cada mes. El sistema de recomendacion
alimenta el feed Para ti, y TikTok dice construirlo segun estos criterios:

- Ofrecer una experiencia segura para un publico amplio, y en particular para
  adolescentes.
- Respetar los contextos locales y las normas culturales.
- Mantener la neutralidad de contenido: el sistema se disena para ser inclusivo
  con todas las comunidades e imparcial respecto al contenido que recomienda.
- Favorecer las oportunidades de expresion original y creativa.
- Permitir la exploracion de contenido nuevo promoviendo variedad de contenido
  y de temas.

## Como funciona el feed Para ti

Cuando interactuas con contenido, generas senales. El sistema las usa para
calcular una puntuacion de prediccion por video, que estima la probabilidad de
que interactues con el. Los videos con puntuacion mas alta se sirven en tu feed.

TikTok tambien tiene en cuenta como interactuan otros: si otro usuario ha
interactuado con dos videos con los que tu tambien has interactuado, el sistema
puede predecir que te interesara un tercer video que ese usuario vio.

### Los cinco pasos

1. **Seleccion de videos para recomendar.** El sistema recupera un gran numero
   de videos que han pasado la moderacion inicial y son elegibles para el feed.
2. **Prediccion.** Se estima la probabilidad de que interactues con cada video:
   dar me gusta, compartir, comentar o saltarlo. Combinando esas predicciones
   sale una puntuacion global.
3. **Clasificacion.** Se ordenan los videos por puntuacion, de mayor a menor.
4. **Comprobacion de similitud.** Se mide cuanto se parecen entre si los videos
   consecutivos. Si los mejor puntuados son demasiado parecidos (por ejemplo,
   usan el mismo sonido), se sustituyen por otros para garantizar variedad.
5. **Reglas de recomendacion.** Capas adicionales de criterio. Por ejemplo,
   reglas que aseguran que el feed incluya creadores de tu region, y que el
   contenido creado por cuentas de menores de 16 anos no sea recomendable.

## Seguridad dentro del sistema

Las Normas de la comunidad definen que contenido no se permite y que categorias
no son elegibles para recomendacion en el feed Para ti. Cuando se sube un video
pasa por moderacion automatica y humana. El contenido que infringe las normas se
elimina; el que no es adecuado para un publico amplio se marca como no elegible
para recomendacion. Solo los videos que pasan la moderacion entran en el conjunto
de candidatos.

Se limita el contenido abiertamente adulto para cuentas de 13 a 17 anos, y el
contenido creado por cuentas de menores de 16 no es elegible para el feed Para ti.

## Como influir en tu feed

- **No me interesa**: manten pulsado el video y seleccionalo. Limita ese tipo de
  contenido.
- **Filtros de palabras clave**: puedes filtrar palabras y hashtags del feed.
- **Actualizar Para ti**: refresca el feed para explorar lados nuevos de TikTok.

## Apendice: senales, predicciones y datos del video

Lista no exhaustiva. TikTok advierte que las senales son dinamicas y se
actualizan constantemente.

**Senales de personalizacion:**

- Tu region, para alinear las recomendaciones con las normas locales.
- El idioma en que esta configurado tu dispositivo.
- El sistema operativo del dispositivo.
- Videos con los que has interactuado recientemente: vistos, terminados, con me
  gusta o saltados.
- Tus relaciones de seguimiento con otras personas.

**Interacciones que el sistema predice:**

- Dar me gusta, compartir, comentar o marcar como "No me interesa".
- Seguir al autor del video o interactuar con su perfil.
- Terminar, saltar o guardar en favoritos un video.
- Dedicar una cantidad determinada de tiempo a ver un video.
- Tocar la banda sonora del video.

**Senales sobre el propio video:**

- La hora a la que se publico.
- La region desde la que se publico.
- El idioma configurado por el autor.
- La banda sonora.
- La duracion del video.
- Los hashtags asociados.
