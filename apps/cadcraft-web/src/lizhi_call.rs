//! `lizhi.call`: the full CADCraft command surface for a same-origin parent page that the owner
//! has explicitly authorized (立之雲端庫 → ChatGPT). One request runs one operation:
//!
//! - `execute {command, params}`: any engine command with JSON parameters (never a dialog).
//! - `cmdline {text}`: type a line at the command line, exactly like a user.
//! - `script {text}`: a multi-line script, like a `.scr` file.
//! - `commands {filter?}`: the command catalog.
//! - `inspect {entities?, limit?}`: drawing summary (counts, extents, layers, blocks, selection…).
//! - `render {width?, height?, fit?, window?}`: a PNG of the drawing (`pngBase64`).
//!
//! Guards, applied before anything runs: no file-system paths (the browser has none); no commands
//! that replace or close the open drawing, read files, load programs or drive devices; destructive
//! commands (erase, purge, delete, new…) need `confirmed: true`, which the parent only sets after
//! the owner agreed. The engine's own validation and catch-unwind guard still apply.

use serde_json::{Value, json};

/// Longest command-line or script text accepted.
const MAX_TEXT_CHARS: usize = 16_384;
/// Most lines in one script.
const MAX_SCRIPT_LINES: usize = 500;
/// Largest render side in pixels.
const MAX_RENDER_SIDE: u64 = 4096;

/// Commands never run from a remote call: they replace/close the drawing the owner has open,
/// read or write files by path, load programs, or drive printers.
const BLOCKED: &[&str] = &[
    "open",
    "close",
    "closeall",
    "recover",
    "drawingrecovery",
    "xopen",
    "appload",
    "lisp",
    "script",
    "plot",
    "plotwindow",
    "plottermanager",
    "-plottermanager",
    "refclose",
    "bclose",
    "compareclose",
    "arrayclose",
    "quit",
    "exit",
];

/// Commands that delete or replace work: need `confirmed: true`.
const DESTRUCTIVE: &[&str] = &[
    "new",
    "erase",
    "erase.selection",
    "purge",
    "audit",
    "layer.delete",
    "layerstate.delete",
    "layout.delete",
    "style.delete",
    "dimstyle.delete",
    "table.deleterow",
    "table.deletecol",
    "-purge",
    "overkill",
];

/// Parameter names that would point at the file system or the network.
fn is_path_key(key: &str) -> bool {
    matches!(key, "path" | "file" | "filename" | "folder" | "dir" | "directory" | "template" | "url" | "output")
        || key.ends_with("_path")
        || key.ends_with("Path")
}

fn has_path_param(value: &Value, depth: usize) -> bool {
    if depth > 8 {
        return true;
    }
    match value {
        Value::Object(map) => map.iter().any(|(k, v)| (is_path_key(k) && !v.is_null()) || has_path_param(v, depth + 1)),
        Value::Array(items) => items.iter().any(|v| has_path_param(v, depth + 1)),
        _ => false,
    }
}

fn canonical(command: &str) -> String {
    command.trim().trim_start_matches(['_', '.']).to_ascii_lowercase()
}

/// Why a command can't run remotely, or `None` when it may (with `confirmed` for destructive).
pub fn command_refusal(command: &str, confirmed: bool) -> Option<&'static str> {
    let id = canonical(command);
    if BLOCKED.contains(&id.as_str()) {
        return Some("CAD_COMMAND_NOT_ALLOWED_REMOTELY");
    }
    if DESTRUCTIVE.contains(&id.as_str()) && !confirmed {
        return Some("CAD_DESTRUCTIVE_COMMAND_REQUIRES_CONFIRMATION");
    }
    None
}

/// The command names a line of command-line text can start: its first word, and every word that
/// follows an empty input (two spaces = two Enters, which ends the running command).
fn command_starts(line: &str) -> Vec<String> {
    let mut starts = Vec::new();
    let mut after_empty = true;
    for part in line.split(' ') {
        if part.is_empty() {
            after_empty = true;
            continue;
        }
        if after_empty {
            starts.push(canonical(part));
        }
        after_empty = false;
    }
    starts
}

