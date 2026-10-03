//! Bounded execution helpers for external commands.
//!
//! Desktop probes must not be able to hang the application indefinitely or
//! fill memory with unbounded stdout/stderr.  Keep the timeout and process-tree
//! cleanup policy in one place so platform-specific callers do not drift.

use std::io::{self, Read};
use std::process::{Child, Command, Output, Stdio};
use std::time::{Duration, Instant};

const POLL_INTERVAL: Duration = Duration::from_millis(20);
const CLEANUP_TIMEOUT: Duration = Duration::from_millis(750);
const READ_CHUNK_SIZE: usize = 8 * 1024;

pub fn output_with_timeout(
    mut command: Command,
    timeout: Duration,
    max_output_bytes: usize,
) -> io::Result<Output> {
    let deadline = Instant::now().checked_add(timeout).ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "command timeout is too large")
    })?;
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // A dedicated process group lets timeout cleanup terminate descendants
        // rather than leaving shells, package managers, or probes behind.
        command.process_group(0);
    }

    let mut child = command.spawn()?;
    // Keep both pipe handles alive through tree cleanup. No detached or blocked
    // reader threads are needed: this loop is the sole reader of both pipes.
    let mut stdout = child.stdout.take();
    let mut stderr = child.stderr.take();
    let result = (|| -> io::Result<Output> {
        let stdout = stdout
            .as_mut()
            .ok_or_else(|| io::Error::other("child stdout was not captured"))?;
        let stderr = stderr
            .as_mut()
            .ok_or_else(|| io::Error::other("child stderr was not captured"))?;
        let mut stdout_bytes = Vec::new();
        let mut stderr_bytes = Vec::new();
        let mut stdout_eof = false;
        let mut stderr_eof = false;
        let mut captured = 0;

        loop {
            if Instant::now() >= deadline {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    format!("external command exceeded {timeout:?}"),
                ));
            }
            let mut progressed = false;
            if !stdout_eof {
                if let Some(available) = pipe_read_size(stdout)? {
                    stdout_eof = read_bounded_chunk(
                        stdout,
                        &mut stdout_bytes,
                        &mut captured,
                        max_output_bytes,
                        available,
                    )?;
                    progressed = true;
                }
            }
            if !stderr_eof {
                if let Some(available) = pipe_read_size(stderr)? {
                    stderr_eof = read_bounded_chunk(
                        stderr,
                        &mut stderr_bytes,
                        &mut captured,
                        max_output_bytes,
                        available,
                    )?;
                    progressed = true;
                }
            }
            // A direct child may exit while its descendants still own the pipe
            // writers. EOF and process exit must share the same deadline.
            // Delaying reap also keeps the Unix process-group ID from reuse.
            if stdout_eof && stderr_eof {
                if let Some(status) = child.try_wait()? {
                    return Ok(Output {
                        status,
                        stdout: stdout_bytes,
                        stderr: stderr_bytes,
                    });
                }
            }
            if !progressed {
                std::thread::sleep(
                    POLL_INTERVAL.min(deadline.saturating_duration_since(Instant::now())),
                );
            }
        }
    })();

    match result {
        Ok(output) => Ok(output),
        Err(error) => {
            // On Windows taskkill /T needs the parent to still exist. Never
            // kill/reap the direct child before attempting tree termination.
            terminate_process_tree(child.id());
            let _ = child.kill();
            if let Err(cleanup_error) = wait_for_exit(&mut child, CLEANUP_TIMEOUT) {
                return Err(io::Error::new(
                    error.kind(),
                    format!("{error}; process cleanup failed: {cleanup_error}"),
                ));
            }
            Err(error)
        }
    }
}

fn read_bounded_chunk<R: Read>(
    reader: &mut R,
    output: &mut Vec<u8>,
    captured: &mut usize,
    limit: usize,
    available: usize,
) -> io::Result<bool> {
    if available == 0 {
        return Ok(true);
    }
    let mut chunk = [0_u8; READ_CHUNK_SIZE];
    let read = match reader.read(&mut chunk[..available.min(READ_CHUNK_SIZE)]) {
        Err(error) if error.kind() == io::ErrorKind::Interrupted => return Ok(false),
        result => result?,
    };
    if read == 0 {
        return Ok(true);
    }
    if read > limit.saturating_sub(*captured) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("external command output exceeded {limit} bytes"),
        ));
    }
    *captured += read;
    output.extend_from_slice(&chunk[..read]);
    Ok(false)
}

