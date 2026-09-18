use std::io::Read;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::thread;

use include_dir::{include_dir, Dir};
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;
use tiny_http::{Header, Response, Server};

/// The built frontend, embedded into the binary at compile time.
/// `build/` is produced by `npm run build:desktop` before this crate compiles.
static DIST: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/../build");

/// Set once the app is up, so the loopback server can open native dialogs.
static APP: OnceLock<tauri::AppHandle> = OnceLock::new();
/// Folder chosen for exports, remembered on the Rust side so the webview never
/// has to hold — or be trusted with — an arbitrary write path.
static EXPORT_DIR: OnceLock<Mutex<Option<PathBuf>>> = OnceLock::new();

fn export_dir() -> &'static Mutex<Option<PathBuf>> {
    EXPORT_DIR.get_or_init(|| Mutex::new(None))
}

fn content_type(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript",
        "css" => "text/css",
        "json" => "application/json",
        "wasm" => "application/wasm",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "txt" | "map" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

fn header(name: &'static str, value: &'static str) -> Header {
    Header::from_bytes(name.as_bytes(), value.as_bytes()).expect("valid header")
}

/// Minimal percent-decoding for query values.
fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok();
            if let Some(byte) = hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn query_param(request_url: &str, key: &str) -> Option<String> {
    let query = request_url.split_once('?')?.1;
    let prefix = format!("{key}=");
    query
        .split('&')
        .find_map(|pair| pair.strip_prefix(&prefix).map(str::to_owned))
}

/// Pulls a web URL out of an `/__open?url=…` request, rejecting other schemes.
fn requested_url(request_url: &str) -> Option<String> {
    let url = percent_decode(&query_param(request_url, "url")?);
    if url.starts_with("https://") || url.starts_with("http://") {
        Some(url)
    } else {
        None
    }
}

/// Hands a URL to the system browser.
fn open_in_browser(url: &str) {
    #[cfg(target_os = "windows")]
    {
        let _ = std::process::Command::new("cmd")
            .args(["/C", "start", "", url])
            .spawn();
    }
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open").arg(url).spawn();
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let _ = std::process::Command::new("xdg-open").arg(url).spawn();
    }
}

/// Opens the native folder picker. Safe off the main thread — this is the same
/// context Tauri commands run in.
fn pick_export_dir() -> Option<PathBuf> {
    let app = APP.get()?;
    let path = app.dialog().file().blocking_pick_folder()?.into_path().ok()?;
    *export_dir().lock().unwrap() = Some(path.clone());
    Some(path)
}

/// Writes one exported file into the remembered folder. The name is sanitised
/// so a request can never escape that folder.
fn write_into_export_dir(name: &str, bytes: &[u8]) -> bool {
    if name.is_empty() || name.contains('/') || name.contains('\\') || name.contains("..") {
        return false;
    }
    match export_dir().lock().unwrap().clone() {
        Some(dir) => std::fs::write(dir.join(name), bytes).is_ok(),
        None => false,
    }
}

/// Serve the embedded frontend over loopback.
///
/// Tauri's built-in asset protocol cannot host the nested workers that
/// emscripten's threaded (pthread) wasm builds spawn, so those codecs hang.
/// Serving from a real `http://127.0.0.1` origin reproduces the environment
/// the app gets in a browser, where multithreaded wasm works. Cross-origin
/// isolation headers unlock `SharedArrayBuffer`, which threads require.
///
/// The socket binds to loopback only, so nothing is reachable off-machine.
fn start_server() -> u16 {
    let server = Server::http("127.0.0.1:0").expect("failed to bind loopback server");
    let port = server
        .server_addr()
        .to_ip()
        .expect("loopback server has an IP address")
        .port();

    thread::spawn(move || {
        for mut request in server.incoming_requests() {
            let url = request.url().to_owned();
            let path = url.split('?').next().unwrap_or("/").to_owned();
            let path = path.as_str();

            // External links are opened by the system browser so the app's own
            // window keeps showing the app.
            if path == "/__open" {
                if let Some(url) = requested_url(&url) {
                    open_in_browser(&url);
                }
                let _ = request.respond(Response::empty(204));
                continue;
            }

            // Native folder picker for the batch export target.
            if path == "/__pick-folder" {
                let body = pick_export_dir()
                    .map(|p| p.to_string_lossy().into_owned())
                    .unwrap_or_default();
                let _ = request.respond(
                    Response::from_string(body)
                        .with_header(header("Content-Type", "text/plain; charset=utf-8"))
                        .with_header(header("Cache-Control", "no-store")),
                );
                continue;
            }

            // Receives one encoded image; the body is the raw file.
            if path == "/__write" {
                let name = query_param(&url, "name")
                    .map(|v| percent_decode(&v))
                    .unwrap_or_default();
                let mut bytes = Vec::new();
                let read_ok = request
                    .as_reader()
                    .take(256 * 1024 * 1024)
                    .read_to_end(&mut bytes)
                    .is_ok();
                let status = if read_ok && write_into_export_dir(&name, &bytes) {
                    204
                } else {
                    400
                };
                let _ = request.respond(Response::empty(status));
                continue;
            }

            let relative = if path == "/" {
                "index.html"
            } else {
                path.trim_start_matches('/')
            };

            let response = match DIST.get_file(relative) {
                Some(file) => Response::from_data(file.contents().to_vec()).with_header(
                    Header::from_bytes(
                        &b"Content-Type"[..],
                        content_type(relative).as_bytes(),
                    )
                    .expect("valid content type"),
                ),
                None => Response::from_data(Vec::new()).with_status_code(404),
            };

            let response = response
                .with_header(header("Cross-Origin-Opener-Policy", "same-origin"))
                .with_header(header("Cross-Origin-Embedder-Policy", "require-corp"))
                .with_header(header("Cross-Origin-Resource-Policy", "cross-origin"));

            let _ = request.respond(response);
        }
    });

    port
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let port = start_server();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(move |app| {
            APP.set(app.handle().clone()).ok();

            let url = format!("http://127.0.0.1:{port}/");
            tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::External(url.parse().expect("valid loopback url")),
            )
            .title("Squoosh Tool")
            .inner_size(1280.0, 860.0)
            .min_inner_size(720.0, 560.0)
            .disable_drag_drop_handler()
            .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
