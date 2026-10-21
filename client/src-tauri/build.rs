//! The house goes into the app here: the server's address from `OFFICE_MUMBLE_SERVER`, and the certificate the
//! server issued, from `OFFICE_MUMBLE_CERT` or from where the server puts it on this machine. A colleague is
//! handed an app that knows its office and trusts exactly that server, with nothing to type and nothing to
//! accept.

use std::path::PathBuf;

#[path = "src/house.rs"]
#[allow(dead_code)]
mod house;

fn main() {
    println!("cargo:rerun-if-env-changed=OFFICE_MUMBLE_SERVER");
    println!("cargo:rerun-if-env-changed=OFFICE_MUMBLE_CERT");

    // A development build talks to the server on the same machine; an app for somebody else has to be told.
    let release = std::env::var("PROFILE").as_deref() == Ok("release");
    let server = match std::env::var("OFFICE_MUMBLE_SERVER") {
        Ok(given) => given,
        Err(_) if !release => "localhost".to_string(),
        Err(_) => fail("name the server the app is for: OFFICE_MUMBLE_SERVER=<host or host:port> cargo tauri build"),
    };
    let socket = house::socket_url(&server)
        .unwrap_or_else(|| fail(&format!("OFFICE_MUMBLE_SERVER={server:?} names no host a server can stand at")));
    println!("cargo:rustc-env=OFFICE_MUMBLE_SOCKET={socket}");

    // The certificate the app pins is a build input, not the server's own pair: on a machine that hosts a
    // server, cert.pem is one half of cert.pem + key.pem and must not be replaced by a fetched one. So a fetch
    // lands in pinned.pem, and that is read first. cert.pem still works — it is the right file when the build
    // happens on the server's own machine.
    let cert = std::env::var("OFFICE_MUMBLE_CERT")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            let pinned = PathBuf::from("../../.office-mumble/pinned.pem");
            if pinned.exists() {
                pinned
            } else {
                PathBuf::from("../../.office-mumble/cert.pem")
            }
        });
    println!("cargo:rerun-if-changed={}", cert.display());
    let pem = std::fs::read(&cert).unwrap_or_else(|e| {
        fail(&format!(
            "no certificate at {}: {e} — start the server once so it issues one, or name it with OFFICE_MUMBLE_CERT",
            cert.display()
        ))
    });
    let out = PathBuf::from(std::env::var("OUT_DIR").expect("cargo sets OUT_DIR"));
    std::fs::write(out.join("house-cert.pem"), pem).expect("OUT_DIR is writable");

    tauri_build::build()
}

fn fail(why: &str) -> ! {
    eprintln!("office-mumble: {why}");
    std::process::exit(1)
}