#[cfg(unix)]
fn pipe_read_size<R: std::os::fd::AsRawFd>(reader: &R) -> io::Result<Option<usize>> {
    #[repr(C)]
    struct PollFd {
        fd: std::ffi::c_int,
        events: std::ffi::c_short,
        revents: std::ffi::c_short,
    }
    // nfds_t is unsigned long on Linux and unsigned int on macOS/BSD.
    #[cfg(any(
        target_os = "linux",
        target_os = "android",
        target_os = "solaris",
        target_os = "illumos",
        target_os = "aix"
    ))]
    type PollCount = std::ffi::c_ulong;
    #[cfg(not(any(
        target_os = "linux",
        target_os = "android",
        target_os = "solaris",
        target_os = "illumos",
        target_os = "aix"
    )))]
    type PollCount = std::ffi::c_uint;
    unsafe extern "C" {
        fn poll(fds: *mut PollFd, count: PollCount, timeout: std::ffi::c_int) -> std::ffi::c_int;
    }
    let mut fd = PollFd {
        fd: reader.as_raw_fd(),
        events: 1, // POLLIN; poll also reports EOF/errors without an explicit mask.
        revents: 0,
    };
    // SAFETY: fd is a live, exclusively read pipe; poll gets one valid entry and
    // a zero timeout. No competing reader can consume the readiness indication.
    let ready = unsafe { poll(&mut fd, 1, 0) };
    if ready < 0 {
        let error = io::Error::last_os_error();
        return if error.kind() == io::ErrorKind::Interrupted {
            Ok(None)
        } else {
            Err(error)
        };
    }
    Ok((ready > 0).then_some(READ_CHUNK_SIZE))
}

#[cfg(target_os = "windows")]
fn pipe_read_size<R: std::os::windows::io::AsRawHandle>(reader: &R) -> io::Result<Option<usize>> {
    use std::ffi::c_void;
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn PeekNamedPipe(
            pipe: *mut c_void,
            buffer: *mut c_void,
            buffer_size: u32,
            bytes_read: *mut u32,
            bytes_available: *mut u32,
            bytes_left: *mut u32,
        ) -> i32;
    }
    let mut available = 0_u32;
    // SAFETY: the child pipe handle stays owned by this function's caller. The
    // optional output pointers are null; available points to a live DWORD.
    let ok = unsafe {
        PeekNamedPipe(
            reader.as_raw_handle(),
            std::ptr::null_mut(),
            0,
            std::ptr::null_mut(),
            &mut available,
            std::ptr::null_mut(),
        )
    };
    if ok != 0 {
        // Never issue a synchronous read for more bytes than the sole reader
        // knows are already buffered. Zero available is not EOF.
        return Ok((available > 0).then_some(available as usize));
    }
    let error = io::Error::last_os_error();
    match error.raw_os_error() {
        Some(109 | 233) => Ok(Some(0)), // ERROR_BROKEN_PIPE / ERROR_PIPE_NOT_CONNECTED
        _ => Err(error),
    }
}

#[cfg(not(any(unix, target_os = "windows")))]
fn pipe_read_size<R>(_reader: &R) -> io::Result<Option<usize>> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "bounded command pipes are unsupported on this platform",
    ))
}

fn wait_for_exit(child: &mut Child, timeout: Duration) -> io::Result<()> {
    let deadline = Instant::now() + timeout;
    loop {
        if child.try_wait()?.is_some() {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "process did not exit during the cleanup grace period",
            ));
        }
        std::thread::sleep(POLL_INTERVAL.min(deadline.saturating_duration_since(Instant::now())));
    }
}

#[cfg(target_os = "windows")]
fn terminate_process_tree(pid: u32) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;

    // A naturally exited parent may already be absent from taskkill's tree.
    // Pipe deadlines still hold, but this is not Windows job-object containment.
    let Ok(mut killer) = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
    else {
        return;
    };

    if wait_for_exit(&mut killer, CLEANUP_TIMEOUT).is_err() {
        let _ = killer.kill();
        let _ = wait_for_exit(&mut killer, CLEANUP_TIMEOUT);
    }
}

#[cfg(unix)]
fn terminate_process_tree(pid: u32) {
    // Use the syscall directly instead of resolving an external kill executable
    // through PATH, which probes may deliberately restrict.
    unsafe extern "C" {
        fn kill(pid: i32, signal: i32) -> i32;
    }

    const SIGKILL: i32 = 9;
    let process_group = -(pid as i32);
    // SAFETY: the negative PID targets the dedicated process group created
    // before spawning the child; SIGKILL is intentionally used for cleanup.
    let _ = unsafe { kill(process_group, SIGKILL) };
}

#[cfg(not(any(unix, target_os = "windows")))]
fn terminate_process_tree(_pid: u32) {}

#[cfg(test)]
mod tests {
    use super::*;

