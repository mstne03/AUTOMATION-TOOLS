//! Shell Tauri mínimo: lanza el sidecar `app-backend` con un token por arranque,
//! lee la primera línea de su stdout (`{"port": N, "token": "..."}`), expone
//! `{port, token}` a la UI con el comando `sidecar_info` y mata el proceso al salir.
//!
//! El token no se escribe en disco ni en logs: solo viaja por la variable de entorno
//! del hijo y por el comando `invoke` hacia el WebView.

use std::sync::Mutex;
use std::time::Duration;

use rand::RngCore;
use serde::Serialize;
use tauri::{Manager, RunEvent};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

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

fn spawn_sidecar(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let token = random_token();

    // En desarrollo: `uv run app-backend` con cwd = app-backend/ (hermano de app-ui/).
    // ponytail: la Fase 4 sustituye esto por `app.shell().sidecar("app-backend")`.
    let backend_dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../../app-backend");
    let (mut rx, child) = app
        .shell()
        .command("uv")
        .args(["run", "app-backend"])
        .current_dir(backend_dir)
        .env("APP_BACKEND_TOKEN", &token)
        .spawn()?;

    let state = app.state::<Sidecar>();
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(Sidecar::default())
        .invoke_handler(tauri::generate_handler![sidecar_info])
        .setup(|app| {
            spawn_sidecar(app.handle())?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error al construir la aplicación Tauri")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                if let Some(child) = app.state::<Sidecar>().child.lock().unwrap().take() {
                    let _ = child.kill();
                }
            }
        });
}
