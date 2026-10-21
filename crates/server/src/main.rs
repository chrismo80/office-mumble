//! The one server process.
//!
//! It holds the plan, keeps who is where, and moves people along their ways. It does not touch audio —
//! that goes between clients — and it does not know about rooms, invitations or meetings. Of the hearing
//! rule it applies one part itself: an introduction or a signal is carried only inside one area.
//!
//! | Module    | Holds                                                                |
//! |-----------|----------------------------------------------------------------------|
//! | `world`   | every decision: the plan, the people, the lock, what a message gets  |
//! | `person`  | somebody on the floor, and how they walk                             |
//! | `session` | the sockets, carrying what the world decided                         |
//! | `tls`     | the certificate issued in the house                                  |

mod avatars;
mod person;
mod session;
mod tls;
mod world;

use std::{net::SocketAddr, path::Path};

use axum::{http::StatusCode, routing::get, Router};
use office_mumble_wire::{PlanFile, CELL_M};
use tower_http::services::ServeDir;

use crate::session::Hub;
use crate::world::World;

#[tokio::main]
async fn main() {
    // The provider by name, before anything asks rustls for one: see the note in Cargo.toml.
    let _ = rustls::crypto::ring::default_provider().install_default();
    let plan_path = setting("OFFICE_MUMBLE_PLAN", "fixtures/floor-t1.json");
    // What an earlier run wrote is the plan now; the file named by OFFICE_MUMBLE_PLAN is the seed it grew
    // from, and the tests keep reading it untouched. Written beside it, so both are in the same place.
    let save_path = setting("OFFICE_MUMBLE_SAVE", &plan_path.replace(".json", ".plan.json"));
    let read_from = if std::path::Path::new(&save_path).exists() { save_path.clone() } else { plan_path.clone() };
    let text = std::fs::read_to_string(&read_from).unwrap_or_else(|e| fail(&format!("cannot read {read_from}: {e}")));
    let model = PlanFile::parse(&text).unwrap_or_else(|e| fail(&format!("{read_from}: {e}")));
    let port: u16 = setting("OFFICE_MUMBLE_PORT", "8787").parse().unwrap_or(8787);

    let world = World::new(model, read_from.clone()).keep_on_disk(std::path::PathBuf::from(save_path.clone()));
    let grid = world.grid();
    println!(
        "plan {read_from}: {}x{} cells = {:.0} m x {:.0} m",
        grid.width(),
        grid.height(),
        grid.width() as f32 * CELL_M,
        grid.height() as f32 * CELL_M
    );

    let hub = Hub::new(world, std::sync::Arc::new(avatars::Avatars::new(port)));
    tokio::spawn(hub.clone().tick_forever());
    // Test avatars walk themselves: nothing is behind them, so somebody has to decide where they go.
    tokio::spawn(avatars::wander_forever(hub.clone()));
    // A speaking avatar whose process ended is a name in the sidebar with nobody behind it.
    tokio::spawn(avatars::hear_forever(hub.clone()));

    let client_dir = setting("OFFICE_MUMBLE_CLIENT_DIR", "client/dist");
    if Path::new(&client_dir).join("index.html").is_file() {
        println!("serving the client from {client_dir}");
    } else {
        eprintln!("nothing built at {client_dir}/index.html — `cd client && pnpm build`; the socket works anyway");
    }
    let dummy_dir = setting("OFFICE_MUMBLE_DUMMY_DIR", "harness/dist");
    if Path::new(&dummy_dir).join("index.html").is_file() {
        println!("serving the harness colleague from {dummy_dir} at /dummy/");
    }

    let tls = tls::certificate().await;
    let app = Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/cert.pem", get(tls::certificate_file))
        // Nothing to show: a 404 on every visit is noise in a console that should stay empty.
        .route("/favicon.ico", get(|| async { StatusCode::NO_CONTENT }))
        .route("/ws", get(session::upgrade))
        .merge(avatars::Avatars::routes())
        .with_state(hub)
        .nest_service("/dummy", ServeDir::new(dummy_dir))
        .fallback_service(ServeDir::new(client_dir));

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    println!("listening on https://{addr}/ — websocket at wss://{addr}/ws");
    axum_server::bind_rustls(addr, tls)
        .serve(app.into_make_service())
        .await
        .unwrap_or_else(|e| fail(&format!("serve: {e}")));
}

/// A setting from the environment, or its default.
fn setting(name: &str, default: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| default.to_string())
}

pub(crate) fn fail(message: &str) -> ! {
    eprintln!("office-mumble-server: {message}");
    std::process::exit(1)
}
