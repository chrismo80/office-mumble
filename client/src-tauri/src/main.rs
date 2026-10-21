//! The shell: the operating-system half of the client. It opens the window the place is drawn in, puts an icon
//! in the tray, and tells the webview whether somebody is at the machine. Everything that makes up the place —
//! the map, the rule, the voice — is the same TypeScript the browser runs; the shell only hosts it.
//!
//! Closing the window ends the app, as leaving for the day does. The tray says whether you are in the office
//! and brings the window back; it is not somewhere the app hides.

// A window and no console behind it, once it is built for somebody to use.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// The address is turned into the socket by `build.rs`; here only for its tests.
#[cfg(test)]
mod house;
mod lock;
#[cfg(target_os = "windows")]
mod microphone;
mod socket;
mod user;

use std::sync::Mutex;

use serde::Serialize;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager};

/// Whether somebody is at this machine, as the lock watch last said. The webview asks for it once when it loads,
/// because an event sent before it listened is an event it never heard.
struct Presence(Mutex<bool>);

/// The event the webview listens to, with `true` for present and `false` for gone.
const PRESENCE_EVENT: &str = "presence";
const TRAY: &str = "main";

#[tauri::command]
fn presence(state: tauri::State<Presence>) -> bool {
    *state.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// What the webview shows about the house: the socket the app was built for, and the name the system knows the
/// person by, for when they have not chosen one.
#[derive(Serialize)]
struct House {
    socket: &'static str,
    user: String,
}

#[tauri::command]
fn house() -> House {
    House { socket: socket::SOCKET, user: user::display_name() }
}

fn main() {
    tauri::Builder::default()
        .manage(Presence(Mutex::new(true)))
        .manage(socket::Socket::new())
        .invoke_handler(tauri::generate_handler![
            presence,
            house,
            socket::socket_open,
            socket::socket_send,
            socket::socket_close
        ])
        .setup(|app| {
            tray(app.handle())?;
            // The microphone is answered before anybody can ask for it, once per window: on Windows the webview
            // keeps the answer to its own dialog forever, so this app gives that answer itself.
            #[cfg(target_os = "windows")]
            if let Some(window) = app.get_webview_window("main") {
                microphone::granted(&window);
            }
            let handle = app.handle().clone();
            lock::watch(lock::Watch::new(move |present| told(&handle, present)));
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("the shell could not start");
}

/// The lock watch changed its answer: keep it, say it in the tray, and tell the webview.
fn told(app: &AppHandle, present: bool) {
    *app.state::<Presence>().0.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = present;
    if let Some(tray) = app.tray_by_id(TRAY) {
        let _ = tray.set_tooltip(Some(tooltip(present)));
    }
    let _ = app.emit(PRESENCE_EVENT, present);
}

fn tooltip(present: bool) -> &'static str {
    if present {
        "office-mumble — im Büro"
    } else {
        "office-mumble — nicht da (gesperrt oder im Ruhezustand)"
    }
}

fn tray(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Fenster zeigen", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Beenden", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;
    let mut builder = TrayIconBuilder::with_id(TRAY)
        .tooltip(tooltip(true))
        .menu(&menu)
        // A click on the icon brings the window back; the menu is on the other button, as the tray is used on
        // Windows. On macOS the menu bar opens its menu on the click, as every icon there does.
        .show_menu_on_left_click(cfg!(target_os = "macos"))
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_window(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

fn show_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}
