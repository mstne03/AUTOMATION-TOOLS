//! Shell Tauri mínimo: lanza el sidecar `app-backend` con un token por arranque,
//! lee la primera línea de su stdout (`{"port": N, "token": "..."}`), expone
//! `{port, token}` a la UI con el comando `sidecar_info` y mata el proceso al salir.
//!
//! El token no se escribe en disco ni en logs: solo viaja por la variable de entorno
//! del hijo y por el comando `invoke` hacia el WebView.
//!
//! En desarrollo (`debug_assertions`) el sidecar es `uv run app-backend`; en release es
//! el binario de PyInstaller que Tauri arrastra como `externalBin` (`binaries/`), con la
//! carpeta `_internal` junto a él como recurso. En ambos casos el hijo se ata a un Job
//! Object con KILL_ON_JOB_CLOSE: si la app muere de cualquier forma (crash, `taskkill /F`)
//! el kernel cierra el handle del job y mata al sidecar; sin esto quedaba huérfano.
//!
//! Instancia única: un mutex `Local\SEOStudio-<identifier>` se adquiere en `setup`, antes de
//! lanzar el sidecar. Una segunda instancia avisa y sale sin arrancar otro backend.
//!
//! Importar (`importar_recurso`) y exportar (`exportar_mp4`) copian por handle único (I6): la UI
//! no envía ni recibe rutas, solo un id de bandeja de 32 hex o el id del proyecto.
//!
//! El updater corre en Rust (comandos `update_check` / `update_install`), y el diálogo
//! para elegir el vídeo (`elegir_video`) o una carpeta (`elegir_carpeta`) y abrir enlaces en el navegador (`abrir_url`)
//! también, así que el WebView sigue sin ningún permiso más allá de `core:default`.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use rand::RngCore;
use serde::Serialize;
use tauri::{Manager, RunEvent};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_updater::UpdaterExt;

#[derive(Clone, Serialize)]
pub struct SidecarInfo {
    port: u16,
    token: String,
}

#[derive(Default)]
struct Sidecar {
    info: Mutex<Option<SidecarInfo>>,
    child: Mutex<Option<CommandChild>>,
    failed: Mutex<Option<String>>,
    /// Vive tanto como la app: al cerrarse el handle (incluso por crash) muere el hijo.
    job: Mutex<Option<win32job::Job>>,
}

/// Espera (hasta 60 s) a que el sidecar haya anunciado su puerto.
#[tauri::command]
async fn sidecar_info(state: tauri::State<'_, Sidecar>) -> Result<SidecarInfo, String> {
    for _ in 0..600 {
        if let Some(info) = state.info.lock().unwrap().clone() {
            return Ok(info);
        }
        if let Some(err) = state.failed.lock().unwrap().clone() {
            return Err(err);
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    Err("El sidecar no ha arrancado en 60 s.".into())
}

fn random_token() -> String {
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Ata el proceso `pid` a un Job Object nuevo con KILL_ON_JOB_CLOSE y lo devuelve.
/// Solo el sidecar entra en el job (no la propia app): así el instalador que lanza el
/// updater antes de salir no queda atado y no muere con nosotros.
fn job_for(pid: u32) -> Result<win32job::Job, String> {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
    };

    let job = win32job::Job::create().map_err(|e| e.to_string())?;
    let mut info = job.query_extended_limit_info().map_err(|e| e.to_string())?;
    info.limit_kill_on_job_close();
    job.set_extended_limit_info(&info)
        .map_err(|e| e.to_string())?;
    let handle = unsafe { OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid) };
    if handle.is_null() {
        return Err(format!(
            "OpenProcess({pid}): {}",
            std::io::Error::last_os_error()
        ));
    }
    let r = job
        .assign_process(handle as isize)
        .map_err(|e| e.to_string());
    unsafe { CloseHandle(handle) };
    r.map(|_| job)
}

fn spawn_sidecar(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let token = random_token();

    // Desarrollo: `uv run app-backend` con cwd = app-backend/ (hermano de app-ui/).
    #[cfg(debug_assertions)]
    let command = app
        .shell()
        .command("uv")
        .args(["run", "app-backend"])
        .current_dir(concat!(env!("CARGO_MANIFEST_DIR"), "/../../app-backend"));
    // Release: binario de PyInstaller (externalBin) con `_internal/` en el directorio de
    // recursos, que en Windows es el de instalación (el mismo que el del .exe).
    #[cfg(not(debug_assertions))]
    let command = app
        .shell()
        .sidecar("app-backend")?
        .current_dir(app.path().resource_dir()?);

    let (mut rx, child) = command.env("APP_BACKEND_TOKEN", &token).spawn()?;

    let state = app.state::<Sidecar>();
    match job_for(child.pid()) {
        Ok(job) => *state.job.lock().unwrap() = Some(job),
        // No es fatal: el sidecar funciona igual, solo que un cierre forzoso lo dejaría vivo.
        Err(e) => eprintln!("[tauri] No se pudo atar el sidecar a un Job Object: {e}"),
    }
    *state.child.lock().unwrap() = Some(child);

    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let state = handle.state::<Sidecar>();
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    let text = String::from_utf8_lossy(&line);
                    // El guard se suelta en esta línea: dentro del `if` se vuelve a bloquear el
                    // mismo Mutex, y con el guard vivo en la condición sería un interbloqueo.
                    let sin_puerto = state.info.lock().unwrap().is_none();
                    if sin_puerto
                        && let Ok(v) = serde_json::from_str::<serde_json::Value>(&text)
                        && let Some(port) = v.get("port").and_then(|p| p.as_u64())
                    {
                        // No se registra la línea: contiene el token.
                        *state.info.lock().unwrap() = Some(SidecarInfo {
                            port: port as u16,
                            token: token.clone(),
                        });
                        continue;
                    }
                    eprint!("[sidecar] {text}");
                }
                CommandEvent::Stderr(line) => {
                    eprint!("[sidecar] {}", String::from_utf8_lossy(&line))
                }
                CommandEvent::Error(e) => {
                    *state.failed.lock().unwrap() = Some(format!("Error del sidecar: {e}"));
                }
                CommandEvent::Terminated(status) => {
                    if state.info.lock().unwrap().is_none() {
                        *state.failed.lock().unwrap() = Some(format!(
                            "El sidecar terminó antes de arrancar (código {:?}).",
                            status.code
                        ));
                    }
                    break;
                }
                _ => {}
            }
        }
    });
    Ok(())
}

