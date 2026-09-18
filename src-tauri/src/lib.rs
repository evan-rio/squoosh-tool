use std::thread;

use include_dir::{include_dir, Dir};
use tiny_http::{Header, Response, Server};

/// The built frontend, embedded into the binary at compile time.
/// `build/` is produced by `npm run build:desktop` before this crate compiles.
static DIST: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/../build");

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

/// Pulls a web URL out of an `/__open?url=…` request, rejecting other schemes.
fn requested_url(request_url: &str) -> Option<String> {
    let query = request_url.split_once('?')?.1;
    for pair in query.split('&') {
        if let Some(value) = pair.strip_prefix("url=") {
            let url = percent_decode(value);
            if url.starts_with("https://") || url.starts_with("http://") {
                return Some(url);
            }
            return None;
        }
    }
    None
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
        for request in server.incoming_requests() {
            let path = request.url().split('?').next().unwrap_or("/");

            // External links are opened by the system browser so the app's own
            // window keeps showing the app.
            if path == "/__open" {
                if let Some(url) = requested_url(request.url()) {
                    open_in_browser(&url);
                }
                let _ = request.respond(Response::empty(204));
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
        .setup(move |app| {
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
