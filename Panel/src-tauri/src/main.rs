// Prevents an extra console window on Windows in release builds — but never for
// the test harness, which reports through stdout.
#![cfg_attr(all(not(debug_assertions), not(test)), windows_subsystem = "windows")]

fn main() {
    panel_lib::run()
}