fn kill_sidecar(app: &tauri::AppHandle) {
    if let Some(child) = app.state::<Sidecar>().child.lock().unwrap().take() {
        let _ = child.kill();
    }
}

// ------------------------------------------------------------------ updater

#[derive(Clone, Serialize)]
pub struct UpdateInfo {
    version: String,
    notes: Option<String>,
}

/// Consulta `latest.json` (plugins.updater.endpoints). `None` si ya estamos al día.
#[tauri::command]
async fn update_check(app: tauri::AppHandle) -> Result<Option<UpdateInfo>, String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    let update = updater.check().await.map_err(|e| e.to_string())?;
    Ok(update.map(|u| UpdateInfo {
        version: u.version.clone(),
        notes: u.body.clone(),
    }))
}

/// Descarga el instalador, verifica su firma minisign con la clave pública embebida,
/// cierra el sidecar y lanza el instalador (modo pasivo), que reinicia la app al acabar.
/// En Windows el plugin sale con `std::process::exit(0)`: no pasa por `RunEvent::Exit`.
#[tauri::command]
async fn update_install(app: tauri::AppHandle) -> Result<(), String> {
    let handle = app.clone();
    let updater = app
        .updater_builder()
        .on_before_exit(move || kill_sidecar(&handle))
        .build()
        .map_err(|e| e.to_string())?;
    let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
        return Err("No hay ninguna actualización pendiente.".into());
    };
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|e| e.to_string())
}

// ------------------------------------------------------------------ diálogo

const EXTENSIONES_VIDEO: [&str; 5] = ["mp4", "mov", "mkv", "webm", "avi"];

/// Abre el explorador de Windows en `dir_inicial` (la primera carpeta permitida) filtrado a
/// vídeo y devuelve la ruta elegida, o `None` si se cancela. Es comodidad, no control de
/// acceso: el sidecar sigue validando la ruta contra la lista blanca (`resolve_allowed`).
/// Comando `async` para que el diálogo bloqueante no corra en el hilo principal.
#[tauri::command]
async fn elegir_video(app: tauri::AppHandle, dir_inicial: String) -> Option<String> {
    let mut dialogo = app.dialog().file().add_filter("Vídeo", &EXTENSIONES_VIDEO);
    if !dir_inicial.is_empty() && std::path::Path::new(&dir_inicial).is_dir() {
        dialogo = dialogo.set_directory(&dir_inicial);
    }
    let ruta = dialogo.blocking_pick_file()?;
    ruta.into_path()
        .ok()
        .map(|p| p.to_string_lossy().into_owned())
}

