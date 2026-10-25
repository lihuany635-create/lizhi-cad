//! The `postMessage` bridge to a same-origin parent page (`?host=parent`), for pages that embed
//! CADCraft in an `<iframe>` (such as a Nextcloud app). Messages are plain objects with a `type`:
//!
//! - `cadcraft:ready` (to the parent): `{ version }`, the app is listening; send a drawing now.
//! - `cadcraft:open` (from the parent): `{ name, bytes }`, bytes an `ArrayBuffer` or
//!   `Uint8Array`. It opens like a file picked with File › Open or dropped on the window.
//! - `cadcraft:save` (to the parent): `{ requestId, name, bytes }` (a transferred `ArrayBuffer`) for every
//!   file CADCraft would otherwise download (SAVE, SAVEAS, exports): it replaces the engine's
//!   delivery hook. The parent stores the file and reports failures itself.
//! - `cadcraft:save-ack` (from the parent): `{ requestId, ok }` after verified persistence.\n//!   Pending/failed delivery keeps parent-visible dirty true until a good ACK.\n//! - `cadcraft:command` (from same-origin parent): `{ requestId, command, params }`.
//!   Only a small static geometry allowlist is executed (no scripts, paths, file I/O or shell).
//! - `cadcraft:command-result` (to parent): `{ requestId, ok, result? , error? }`.
//! - `cadcraft:dirty` (to the parent): `{ dirty }` whenever unsaved changes appear or go away.
//! - `cadcraft:failed` (to the parent): `{ error }` when the app couldn't start.
//!
//! Only the parent window on the page's own origin is heard or answered. In host mode the app
//! starts on the Start tab rather than an empty Drawing1, and the parent guards leaving the page.

use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet, VecDeque};
use std::rc::Rc;

use cadcraft_ui_egui::CadApp;
use wasm_bindgen::JsCast as _;
use wasm_bindgen::JsValue;
use wasm_bindgen::closure::Closure;
use web_sys::js_sys;

/// Longest file name taken from the parent page.
const MAX_NAME_CHARS: usize = 255;
const MAX_REMOTE_PARAMS_CHARS: usize = 8192;
const MAX_PENDING_COMMANDS: usize = 16;
const MAX_RECENT_COMMANDS: usize = 512;

thread_local! {
    /// The bridge [`deliver`] posts through (the engine's hook is a plain `fn`).
    static BRIDGE: RefCell<Option<Bridge>> = const { RefCell::new(None) };
}


/// A bounded, same-origin, user-authorized CAD command request, never arbitrary code.
struct RemoteCommand {
    request_id: String,
    command: String,
    params: serde_json::Value,
}

fn safe_command(command: &str, params: &serde_json::Value) -> bool {
    if !params.is_object() { return false; }
    match command {
        "new" => params.as_object().is_some_and(|o| o.is_empty() || (o.len()==1 && o.get("metric").is_some_and(serde_json::Value::is_boolean))),
        "line" => params.get("points").is_some_and(|p| p.as_array().is_some_and(|a| (2..=64).contains(&a.len())))
             && params.as_object().is_some_and(|o| o.keys().all(|k| k=="points" || k=="closed")),
        "rectang" => params.get("p1").is_some() && params.get("p2").is_some()
             && params.as_object().is_some_and(|o| o.len()==2),
        "circle" => params.get("center").is_some() && (params.get("radius").is_some() ^ params.get("diameter").is_some())
             && params.as_object().is_some_and(|o| o.keys().all(|k| k=="center" || k=="radius" || k=="diameter")),
        // New read-only bridge commands. Never accept a filename, path, script,
        // arbitrary engine command, or a raw request for the full drawing.
        "lizhi.inspect" => safe_inspect(params),
        "lizhi.entities" => safe_entities(params),
        _ => false,
    }
}

