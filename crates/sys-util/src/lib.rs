//! Cross-platform helpers for spawning child processes.
//!
//! On Windows a spawned child (PowerShell, netstat, adb, …) allocates its own
//! console window by default, which flashes on screen while the command runs.
//! [`CommandExt::no_window`] suppresses that window. It is a no-op on macOS and
//! Linux, so callers can apply it unconditionally without per-platform guards.

use std::process::Command;

/// Extension trait for [`Command`] that hides the child's console window.
pub trait CommandExt {
    /// Suppress the console window Windows would otherwise allocate for the
    /// spawned child. No-op on non-Windows platforms.
    fn no_window(&mut self) -> &mut Self;
}

#[cfg(target_os = "windows")]
impl CommandExt for Command {
    fn no_window(&mut self) -> &mut Self {
        use std::os::windows::process::CommandExt as WinCommandExt;

        // CREATE_NO_WINDOW — see the Win32 process creation flags.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        self.creation_flags(CREATE_NO_WINDOW);
        self
    }
}

#[cfg(not(target_os = "windows"))]
impl CommandExt for Command {
    fn no_window(&mut self) -> &mut Self {
        self
    }
}