/// Abre el explorador de Windows filtrado a `.json` para elegir el `client_secret.json` de Google
/// (Onboarding). Devuelve la ruta o `None` si se cancela; el sidecar lee y valida el fichero.
#[tauri::command]
async fn elegir_client_secret(app: tauri::AppHandle) -> Option<String> {
    let ruta = app
        .dialog()
        .file()
        .add_filter("Credenciales de Google (JSON)", &["json"])
        .blocking_pick_file()?;
    ruta.into_path()
        .ok()
        .map(|p| p.to_string_lossy().into_owned())
}

/// Abre el explorador de Windows para elegir una carpeta (Ajustes → Carpetas permitidas), situado
/// en `dir_inicial` si existe. Devuelve `None` si se cancela. Comodidad, no control de acceso:
/// el sidecar guarda la lista y valida cada ruta al usarla (`resolve_allowed`).
#[tauri::command]
async fn elegir_carpeta(app: tauri::AppHandle, dir_inicial: String) -> Option<String> {
    let mut dialogo = app.dialog().file();
    if !dir_inicial.is_empty() && std::path::Path::new(&dir_inicial).is_dir() {
        dialogo = dialogo.set_directory(&dir_inicial);
    }
    let ruta = dialogo.blocking_pick_folder()?;
    ruta.into_path()
        .ok()
        .map(|p| p.to_string_lossy().into_owned())
}

// ------------------------------------------------------------------ enlaces

/// Solo `https://` y sin espacios ni caracteres de control. Las URLs del chat las escribe el
/// modelo (entrada no confiable): nada de `file:`, `javascript:` ni `http:`.
fn url_https_valida(url: &str) -> bool {
    url.len() > "https://".len()
        && url.starts_with("https://")
        && !url.chars().any(|c| c.is_whitespace() || c.is_control())
}

/// Abre `url` en el navegador del sistema (mismo patrón que `elegir_video`).
#[tauri::command]
fn abrir_url(app: tauri::AppHandle, url: String) -> Result<(), String> {
    if !url_https_valida(&url) {
        return Err("Solo se abren enlaces https://".into());
    }
    #[allow(deprecated)]
    app.shell().open(url, None).map_err(|e| e.to_string())
}

// ------------------------------------------------- importar y exportar (I6)

const MB: u64 = 1024 * 1024;
/// Tope del MP4 exportado: un render largo pesa cientos de MB; esto solo corta lo absurdo.
const LIMITE_MP4: u64 = 8 * 1024 * MB;

/// `APP_BACKEND_DIR` o `%LOCALAPPDATA%\seo-studio`, igual que `config.py` (un valor vacío
/// cuenta como ausente, como en `os.environ.get(...) or ...`).
fn dir_estado_desde(
    app_backend_dir: Option<String>,
    local_app_data: Option<String>,
    home: Option<PathBuf>,
) -> PathBuf {
    // A27-8: nunca una ruta relativa (colgaría del cwd). Vacío o relativo cuenta como ausente.
    if let Some(d) = app_backend_dir.filter(|d| Path::new(d).is_absolute()) {
        return PathBuf::from(d);
    }
    let base = local_app_data
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .or(home.filter(|p| p.is_absolute()))
        .unwrap_or_else(std::env::temp_dir);
    base.join("seo-studio")
}

fn dir_estado() -> PathBuf {
    dir_estado_desde(
        std::env::var("APP_BACKEND_DIR").ok(),
        std::env::var("LOCALAPPDATA").ok(),
        std::env::home_dir(),
    )
}