/// Keep the browser-local geometry query bounded before it reaches the engine.
/// The native engine defaults to 500 entities without a limit, so requiring
/// a bounded page here is a security boundary, not just a performance hint.
fn safe_inspect(params: &serde_json::Value) -> bool {
    params.as_object().is_some_and(serde_json::Map::is_empty)
}
fn safe_entities(params: &serde_json::Value) -> bool {
    let Some(o) = params.as_object() else { return false };
    if !o.keys().all(|k| matches!(k.as_str(), "type" | "layer" | "limit" | "offset" | "selected")) {
        return false;
    }
    if !o.get("type").is_none_or(|v| v.as_str().is_some_and(|x| x.len()<=32 && !x.contains('\\0'))) {
        return false;
    }
    if !o.get("layer").is_none_or(|v| v.as_str().is_some_and(|x| x.len()<=80 && !x.contains('\\0'))) {
        return false;
    }
    if !o.get("selected").is_none_or(serde_json::Value::is_boolean) { return false; }
    if !o.get("limit").is_none_or(|v| v.as_u64().is_some_and(|n| (1..=8).contains(&n))) { return false; }
    o.get("offset").is_none_or(|v| v.as_u64().is_some_and(|n| n<=10_000))
}

fn is_point(value: &serde_json::Value) -> bool {
    value.as_array().is_some_and(|a| a.len()==2 && a.iter().all(|x| x.as_f64().is_some_and(|n| n.is_finite() && n.abs()<=1_000_000.0)))
}
fn checked_geometry(command: &str, params: &serde_json::Value) -> bool {
    if !safe_command(command,params) {return false;}
    match command {
        "new" => true,
        "rectang" => params.get("p1").is_some_and(is_point) && params.get("p2").is_some_and(is_point),
        "line" => params.get("points").and_then(serde_json::Value::as_array).is_some_and(|a| a.iter().all(is_point))
             && params.get("closed").is_none_or(serde_json::Value::is_boolean),
        "circle" => params.get("center").is_some_and(is_point)
              && params.get("radius").or_else(||params.get("diameter")).and_then(serde_json::Value::as_f64)
                 .is_some_and(|n| n.is_finite() && n>0.0 && n<=1_000_000.0),
        "lizhi.inspect" | "lizhi.entities" => true,
        _ => false,
    }
}

#[derive(Clone)]
pub struct Bridge {
    window: web_sys::Window,
    parent: web_sys::Window,
    origin: String,
    pending: Rc<RefCell<HashMap<String, String>>>,
    failed: Rc<RefCell<HashSet<String>>>,
    verified: Rc<RefCell<Vec<String>>>,
    next_id: Rc<Cell<u64>>,
    command_queue: Rc<RefCell<VecDeque<RemoteCommand>>>,
    seen_commands: Rc<RefCell<VecDeque<String>>>,
}

/// The unsaved-changes state last reported to the parent.
#[derive(Default)]
pub struct DirtyReport(Cell<Option<bool>>);

impl Bridge {
    /// `None` when the page isn't framed (there is no parent to talk to).
    pub fn new() -> Option<Self> {
        let window = web_sys::window()?;
        let parent = window.parent().ok().flatten()?;
        if js_sys::Object::is(&parent, &window) {
            return None;
        }
        let origin = window.location().origin().ok()?;
        Some(Self {
            window, parent, origin,
            pending: Rc::default(),
            failed: Rc::default(),
            verified: Rc::default(),
            next_id: Rc::new(Cell::new(0)),
            command_queue: Rc::default(),
            seen_commands: Rc::default(),
        })
    }

    /// Make this the bridge [`deliver`] uses.
    pub fn install(&self) {
        BRIDGE.with(|b| *b.borrow_mut() = Some(self.clone()));
    }

    pub fn post_ready(&self) {
        self.send(&[("type", "cadcraft:ready".into()), ("version", env!("CARGO_PKG_VERSION").into())]);
    }

    pub fn post_failed(&self, error: &str) {
        self.send(&[("type", "cadcraft:failed".into()), ("error", error.into())]);
    }

