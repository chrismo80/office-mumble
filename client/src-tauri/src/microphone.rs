//! The microphone, in the place each system keeps its answer.
//!
//! Two things have to allow a webview to hear anybody, and they are asked in different places. What the *app*
//! says it wants the microphone for is the system's business: macOS reads `Info.plist`'s
//! `NSMicrophoneUsageDescription` for the sentence in its dialog. What the *webview* grants is the webview's own
//! business, and there macOS leaves it to wry, which answers capture requests itself. WebView2 does not: it keeps
//! its own answer, shows its own dialog, stores the choice in the app's WebView2 profile and offers no way back
//! to it — a person who once clicked *Don't allow* cannot undo that in any settings window, and the app never
//! hears anybody again. Nobody should lose their voice to a stray click on a dialog they only saw once.
//!
//! So on Windows the request is answered here, for this app's own page, and WebView2 is never asked. The handler
//! covers one webview for its whole life, which is why it is registered once, at startup, and why every kind
//! this app does not use is left to WebView2's own answer: it wants the microphone, not the camera, and must not
//! be in a position to grant what it never asks for.

#[cfg(target_os = "windows")]
use tauri::WebviewWindow;

/// Let the page in this window use the microphone, without WebView2 asking the person.
#[cfg(target_os = "windows")]
pub fn granted(window: &WebviewWindow) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_PERMISSION_KIND_MICROPHONE, COREWEBVIEW2_PERMISSION_KIND_UNKNOWN_PERMISSION,
        COREWEBVIEW2_PERMISSION_STATE_ALLOW, ICoreWebView2PermissionRequestedEventArgs,
    };
    use webview2_com::{PermissionRequestedEventHandler, take_pwstr};
    use windows_core::PWSTR;

    let _ = window.with_webview(|webview| {
        // A window without a web engine is a window nobody will be heard in either way.
        let Ok(core) = (unsafe { webview.controller().CoreWebView2() }) else { return };
        let handler = PermissionRequestedEventHandler::create(Box::new(
            |_, arguments: Option<ICoreWebView2PermissionRequestedEventArgs>| {
                let Some(arguments) = arguments else { return Ok(()) };
                unsafe {
                    let mut kind = COREWEBVIEW2_PERMISSION_KIND_UNKNOWN_PERMISSION;
                    arguments.PermissionKind(&mut kind)?;
                    if kind != COREWEBVIEW2_PERMISSION_KIND_MICROPHONE {
                        return Ok(());
                    }
                    let mut asked = PWSTR::null();
                    arguments.Uri(&mut asked)?;
                    if is_this_page(&take_pwstr(asked)) {
                        arguments.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW)?;
                    }
                }
                Ok(())
            },
        ));
        let mut token = 0i64;
        let _ = unsafe { core.add_PermissionRequested(&handler, &mut token) };
    });
}

/// Whether the page asking is the app's own. The window loads the client's own files — from the bundle at
/// `http://tauri.localhost`, or from the development server while developing — and never somebody else's page,
/// so nothing else may be given the microphone.
#[cfg(target_os = "windows")]
fn is_this_page(origin: &str) -> bool {
    ["http://tauri.localhost", "tauri://localhost", "http://localhost:5173"]
        .iter()
        .any(|ours| origin.starts_with(ours))
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::*;

    #[test]
    fn only_the_apps_own_page_may_use_the_microphone() {
        assert!(is_this_page("http://tauri.localhost/index.html"));
        assert!(!is_this_page("https://192.168.1.20:8787/"));
    }
}