    fn inherited_pipe_command(delay_ms: u64) -> Command {
        #[cfg(target_os = "windows")]
        {
            use base64::Engine;
            use std::os::windows::process::CommandExt;
            let script = format!(
                "$ProgressPreference='SilentlyContinue'; Start-Sleep -Milliseconds {delay_ms}; [Console]::Error.Write(456)"
            );
            let encoded = base64::engine::general_purpose::STANDARD.encode(
                script
                    .encode_utf16()
                    .flat_map(u16::to_le_bytes)
                    .collect::<Vec<_>>(),
            );
            let script = format!("start /b powershell.exe -NoProfile -NonInteractive -EncodedCommand {encoded} & <nul set /p =123&exit /b 0");
            let mut command = Command::new("cmd.exe");
            command
                .args(["/d", "/c", &script])
                .creation_flags(0x08000000);
            command
        }
        #[cfg(not(target_os = "windows"))]
        {
            let mut command = Command::new("sh");
            command.args([
                "-c",
                &format!(
                    "(sleep {}; printf 456 >&2) & printf 123",
                    delay_ms as f64 / 1000.0
                ),
            ]);
            command
        }
    }

    #[test]
    fn output_budget_is_shared_between_stdout_and_stderr() {
        let mut captured = 0;
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        assert!(!read_bounded_chunk(
            &mut io::Cursor::new(b"abc"),
            &mut stdout,
            &mut captured,
            5,
            3,
        )
        .unwrap());
        assert!(!read_bounded_chunk(
            &mut io::Cursor::new(b"de"),
            &mut stderr,
            &mut captured,
            5,
            2,
        )
        .unwrap());
        let error =
            read_bounded_chunk(&mut io::Cursor::new(b"f"), &mut stderr, &mut captured, 5, 1)
                .expect_err("the combined byte budget must not be exceeded");
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        assert_eq!(captured, 5);
        assert_eq!(stdout, b"abc");
        assert_eq!(stderr, b"de");
    }

    #[test]
    fn captures_inherited_pipe_output_after_direct_child_exit() {
        let output = output_with_timeout(inherited_pipe_command(100), Duration::from_secs(3), 1024)
            .expect("late descendant output arrives before the shared deadline");
        assert!(output.status.success());
        assert_eq!(output.stdout, b"123");
        assert_eq!(output.stderr, b"456");
    }

    #[test]
    fn deadline_includes_inherited_pipes_after_direct_child_exit() {
        // The finite fixture also exits on its own if Windows taskkill cannot
        // locate a descendant whose parent has already naturally exited.
        let started = Instant::now();
        let error = output_with_timeout(
            inherited_pipe_command(5000),
            Duration::from_millis(1500),
            1024,
        )
        .expect_err("parent exit must not bypass the pipe deadline");
        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[cfg(unix)]
    #[test]
    fn deadline_includes_child_exit_after_both_pipes_close() {
        let mut command = Command::new("sh");
        command.args(["-c", "exec 1>&- 2>&-; sleep 5"]);
        let started = Instant::now();
        let error = output_with_timeout(command, Duration::from_millis(100), 1024)
            .expect_err("pipe EOF must not bypass the process deadline");
        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
        assert!(started.elapsed() < Duration::from_secs(3));
    }

    #[test]
    fn captures_small_output() {
        #[cfg(target_os = "windows")]
        let command = {
            let mut command = Command::new("cmd");
            command.args(["/D", "/S", "/C", "echo ready"]);
            command
        };
        #[cfg(not(target_os = "windows"))]
        let command = {
            let mut command = Command::new("sh");
            command.args(["-c", "printf ready"]);
            command
        };

        let output =
            output_with_timeout(command, Duration::from_secs(2), 1024).expect("command succeeds");
        assert!(String::from_utf8_lossy(&output.stdout).contains("ready"));
    }

    #[test]
    fn terminates_timed_out_process() {
        #[cfg(target_os = "windows")]
        let command = {
            let mut command = Command::new("powershell.exe");
            command.args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Start-Sleep -Seconds 5",
            ]);
            command
        };
        #[cfg(not(target_os = "windows"))]
        let command = {
            let mut command = Command::new("sh");
            command.args(["-c", "sleep 5"]);
            command
        };

        let started = Instant::now();
        let error = output_with_timeout(command, Duration::from_millis(100), 1024)
            .expect_err("command must time out");
        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
        assert!(started.elapsed() < Duration::from_secs(3));
    }

    #[test]
    fn terminates_process_when_output_limit_is_exceeded() {
        #[cfg(target_os = "windows")]
        let command = {
            let mut command = Command::new("cmd.exe");
            command.args([
                "/D",
                "/S",
                "/C",
                "(for /L %i in (1,1,1000) do @echo 0123456789abcdef)",
            ]);
            command
        };
        #[cfg(not(target_os = "windows"))]
        let command = {
            let mut command = Command::new("sh");
            command.args(["-c", "while :; do printf 0123456789abcdef; done"]);
            command
        };

        let started = Instant::now();
        let error = output_with_timeout(command, Duration::from_secs(5), 1024)
            .expect_err("command must be stopped at the output limit");
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        assert!(started.elapsed() < Duration::from_secs(3));
    }
}