fn text_refusal(text: &str, confirmed: bool) -> Option<&'static str> {
    if text.chars().count() > MAX_TEXT_CHARS || text.lines().count() > MAX_SCRIPT_LINES {
        return Some("CAD_TEXT_TOO_LONG");
    }
    if text.contains('\0') {
        return Some("CAD_TEXT_INVALID");
    }
    for line in text.lines() {
        for word in command_starts(line) {
            // A JSON-form call (`erase {"handles":…}`) starts with the command too.
            let id = word.split('{').next().unwrap_or("");
            if let Some(reason) = command_refusal(id, confirmed) {
                return Some(reason);
            }
        }
    }
    None
}

fn obj_keys_within(o: &serde_json::Map<String, Value>, allowed: &[&str]) -> bool {
    o.keys().all(|k| allowed.contains(&k.as_str()))
}

/// Validates a `lizhi.call` request without touching the drawing. `Err` carries the reason.
pub fn check_call(params: &Value) -> Result<(), &'static str> {
    let Some(o) = params.as_object() else { return Err("CAD_CALL_INVALID") };
    let confirmed = match o.get("confirmed") {
        None => false,
        Some(Value::Bool(true)) => true,
        Some(_) => return Err("CAD_CALL_INVALID"),
    };
    let Some(op) = o.get("op").and_then(Value::as_str) else { return Err("CAD_CALL_INVALID") };
    if has_path_param(params, 0) {
        return Err("CAD_BROWSER_HAS_NO_FILESYSTEM_PATH");
    }
    match op {
        "execute" => {
            if !obj_keys_within(o, &["op", "command", "params", "confirmed"]) {
                return Err("CAD_CALL_INVALID");
            }
            let Some(command) = o.get("command").and_then(Value::as_str) else { return Err("CAD_CALL_INVALID") };
            if command.is_empty() || command.len() > 64 || !command.chars().all(|c| c.is_ascii_graphic()) {
                return Err("CAD_CALL_INVALID");
            }
            if !o.get("params").is_none_or(|p| p.is_object() || p.is_null()) {
                return Err("CAD_CALL_INVALID");
            }
            command_refusal(command, confirmed).map_or(Ok(()), Err)
        }
        "cmdline" | "script" => {
            if !obj_keys_within(o, &["op", "text", "confirmed"]) {
                return Err("CAD_CALL_INVALID");
            }
            let Some(text) = o.get("text").and_then(Value::as_str) else { return Err("CAD_CALL_INVALID") };
            text_refusal(text, confirmed).map_or(Ok(()), Err)
        }
        "commands" => {
            if !obj_keys_within(o, &["op", "filter"]) || !o.get("filter").is_none_or(|f| f.as_str().is_some_and(|s| s.len() <= 64)) {
                return Err("CAD_CALL_INVALID");
            }
            Ok(())
        }
        "inspect" => {
            if !obj_keys_within(o, &["op", "entities", "limit"])
                || !o.get("entities").is_none_or(Value::is_boolean)
                || !o.get("limit").is_none_or(|v| v.as_u64().is_some_and(|n| (1..=2000).contains(&n)))
            {
                return Err("CAD_CALL_INVALID");
            }
            Ok(())
        }
        "render" => {
            if !obj_keys_within(o, &["op", "width", "height", "fit", "window"])
                || !["width", "height"].iter().all(|k| o.get(*k).is_none_or(|v| v.as_u64().is_some_and(|n| (16..=MAX_RENDER_SIDE).contains(&n))))
                || !o.get("fit").is_none_or(Value::is_boolean)
            {
                return Err("CAD_CALL_INVALID");
            }
            Ok(())
        }
        _ => Err("CAD_CALL_UNKNOWN_OP"),
    }
}

/// `true` when [`check_call`] accepts the request (for the host's allowlist).
pub fn safe_call(params: &Value) -> bool {
    check_call(params).is_ok()
}

