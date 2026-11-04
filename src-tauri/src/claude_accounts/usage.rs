//! What Claude Code has used, read from its own conversation logs.
//!
//! Every assistant message in `<config folder>/projects/**/*.jsonl` records
//! the tokens it cost. This reads those files for the default config folder
//! and for each parallel session folder, counts every message once (a resumed
//! conversation copies its history into a new file), and sums tokens by day,
//! project, model and where the message came from.
//!
//! It is separate from the usage database on purpose: that one only reads the
//! default folder and has no project or account to group by, and adding them
//! would be a schema migration. Costs are not computed here; the caller
//! prices each model's tokens.
//!
//! A parsed file is remembered by its size and modification time, so only
//! files that changed are read again.

use std::collections::hash_map::DefaultHasher;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::hash::{Hash, Hasher};
use std::io::{self, BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::UNIX_EPOCH;

use chrono::{Local, NaiveDate};
use serde::Serialize;
use serde_json::Value;

use super::code::{self, sessions, CodeVault};
use crate::security_limits::is_link_or_reparse_point;

const MAX_FILES: usize = 200_000;
const MAX_LINE_BYTES: usize = 8 * 1024 * 1024;
const MAX_FILE_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_DEPTH: usize = 7;
const TOP_PROJECTS: usize = 30;

/// A folder whose conversations are counted, and what to call it.
#[derive(Debug, Clone)]
pub struct Root {
    pub label: String,
    /// The saved login it belongs to, for a session folder.
    pub account_id: Option<String>,
    pub path: PathBuf,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tokens {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
}

impl Tokens {
    pub fn total(&self) -> u64 {
        self.input + self.output + self.cache_read + self.cache_write
    }

    fn add(&mut self, other: &Tokens) {
        self.input += other.input;
        self.output += other.output;
        self.cache_read += other.cache_read;
        self.cache_write += other.cache_write;
    }

    fn max(&mut self, other: &Tokens) {
        self.input = self.input.max(other.input);
        self.output = self.output.max(other.output);
        self.cache_read = self.cache_read.max(other.cache_read);
        self.cache_write = self.cache_write.max(other.cache_write);
    }
}

/// One message's usage.
#[derive(Debug, Clone)]
struct Record {
    key: u64,
    day: NaiveDate,
    project: Arc<str>,
    model: Arc<str>,
    tokens: Tokens,
}

struct CachedFile {
    len: u64,
    modified: u128,
    records: Arc<Vec<Record>>,
}

static CACHE: LazyLock<Mutex<HashMap<PathBuf, CachedFile>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static INTERNED: LazyLock<Mutex<HashSet<Arc<str>>>> = LazyLock::new(|| Mutex::new(HashSet::new()));

fn intern(text: &str) -> Arc<str> {
    let mut set = INTERNED.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(existing) = set.get(text) {
        return existing.clone();
    }
    let value: Arc<str> = Arc::from(text);
    set.insert(value.clone());
    value
}

fn hash_of(parts: &[&str]) -> u64 {
    let mut hasher = DefaultHasher::new();
    for part in parts {
        part.hash(&mut hasher);
    }
    hasher.finish()
}

// ===== reading =====

/// Reads one line of at most `cap` bytes into `line`; longer lines are read
/// through and dropped (`Ok(Some(false))`). `Ok(None)` at the end of the file.
fn read_capped_line<R: BufRead>(
    reader: &mut R,
    line: &mut Vec<u8>,
    cap: usize,
) -> io::Result<Option<bool>> {
    line.clear();
    let mut seen_any = false;
    let mut too_long = false;
    loop {
        let buffer = reader.fill_buf()?;
        if buffer.is_empty() {
            return Ok(seen_any.then_some(!too_long));
        }
        seen_any = true;
        let (chunk, done) = match buffer.iter().position(|&byte| byte == b'\n') {
            Some(end) => (&buffer[..end], Some(end + 1)),
            None => (buffer, None),
        };
        if !too_long {
            if line.len() + chunk.len() > cap {
                too_long = true;
                line.clear();
            } else {
                line.extend_from_slice(chunk);
            }
        }
        let consumed = done.unwrap_or(chunk.len());
        reader.consume(consumed);
        if done.is_some() {
            return Ok(Some(!too_long));
        }
    }
}

fn token_count(usage: &Value, field: &str) -> u64 {
    usage.get(field).and_then(Value::as_u64).unwrap_or(0)
}

/// The usage of one JSONL line, if it is an assistant message that cost tokens.
fn parse_line(line: &[u8], fallback_project: &str) -> Option<Record> {
    // Most lines are not assistant usage; skip them without parsing.
    let text = std::str::from_utf8(line).ok()?;
    if !text.contains("\"usage\"") {
        return None;
    }
    let value: Value = serde_json::from_str(text).ok()?;
    let message = value.get("message")?;
    let usage = message.get("usage")?;
    let model = message.get("model").and_then(Value::as_str)?;
    if model.is_empty() || model.starts_with('<') {
        return None;
    }
    let tokens = Tokens {
        input: token_count(usage, "input_tokens"),
        output: token_count(usage, "output_tokens"),
        cache_read: token_count(usage, "cache_read_input_tokens"),
        cache_write: token_count(usage, "cache_creation_input_tokens"),
    };
    if tokens.total() == 0 {
        return None;
    }
    let stamp = value.get("timestamp").and_then(Value::as_str)?;
    let day = chrono::DateTime::parse_from_rfc3339(stamp)
        .ok()?
        .with_timezone(&Local)
        .date_naive();
    let message_id = message.get("id").and_then(Value::as_str).unwrap_or("");
    let request_id = value.get("requestId").and_then(Value::as_str).unwrap_or("");
    // Without an id there is nothing to count once; use where the line is.
    let key = if message_id.is_empty() {
        hash_of(&[stamp, model, &tokens.total().to_string()])
    } else {
        hash_of(&[message_id, request_id])
    };
    let project = value
        .get("cwd")
        .and_then(Value::as_str)
        .filter(|cwd| !cwd.is_empty())
        .unwrap_or(fallback_project);
    Some(Record {
        key,
        day,
        project: intern(project),
        model: intern(model),
        tokens,
    })
}

fn parse_file(path: &Path, fallback_project: &str) -> io::Result<Vec<Record>> {
    let mut reader = BufReader::with_capacity(256 * 1024, fs::File::open(path)?);
    let mut line = Vec::new();
    let mut records = Vec::new();
    while let Some(complete) = read_capped_line(&mut reader, &mut line, MAX_LINE_BYTES)? {
        if complete {
            if let Some(record) = parse_line(&line, fallback_project) {
                records.push(record);
            }
        }
    }
    Ok(records)
}

fn modified_of(meta: &fs::Metadata) -> u128 {
    meta.modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |elapsed| elapsed.as_nanos())
}

/// Every `.jsonl` under `<root>/projects`, with the folder name of its project.
fn collect_files(root: &Path, out: &mut Vec<(PathBuf, String)>, truncated: &mut bool) {
    fn walk(
        dir: &Path,
        project: &str,
        depth: usize,
        out: &mut Vec<(PathBuf, String)>,
        truncated: &mut bool,
    ) {
        if depth > MAX_DEPTH {
            return;
        }
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            if out.len() >= MAX_FILES {
                *truncated = true;
                return;
            }
            let path = entry.path();
            let Ok(meta) = fs::symlink_metadata(&path) else {
                continue;
            };
            if is_link_or_reparse_point(&meta) {
                continue;
            }
            if meta.is_dir() {
                walk(&path, project, depth + 1, out, truncated);
            } else if meta.is_file() && path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
                out.push((path, project.to_string()));
            }
        }
    }
    let Ok(projects) = fs::read_dir(root.join("projects")) else {
        return;
    };
    for entry in projects.flatten() {
        let path = entry.path();
        let Ok(meta) = fs::symlink_metadata(&path) else {
            continue;
        };
        if meta.is_dir() && !is_link_or_reparse_point(&meta) {
            let name = entry.file_name().to_string_lossy().into_owned();
            walk(&path, &name, 0, out, truncated);
        }
    }
}