    /// Hear drawings from the parent; they arrive through the upload inbox.
    pub fn listen(&self, inbox: crate::upload::Inbox, ctx: egui::Context) {
        let parent = self.parent.clone();
        let origin = self.origin.clone();
        let pending = self.pending.clone();
        let failed = self.failed.clone();
        let verified = self.verified.clone();
        let commands = self.command_queue.clone();
        let seen_commands = self.seen_commands.clone();
        let on_message = Closure::<dyn FnMut(web_sys::MessageEvent)>::new(move |event: web_sys::MessageEvent| {
            if event.origin() != origin || !event.source().is_some_and(|s| js_sys::Object::is(&s, &parent)) {
                return;
            }
            let data = event.data();
            if string(&data, "type").as_deref() == Some("cadcraft:command") {
                let Some(request_id) = string(&data, "requestId") else {return};
                let Some(command) = string(&data, "command") else {return};
                if request_id.len()>96 || request_id.is_empty()
                    || !request_id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
                    || commands.borrow().len()>=MAX_PENDING_COMMANDS
                {
                    return;
                }
                if seen_commands.borrow().iter().any(|v| v == &request_id) {return;}
                let Ok(value) = js_sys::Reflect::get(&data, &JsValue::from_str("params")) else {return};
                let Ok(json) = js_sys::JSON::stringify(&value) else {return};
                let Some(json) = json.as_string() else {return};
                if json.len()>MAX_REMOTE_PARAMS_CHARS {return;}
                let Ok(params) = serde_json::from_str::<serde_json::Value>(&json) else {return};
                if !checked_geometry(&command,&params) {return;}
                {
                    let mut seen = seen_commands.borrow_mut();
                    seen.push_back(request_id.clone());
                    if seen.len()>MAX_RECENT_COMMANDS {seen.pop_front();}
                }
                commands.borrow_mut().push_back(RemoteCommand {request_id, command, params});
                ctx.request_repaint();
                return;
            }
            if string(&data, "type").as_deref() == Some("cadcraft:save-ack") {
                let Some(request_id) = string(&data, "requestId") else { return };
                if let Some(name) = pending.borrow_mut().remove(&request_id) {
                    let ok = js_sys::Reflect::get(&data, &JsValue::from_str("ok")).ok().and_then(|v| v.as_bool()) == Some(true);
                    if ok {
                        failed.borrow_mut().remove(&name);
                        verified.borrow_mut().push(name);
                    } else if name.to_ascii_lowercase().ends_with(".dxf") || name.to_ascii_lowercase().ends_with(".dwg") {
                        failed.borrow_mut().insert(name);
                    }
                    ctx.request_repaint();
                }
                return;
            }
            if string(&data, "type").as_deref() != Some("cadcraft:open") {
                return;
            }
            let name = string(&data, "name")
                .filter(|n| !n.trim().is_empty())
                .map(|n| n.chars().take(MAX_NAME_CHARS).collect())
                .unwrap_or_else(|| "Drawing.dxf".to_string());
            // Refuse an oversized drawing before copying it into the app's memory.
            let Some(array) = byte_array(&data) else { return };
            if let Some(e) = CadApp::open_size_error(&name, u64::from(array.length())) {
                inbox.refuse(e);
                return;
            }
            inbox.receive(name, array.to_vec());
        });
        if self.window.add_event_listener_with_callback("message", on_message.as_ref().unchecked_ref()).is_ok() {
            // The listener lives as long as the page.
            on_message.forget();
        }
    }