#[cfg(target_arch = "wasm32")]
fn render_window(p: &Value) -> Option<cadcraft_engine::geom::Bounds2> {
    let a = p.get("window")?.as_array().filter(|a| a.len() == 2)?;
    let pt = |v: &Value| -> Option<cadcraft_engine::geom::Vec2> {
        let c = v.as_array().filter(|c| c.len() == 2)?;
        let (x, y) = (c.first()?.as_f64()?, c.get(1)?.as_f64()?);
        (x.is_finite() && y.is_finite()).then(|| cadcraft_engine::geom::Vec2::new(x, y))
    };
    let b = cadcraft_engine::geom::Bounds2::new(pt(a.first()?)?, pt(a.get(1)?)?);
    (b.width() > 0.0 && b.height() > 0.0).then_some(b)
}

/// Runs a checked `lizhi.call` inside the CAD app's event loop.
#[cfg(target_arch = "wasm32")]
pub fn run(app: &mut cadcraft_ui_egui::CadApp, params: &Value) -> Result<Value, String> {
    use cadcraft_ui_egui::control;
    check_call(params).map_err(str::to_string)?;
    let s = |k: &str| params.get(k).and_then(Value::as_str).unwrap_or("");
    let revision = |app: &cadcraft_ui_egui::CadApp| app.session.state().map(|st| st.revision).unwrap_or(0);
    let before = revision(app);
    let out = match s("op") {
        "execute" => {
            let p = params.get("params").cloned().filter(|v| !v.is_null()).unwrap_or_else(|| json!({}));
            json!({"result": app.run(s("command"), p)?})
        }
        "cmdline" => {
            let log_before = app.session.log.len();
            let error = app.cmdline(s("text"));
            let output: Vec<String> = app.session.log.iter().skip(log_before).cloned().collect();
            json!({"output": output, "error": error, "state": control::cmdline_state(app)})
        }
        "script" => {
            let log_before = app.session.log.len();
            let r = app.session.script(s("text")).map_err(|e| e.to_string());
            let output: Vec<String> = app.session.log.iter().skip(log_before).cloned().collect();
            match r {
                Ok(()) => json!({"output": output, "state": control::cmdline_state(app)}),
                Err(e) => return Err(e),
            }
        }
        "commands" => {
            let filter = s("filter").to_ascii_lowercase();
            let all = control::all_commands(app);
            let list: Vec<Value> = all
                .as_array()
                .map(|a| a.iter().filter(|c| filter.is_empty() || c.to_string().to_ascii_lowercase().contains(&filter)).cloned().collect())
                .unwrap_or_default();
            json!({"count": list.len(), "commands": list})
        }
        "inspect" => {
            let mut p = json!({"entities": params.get("entities").and_then(Value::as_bool).unwrap_or(false)});
            if let (Some(limit), Some(map)) = (params.get("limit").cloned(), p.as_object_mut()) {
                map.insert("limit".into(), limit);
            }
            app.run("drawing.inspect", p)?
        }
        "render" => {
            let side = |k: &str, d: u32| params.get(k).and_then(Value::as_u64).and_then(|n| u32::try_from(n).ok()).unwrap_or(d);
            let st = app.session.state().map_err(|e| e.to_string())?;
            let window = render_window(params);
            let opts = cadcraft_render::Options { view: window, transparency: app.session.settings.transparency_display, ..Default::default() };
            let list = cadcraft_render::build(&st.doc, &st.space, &opts);
            let view = match &window {
                Some(win) => cadcraft_render::raster::View::of_window(
                    win,
                    params.get("width").and_then(Value::as_u64).and_then(|n| u32::try_from(n).ok()),
                    params.get("height").and_then(Value::as_u64).and_then(|n| u32::try_from(n).ok()),
                ),
                None => cadcraft_render::raster::View::fit(&list.bounds, side("width", 1600), side("height", 1000), 0.05),
            };
            let png = cadcraft_render::raster::render_png(&list, &view, &cadcraft_render::raster::RasterOptions::default()).ok_or("render failed")?;
            json!({"png_base64": cadcraft_engine::cmd::file::base64_encode(&png), "width": view.width, "height": view.height})
        }
        _ => return Err("CAD_CALL_UNKNOWN_OP".into()),
    };
    let after = revision(app);
    let mut out = out;
    if let Some(map) = out.as_object_mut() {
        map.insert("revisionBefore".into(), json!(before));
        map.insert("revisionAfter".into(), json!(after));
        map.insert("mutated".into(), json!(after != before));
    } else {
        out = json!({"result": out, "revisionBefore": before, "revisionAfter": after, "mutated": after != before});
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn any_engine_command_is_allowed() {
        assert!(safe_call(&json!({"op": "execute", "command": "offset", "params": {"distance": 2}})));
        assert!(safe_call(&json!({"op": "execute", "command": "layer.new", "params": {"name": "Walls"}})));
        assert!(safe_call(&json!({"op": "cmdline", "text": "line 0,0 @10,0 @0,5 c"})));
        assert!(safe_call(&json!({"op": "script", "text": "circle 5,2 1\nzoom e\n"})));
        assert!(safe_call(&json!({"op": "commands", "filter": "dim"})));
        assert!(safe_call(&json!({"op": "inspect", "entities": true, "limit": 50})));
        assert!(safe_call(&json!({"op": "render", "width": 800, "window": [[0, 0], [10, 10]]})));
    }

    #[test]
    fn file_and_lifecycle_commands_are_refused() {
        for c in ["open", "OPEN", "_close", "appload", "lisp", "script", "plot", "recover"] {
            assert_eq!(check_call(&json!({"op": "execute", "command": c})), Err("CAD_COMMAND_NOT_ALLOWED_REMOTELY"), "{c}");
        }
        assert_eq!(check_call(&json!({"op": "cmdline", "text": "open"})), Err("CAD_COMMAND_NOT_ALLOWED_REMOTELY"));
        assert_eq!(check_call(&json!({"op": "script", "text": "line 0,0 1,1\nappload"})), Err("CAD_COMMAND_NOT_ALLOWED_REMOTELY"));
    }

    #[test]
    fn destructive_commands_need_confirmation() {
        assert_eq!(
            check_call(&json!({"op": "execute", "command": "erase", "params": {"handles": ["1A"]}})),
            Err("CAD_DESTRUCTIVE_COMMAND_REQUIRES_CONFIRMATION")
        );
        assert!(safe_call(&json!({"op": "execute", "command": "erase", "params": {"handles": ["1A"]}, "confirmed": true})));
        assert_eq!(check_call(&json!({"op": "cmdline", "text": "line 0,0 1,1  purge"})), Err("CAD_DESTRUCTIVE_COMMAND_REQUIRES_CONFIRMATION"));
        assert_eq!(check_call(&json!({"op": "cmdline", "text": "new"})), Err("CAD_DESTRUCTIVE_COMMAND_REQUIRES_CONFIRMATION"));
        // A keyword answering a prompt is not a command start.
        assert!(safe_call(&json!({"op": "cmdline", "text": "line 0,0 @10,0 close"})));
        assert!(safe_call(&json!({"op": "cmdline", "text": "zoom e"})));
    }

    #[test]
    fn paths_and_malformed_requests_are_refused() {
        assert_eq!(
            check_call(&json!({"op": "execute", "command": "saveas", "params": {"path": "/etc/x.dxf"}})),
            Err("CAD_BROWSER_HAS_NO_FILESYSTEM_PATH")
        );
        assert_eq!(
            check_call(&json!({"op": "execute", "command": "new", "params": {"template": "a.dwt"}, "confirmed": true})),
            Err("CAD_BROWSER_HAS_NO_FILESYSTEM_PATH")
        );
        assert_eq!(check_call(&json!({"op": "render", "width": 99999})), Err("CAD_CALL_INVALID"));
        assert_eq!(check_call(&json!({"op": "execute", "command": "line", "confirmed": false})), Err("CAD_CALL_INVALID"));
        assert_eq!(check_call(&json!({"op": "nope"})), Err("CAD_CALL_UNKNOWN_OP"));
        assert_eq!(check_call(&json!({"op": "cmdline", "text": "x".repeat(MAX_TEXT_CHARS + 1)})), Err("CAD_TEXT_TOO_LONG"));
        assert_eq!(check_call(&json!("execute")), Err("CAD_CALL_INVALID"));
        let mut deep = json!(1);
        for _ in 0..20 {
            deep = json!({"a": deep});
        }
        assert_eq!(check_call(&json!({"op": "execute", "command": "line", "params": deep})), Err("CAD_BROWSER_HAS_NO_FILESYSTEM_PATH"));
    }
}