/// What a scan found, before it is counted.
pub struct Scan {
    records: Vec<(usize, Arc<Vec<Record>>)>,
    pub files: usize,
    /// Some files were left out (too many, or too large).
    pub truncated: bool,
}

impl Scan {
    /// Every model that appears, for pricing.
    pub fn models(&self) -> HashSet<String> {
        self.records
            .iter()
            .flat_map(|(_, records)| records.iter().map(|record| record.model.to_string()))
            .collect()
    }
}

/// The default config folder and each saved login's session folder.
pub fn roots(vault: &CodeVault, default_dir: PathBuf) -> Vec<Root> {
    let mut roots = vec![Root {
        label: "默认登录".to_string(),
        account_id: None,
        path: default_dir,
    }];
    for (id, name) in code::saved_names(vault) {
        if let Ok(path) = sessions::profile_dir(vault, &id) {
            if path.is_dir() {
                roots.push(Root {
                    label: name,
                    account_id: Some(id),
                    path,
                });
            }
        }
    }
    roots
}

/// Reads the conversation logs of every root; files that did not change since
/// the last scan are taken from memory.
pub fn scan(roots: &[Root]) -> Scan {
    let mut records = Vec::new();
    let mut files = 0usize;
    let mut truncated = false;
    let mut seen: HashSet<PathBuf> = HashSet::new();
    for (index, root) in roots.iter().enumerate() {
        let mut found = Vec::new();
        collect_files(&root.path, &mut found, &mut truncated);
        for (path, project) in found {
            let Ok(meta) = fs::metadata(&path) else {
                continue;
            };
            if meta.len() > MAX_FILE_BYTES {
                truncated = true;
                continue;
            }
            let (len, modified) = (meta.len(), modified_of(&meta));
            let cached = {
                let cache = CACHE.lock().unwrap_or_else(|e| e.into_inner());
                cache
                    .get(&path)
                    .filter(|entry| entry.len == len && entry.modified == modified)
                    .map(|entry| entry.records.clone())
            };
            let parsed = match cached {
                Some(records) => records,
                None => {
                    let Ok(parsed) = parse_file(&path, &project) else {
                        continue;
                    };
                    let parsed = Arc::new(parsed);
                    CACHE.lock().unwrap_or_else(|e| e.into_inner()).insert(
                        path.clone(),
                        CachedFile {
                            len,
                            modified,
                            records: parsed.clone(),
                        },
                    );
                    parsed
                }
            };
            files += 1;
            seen.insert(path);
            records.push((index, parsed));
        }
    }
    // Forget files that are gone.
    CACHE
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .retain(|path, _| seen.contains(path) || !roots.iter().any(|r| path.starts_with(&r.path)));
    Scan {
        records,
        files,
        truncated,
    }
}

