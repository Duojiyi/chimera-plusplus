//! Bounded JSONL access shared by Codex listing and message loading.
//! Compressed streams must be decoded before either operation reads UTF-8.
use std::collections::VecDeque;
use std::io::{self, BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::Path;

use crate::security_limits::{open_regular_file_no_symlink, MAX_SESSION_FILE_BYTES};

const MAX_COMPRESSED_BYTES: u64 = 256 * 1024 * 1024;
const MAX_SCAN_DECODED_BYTES: u64 = 256 * 1024 * 1024;
const MAX_LINE_BYTES: usize = 16 * 1024 * 1024;
const TAIL_BYTES: u64 = 16_384;

/// Unlike Take, reaching a limit is an error, not a successful truncated EOF.
struct LimitedRead<R> {
    inner: R,
    remaining: u64,
    label: &'static str,
}

impl<R: Read> Read for LimitedRead<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }
        if self.remaining == 0 {
            return match self.inner.read(&mut [0u8; 1])? {
                0 => Ok(0),
                _ => Err(io::Error::new(io::ErrorKind::InvalidData, self.label)),
            };
        }
        let len = buf.len().min(self.remaining as usize);
        let read = self.inner.read(&mut buf[..len])?;
        self.remaining -= read as u64;
        Ok(read)
    }
}

pub(super) struct SessionLines {
    reader: BufReader<Box<dyn Read>>,
    max_line_bytes: usize,
}

impl SessionLines {
    fn new(reader: impl Read + 'static, output_limit: u64, max_line_bytes: usize) -> Self {
        Self {
            reader: BufReader::new(Box::new(LimitedRead {
                inner: reader,
                remaining: output_limit,
                label: "session decoded output exceeds byte limit",
            })),
            max_line_bytes,
        }
    }

    pub(super) fn next_line(&mut self) -> io::Result<Option<String>> {
        let mut bytes = Vec::new();
        let read = (&mut self.reader)
            .take(self.max_line_bytes as u64 + 1)
            .read_until(b'\n', &mut bytes)?;
        if read == 0 {
            return Ok(None);
        }
        if read > self.max_line_bytes {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "session line exceeds byte limit",
            ));
        }
        if bytes.last() == Some(&b'\n') {
            bytes.pop();
            if bytes.last() == Some(&b'\r') {
                bytes.pop();
            }
        }
        String::from_utf8(bytes)
            .map(Some)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
    }
}

fn is_compressed(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.ends_with(".jsonl.zst"))
}

pub(super) fn open_lines(path: &Path, output_limit: u64) -> io::Result<SessionLines> {
    open_lines_with_limits(path, MAX_COMPRESSED_BYTES, output_limit, MAX_LINE_BYTES)
}

fn open_lines_with_limits(
    path: &Path,
    input_limit: u64,
    output_limit: u64,
    line_limit: usize,
) -> io::Result<SessionLines> {
    let file = open_regular_file_no_symlink(path)?;
    let compressed = is_compressed(path);
    let input_limit = if compressed {
        input_limit
    } else {
        output_limit
    };
    if file.metadata()?.len() > input_limit {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "session input exceeds byte limit",
        ));
    }
    let input = LimitedRead {
        inner: file,
        remaining: input_limit,
        label: "session input exceeds byte limit",
    };
    if compressed {
        let mut decoder = zstd::stream::read::Decoder::new(input)?;
        // Bound the decoder's own window allocation as well as decoded output.
        decoder.window_log_max(26)?;
        Ok(SessionLines::new(decoder, output_limit, line_limit))
    } else {
        Ok(SessionLines::new(input, output_limit, line_limit))
    }
}

