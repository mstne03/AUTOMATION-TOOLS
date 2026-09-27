# Sistema de IA de reels en cadena de Instagram (Meta, Centro de Transparencia)

> Capturado el 2026-09-27. Ultima actualizacion declarada por Meta: 11 nov 2025.
> Original: https://transparency.meta.com/features/explaining-ranking/ig-reels-chaining/
> Se renderiza por JavaScript y trafilatura no la puede leer, por eso se guarda
> aqui como archivo local.
>
> Esta es la fuente mas granular disponible sobre Reels: Meta publica las
> predicciones concretas del modelo y las senales que alimentan cada una.

## Como funciona

El sistema de IA de reels en cadena decide automaticamente que reels aparecen y
en que orden, prediciendo lo que tiene mas probabilidades de interesarte o
generar interaccion. Cuatro pasos:

1. **Recopilar inventario.** Reune todos los reels potenciales: de cuentas que
   sigues, o similares a aquellos con los que interactuaste recientemente.
2. **Analizar senales.** Evalua senales de cada reel: la duracion, la similitud
   con otros reels y el grado de coincidencia con el contenido con el que sueles
   interactuar. Un modelo sencillo selecciona **aproximadamente 100 reels**.
   Ademas se aplican procesos de integridad que eliminan contenido no
   recomendable.
3. **Hacer predicciones.** Modelos que predicen que contenido te resultara mas
   relevante y valioso.
4. **Clasificar por puntuacion.** Calcula una puntuacion de relevancia para esos
   ~100 reels y los ordena. Los de mayor valor predicho aparecen antes.

## Las predicciones del modelo y sus senales

Esto es lo que Meta declara que el sistema intenta predecir. El orden es el de
la propia pagina.

### Probabilidad de que uses el audio de un reel en uno que crees tu

- Si estuviste viendo reels durante mas de 15 segundos.
- Cuantas veces hiciste clic en el enlace del audio en los reels que viste.
- Cuantas veces hiciste clic en "Usar audio" tras hacer clic en el enlace del
  audio, en proporcion a la cantidad de reels vistos.

### Probabilidad de que veas menos de tres segundos de un reel

- Cuantas veces otros usuarios vieron al menos tres segundos del reel en
  cualquier lugar de Instagram.
- Cuantas veces se descarto el reel.
- Cuantas veces se vieron al menos tres segundos en la seccion Explorar.
- Cuantas veces se vio con el sonido activado.
- **Cuantas veces se omitio la publicacion en los primeros dos segundos desde
  que se abrio.**

### Probabilidad de que marques "Me interesa"

- Los autores de los reels que viste menos de tres segundos.
- Cantidad de personas a las que les gusto el reel.
- Videos que guardaste.
- Publicaciones que volviste a compartir y sus autores.
- Perfiles de autores en los que hiciste clic.

### Probabilidad de que comentes un reel

- Contenido que comentaste en el pasado.
- Tiempo que los espectadores de tu pais dedicaron a este reel.
- Autores a los que comentaste en el pasado, y en la ultima hora.
- Cantidad de comentarios que hiciste en el pasado.

### Probabilidad de que veas mas un reel que el 95% de los usuarios que vieron reels de la misma duracion

- Duracion del reel.
- Cantidad de tiempo que otras personas pasaron viendolo.

> Esta prediccion es importante: la retencion se mide **relativa a otros reels
> de duracion parecida**, no en absoluto. Un reel largo no compite con uno corto.

### Probabilidad de que hagas clic en un reel vertical de Explorar para verlo en pantalla completa

- Cantidad de publicaciones y reels que viste en Explorar.
- Tiempo que pasaste viendo reels.
- Cantidad de reels verticales en los que hiciste clic desde Explorar.

### Probabilidad de que vuelvas a compartir un reel

- Cantidad de tiempo que otras personas pasaron viendolo.
- Publicaciones que volviste a compartir previamente y sus autores.

### Probabilidad de que compartas un reel fuera de Instagram

- Tiempo que pasaste viendo reels.
- Publicaciones que volviste a compartir previamente y sus autores.
- Cuantas veces compartiste una publicacion de forma externa, y cuantas veces
  otras personas compartieron esta.

### Probabilidad de que sigas al autor de un reel

- Cantidad de seguidores que obtuvo el autor gracias al reel.
- Autores que seguiste.

## Controles del espectador

Ver primero los mas recientes (pestana "Siguiendo" en el feed de Reels),
reportar, remix, guardar, "No me interesa", compartir y ajustar el control de
contenido delicado.
