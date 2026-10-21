//! The name somebody is shown under until they choose one, taken from the operating system: the account's full
//! name where the system knows one, the login name where it does not. It stands in for the directory, which is
//! what will say who somebody is once the server binds against it.

pub fn display_name() -> String {
    full_name().filter(|name| !name.trim().is_empty()).unwrap_or_else(login_name)
}

fn login_name() -> String {
    std::env::var("USERNAME").or_else(|_| std::env::var("USER")).unwrap_or_default()
}

#[cfg(windows)]
fn full_name() -> Option<String> {
    use windows_sys::Win32::Security::Authentication::Identity::{GetUserNameExW, NameDisplay};
    let mut buffer = [0u16; 256];
    let mut length = buffer.len() as u32;
    // Answers for a domain account; a local account has no display name and the call says so.
    let ok = unsafe { GetUserNameExW(NameDisplay, buffer.as_mut_ptr(), &mut length) };
    (ok != 0).then(|| String::from_utf16_lossy(&buffer[..length as usize]))
}

#[cfg(target_os = "macos")]
fn full_name() -> Option<String> {
    Some(objc2_foundation::NSFullUserName().to_string())
}

#[cfg(not(any(windows, target_os = "macos")))]
fn full_name() -> Option<String> {
    None
}