    /// Process validated queued geometry commands only inside the real CAD app's UI event loop.
    /// Cannot touch arbitrary files, run AutoLISP, scripts, shell, clipboard or JS.
    pub fn run_remote_commands(&self, app: &mut CadApp) {
        let pending: Vec<RemoteCommand> = self.command_queue.borrow_mut().drain(..).collect();
        for req in pending {
            let answer = if req.command=="lizhi.inspect" || req.command=="lizhi.entities" {
                bounded_read(app,&req.command,&req.params)
            } else {
                app.run(&req.command,req.params)
            };
            let mut parts: Vec<(&str, JsValue)> = vec![
                ("type", "cadcraft:command-result".into()),
                ("requestId", req.request_id.into()),
                ("ok", answer.is_ok().into()),
            ];
            match answer {
                Ok(value) => {
                    let json = serde_json::to_string(&value).unwrap_or_else(|_| "{}".to_string());
                    if let Ok(parsed) = js_sys::JSON::parse(&json) {
                        parts.push(("result",parsed));
                    }
                }
                Err(error) => {
                    parts.push(("error",error.chars().take(300).collect::<String>().into()));
                }
            }
            self.send(&parts);
        }
    }

/// The native CAD engine has a read-only `entities` query and `drawing.inspect`.
/// Expose only minimal geometric data, not the engine's raw document structure.
fn bounded_read(app: &mut CadApp, name: &str, input: &serde_json::Value) -> Result<serde_json::Value,String> {
    let revision = app.session.state().map_err(|e| e.to_string())?.revision;
    if name=="lizhi.inspect" {
        let value=app.run("drawing.inspect",serde_json::json!({"entities":false}))?;
        return Ok(serde_json::json!({
            "revision": revision,
            "entityCount":value.get("entityCount"),
            "counts":value.get("counts"),
            "extents":value.get("extents"),
            "space":value.get("space"),
            "dirty":value.get("dirty"),
            "currentLayer":value.get("currentLayer"),
            "selectionCount":value.get("selection").and_then(serde_json::Value::as_array).map(Vec::len).unwrap_or(0),
        }));
    }
    if name!="lizhi.entities" { return Err("unsupported read command".into()); }
    let mut params = input.clone();
    if let Some(o)=params.as_object_mut() { o.entry("limit").or_insert(8.into()); }
    let value=app.run("entities",params)?;
    let mut result=Vec::new();
    let mut bytes=0usize;
    if let Some(entries)=value.get("entities").and_then(serde_json::Value::as_array) {
        for entity in entries.iter().take(8) {
            let ty=entity.get("type").and_then(serde_json::Value::as_str).unwrap_or("");
            let lower=ty.to_ascii_lowercase();
            // Do not return text, blocks, paths, embedded attributes, scripts or
            // raw complete DXF entities. Other entity types still get handles.
            let simple=matches!(lower.as_str(), "line"|"circle"|"arc"|"lwpolyline"|"polyline");
            let geometry=entity.get("geometry").filter(|v| simple && v.to_string().len()<=640).cloned();
            let row=serde_json::json!({
                "handle":entity.get("handle"),
                "type":ty.chars().take(32).collect::<String>(),
                "layer":entity.get("layer").and_then(serde_json::Value::as_str).unwrap_or("").chars().take(80).collect::<String>(),
                "geometry":geometry.clone(),
                "geometryAvailable":geometry.is_some(),
            });
            let len=row.to_string().len();
            if bytes+len>2800 { break; }
            bytes+=len;
            result.push(row);
        }
    }
    Ok(serde_json::json!({
        "revision":revision,
        "count":value.get("count"),
        "returned":result.len(),
        "offset":value.get("offset"),
        "entities":result,
        "hasMore":value.get("count").and_then(serde_json::Value::as_u64).unwrap_or(0)>
            value.get("offset").and_then(serde_json::Value::as_u64).unwrap_or(0)+result.len() as u64,
    }))
}

    /// Consume exactly-once verified disk acknowledgements and finalize only their matching
    /// drawing. A failure leaves the engine's DocState.save_pending dirty; another drawing's
    /// success cannot silently clear it.
    pub fn apply_verified_saves(&self, app: &mut CadApp) {
        let names = std::mem::take(&mut *self.verified.borrow_mut());
        for name in names {
            if self.failed.borrow().contains(&name)
                || self.pending.borrow().values().any(|pending_name| pending_name == &name)
            {
                continue;
            }
            // A filename alone is not a unique drawing identifier. Never let the ACK
            // for one tab silently finalize two tabs with the same basename.
            let candidates: Vec<usize> = app.session.docs.iter().enumerate()
                .filter(|(_, doc)| doc.save_pending && doc.path.as_deref().is_some_and(
                    |p| p == name || p.rsplit(['/', '\\']).next() == Some(name.as_str())
                ))
                .map(|(index, _)| index)
                .collect();
            if let [index] = candidates.as_slice() {
                if let Some(doc) = app.session.docs.get_mut(*index) {
                    doc.save_pending = false;
                }
            }
        }
    }