// ===== counting =====

/// What a bucket costs. `None` when the model has no price.
pub type Price<'a> = &'a dyn Fn(&str, &Tokens) -> Option<f64>;

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bucket {
    pub tokens: Tokens,
    pub messages: u32,
    pub cost_usd: f64,
    /// Some of these tokens are from a model with no known price.
    pub cost_partial: bool,
}

impl Bucket {
    fn add(&mut self, tokens: &Tokens, cost: Option<f64>) {
        self.tokens.add(tokens);
        self.messages += 1;
        match cost {
            Some(cost) => self.cost_usd += cost,
            None => self.cost_partial = true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DayUsage {
    /// `YYYY-MM-DD`, local time.
    pub day: String,
    #[serde(flatten)]
    pub usage: Bucket,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NamedUsage {
    pub name: String,
    /// The project folder, or the saved login's id.
    pub detail: Option<String>,
    pub last_day: Option<String>,
    #[serde(flatten)]
    pub usage: Bucket,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageOverview {
    pub range_days: Option<u32>,
    pub files_scanned: usize,
    pub truncated: bool,
    pub totals: Bucket,
    pub days: Vec<DayUsage>,
    pub projects: Vec<NamedUsage>,
    pub models: Vec<NamedUsage>,
    pub sources: Vec<NamedUsage>,
}

fn project_name(path: &str) -> String {
    path.trim_end_matches(['\\', '/'])
        .rsplit(['\\', '/'])
        .find(|part| !part.is_empty())
        .unwrap_or(path)
        .to_string()
}

fn named(map: HashMap<String, (Option<String>, Option<NaiveDate>, Bucket)>) -> Vec<NamedUsage> {
    let mut rows: Vec<NamedUsage> = map
        .into_iter()
        .map(|(name, (detail, last, usage))| NamedUsage {
            name,
            detail,
            last_day: last.map(|day| day.format("%Y-%m-%d").to_string()),
            usage,
        })
        .collect();
    rows.sort_by(|a, b| {
        b.usage
            .tokens
            .total()
            .cmp(&a.usage.tokens.total())
            .then_with(|| a.name.cmp(&b.name))
    });
    rows
}

/// Counts a scan: every message once, inside the last `range_days` days
/// (`None` for all of it), ending today (`today`, local).
pub fn summarize(
    scan: &Scan,
    roots: &[Root],
    range_days: Option<u32>,
    today: NaiveDate,
    price: Price<'_>,
) -> UsageOverview {
    let since = range_days.map(|days| today - chrono::Duration::days(i64::from(days.max(1)) - 1));

    // One entry per message: the largest of each count (a message is written
    // several times while it streams), from the first root that had it.
    let mut unique: HashMap<u64, (usize, Record)> = HashMap::new();
    for (root, records) in &scan.records {
        for record in records.iter() {
            if since.is_some_and(|since| record.day < since) || record.day > today {
                continue;
            }
            unique
                .entry(record.key)
                .and_modify(|(_, kept)| kept.tokens.max(&record.tokens))
                .or_insert_with(|| (*root, record.clone()));
        }
    }

    let mut totals = Bucket::default();
    let mut days: HashMap<NaiveDate, Bucket> = HashMap::new();
    let mut projects: HashMap<String, (Option<String>, Option<NaiveDate>, Bucket)> = HashMap::new();
    let mut models: HashMap<String, (Option<String>, Option<NaiveDate>, Bucket)> = HashMap::new();
    let mut sources: HashMap<String, (Option<String>, Option<NaiveDate>, Bucket)> = HashMap::new();
    let mut prices: HashMap<Arc<str>, bool> = HashMap::new();
    for (root, record) in unique.values() {
        let cost = price(&record.model, &record.tokens);
        prices.entry(record.model.clone()).or_insert(cost.is_some());
        totals.add(&record.tokens, cost);
        days.entry(record.day)
            .or_default()
            .add(&record.tokens, cost);
        // One project per folder: paths differ only by case or a trailing
        // separator on Windows.
        let detail = record.project.to_string();
        let key = detail.trim_end_matches(['\\', '/']).to_string();
        let key = if cfg!(windows) {
            key.to_lowercase()
        } else {
            key
        };
        let entry = projects
            .entry(key)
            .or_insert_with(|| (Some(detail), None, Bucket::default()));
        entry.1 = entry.1.max(Some(record.day));
        entry.2.add(&record.tokens, cost);
        let entry =
            models
                .entry(record.model.to_string())
                .or_insert((None, None, Bucket::default()));
        entry.1 = entry.1.max(Some(record.day));
        entry.2.add(&record.tokens, cost);
        let source = &roots[*root];
        let entry = sources.entry(source.label.clone()).or_insert((
            source.account_id.clone(),
            None,
            Bucket::default(),
        ));
        entry.1 = entry.1.max(Some(record.day));
        entry.2.add(&record.tokens, cost);
    }

    let mut day_rows: Vec<DayUsage> = days
        .into_iter()
        .map(|(day, usage)| DayUsage {
            day: day.format("%Y-%m-%d").to_string(),
            usage,
        })
        .collect();
    day_rows.sort_by(|a, b| a.day.cmp(&b.day));

    // Projects were keyed by folder; show the folder's name, with its path.
    let mut project_rows = named(projects);
    for row in &mut project_rows {
        let path = row.detail.clone().unwrap_or_else(|| row.name.clone());
        row.name = project_name(&path);
        row.detail = Some(path);
    }
    project_rows.truncate(TOP_PROJECTS);

    UsageOverview {
        range_days,
        files_scanned: scan.files,
        truncated: scan.truncated,
        totals,
        days: day_rows,
        projects: project_rows,
        models: named(models),
        sources: named(sources),
    }
}

/// Today in the local time zone.
pub fn today() -> NaiveDate {
    Local::now().date_naive()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn line(id: &str, request: &str, model: &str, stamp: &str, cwd: &str, usage: Value) -> String {
        json!({
            "type": "assistant",
            "timestamp": stamp,
            "cwd": cwd,
            "requestId": request,
            "message": {"id": id, "model": model, "usage": usage}
        })
        .to_string()
    }

    fn usage(input: u64, output: u64, read: u64, write: u64) -> Value {
        json!({
            "input_tokens": input, "output_tokens": output,
            "cache_read_input_tokens": read, "cache_creation_input_tokens": write
        })
    }

    fn write_log(root: &Path, project: &str, name: &str, lines: &[String]) -> PathBuf {
        let dir = root.join("projects").join(project);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        fs::write(&path, lines.join("\n") + "\n").unwrap();
        path
    }

    fn root(path: &Path, label: &str, id: Option<&str>) -> Root {
        Root {
            label: label.to_string(),
            account_id: id.map(str::to_string),
            path: path.to_path_buf(),
        }
    }

    const NO_PRICE: Price<'static> = &|_, _| None;

    fn day(text: &str) -> NaiveDate {
        NaiveDate::parse_from_str(text, "%Y-%m-%d").unwrap()
    }

    /// A timestamp at local noon, so the local day is the same everywhere.
    fn noon(date: &str) -> String {
        let naive = day(date).and_hms_opt(12, 0, 0).unwrap();
        naive.and_local_timezone(Local).unwrap().to_rfc3339()
    }

    #[test]
    fn a_message_is_counted_once_across_files_and_streaming_writes() {
        let temp = tempfile::tempdir().unwrap();
        let t = noon("2026-11-03");
        // Written twice while streaming (the second has the final output), and
        // again in the file a resumed conversation started.
        write_log(
            temp.path(),
            "p1",
            "a.jsonl",
            &[
                line(
                    "m1",
                    "r1",
                    "claude-fable-5",
                    &t,
                    "D:\\work\\app",
                    usage(10, 1, 100, 5),
                ),
                line(
                    "m1",
                    "r1",
                    "claude-fable-5",
                    &t,
                    "D:\\work\\app",
                    usage(10, 40, 100, 5),
                ),
                line(
                    "m2",
                    "r2",
                    "claude-fable-5",
                    &t,
                    "D:\\work\\app",
                    usage(20, 2, 0, 0),
                ),
            ],
        );
        write_log(
            temp.path(),
            "p1",
            "b.jsonl",
            &[line(
                "m1",
                "r1",
                "claude-fable-5",
                &t,
                "D:\\work\\app",
                usage(10, 40, 100, 5),
            )],
        );
        let roots = [root(temp.path(), "默认登录", None)];
        let overview = summarize(&scan(&roots), &roots, None, day("2026-11-04"), NO_PRICE);
        assert_eq!(overview.totals.messages, 2);
        assert_eq!(
            overview.totals.tokens,
            Tokens {
                input: 30,
                output: 42,
                cache_read: 100,
                cache_write: 5
            }
        );
        assert!(overview.totals.cost_partial, "no price was known");
        assert_eq!(overview.files_scanned, 2);
    }

    #[test]
    fn tokens_are_grouped_by_day_project_model_and_where_they_came_from() {
        let temp = tempfile::tempdir().unwrap();
        let session = tempfile::tempdir().unwrap();
        write_log(
            temp.path(),
            "p1",
            "a.jsonl",
            &[
                line(
                    "a1",
                    "r",
                    "claude-fable-5",
                    &noon("2026-11-03"),
                    "D:\\work\\app",
                    usage(10, 10, 0, 0),
                ),
                line(
                    "a2",
                    "r",
                    "claude-sonnet-5-5",
                    &noon("2026-11-04"),
                    "D:\\work\\app",
                    usage(5, 5, 0, 0),
                ),
                line(
                    "a3",
                    "r",
                    "claude-fable-5",
                    &noon("2026-11-04"),
                    "D:\\work\\Other\\",
                    usage(1, 1, 0, 0),
                ),
            ],
        );
        write_log(
            session.path(),
            "p9",
            "s.jsonl",
            &[line(
                "s1",
                "r",
                "claude-fable-5",
                &noon("2026-11-04"),
                "D:\\work\\app",
                usage(100, 100, 0, 0),
            )],
        );
        let roots = [
            root(temp.path(), "默认登录", None),
            root(session.path(), "工作号", Some("a1b2")),
        ];
        let overview = summarize(&scan(&roots), &roots, None, day("2026-11-04"), NO_PRICE);
        assert_eq!(
            overview
                .days
                .iter()
                .map(|d| d.day.as_str())
                .collect::<Vec<_>>(),
            ["2026-11-03", "2026-11-04"]
        );
        assert_eq!(overview.days[1].usage.messages, 3);
        let project = |name: &str| overview.projects.iter().find(|p| p.name == name).unwrap();
        assert_eq!(project("app").usage.tokens.total(), 20 + 10 + 200);
        assert_eq!(project("Other").usage.tokens.total(), 2);
        assert_eq!(project("app").detail.as_deref(), Some("D:\\work\\app"));
        assert_eq!(overview.projects[0].name, "app", "biggest first");
        let model = |name: &str| overview.models.iter().find(|m| m.name == name).unwrap();
        assert_eq!(model("claude-fable-5").usage.messages, 3);
        let source = |name: &str| overview.sources.iter().find(|s| s.name == name).unwrap();
        assert_eq!(source("工作号").usage.tokens.total(), 200);
        assert_eq!(source("工作号").detail.as_deref(), Some("a1b2"));
        assert_eq!(source("默认登录").usage.messages, 3);
        assert_eq!(source("默认登录").last_day.as_deref(), Some("2026-11-04"));
    }

    #[test]
    fn the_range_keeps_the_last_days_and_costs_use_the_price_given() {
        let temp = tempfile::tempdir().unwrap();
        write_log(
            temp.path(),
            "p",
            "a.jsonl",
            &[
                line(
                    "old",
                    "r",
                    "claude-fable-5",
                    &noon("2026-10-01"),
                    "D:\\w",
                    usage(1_000_000, 0, 0, 0),
                ),
                line(
                    "new",
                    "r",
                    "claude-fable-5",
                    &noon("2026-11-04"),
                    "D:\\w",
                    usage(1_000_000, 1_000_000, 0, 0),
                ),
                line(
                    "unknown",
                    "r",
                    "mystery-model",
                    &noon("2026-11-04"),
                    "D:\\w",
                    usage(7, 0, 0, 0),
                ),
            ],
        );
        let roots = [root(temp.path(), "默认登录", None)];
        let scanned = scan(&roots);
        let price: Price<'_> = &|model, tokens| {
            (model == "claude-fable-5")
                .then(|| tokens.input as f64 * 3.0 / 1e6 + tokens.output as f64 * 15.0 / 1e6)
        };
        let week = summarize(&scanned, &roots, Some(7), day("2026-11-04"), price);
        assert_eq!(week.totals.messages, 2);
        assert!((week.totals.cost_usd - 18.0).abs() < 1e-9);
        assert!(week.totals.cost_partial);
        let all = summarize(&scanned, &roots, None, day("2026-11-04"), price);
        assert_eq!(all.totals.messages, 3);
        assert!((all.totals.cost_usd - 21.0).abs() < 1e-9);
        // The model with no price is listed, flagged, and costs nothing here.
        let mystery = all
            .models
            .iter()
            .find(|m| m.name == "mystery-model")
            .unwrap();
        assert!(mystery.usage.cost_partial && mystery.usage.cost_usd == 0.0);
        // A message dated after today is not counted.
        let before = summarize(&scanned, &roots, None, day("2026-11-03"), price);
        assert_eq!(before.totals.messages, 1);
    }

    #[test]
    fn lines_that_are_not_usage_are_skipped_and_odd_files_do_not_stop_the_count() {
        let temp = tempfile::tempdir().unwrap();
        let t = noon("2026-11-04");
        let long = format!("{{\"junk\":\"{}\"}}", "x".repeat(MAX_LINE_BYTES + 10));
        write_log(temp.path(), "p", "a.jsonl", &[
            "{ not json \"usage\"".to_string(),
            json!({"type": "user", "message": {"role": "user", "content": "hi"}}).to_string(),
            line("synth", "r", "<synthetic>", &t, "D:\\w", usage(5, 5, 0, 0)),
            line("zero", "r", "claude-fable-5", &t, "D:\\w", usage(0, 0, 0, 0)),
            json!({"timestamp": "yesterday", "message": {"id": "x", "model": "m", "usage": usage(1, 1, 0, 0)}}).to_string(),
            long,
            line("ok", "r", "claude-fable-5", &t, "", usage(3, 4, 0, 0)),
        ]);
        let dir = temp.path().join("projects").join("p");
        fs::write(dir.join("notes.txt"), "usage").unwrap();
        fs::write(dir.join("bad.jsonl"), [0xff, 0xfe, b'\n']).unwrap();
        let roots = [root(temp.path(), "默认登录", None)];
        let overview = summarize(&scan(&roots), &roots, None, day("2026-11-04"), NO_PRICE);
        assert_eq!(overview.totals.messages, 1);
        // With no cwd the project folder's name stands in.
        assert_eq!(overview.projects[0].name, "p");
    }

    #[test]
    fn a_file_is_read_again_only_when_it_changed() {
        let temp = tempfile::tempdir().unwrap();
        let t = noon("2026-11-04");
        let path = write_log(
            temp.path(),
            "p",
            "a.jsonl",
            &[line(
                "one",
                "r",
                "claude-fable-5",
                &t,
                "D:\\w",
                usage(1, 1, 0, 0),
            )],
        );
        let roots = [root(temp.path(), "默认登录", None)];
        let count = || {
            summarize(&scan(&roots), &roots, None, day("2026-11-04"), NO_PRICE)
                .totals
                .messages
        };
        assert_eq!(count(), 1);
        fs::write(
            &path,
            [
                line("one", "r", "claude-fable-5", &t, "D:\\w", usage(1, 1, 0, 0)),
                line("two", "r", "claude-fable-5", &t, "D:\\w", usage(2, 2, 0, 0)),
            ]
            .join("\n"),
        )
        .unwrap();
        assert_eq!(count(), 2);
        fs::remove_file(&path).unwrap();
        assert_eq!(count(), 0);
        assert!(
            !CACHE.lock().unwrap().contains_key(&path),
            "gone files are forgotten"
        );
    }

    #[test]
    fn nested_sub_agent_logs_are_found_and_links_are_not_followed() {
        let temp = tempfile::tempdir().unwrap();
        let t = noon("2026-11-04");
        let nested = temp
            .path()
            .join("projects")
            .join("p")
            .join("session-1")
            .join("subagents");
        fs::create_dir_all(&nested).unwrap();
        fs::write(
            nested.join("agent.jsonl"),
            line("sub", "r", "claude-fable-5", &t, "D:\\w", usage(1, 1, 0, 0)),
        )
        .unwrap();
        let roots = [root(temp.path(), "默认登录", None)];
        let overview = summarize(&scan(&roots), &roots, None, day("2026-11-04"), NO_PRICE);
        assert_eq!(overview.totals.messages, 1);
        assert_eq!(overview.files_scanned, 1);
    }

    #[test]
    fn project_names_come_from_the_last_path_part() {
        assert_eq!(project_name("D:\\work\\app"), "app");
        assert_eq!(project_name("D:\\work\\app\\"), "app");
        assert_eq!(project_name("/home/me/app"), "app");
        assert_eq!(project_name("D:\\"), "D:");
        assert_eq!(project_name("plain"), "plain");
    }
}
