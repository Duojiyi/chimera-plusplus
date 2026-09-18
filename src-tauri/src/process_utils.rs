//! Bounded execution helpers for external commands.
//!
//! Desktop probes must not be able to hang the application indefinitely or
//! fill memory with unbounded stdout/stderr.  Keep the timeout and process-tree
//! cleanup policy in one place so platform-specific callers do not drift.

use std::io::{self, Read};
use std::process::{Command, Output, Stdio};
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Arc,
};
use std::time::{Duration, Instant};

const POLL_INTERVAL: Duration = Duration::from_millis(20);

pub fn output_with_timeout(
    mut command: Command,
    timeout: Duration,
    max_output_bytes: usize,
) -> io::Result<Output> {
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
    let child_id = child.id();
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| io::Error::other("child stdout was not captured"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| io::Error::other("child stderr was not captured"))?;

    let captured = Arc::new(AtomicUsize::new(0));
    let overflowed = Arc::new(AtomicBool::new(false));
    let stdout_reader = spawn_bounded_reader(
        stdout,
        Arc::clone(&captured),
        Arc::clone(&overflowed),
        max_output_bytes,
    );
    let stderr_reader =
        spawn_bounded_reader(stderr, captured, Arc::clone(&overflowed), max_output_bytes);

    let deadline = Instant::now() + timeout;
    let (status, timed_out) = loop {
        if let Some(status) = child.try_wait()? {
            break (status, false);
        }
        if overflowed.load(Ordering::Relaxed) {
            let _ = child.kill();
            terminate_process_tree(child_id);
            break (child.wait()?, false);
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            terminate_process_tree(child_id);
            break (child.wait()?, true);
        }
        std::thread::sleep(POLL_INTERVAL);
    };

    let stdout = join_reader(stdout_reader)?;
    let stderr = join_reader(stderr_reader)?;

    if overflowed.load(Ordering::Relaxed) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("external command output exceeded {max_output_bytes} bytes"),
        ));
    }
    if timed_out {
        return Err(io::Error::new(
            io::ErrorKind::TimedOut,
            format!("external command exceeded {} seconds", timeout.as_secs()),
        ));
    }

    Ok(Output {
        status,
        stdout,
        stderr,
    })
}

fn spawn_bounded_reader<R>(
    reader: R,
    captured: Arc<AtomicUsize>,
    overflowed: Arc<AtomicBool>,
    limit: usize,
) -> std::thread::JoinHandle<io::Result<Vec<u8>>>
where
    R: Read + Send + 'static,
{
    std::thread::spawn(move || read_bounded(reader, &captured, &overflowed, limit))
}

fn read_bounded<R: Read>(
    mut reader: R,
    captured: &AtomicUsize,
    overflowed: &AtomicBool,
    limit: usize,
) -> io::Result<Vec<u8>> {
    let mut output = Vec::new();
    let mut chunk = [0_u8; 8 * 1024];
    loop {
        if overflowed.load(Ordering::Relaxed) {
            return Ok(output);
        }
        let read = reader.read(&mut chunk)?;
        if read == 0 {
            return Ok(output);
        }

        let previous = captured.fetch_add(read, Ordering::Relaxed);
        let remaining = limit.saturating_sub(previous);
        let keep = remaining.min(read);
        if keep > 0 {
            output.extend_from_slice(&chunk[..keep]);
        }
        if keep < read {
            overflowed.store(true, Ordering::Relaxed);
            // Stop consuming this pipe immediately.  A descendant process can
            // inherit stdout/stderr and keep the pipe open after the direct
            // child exits; retaining the reader here would make cleanup wait
            // indefinitely even though the byte budget was already exceeded.
            return Ok(output);
        }
    }
}

fn join_reader(handle: std::thread::JoinHandle<io::Result<Vec<u8>>>) -> io::Result<Vec<u8>> {
    handle
        .join()
        .map_err(|_| io::Error::other("external command output reader panicked"))?
}

#[cfg(target_os = "windows")]
fn terminate_process_tree(pid: u32) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;

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

    let deadline = Instant::now() + Duration::from_millis(750);
    loop {
        match killer.try_wait() {
            Ok(Some(_)) | Err(_) => break,
            Ok(None) if Instant::now() >= deadline => {
                let _ = killer.kill();
                let _ = killer.wait();
                break;
            }
            Ok(None) => std::thread::sleep(POLL_INTERVAL),
        }
    }
}

#[cfg(unix)]
fn terminate_process_tree(pid: u32) {
    // Use the syscall directly instead of resolving an external `kill`
    // executable through PATH.  Probes may run with a restricted environment,
    // and a failed cleanup command would leave descendants holding the pipe
    // open while the bounded-reader threads wait forever.
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
