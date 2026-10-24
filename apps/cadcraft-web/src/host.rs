//! The `postMessage` bridge to a same-origin parent page (`?host=parent`), for pages that embed
//! CADCraft in an `<iframe>` (such as a Nextcloud app). Messages are plain objects with a `type`:
//!
//! - `cadcraft:ready` (to the parent): `{ version }`, the app is listening; send a drawing now.
//! - `cadcraft:open` (from the parent): `{ name, bytes }`, bytes an `ArrayBuffer` or
//!   `Uint8Array`. It opens like a file picked with File › Open or dropped on the window.
//! - `cadcraft:save` (to the parent): `{ requestId, name, bytes }` (a transferred `ArrayBuffer`) for every
//!   file CADCraft would otherwise download (SAVE, SAVEAS, exports): it replaces the engine's
//!   delivery hook. The parent stores the file and reports failures itself.
//! - `cadcraft:save-ack` (from the parent): `{ requestId, ok }` after verified persistence.\n//!   Pending/failed delivery keeps parent-visible dirty true until a good ACK.\n//! - `cadcraft:dirty` (to the parent): `{ dirty }` whenever unsaved changes appear or go away.
//! - `cadcraft:failed` (to the parent): `{ error }` when the app couldn't start.
//!
//! Only the parent window on the page's own origin is heard or answered. In host mode the app
//! starts on the Start tab rather than an empty Drawing1, and the parent guards leaving the page.

use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use cadcraft_ui_egui::CadApp;
use wasm_bindgen::JsCast as _;
use wasm_bindgen::JsValue;
use wasm_bindgen::closure::Closure;
use web_sys::js_sys;

/// Longest file name taken from the parent page.
const MAX_NAME_CHARS: usize = 255;

thread_local! {
    /// The bridge [`deliver`] posts through (the engine's hook is a plain `fn`).
    static BRIDGE: RefCell<Option<Bridge>> = const { RefCell::new(None) };
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
        let on_message = Closure::<dyn FnMut(web_sys::MessageEvent)>::new(move |event: web_sys::MessageEvent| {
            if event.origin() != origin || !event.source().is_some_and(|s| js_sys::Object::is(&s, &parent)) {
                return;
            }
            let data = event.data();
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
            for doc in &mut app.session.docs {
                let matches = doc.path.as_deref().is_some_and(|p| p == name || p.rsplit(['/', '\\']).next() == Some(name.as_str()));
                if matches {
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
