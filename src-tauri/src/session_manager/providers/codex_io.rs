//! Bounded JSONL access shared by Codex listing and message loading.
//! Compressed streams must be decoded before either operation reads UTF-8.
//! A plain rollout is streamed without a whole-file cap: every line is capped
//! and callers bound what they keep, so a long session stays readable.
use std::collections::VecDeque;
use std::io::{self, BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::Path;

use crate::security_limits::open_regular_file_no_symlink;

const MAX_COMPRESSED_BYTES: u64 = 256 * 1024 * 1024;
/// Decoded bytes one zstd stream may expand to, for listing and loading alike.
pub(super) const MAX_DECODED_BYTES: u64 = 256 * 1024 * 1024;
const MAX_LINE_BYTES: usize = 16 * 1024 * 1024;
const TAIL_BYTES: u64 = 16_384;
/// How much of an oversized line is kept to tell what kind of record it was.
const OVERSIZED_PREFIX_BYTES: usize = 256;

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

/// One JSONL record as read by [`SessionLines::next_record`].
pub(super) enum SessionLine {
    Text(String),
    /// A line over the per-line cap. It was consumed without being kept:
    /// `bytes` (newline included) says how large it was and `prefix` holds
    /// its first bytes, enough to read the record type.
    Oversized {
        bytes: u64,
        prefix: Vec<u8>,
    },
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

    fn unbounded(reader: impl Read + 'static, max_line_bytes: usize) -> Self {
        Self {
            reader: BufReader::new(Box::new(reader)),
            max_line_bytes,
        }
    }

    /// The next line, or the size of a line too long to keep. Reading carries
    /// on after an oversized line, so one huge record cannot hide the rest.
    pub(super) fn next_record(&mut self) -> io::Result<Option<SessionLine>> {
        let mut bytes = Vec::new();
        let read = (&mut self.reader)
            .take(self.max_line_bytes as u64 + 1)
            .read_until(b'\n', &mut bytes)?;
        if read == 0 {
            return Ok(None);
        }
        if read > self.max_line_bytes {
            let rest = if bytes.last() == Some(&b'\n') {
                0
            } else {
                self.skip_rest_of_line()?
            };
            bytes.truncate(OVERSIZED_PREFIX_BYTES);
            return Ok(Some(SessionLine::Oversized {
                bytes: read as u64 + rest,
                prefix: bytes,
            }));
        }
        if bytes.last() == Some(&b'\n') {
            bytes.pop();
            if bytes.last() == Some(&b'\r') {
                bytes.pop();
            }
        }
        String::from_utf8(bytes)
            .map(|line| Some(SessionLine::Text(line)))
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
    }

    /// Strict reading for the tests that pin the limits: an oversized line is
    /// an error here.
    #[cfg(test)]
    fn next_line(&mut self) -> io::Result<Option<String>> {
        match self.next_record()? {
            None => Ok(None),
            Some(SessionLine::Text(line)) => Ok(Some(line)),
            Some(SessionLine::Oversized { .. }) => Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "session line exceeds byte limit",
            )),
        }
    }

    /// Consume the rest of the current line, newline included, one buffer at
    /// a time so the line is never held in memory. Returns the bytes skipped.
    fn skip_rest_of_line(&mut self) -> io::Result<u64> {
        let mut skipped = 0u64;
        loop {
            let buffer = self.reader.fill_buf()?;
            if buffer.is_empty() {
                return Ok(skipped);
            }
            let (consumed, line_ended) = match buffer.iter().position(|&byte| byte == b'\n') {
                Some(index) => (index + 1, true),
                None => (buffer.len(), false),
            };
            self.reader.consume(consumed);
            skipped += consumed as u64;
            if line_ended {
                return Ok(skipped);
            }
        }
    }
}

fn is_compressed(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.ends_with(".jsonl.zst"))
}

/// `decoded_limit` bounds what a zstd stream may expand to; a plain file is
/// streamed line by line without a whole-file cap.
pub(super) fn open_lines(path: &Path, decoded_limit: u64) -> io::Result<SessionLines> {
    open_lines_with_limits(path, MAX_COMPRESSED_BYTES, decoded_limit, MAX_LINE_BYTES)
}

