use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use serde_json::{Map, Value};

const ENV_NAME: &str = "NANOGRAPH_WRITE_TRACE";

pub(crate) fn elapsed_ms(start: Instant) -> u64 {
    start.elapsed().as_millis().try_into().unwrap_or(u64::MAX)
}

pub(crate) fn event(name: &str, fields: Value) {
    let Ok(target) = std::env::var(ENV_NAME) else {
        return;
    };
    let trimmed = target.trim();
    if trimmed.is_empty()
        || trimmed.eq_ignore_ascii_case("0")
        || trimmed.eq_ignore_ascii_case("false")
        || trimmed.eq_ignore_ascii_case("off")
    {
        return;
    }

    let mut object = match fields {
        Value::Object(map) => map,
        _ => Map::new(),
    };
    object.insert("event".to_string(), Value::String(name.to_string()));
    object.insert("timeMs".to_string(), Value::from(now_unix_ms()));

    let Ok(line) = serde_json::to_string(&Value::Object(object)) else {
        return;
    };
    if trimmed.eq_ignore_ascii_case("1")
        || trimmed.eq_ignore_ascii_case("true")
        || trimmed.eq_ignore_ascii_case("stderr")
    {
        eprintln!("{}", line);
        return;
    }

    let path = PathBuf::from(trimmed);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{}", line);
    }
}

fn now_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().try_into().unwrap_or(u64::MAX))
        .unwrap_or_default()
}