    /// After each frame: tell the parent when unsaved changes appear or go away.
    pub fn report_dirty(&self, app: &CadApp, reported: &DirtyReport) {
        let dirty = app.session.docs.iter().any(|d| d.is_dirty())
            || !self.pending.borrow().is_empty() || !self.failed.borrow().is_empty();
        if reported.0.get() != Some(dirty) && self.send(&[("type", "cadcraft:dirty".into()), ("dirty", dirty.into())]) {
            reported.0.set(Some(dirty));
        }
    }

    fn post_save(&self, name: &str, bytes: &[u8]) -> Result<(), String> {
        let next = self.next_id.get().wrapping_add(1);
        self.next_id.set(next);
        let request_id = format!("cad-save-{next}");
        let buffer = js_sys::Uint8Array::from(bytes).buffer();
        let message = message(&[
            ("type", "cadcraft:save".into()), ("name", name.into()),
            ("requestId", request_id.clone().into()), ("bytes", buffer.clone().into()),
        ]).ok_or_else(|| "couldn't build the message".to_string())?;
        self.pending.borrow_mut().insert(request_id.clone(), name.to_string());
        let sent = self.parent
            .post_message_with_transfer(&message, &self.origin, &js_sys::Array::of1(&buffer))
            .map_err(|e| e.as_string().unwrap_or_else(|| format!("{e:?}")));
        if sent.is_err() {
            self.pending.borrow_mut().remove(&request_id);
            if name.to_ascii_lowercase().ends_with(".dxf") || name.to_ascii_lowercase().ends_with(".dwg") {
                self.failed.borrow_mut().insert(name.to_string());
            }
        }
        sent
    }

    /// Post a message to the parent; false if it couldn't be sent.
    fn send(&self, fields: &[(&str, JsValue)]) -> bool {
        message(fields).is_some_and(|m| self.parent.post_message(&m, &self.origin).is_ok())
    }
}

/// The engine's delivery hook in host mode ([`cadcraft_engine::cmd::file::set_deliver`]): hand
/// the file to the parent page. `Ok` means transport only; DocState remains dirty\n/// until a verified storage acknowledgement is processed.
pub fn deliver(name: &str, _mime: &str, bytes: &[u8]) -> Result<(), String> {
    let bridge = BRIDGE.with(|b| b.borrow().clone()).ok_or("the page that embeds CADCraft is gone")?;
    bridge.post_save(name, bytes)
}

fn message(fields: &[(&str, JsValue)]) -> Option<js_sys::Object> {
    let m = js_sys::Object::new();
    for (key, value) in fields {
        js_sys::Reflect::set(&m, &JsValue::from_str(key), value).ok()?;
    }
    Some(m)
}

fn string(data: &JsValue, key: &str) -> Option<String> {
    js_sys::Reflect::get(data, &JsValue::from_str(key)).ok()?.as_string()
}

/// `bytes` (an `ArrayBuffer` or `Uint8Array`) as a view, not yet copied.
fn byte_array(data: &JsValue) -> Option<js_sys::Uint8Array> {
    let bytes = js_sys::Reflect::get(data, &JsValue::from_str("bytes")).ok()?;
    if let Some(array) = bytes.dyn_ref::<js_sys::Uint8Array>() {
        Some(array.clone())
    } else if bytes.is_instance_of::<js_sys::ArrayBuffer>() {
        Some(js_sys::Uint8Array::new(&bytes))
    } else {
        None
    }
}

#[cfg(test)]
mod lizhi_entity_bridge_tests {
    use super::{safe_command,checked_geometry};
    use serde_json::json;
    #[test]
    fn read_commands_are_bounded_and_do_not_allow_file_or_script_access() {
        assert!(safe_command("lizhi.inspect",&json!({})));
        assert!(!safe_command("lizhi.inspect",&json!({"entities":true})));
        assert!(checked_geometry("lizhi.entities",&json!({"type":"Line","limit":8,"offset":10})));
        assert!(!checked_geometry("lizhi.entities",&json!({"limit":1000})));
        assert!(!checked_geometry("lizhi.entities",&json!({"path":"/private/diagram.dxf"})));
        assert!(!checked_geometry("lizhi.entities",&json!({"window":[[-1,-1],[1,1]]})));
        assert!(!checked_geometry("lizhi.entities",&json!({"selected":"yes"})));
        assert!(!checked_geometry("execute",&json!({"command":"erase"})));
    }
}