/// `(nombre del filtro, extensiones, límite en bytes)` de una clase de lista cerrada (I15).
fn clase_info(clase: &str) -> Result<(&'static str, &'static [&'static str], u64), String> {
    match clase {
        "foto" => Ok(("Foto", &["jpg", "jpeg", "png", "webp"], 50 * MB)),
        "clip" => Ok(("Clip de vídeo", &["mp4", "mov", "webm"], 500 * MB)),
        "musica" => Ok(("Música", &["mp3", "wav", "flac", "ogg", "m4a"], 100 * MB)),
        _ => Err("Clase de recurso no válida.".into()),
    }
}

/// `^video\d{3}$`, solo dígitos ASCII (el mismo patrón que el backend, sin `..`, `:` ni rutas).
fn validar_id(id: &str) -> Result<(), String> {
    let b = id.as_bytes();
    if b.len() == 8 && id.starts_with("video") && b[5..].iter().all(u8::is_ascii_digit) {
        Ok(())
    } else {
        Err("Identificador de proyecto no válido.".into())
    }
}

/// Abre `ruta` **una sola vez**, sin seguir puntos de reanálisis, y comprueba sobre el handle:
/// fichero de disco normal (ni carpeta, ni junction o symlink, ni tubería), un único enlace
/// duro y tamaño ≤ `limite`. Todo lo demás se hace desde este handle, sin reabrir la ruta.
fn abrir_regular(ruta: &Path, limite: u64) -> Result<File, String> {
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT,
        FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_TYPE_DISK,
        GetFileInformationByHandle, GetFileType,
    };

    const NO: &str = "El fichero elegido no se puede importar.";
    let file = std::fs::OpenOptions::new()
        .read(true)
        // Otros pueden leer y borrar/renombrar (el render sustituye `video.mp4` con rename), pero
        // no escribir: no se copia un fichero a medio escribir.
        .share_mode(0x1 | 0x4)
        // BACKUP_SEMANTICS deja abrir carpetas y junctions: así los rechaza la comprobación de
        // atributos de abajo, no un fallo incidental de `open`.
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS)
        .open(ruta)
        .map_err(|_| NO.to_string())?;
    let h = file.as_raw_handle();
    // SAFETY: `h` es el handle vivo de `file`; `info` es una estructura de salida del tamaño correcto.
    let (tipo, ok, info) = unsafe {
        let mut info: BY_HANDLE_FILE_INFORMATION = std::mem::zeroed();
        (
            GetFileType(h),
            GetFileInformationByHandle(h, &mut info),
            info,
        )
    };
    if tipo != FILE_TYPE_DISK || ok == 0 {
        return Err(NO.into());
    }
    if info.dwFileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY) != 0 {
        return Err(
            "No se admiten enlaces, carpetas ni ficheros de OneDrive; cópialo fuera de OneDrive."
                .into(),
        );
    }
    if info.nNumberOfLinks != 1 {
        return Err("No se admiten enlaces duros.".into());
    }
    let tam = (u64::from(info.nFileSizeHigh) << 32) | u64::from(info.nFileSizeLow);
    if tam > limite {
        return Err(format!(
            "El fichero supera el límite de {} MB.",
            limite / MB
        ));
    }
    Ok(file)
}

/// Copia como mucho `limite` bytes; si hay más (el fichero creció tras la comprobación) falla.
fn copiar_limitado(
    origen: &mut impl Read,
    destino: &mut impl Write,
    limite: u64,
) -> Result<u64, String> {
    let n = std::io::copy(&mut origen.take(limite + 1), destino)
        .map_err(|_| "No se pudo copiar el fichero.".to_string())?;
    if n > limite {
        return Err(format!(
            "El fichero supera el límite de {} MB.",
            limite / MB
        ));
    }
    Ok(n)
}

/// Copia el contenido de `origen` a `destino`, que **no puede existir**. Si algo falla, no deja
/// un destino a medias.
fn copiar_a_destino_nuevo(origen: &mut File, destino: &Path, limite: u64) -> Result<(), String> {
    let mut out = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destino)
        .map_err(|e| match e.kind() {
            std::io::ErrorKind::AlreadyExists => EXISTE.to_string(),
            _ => "No se pudo crear el fichero de destino.".to_string(),
        })?;
    let r = copiar_limitado(origen, &mut out, limite).and_then(|_| {
        out.sync_all()
            .map_err(|_| "No se pudo terminar la copia.".to_string())
    });
    if r.is_err() {
        drop(out);
        let _ = std::fs::remove_file(destino);
    }
    r
}

const EXISTE: &str = "El destino ya existe; elige otro nombre.";

/// Importa `origen` a `dir/<32 hex>.bin` y devuelve el id (los 32 hex, nunca la ruta).
/// La copia va a `<id>.parcial` y entra como `.bin` con un rename al terminar: el motor nunca ve
/// un `.bin` a medias, y lo que deja un proceso muerto a media copia lo barre el motor (A27-3).
fn copiar_a_bandeja(origen: &Path, dir: &Path, limite: u64) -> Result<String, String> {
    let mut f = abrir_regular(origen, limite)?;
    std::fs::create_dir_all(dir).map_err(|_| "No se pudo preparar la bandeja.".to_string())?;
    // A27-8: la bandeja ni su carpeta `video` pueden ser un enlace o una junction (el motor tampoco la leería).
    for d in [Some(dir), dir.parent()].into_iter().flatten() {
        if std::fs::symlink_metadata(d).map_or(true, |m| m.file_type().is_symlink()) {
            return Err("La carpeta de la bandeja no es válida.".into());
        }
    }
    for _ in 0..3 {
        let mut bytes = [0u8; 16];
        rand::rng().fill_bytes(&mut bytes);
        let id: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
        let parcial = dir.join(format!("{id}.parcial"));
        let bin = dir.join(format!("{id}.bin"));
        if bin.exists() {
            continue;
        }
        match copiar_a_destino_nuevo(&mut f, &parcial, limite) {
            Ok(()) => {
                return std::fs::rename(&parcial, &bin).map(|_| id).map_err(|_| {
                    let _ = std::fs::remove_file(&parcial);
                    "No se pudo terminar la copia.".to_string()
                });
            }
            // Colisión de id (prácticamente imposible): se reintenta desde el principio.
            Err(e) if e == EXISTE => {
                f.seek(SeekFrom::Start(0))
                    .map_err(|_| "No se pudo copiar el fichero.".to_string())?;
            }
            Err(e) => return Err(e),
        }
    }
    Err("No se pudo reservar un identificador de bandeja.".into())
}

