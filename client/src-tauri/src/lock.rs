//! Whether somebody is at this machine, as the operating system says it: the screen locked or unlocked, the
//! machine gone to sleep or woken. That is the one fact the contract takes from the operating system — present
//! means connected, awake and unlocked — and it is a platform API on each system, which is why it lives here and
//! not in the webview.
//!
//! Nothing else is observed: not input, not focus, not an idle timer. Locking a screen is a deliberate act, and
//! a machine left unlocked and unattended is the person's responsibility, not something to infer.

use std::sync::Mutex;

/// Something the operating system reported.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Event {
    Locked,
    Unlocked,
    Sleeping,
    Woke,
    /// Another user took the console — fast user switching, which macOS reports apart from a lock. Windows locks
    /// the session first, so there it arrives as `Locked`.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    SwitchedAway,
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    SwitchedBack,
}

/// The facts that make somebody absent, kept apart because they end apart: a machine that wakes on a lock screen
/// has woken, and is still locked.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Machine {
    locked: bool,
    asleep: bool,
    switched_away: bool,
}

impl Machine {
    pub fn present(&self) -> bool {
        !(self.locked || self.asleep || self.switched_away)
    }

    /// Take one event in, and say the new answer when it changed.
    pub fn apply(&mut self, event: Event) -> Option<bool> {
        let before = self.present();
        match event {
            Event::Locked => self.locked = true,
            Event::Unlocked => self.locked = false,
            Event::Sleeping => self.asleep = true,
            Event::Woke => self.asleep = false,
            Event::SwitchedAway => self.switched_away = true,
            Event::SwitchedBack => self.switched_away = false,
        }
        let after = self.present();
        (after != before).then_some(after)
    }
}

/// The machine's state and whom to tell when the answer changes. The shell starts where the person is: a client
/// is opened by somebody sitting at an unlocked screen.
pub struct Watch {
    machine: Mutex<Machine>,
    notify: Box<dyn Fn(bool) + Send + Sync>,
}

impl Watch {
    pub fn new(notify: impl Fn(bool) + Send + Sync + 'static) -> Self {
        Watch { machine: Mutex::new(Machine::default()), notify: Box::new(notify) }
    }

    pub fn tell(&self, event: Event) {
        let changed = self.machine.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).apply(event);
        if let Some(present) = changed {
            (self.notify)(present);
        }
    }
}

#[cfg(windows)]
pub use windows::watch;

#[cfg(target_os = "macos")]
pub use macos::watch;

/// Linux watches nothing yet: the screen lock is a D-Bus question there, and a Linux client carries no voice in
/// its webview anyway, so its way in is the browser. The window still opens, and it says the person is present
/// for as long as it is open — which is all a browser tab can say either.
#[cfg(not(any(windows, target_os = "macos")))]
pub fn watch(_watch: Watch) {}

#[cfg(windows)]
mod windows {
    //! A hidden window of its own, on a thread of its own, because the session and power notifications are
    //! messages to a window. It is a real top-level window rather than a message-only one: a message-only window
    //! is not sent broadcasts, and the power notifications are broadcast.

    use std::ptr::{null, null_mut};
    use std::sync::OnceLock;

    use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::System::RemoteDesktop::{WTSRegisterSessionNotification, NOTIFY_FOR_THIS_SESSION};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, RegisterClassW, TranslateMessage, MSG,
        PBT_APMRESUMEAUTOMATIC, PBT_APMRESUMESUSPEND, PBT_APMSUSPEND, WM_POWERBROADCAST, WM_WTSSESSION_CHANGE,
        WNDCLASSW, WTS_SESSION_LOCK, WTS_SESSION_UNLOCK,
    };

    use super::{Event, Watch};

    /// The window procedure is a plain function, so the watch it reports to is reachable from one place.
    static WATCH: OnceLock<Watch> = OnceLock::new();

    pub fn watch(watch: Watch) {
        if WATCH.set(watch).is_err() {
            return;
        }
        std::thread::spawn(|| unsafe { listen() });
    }

    unsafe fn listen() {
        let class: Vec<u16> = "office-mumble-lock-watch\0".encode_utf16().collect();
        let instance = GetModuleHandleW(null());
        let mut window_class: WNDCLASSW = std::mem::zeroed();
        window_class.lpfnWndProc = Some(procedure);
        window_class.hInstance = instance;
        window_class.lpszClassName = class.as_ptr();
        RegisterClassW(&window_class);
        // Never shown: no style that makes it visible, no size, no parent.
        let window =
            CreateWindowExW(0, class.as_ptr(), class.as_ptr(), 0, 0, 0, 0, 0, null_mut(), null_mut(), instance, null());
        if window.is_null() {
            eprintln!("lock watch: no window to receive the session's notifications");
            return;
        }
        if WTSRegisterSessionNotification(window, NOTIFY_FOR_THIS_SESSION) == 0 {
            eprintln!("lock watch: the session would not report its lock");
        }
        let mut message: MSG = std::mem::zeroed();
        while GetMessageW(&mut message, null_mut(), 0, 0) > 0 {
            TranslateMessage(&message);
            DispatchMessageW(&message);
        }
    }

    unsafe extern "system" fn procedure(window: HWND, message: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        let event = match (message, wparam as u32) {
            (WM_WTSSESSION_CHANGE, WTS_SESSION_LOCK) => Some(Event::Locked),
            (WM_WTSSESSION_CHANGE, WTS_SESSION_UNLOCK) => Some(Event::Unlocked),
            (WM_POWERBROADCAST, PBT_APMSUSPEND) => Some(Event::Sleeping),
            (WM_POWERBROADCAST, PBT_APMRESUMEAUTOMATIC | PBT_APMRESUMESUSPEND) => Some(Event::Woke),
            _ => None,
        };
        if let (Some(event), Some(watch)) = (event, WATCH.get()) {
            watch.tell(event);
        }
        DefWindowProcW(window, message, wparam, lparam)
    }
}

