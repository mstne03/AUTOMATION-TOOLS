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
//! El updater corre en Rust (comandos `update_check` / `update_install`), y el diálogo
//! para elegir el vídeo también (`elegir_video`), así que el WebView sigue sin ningún
//! permiso más allá de `core:default`.

use std::sync::Mutex;
use std::time::Duration;

use rand::RngCore;
use serde::Serialize;
use tauri::{Manager, RunEvent};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;
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
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE};

    let job = win32job::Job::create().map_err(|e| e.to_string())?;
    let mut info = job.query_extended_limit_info().map_err(|e| e.to_string())?;
    info.limit_kill_on_job_close();
    job.set_extended_limit_info(&info).map_err(|e| e.to_string())?;
    let handle = unsafe { OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid) };
    if handle.is_null() {
        return Err(format!("OpenProcess({pid}): {}", std::io::Error::last_os_error()));
    }
    let r = job.assign_process(handle as isize).map_err(|e| e.to_string());
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
                    if state.info.lock().unwrap().is_none() {
                        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
                            if let Some(port) = v.get("port").and_then(|p| p.as_u64()) {
                                // No se registra la línea: contiene el token.
                                *state.info.lock().unwrap() = Some(SidecarInfo {
                                    port: port as u16,
                                    token: token.clone(),
                                });
                                continue;
                            }
                        }
                    }
                    eprint!("[sidecar] {text}");
                }
                CommandEvent::Stderr(line) => eprint!("[sidecar] {}", String::from_utf8_lossy(&line)),
                CommandEvent::Error(e) => {
                    *state.failed.lock().unwrap() = Some(format!("Error del sidecar: {e}"));
                }
                CommandEvent::Terminated(status) => {
                    if state.info.lock().unwrap().is_none() {
                        *state.failed.lock().unwrap() =
                            Some(format!("El sidecar terminó antes de arrancar (código {:?}).", status.code));
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
    Ok(update.map(|u| UpdateInfo { version: u.version.clone(), notes: u.body.clone() }))
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
    ruta.into_path().ok().map(|p| p.to_string_lossy().into_owned())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .manage(Sidecar::default())
        .invoke_handler(tauri::generate_handler![sidecar_info, update_check, update_install, elegir_video])
        .setup(|app| {
            spawn_sidecar(app.handle())?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error al construir la aplicación Tauri")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                kill_sidecar(app);
            }
        });
}