/// Copia `origen` (el MP4 del proyecto) al `destino` elegido; el destino no se pisa.
fn exportar_a(origen: &Path, destino: &Path, limite: u64) -> Result<(), String> {
    let mut f = abrir_regular(origen, limite)?;
    copiar_a_destino_nuevo(&mut f, destino, limite)
}

/// Diálogo de abrir con filtro por clase; copia el fichero a la bandeja y devuelve su id (32 hex)
/// o `None` si se cancela. La UI no recibe ni envía ninguna ruta.
#[tauri::command]
async fn importar_recurso(app: tauri::AppHandle, clase: String) -> Result<Option<String>, String> {
    let (nombre, extensiones, limite) = clase_info(&clase)?;
    let Some(elegido) = app
        .dialog()
        .file()
        .add_filter(nombre, extensiones)
        .blocking_pick_file()
    else {
        return Ok(None);
    };
    let origen = elegido
        .into_path()
        .map_err(|_| "Ruta no válida.".to_string())?;
    let dir = dir_estado().join("video").join("bandeja");
    tauri::async_runtime::spawn_blocking(move || copiar_a_bandeja(&origen, &dir, limite))
        .await
        .map_err(|_| "La importación se interrumpió.".to_string())?
        .map(Some)
}

/// Diálogo de guardar; copia `<estado>/video/proyectos/<id>/video.mp4` al destino elegido.
/// `true` = guardado, `false` = diálogo cancelado; cualquier fallo es un `Err` sin rutas.
#[tauri::command]
async fn exportar_mp4(app: tauri::AppHandle, id: String) -> Result<bool, String> {
    validar_id(&id)?;
    let origen = dir_estado()
        .join("video")
        .join("proyectos")
        .join(&id)
        .join("video.mp4");
    let Some(elegido) = app
        .dialog()
        .file()
        .add_filter("Vídeo MP4", &["mp4"])
        .set_file_name(format!("{id}.mp4"))
        .blocking_save_file()
    else {
        return Ok(false);
    };
    let destino = elegido
        .into_path()
        .map_err(|_| "Ruta no válida.".to_string())?;
    tauri::async_runtime::spawn_blocking(move || exportar_a(&origen, &destino, LIMITE_MP4))
        .await
        .map_err(|_| "La exportación se interrumpió.".to_string())??;
    Ok(true)
}

// ------------------------------------------------------------ instancia única

/// Mutex con nombre que vive lo que la app: mientras el handle esté abierto, una segunda
/// instancia no puede adquirirlo. Dos backends compartirían `<estado>/video/` con cerrojos y
/// claves separados (borrados durante un render, voz facturada dos veces).
struct InstanciaUnica(usize);

impl Drop for InstanciaUnica {
    fn drop(&mut self) {
        // SAFETY: `self.0` es el handle devuelto por CreateMutexW, propio de esta estructura y
        // cerrado solo aquí.
        unsafe { windows_sys::Win32::Foundation::CloseHandle(self.0 as _) };
    }
}

/// `Local\SEOStudio-<identifier>`: espacio de nombres de la sesión (nunca `Global\`). El
/// identificador viene de la configuración, pero se valida igual: sin separadores ni espacios.
fn nombre_mutex(identifier: &str) -> Result<String, String> {
    let valido = !identifier.is_empty()
        && identifier.len() <= 100
        && identifier
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'));
    if !valido {
        return Err(format!(
            "Identificador no válido para el mutex: {identifier:?}"
        ));
    }
    Ok(format!(r"Local\SEOStudio-{identifier}"))
}