/// `input_limit` and `output_limit` guard a zstd stream against decompression
/// bombs (compressed size and decoded size). `line_limit` caps each line of
/// either kind of file.
pub(super) fn open_lines_with_limits(
    path: &Path,
    input_limit: u64,
    output_limit: u64,
    line_limit: usize,
) -> io::Result<SessionLines> {
    let file = open_regular_file_no_symlink(path)?;
    if !is_compressed(path) {
        return Ok(SessionLines::unbounded(file, line_limit));
    }
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
    let mut decoder = zstd::stream::read::Decoder::new(input)?;
    // Bound the decoder's own window allocation as well as decoded output.
    decoder.window_log_max(26)?;
    Ok(SessionLines::new(decoder, output_limit, line_limit))
}

/// The first `head_n` records and the last `tail_n` lines. An oversized line
/// still uses up a head slot but is left out, so one huge record (an inlined
/// image, a long tool log) does not drop the whole session from the list.
pub(super) fn read_head_tail_lines(
    path: &Path,
    head_n: usize,
    tail_n: usize,
) -> io::Result<(Vec<String>, Vec<String>)> {
    read_head_tail_lines_with_limit(path, head_n, tail_n, MAX_LINE_BYTES)
}

fn read_head_tail_lines_with_limit(
    path: &Path,
    head_n: usize,
    tail_n: usize,
    line_limit: usize,
) -> io::Result<(Vec<String>, Vec<String>)> {
    if is_compressed(path) {
        let mut lines =
            open_lines_with_limits(path, MAX_COMPRESSED_BYTES, MAX_DECODED_BYTES, line_limit)?;
        let mut head = Vec::new();
        let mut tail = VecDeque::new();
        let mut records = 0usize;
        while let Some(record) = lines.next_record()? {
            records += 1;
            let SessionLine::Text(line) = record else {
                continue;
            };
            if records <= head_n {
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
    let mut lines = SessionLines::unbounded(file, line_limit);
    let mut head = Vec::new();
    for _ in 0..head_n {
        match lines.next_record()? {
            None => break,
            Some(SessionLine::Text(line)) => head.push(line),
            Some(SessionLine::Oversized { .. }) => {}
        }
    }
    let seek_pos = file_len.saturating_sub(TAIL_BYTES);
    let mut tail_file = open_regular_file_no_symlink(path)?;
    tail_file.seek(SeekFrom::Start(seek_pos))?;
    let mut tail_lines =
        SessionLines::new(tail_file.take(file_len - seek_pos), TAIL_BYTES, line_limit);
    if seek_pos > 0 {
        // The seek may land inside a UTF-8 code point. Discard raw bytes first.
        tail_lines.skip_rest_of_line()?;
    }
    let mut tail = VecDeque::new();
    while let Some(record) = tail_lines.next_record()? {
        let SessionLine::Text(line) = record else {
            continue;
        };
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

    #[test]
    fn an_oversized_line_is_skipped_without_hiding_what_follows() {
        let content = format!("first\n{}\r\nlast", "x".repeat(50));
        let mut lines = SessionLines::unbounded(Cursor::new(content.into_bytes()), 10);
        assert!(matches!(
            lines.next_record().unwrap(),
            Some(SessionLine::Text(line)) if line == "first"
        ));
        assert!(matches!(
            lines.next_record().unwrap(),
            Some(SessionLine::Oversized { bytes: 52, prefix }) if prefix == b"xxxxxxxxxxx"
        ));
        assert!(matches!(
            lines.next_record().unwrap(),
            Some(SessionLine::Text(line)) if line == "last"
        ));
        assert!(lines.next_record().unwrap().is_none());
    }

    #[test]
    fn a_plain_rollout_has_no_whole_file_cap() {
        let tmp = tempdir().unwrap();
        let path = tmp.path().join("rollout.jsonl");
        std::fs::write(&path, "one\ntwo\nthree\n").unwrap();
        // The input and decoded limits only guard zstd streams.
        assert_eq!(
            drain(open_lines_with_limits(&path, 4, 4, 100).unwrap()).unwrap(),
            ["one", "two", "three"]
        );
    }

    #[test]
    fn listing_keeps_the_records_around_an_oversized_line() {
        let tmp = tempdir().unwrap();
        let content = format!("head\n{}\nnext\nlast\n", "y".repeat(65));
        for name in ["rollout.jsonl", "rollout.jsonl.zst"] {
            let path = tmp.path().join(name);
            let bytes = if is_compressed(&path) {
                zstd::stream::encode_all(content.as_bytes(), 1).unwrap()
            } else {
                content.as_bytes().to_vec()
            };
            std::fs::write(&path, bytes).unwrap();
            let (head, tail) = read_head_tail_lines_with_limit(&path, 3, 2, 64).unwrap();
            assert_eq!(head, ["head", "next"], "{name}");
            assert_eq!(tail, ["next", "last"], "{name}");
        }
    }
}