#[cfg(target_os = "macos")]
mod macos {
    //! Two notification centres: the distributed one, where the login window says the screen locked, and the
    //! workspace's, where the machine says it goes to sleep and the session says another user took the console.
    //! Both are observed on the main queue, which is the run loop the shell already turns.

    use std::ptr::NonNull;
    use std::sync::Arc;

    use block2::RcBlock;
    use objc2_app_kit::{
        NSWorkspace, NSWorkspaceDidWakeNotification, NSWorkspaceSessionDidBecomeActiveNotification,
        NSWorkspaceSessionDidResignActiveNotification, NSWorkspaceWillSleepNotification,
    };
    use objc2_foundation::{NSDistributedNotificationCenter, NSNotification, NSNotificationCenter, NSOperationQueue, NSString};

    use super::{Event, Watch};

    pub fn watch(watch: Watch) {
        let watch = Arc::new(watch);
        let distributed = NSDistributedNotificationCenter::defaultCenter();
        observe(&distributed, &NSString::from_str("com.apple.screenIsLocked"), Event::Locked, &watch);
        observe(&distributed, &NSString::from_str("com.apple.screenIsUnlocked"), Event::Unlocked, &watch);

        let workspace = NSWorkspace::sharedWorkspace().notificationCenter();
        unsafe {
            observe(&workspace, NSWorkspaceWillSleepNotification, Event::Sleeping, &watch);
            observe(&workspace, NSWorkspaceDidWakeNotification, Event::Woke, &watch);
            observe(&workspace, NSWorkspaceSessionDidResignActiveNotification, Event::SwitchedAway, &watch);
            observe(&workspace, NSWorkspaceSessionDidBecomeActiveNotification, Event::SwitchedBack, &watch);
        }
    }

    fn observe(center: &NSNotificationCenter, name: &NSString, event: Event, watch: &Arc<Watch>) {
        let watch = Arc::clone(watch);
        let block = RcBlock::new(move |_: NonNull<NSNotification>| watch.tell(event));
        let observer = unsafe {
            center.addObserverForName_object_queue_usingBlock(Some(name), None, Some(&NSOperationQueue::mainQueue()), &block)
        };
        // Observed for as long as the shell runs: the centre keeps the block for as long as the observer lives.
        std::mem::forget(observer);
    }
}

#[cfg(test)]
mod tests {
    use super::{Event, Machine};

    #[test]
    fn a_locked_screen_is_absence_and_unlocking_it_is_presence_again() {
        let mut machine = Machine::default();
        assert!(machine.present(), "the shell must start present: it is opened at an unlocked screen");
        assert_eq!(machine.apply(Event::Locked), Some(false), "locking the screen must make the person absent");
        assert_eq!(machine.apply(Event::Unlocked), Some(true), "unlocking the screen must make the person present");
    }

    #[test]
    fn a_machine_that_wakes_on_its_lock_screen_stays_absent_until_it_is_unlocked() {
        let mut machine = Machine::default();
        machine.apply(Event::Locked);
        machine.apply(Event::Sleeping);
        assert_eq!(machine.apply(Event::Woke), None, "waking on a lock screen must not make the person present");
        assert_eq!(machine.apply(Event::Unlocked), Some(true), "unlocking after the wake must make the person present");
    }

    #[test]
    fn a_machine_that_wakes_without_a_lock_screen_is_present_again() {
        let mut machine = Machine::default();
        assert_eq!(machine.apply(Event::Sleeping), Some(false), "a sleeping machine must make the person absent");
        assert_eq!(machine.apply(Event::Woke), Some(true), "a machine woken without a lock must make the person present");
    }

    #[test]
    fn a_repeated_report_changes_nothing() {
        let mut machine = Machine::default();
        machine.apply(Event::Locked);
        assert_eq!(machine.apply(Event::Locked), None, "a second lock must not be told as a change");
    }
}