/// `Err` si el mutex ya existe (otra instancia viva) o no se pudo crear. Falla cerrado.
fn adquirir(nombre: &str) -> Result<InstanciaUnica, String> {
    use windows_sys::Win32::Foundation::{CloseHandle, ERROR_ALREADY_EXISTS, GetLastError};
    use windows_sys::Win32::System::Threading::CreateMutexW;

    let ancho: Vec<u16> = nombre.encode_utf16().chain(std::iter::once(0)).collect();
    // SAFETY: `ancho` es UTF-16 terminado en 0 y vive durante la llamada; sin atributos de seguridad.
    let handle = unsafe { CreateMutexW(std::ptr::null(), 0, ancho.as_ptr()) };
    if handle.is_null() {
        // Incluye ACCESS_DENIED (nombre ocupado por otro objeto): no es «ya abierto».
        return Err(format!(
            "No se pudo reservar la instancia única: {}",
            std::io::Error::last_os_error()
        ));
    }
    // Se lee justo después de la llamada: cualquier otra API pisaría el último error.
    // SAFETY: sin llamadas intermedias; el handle es válido y se cierra una sola vez.
    if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
        unsafe { CloseHandle(handle) };
        return Err("Ya hay otra instancia de SEO Studio abierta.".into());
    }
    Ok(InstanciaUnica(handle as usize))
}

/// Reserva la instancia única antes de lanzar el sidecar. Si ya hay otra, avisa en un
/// diálogo y sale sin arrancar nada; la UI recibe el error en vez de esperar al sidecar.
fn arrancar_con_instancia_unica(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let nombre = nombre_mutex(&app.config().identifier)?;
    match adquirir(&nombre) {
        Ok(instancia) => {
            app.manage(instancia);
            spawn_sidecar(app.handle())
        }
        Err(e) => {
            eprintln!("[tauri] {e}");
            *app.state::<Sidecar>().failed.lock().unwrap() = Some(e.clone());
            let handle = app.handle().clone();
            app.dialog()
                .message(format!(
                    "{e}
Esta ventana se cerrará."
                ))
                .title("SEO Studio")
                .kind(tauri_plugin_dialog::MessageDialogKind::Warning)
                .show(move |_| handle.exit(0));
            Ok(())
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .manage(Sidecar::default())
        .invoke_handler(tauri::generate_handler![
            sidecar_info,
            update_check,
            update_install,
            elegir_video,
            elegir_carpeta,
            elegir_client_secret,
            abrir_url,
            importar_recurso,
            exportar_mp4
        ])
        .setup(|app| arrancar_con_instancia_unica(app))
        .build(tauri::generate_context!())
        .expect("error al construir la aplicación Tauri")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                kill_sidecar(app);
            }
        });
}

#[cfg(test)]
mod tests {
    use super::{adquirir, nombre_mutex, url_https_valida};

    #[test]
    fn segundo_adquirir_falla() {
        // Nombre propio del test: no choca con una app real abierta.
        let nombre = nombre_mutex(&format!("test.instancia.{}", std::process::id())).unwrap();
        let primera = adquirir(&nombre).expect("la primera instancia debe poder adquirir");
        assert!(adquirir(&nombre).is_err(), "la segunda debe fallar");
        drop(primera);
        adquirir(&nombre).expect("al soltar la primera, se puede volver a adquirir");
    }

    #[test]
    fn nombre_local_y_sin_separadores() {
        assert_eq!(
            nombre_mutex("com.seostudio.app").unwrap(),
            r"Local\SEOStudio-com.seostudio.app"
        );
        for malo in ["", r"a\b", "a/b", r"Global\x", "con espacio", "a\0b"] {
            assert!(nombre_mutex(malo).is_err(), "{malo:?}");
        }
    }

    #[test]
    fn solo_https() {
        assert!(url_https_valida(
            "https://console.cloud.google.com/apis/credentials"
        ));
        for mala in [
            "http://x.com",
            "file:///C:/Windows",
            "javascript:alert(1)",
            "https://",
            "https://a b",
            "https://a
b",
            "",
        ] {
            assert!(!url_https_valida(mala), "{mala}");
        }
    }

    // ------------------------------------------------------------ T13: importar y exportar

    use std::io::Read;