pub(super) fn read_head_tail_lines(
    path: &Path,
    head_n: usize,
    tail_n: usize,
) -> io::Result<(Vec<String>, Vec<String>)> {
    if is_compressed(path) {
        let mut lines = open_lines(path, MAX_SCAN_DECODED_BYTES)?;
        let mut head = Vec::new();
        let mut tail = VecDeque::new();
        while let Some(line) = lines.next_line()? {
            if head.len() < head_n {
                head.push(line.clone());
            }
            if tail_n > 0 {
                if tail.len() == tail_n {
                    tail.pop_front();
                }
                tail.push_back(line);
            }
        }
        return Ok((head, tail.into_iter().collect()));
    }

    // Keep the seek-based listing of large plain rollouts. Only compressed
    // files need a bounded full scan; other providers retain their own reader.
    let file = open_regular_file_no_symlink(path)?;
    let file_len = file.metadata()?.len();
    let mut lines = SessionLines::new(file, MAX_SESSION_FILE_BYTES, MAX_LINE_BYTES);
    let mut head = Vec::new();
    for _ in 0..head_n {
        let Some(line) = lines.next_line()? else {
            break;
        };
        head.push(line);
    }
    let seek_pos = file_len.saturating_sub(TAIL_BYTES);
    let mut tail_file = open_regular_file_no_symlink(path)?;
    tail_file.seek(SeekFrom::Start(seek_pos))?;
    let mut tail_lines = SessionLines::new(
        tail_file.take(file_len - seek_pos),
        TAIL_BYTES,
        MAX_LINE_BYTES,
    );
    if seek_pos > 0 {
        // The seek may land inside a UTF-8 code point. Discard raw bytes first.
        tail_lines.reader.read_until(b'\n', &mut Vec::new())?;
    }
    let mut tail = VecDeque::new();
    while let Some(line) = tail_lines.next_line()? {
        if tail_n > 0 {
            if tail.len() == tail_n {
                tail.pop_front();
            }
            tail.push_back(line);
        }
    }
    Ok((head, tail.into_iter().collect()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    use tempfile::tempdir;

    fn drain(mut lines: SessionLines) -> io::Result<Vec<String>> {
        let mut output = Vec::new();
        while let Some(line) = lines.next_line()? {
            output.push(line);
        }
        Ok(output)
    }

    #[test]
    fn reads_plain_and_compressed_lines_including_unterminated_utf8() {
        let tmp = tempdir().unwrap();
        let content = "first\r\n你好\nlast";
        for name in ["rollout.jsonl", "rollout.jsonl.zst"] {
            let path = tmp.path().join(name);
            let bytes = if is_compressed(&path) {
                zstd::stream::encode_all(content.as_bytes(), 1).unwrap()
            } else {
                content.as_bytes().to_vec()
            };
            std::fs::write(&path, bytes).unwrap();
            assert_eq!(
                drain(open_lines(&path, 1024).unwrap()).unwrap(),
                ["first", "你好", "last"]
            );
            let (head, tail) = read_head_tail_lines(&path, 1, 2).unwrap();
            assert_eq!(head, ["first"]);
            assert_eq!(tail, ["你好", "last"]);
        }
    }

    #[test]
    fn compressed_input_output_and_lines_have_independent_limits() {
        let tmp = tempdir().unwrap();
        let path = tmp.path().join("rollout.jsonl.zst");
        let bytes = zstd::stream::encode_all(&b"1234\n5678\n"[..], 1).unwrap();
        let compressed_len = bytes.len() as u64;
        std::fs::write(&path, bytes).unwrap();
        assert!(open_lines_with_limits(&path, compressed_len - 1, 100, 100).is_err());
        let error =
            drain(open_lines_with_limits(&path, compressed_len, 9, 100).unwrap()).unwrap_err();
        assert!(error.to_string().contains("output exceeds"));
        let error =
            drain(open_lines_with_limits(&path, compressed_len, 100, 4).unwrap()).unwrap_err();
        assert!(error.to_string().contains("line exceeds"));
        assert_eq!(
            drain(open_lines_with_limits(&path, compressed_len, 10, 5).unwrap()).unwrap(),
            ["1234", "5678"]
        );
    }

    #[test]
    fn corrupt_truncated_and_invalid_utf8_frames_are_errors_not_empty_sessions() {
        let tmp = tempdir().unwrap();
        let path = tmp.path().join("rollout.jsonl.zst");
        let mut truncated = zstd::stream::encode_all(&b"hello\n"[..], 1).unwrap();
        truncated.pop();
        for bytes in [
            b"not a zstd frame".to_vec(),
            truncated,
            zstd::stream::encode_all(&b"\xff\n"[..], 1).unwrap(),
        ] {
            std::fs::write(&path, bytes).unwrap();
            assert!(open_lines(&path, 1024).and_then(drain).is_err());
            assert!(read_head_tail_lines(&path, 10, 30).is_err());
        }
    }

    #[test]
    fn a_limit_does_not_hide_trailing_input_or_a_large_line() {
        assert!(drain(SessionLines::new(Cursor::new(b"ok\nextra"), 3, 10)).is_err());
        assert!(drain(SessionLines::new(Cursor::new(b"123456"), 100, 5)).is_err());
    }

    #[test]
    fn plain_listing_keeps_large_files_and_ignores_partial_utf8_tail() {
        let tmp = tempdir().unwrap();
        let path = tmp.path().join("rollout.jsonl");
        let content = format!("head\n{}\nlast\n", "你".repeat(6000));
        std::fs::write(&path, content).unwrap();
        let (head, tail) = read_head_tail_lines(&path, 1, 1).unwrap();
        assert_eq!(head, ["head"]);
        assert_eq!(tail, ["last"]);
    }
}