    use super::{
        clase_info, copiar_a_bandeja, copiar_a_destino_nuevo, copiar_limitado, dir_estado_desde,
        exportar_a, validar_id,
    };
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU32, Ordering};

    /// Carpeta temporal propia del test, borrada al soltarla (sin dependencias nuevas).
    struct Tmp(PathBuf);
    impl Tmp {
        fn nueva() -> Tmp {
            static N: AtomicU32 = AtomicU32::new(0);
            let d = std::env::temp_dir().join(format!(
                "seo-studio-t13-{}-{}",
                std::process::id(),
                N.fetch_add(1, Ordering::SeqCst)
            ));
            fs::create_dir_all(&d).unwrap();
            Tmp(d)
        }
        fn fichero(&self, nombre: &str, contenido: &[u8]) -> PathBuf {
            let p = self.0.join(nombre);
            fs::write(&p, contenido).unwrap();
            p
        }
        fn bandeja(&self) -> PathBuf {
            self.0.join("bandeja")
        }
    }
    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn vacia(dir: &Path) -> bool {
        fs::read_dir(dir)
            .map(|mut d| d.next().is_none())
            .unwrap_or(true)
    }

    #[test]
    fn la_bandeja_no_deja_parciales_y_rechaza_un_enlace() {
        let t = Tmp::nueva();
        let o = t.fichero("a.png", b"contenido");
        let id = copiar_a_bandeja(&o, &t.bandeja(), 100).unwrap();
        let nombres: Vec<String> = fs::read_dir(t.bandeja())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(nombres, vec![format!("{id}.bin")]);
        #[cfg(windows)]
        {
            let real = t.0.join("real");
            fs::create_dir_all(&real).unwrap();
            let enlace = t.0.join("enlace");
            if std::os::windows::fs::symlink_dir(&real, &enlace).is_ok() {
                assert!(copiar_a_bandeja(&o, &enlace, 100).is_err());
                assert!(vacia(&real));
            }
        }
        #[cfg(unix)]
        {
            let real = t.0.join("real");
            fs::create_dir_all(&real).unwrap();
            let enlace = t.0.join("enlace");
            std::os::unix::fs::symlink(&real, &enlace).unwrap();
            assert!(copiar_a_bandeja(&o, &enlace, 100).is_err());
            assert!(vacia(&real));
        }
    }

    #[test]
    fn copia_a_la_bandeja_con_id_de_32_hex() {
        let t = Tmp::nueva();
        let o = t.fichero("a.png", b"contenido");
        let id = copiar_a_bandeja(&o, &t.bandeja(), 100).unwrap();
        assert_eq!(id.len(), 32);
        assert!(
            id.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        );
        assert_eq!(
            fs::read(t.bandeja().join(format!("{id}.bin"))).unwrap(),
            b"contenido"
        );
        let id2 = copiar_a_bandeja(&o, &t.bandeja(), 100).unwrap();
        assert_ne!(id, id2, "ids de un solo uso, distintos");
    }

    #[test]
    fn rechaza_symlink() {
        let t = Tmp::nueva();
        let o = t.fichero("real.png", b"x");
        let l = t.0.join("enlace.png");
        if std::os::windows::fs::symlink_file(&o, &l).is_err() {
            // Sin privilegio de symlinks (modo desarrollador desactivado): la CI de Windows sí lo tiene.
            eprintln!("rechaza_symlink: no se pudo crear el symlink, omitido");
            return;
        }
        assert!(copiar_a_bandeja(&l, &t.bandeja(), 100).is_err());
        assert!(vacia(&t.bandeja()));
    }

    #[test]
    fn rechaza_hardlink() {
        let t = Tmp::nueva();
        let o = t.fichero("real.png", b"x");
        let h = t.0.join("duro.png");
        fs::hard_link(&o, &h).unwrap();
        assert!(copiar_a_bandeja(&h, &t.bandeja(), 100).is_err());
        assert!(
            copiar_a_bandeja(&o, &t.bandeja(), 100).is_err(),
            "el original también tiene 2 enlaces"
        );
        assert!(vacia(&t.bandeja()));
    }

    #[test]
    fn rechaza_junction() {
        let t = Tmp::nueva();
        let destino = t.0.join("carpeta");
        fs::create_dir(&destino).unwrap();
        let j = t.0.join("junction");
        let ok = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&j)
            .arg(&destino)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        assert!(ok, "mklink /J no necesita privilegios: debe poder crearse");
        // Se comprueba el texto: así falla si rechaza otra cosa (un fallo de `open`) y no el filtro.
        for ruta in [&j, &destino] {
            let e = copiar_a_bandeja(ruta, &t.bandeja(), 100).unwrap_err();
            assert!(e.starts_with("No se admiten enlaces, carpetas"), "{e}");
        }
        assert!(vacia(&t.bandeja()));
    }

    #[test]
    fn rechaza_grande() {
        let t = Tmp::nueva();
        let o = t.fichero("g.png", &[0u8; 11]);
        assert!(copiar_a_bandeja(&o, &t.bandeja(), 10).is_err());
        assert!(
            copiar_a_bandeja(&o, &t.bandeja(), 11).is_ok(),
            "justo en el límite pasa"
        );
        // Si el fichero crece tras la comprobación, la copia se corta en limite + 1.
        let mut leido = std::io::repeat(7).take(1_000);
        let mut salida = Vec::new();
        assert!(copiar_limitado(&mut leido, &mut salida, 10).is_err());
        assert!(salida.len() <= 11);
    }

    #[test]
    fn rechaza_dispositivos_y_no_deja_destino_a_medias() {
        let t = Tmp::nueva();
        // `NUL` abre como dispositivo de caracteres, no como fichero de disco.
        assert!(copiar_a_bandeja(Path::new("NUL"), &t.bandeja(), 100).is_err());
        // Si la copia falla a medias (el fichero creció tras la comprobación), se borra el destino.
        let o = t.fichero("crece.bin", &[1u8; 20]);
        let mut f = fs::File::open(&o).unwrap();
        let d = t.0.join("parcial.bin");
        assert!(copiar_a_destino_nuevo(&mut f, &d, 10).is_err());
        assert!(!d.exists());
        assert!(vacia(&t.bandeja()));
    }

    #[test]
    fn id_invalido() {
        assert!(validar_id("video001").is_ok());
        assert!(validar_id("video999").is_ok());
        for malo in [
            "",
            "video",
            "video1",
            "video12",
            "video1234",
            "Video001",
            "VIDEO001",
            "video00a",
            "video001 ",
            " video001",
            "video001\n",
            "../video001",
            "video001/..",
            r"video001\x",
            "video:01",
            "video٠٠١",
            r"C:\video001",
            "video001.mp4",
        ] {
            assert!(validar_id(malo).is_err(), "{malo:?}");
        }
    }

    #[test]
    fn clase_invalida() {
        for buena in ["foto", "clip", "musica"] {
            assert!(clase_info(buena).is_ok(), "{buena}");
        }
        assert_eq!(clase_info("foto").unwrap().2, 50 * 1024 * 1024);
        assert_eq!(clase_info("clip").unwrap().2, 500 * 1024 * 1024);
        assert_eq!(clase_info("musica").unwrap().2, 100 * 1024 * 1024);
        for mala in ["", "Foto", "fotos", "video", "../foto", "foto ", "*"] {
            assert!(clase_info(mala).is_err(), "{mala:?}");
        }
    }

    #[test]
    fn destino_no_se_pisa() {
        let t = Tmp::nueva();
        let o = t.fichero("video.mp4", b"nuevo");
        let d = t.fichero("elegido.mp4", b"previo");
        assert!(exportar_a(&o, &d, 100).is_err());
        assert_eq!(fs::read(&d).unwrap(), b"previo");
        let libre = t.0.join("libre.mp4");
        exportar_a(&o, &libre, 100).unwrap();
        assert_eq!(fs::read(&libre).unwrap(), b"nuevo");
    }

    #[test]
    fn exportar_rechaza_enlaces_y_grandes() {
        let t = Tmp::nueva();
        let o = t.fichero("video.mp4", b"0123456789");
        fs::hard_link(&o, t.0.join("otro.mp4")).unwrap();
        let d = t.0.join("d.mp4");
        assert!(exportar_a(&o, &d, 100).is_err());
        assert!(!d.exists(), "no deja destino a medias");
        let o2 = t.fichero("v2.mp4", b"0123456789");
        assert!(exportar_a(&o2, &d, 5).is_err());
        assert!(!d.exists());
    }

    #[test]
    fn dir_estado_sigue_a_config_py() {
        let p = |s: &str| Some(s.to_string());
        let home = Some(PathBuf::from(r"C:\Users\x"));
        assert_eq!(
            dir_estado_desde(p(r"D:\estado"), p(r"C:\L"), home.clone()),
            PathBuf::from(r"D:\estado")
        );
        assert_eq!(
            dir_estado_desde(None, p(r"C:\L"), home.clone()),
            PathBuf::from(r"C:\L\seo-studio")
        );
        // Vacío cuenta como ausente, igual que `os.environ.get(...) or ...` en Python.
        assert_eq!(
            dir_estado_desde(p(""), p(""), home),
            PathBuf::from(r"C:\Users\x\seo-studio")
        );
        // Relativo cuenta como ausente (A27-8), igual que `_absoluta` en config.py.
        assert_eq!(
            dir_estado_desde(p("estado"), p(r"seo\L"), Some(PathBuf::from(r"C:\Users\x"))),
            PathBuf::from(r"C:\Users\x\seo-studio")
        );
        // Cruzado por literal con el backend: si config.py cambia, este test avisa.
        let config = include_str!("../../../app-backend/app_backend/config.py");
        for literal in [
            r#"_absoluta(os.environ.get("APP_BACKEND_DIR"))"#,
            r#"_absoluta(os.environ.get("LOCALAPPDATA"))"#,
            r#"/ "seo-studio""#,
            r#"STATE_DIR / "video" / "proyectos""#,
        ] {
            assert!(
                config.contains(literal),
                "config.py ya no contiene {literal}"
            );
        }
    }
}
