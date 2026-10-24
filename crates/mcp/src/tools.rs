//! MCP tool definitions and dispatch.

use serde_json::{Value, json};

use crate::backend::Backend;

/// Optional process-wide MCP read-only guard for the Lizhi CAD fork.
/// This is NOT user authentication: launchers must still authenticate and isolate
/// each user, drawing and process before exposing the stdio channel remotely.
fn lizhi_read_only() -> bool {
    std::env::var("LIZHI_CAD_MCP_READ_ONLY").is_ok_and(|v| v == "1")
}

/// Restrict a future remote CAD session to native geometric operations only.
/// This flag is *not* authentication and must never be used as a replacement for
/// authenticated, per-user isolated sessions and filesystem sandboxes.
fn lizhi_geometry_only() -> bool {
    std::env::var("LIZHI_CAD_MCP_GEOMETRY_ONLY").is_ok_and(|v| v == "1")
}

const LIZHI_MAX_RENDER_SIDE: u64 = 4096;

fn lizhi_render_allowed(args: &Value) -> bool {
    if args.get("path").is_some_and(|v| !v.is_null()) {
        return false;
    }
    ["width", "height"].into_iter().all(|key| {
        args.get(key).is_none_or(|value| value.is_null()
            || value.as_u64().is_some_and(|n| (16..=LIZHI_MAX_RENDER_SIDE).contains(&n)))
    })
}

fn lizhi_geometry_command_allowed(command: &str) -> bool {
    matches!(
        command,
        "line" | "circle" | "rectang" | "pline" | "arc"
            | "layer.new" | "move" | "copy" | "rotate" | "scale"
            | "erase" | "undo" | "redo" | "zoom"
    )
}

/// In geometry-only mode, only native CAD commands with no file/network
/// capabilities are allowed. The separate storage bridge owns open/save.
pub(crate) fn lizhi_geometry_tool_allowed(name: &str, args: &Value) -> bool {
    match name {
        "list_commands" | "inspect_drawing" | "query_entities" | "find_text" | "new_drawing" => true,
        "render" => lizhi_render_allowed(args),
        "execute" => args.get("command").and_then(Value::as_str).is_some_and(lizhi_geometry_command_allowed),
        _ => false,
    }
}

/// Reject all drawing/file mutations in read-only mode. In particular, `render`
/// accepts a filesystem `path`, so it is read-only only when that path is absent.
pub(crate) fn lizhi_read_tool_allowed(name: &str, args: &Value) -> bool {
    match name {
        "list_commands" | "inspect_drawing" | "query_entities" | "find_text" => true,
        "render" => lizhi_render_allowed(args),
        _ => false,
    }
}

pub fn tool_definitions(has_ui: bool) -> Value {
    tool_definitions_for_policy(has_ui, lizhi_read_only(), lizhi_geometry_only())
}

pub(crate) fn tool_definitions_for_scope(has_ui: bool, read_only: bool) -> Value {
    tool_definitions_for_policy(has_ui, read_only, false)
}

pub(crate) fn tool_definitions_for_policy(has_ui: bool, read_only: bool, geometry_only: bool) -> Value {
    let mut tools = vec![
        json!({"name": "command_line", "description": "Type one line at the CADCraft command line, exactly as a user would at an AutoCAD-style prompt. Starts commands by name or alias (LINE, L, CIRCLE, C, PLINE, RECTANG, MOVE, TRIM, OFFSET, ZOOM…) and answers the active prompt: points `x,y`, relative `@dx,dy`, polar `@dist<angle`, distances, keywords (e.g. `c` for Close), empty text = Enter. Spaces act as Enter, so `circle 0,0 5` works in one call. Returns the new prompt and command-line output, and `error` when the line was refused.",
            "inputSchema": {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]}}),
        json!({"name": "script", "description": "Run a multi-line script (like an AutoCAD .scr file): one or more inputs per line, blank line = Enter.",
            "inputSchema": {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]}}),
        json!({"name": "execute", "description": "Run any command with JSON parameters (no prompts or dialogs). Use list_commands to find ids and parameter docs. Examples: line {points:[[0,0],[10,0]]}, circle {center:[0,0], radius:5}, layer.new {name:\"Walls\", color:\"red\", current:true}, move {handles:[\"10A\"], delta:[5,0]}, zoom {mode:\"extents\"}.",
            "inputSchema": {"type": "object", "properties": {"command": {"type": "string"}, "params": {"type": "object"}}, "required": ["command"]}}),
        json!({"name": "list_commands", "description": "List commands with ids, labels, menu paths, aliases and parameter docs. Optional filter: a substring of the command id, label or an alias.",
            "inputSchema": {"type": "object", "properties": {"filter": {"type": "string"}}}}),
        json!({"name": "inspect_drawing", "description": "Summary of the active drawing: entity counts, extents, layers, styles, blocks, layouts, selection, undo history and (optionally) entities with handles and geometry.",
            "inputSchema": {"type": "object", "properties": {"entities": {"type": "boolean"}, "limit": {"type": "integer"}}}}),
        json!({"name": "query_entities", "description": "Entities filtered by type (Line, Circle, Polyline…), layer, current selection (selected:true; active space only) and/or a window [[x0,y0],[x1,y1]] (objects whose geometry is inside or crosses it; crossing:false = entirely inside). Returns count (all matches), returned (this page) and entities; page with offset and limit (default 500).",
            "inputSchema": {"type": "object", "properties": {"type": {"type": "string"}, "layer": {"type": "string"}, "selected": {"type": "boolean"},
                "window": {"type": "array", "items": {"type": "array", "items": {"type": "number"}, "minItems": 2, "maxItems": 2}, "minItems": 2, "maxItems": 2},
                "crossing": {"type": "boolean"}, "limit": {"type": "integer", "minimum": 0}, "offset": {"type": "integer", "minimum": 0}}}}),
        json!({"name": "render", "description": "Render the active drawing to a PNG and return it as an image: fitted to the extents by default, or just the area `window` [[x0,y0],[x1,y1]] (drawing units), e.g. one sheet or one room of a large drawing. With a window and no size the image is 1600 px wide with the window's shape.",
            "inputSchema": {"type": "object", "properties": {"width": {"type": "integer", "minimum": 16}, "height": {"type": "integer", "minimum": 16}, "fit": {"type": "boolean"},
                "window": {"type": "array", "items": {"type": "array", "items": {"type": "number"}, "minItems": 2, "maxItems": 2}, "minItems": 2, "maxItems": 2},
                "path": {"type": "string"}}}}),
        json!({"name": "find_text", "description": "Read the drawing's texts: TEXT, MTEXT (formatting removed), block attributes and multileaders, each with its text, insertion point `at`, height, rotation, style, layer and handle. Filter by `contains` (any case), `layer` and/or `window` [[x0,y0],[x1,y1]] around the insertion points; page with offset and limit (default 200). Use it to find room names, sheet titles and notes without reading all the geometry.",
            "inputSchema": {"type": "object", "properties": {"contains": {"type": "string"}, "layer": {"type": "string"},
                "window": {"type": "array", "items": {"type": "array", "items": {"type": "number"}, "minItems": 2, "maxItems": 2}, "minItems": 2, "maxItems": 2},
                "limit": {"type": "integer", "minimum": 0}, "offset": {"type": "integer", "minimum": 0}}}}),
        json!({"name": "new_drawing", "description": "Create a new drawing (imperial by default, or metric).",
            "inputSchema": {"type": "object", "properties": {"metric": {"type": "boolean"}}}}),
        json!({"name": "open", "description": "Open a DXF file.", "inputSchema": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}}),
        json!({"name": "save", "description": "Save the drawing (DXF or DWG by extension). A .svg, .png or .pdf path exports instead: the drawing keeps its name and unsaved changes.", "inputSchema": {"type": "object", "properties": {"path": {"type": "string"}}}}),
        json!({"name": "cancel", "description": "Press Escape: cancel the running command (or clear the selection).", "inputSchema": {"type": "object", "properties": {}}}),
    ];
    if has_ui {
        tools.push(json!({"name": "screenshot", "description": "Screenshot the CADCraft window (PNG).", "inputSchema": {"type": "object", "properties": {"path": {"type": "string"}}}}));
        tools.push(json!({"name": "ui_inspect", "description": "UI state: panels, canvas rect, view, cursor and snap, performance.", "inputSchema": {"type": "object", "properties": {}}}));
        tools.push(json!({"name": "ui_click", "description": "Click in the drawing area at world coordinates (or screen with space:\"screen\"). Right button = Enter.", "inputSchema": {"type": "object", "properties": {"x": {"type": "number"}, "y": {"type": "number"}, "space": {"type": "string"}, "button": {"type": "string"}}, "required": ["x", "y"]}}));
    }
    if read_only || geometry_only {
        // Read-only wins when both flags are set (fail-closed).
        tools.retain(|tool| tool["name"].as_str().is_some_and(|name| {
            if read_only {
                lizhi_read_tool_allowed(name, &Value::Null)
            } else {
                // "execute" requires a command argument and is advertised
                // separately from checking its actual dispatch parameters.
                name == "execute" || lizhi_geometry_tool_allowed(name, &Value::Null)
            }
        }));
        // File-output "render(path)" is hidden and also rejected at dispatch.
        if let Some(render) = tools.iter_mut().find(|tool| tool["name"] == "render") {
            if let Some(properties) = render["inputSchema"]["properties"].as_object_mut() {
                properties.remove("path");
            }
        }
    }
    json!({ "tools": tools })
}

fn text(v: &Value) -> Value {
    json!({"content": [{"type": "text", "text": serde_json::to_string_pretty(v).unwrap_or_default()}]})
}

fn err_text(e: &str) -> Value {
    json!({"content": [{"type": "text", "text": e}], "isError": true})
}

/// Whether `v` fits the subset of JSON Schema the tool definitions use: `type`, `items`,
/// `minItems`, `maxItems` and `minimum`.
fn fits(v: &Value, schema: &Value) -> bool {
    let typed = match schema["type"].as_str() {
        Some("string") => v.is_string(),
        // JSON Schema integers include numbers such as 2.0.
        Some("integer") => v.as_f64().is_some_and(|f| f.fract() == 0.0),
        Some("number") => v.is_number(),
        Some("boolean") => v.is_boolean(),
        Some("array") => v.is_array(),
        Some("object") => v.is_object(),
        _ => true,
    };
    let len = v.as_array().map(Vec::len);
    typed
        && schema["minimum"].as_f64().is_none_or(|m| v.as_f64().is_none_or(|f| f >= m))
        && schema["minItems"].as_u64().is_none_or(|m| len.is_none_or(|n| n as u64 >= m))
        && schema["maxItems"].as_u64().is_none_or(|m| len.is_none_or(|n| n as u64 <= m))
        && (schema["items"].is_null() || v.as_array().is_none_or(|a| a.iter().all(|i| fits(i, &schema["items"]))))
}

/// Arguments checked against the tool's input schema: an object, required properties present and
/// each given property fitting its schema (`null` counts as not given). `Err` is the
/// invalid-params message.
fn check_args(name: &str, args: &Value) -> Result<Value, String> {
    let defs = tool_definitions(true);
    let schema = defs["tools"].as_array().and_then(|t| t.iter().find(|t| t["name"] == name)).map(|t| t["inputSchema"].clone());
    let Some(schema) = schema else { return Err(format!("unknown tool `{name}`")) };
    let a = match args {
        Value::Null => json!({}),
        Value::Object(_) => args.clone(),
        _ => return Err(format!("`arguments` of `{name}` must be an object")),
    };
    for key in schema["required"].as_array().into_iter().flatten().filter_map(Value::as_str) {
        if a.get(key).is_none_or(Value::is_null) {
            return Err(format!("`{name}` needs `{key}`"));
        }
    }
    for (key, prop) in schema["properties"].as_object().into_iter().flatten() {
        if let Some(v) = a.get(key).filter(|v| !v.is_null())
            && !fits(v, prop)
        {
            return Err(format!("`{key}` of `{name}` must match {prop}"));
        }
    }
    Ok(a)
}

/// Whether a command-catalog entry's id, label or one of its aliases contains `f` (lower case).
fn command_matches(c: &Value, f: &str) -> bool {
    let has = |s: &str| s.to_ascii_lowercase().contains(f);
    ["id", "label"].iter().any(|k| c[*k].as_str().is_some_and(has))
        || c["aliases"].as_array().is_some_and(|a| a.iter().filter_map(Value::as_str).any(has))
}

/// Internal-only snapshot io. This is deliberately absent from tools/list.
/// It is ONLY available inside a geometry-only process with an unpredictable
/// per-process capability injected by the trusted LOCAL session host.
/// No path is read from a tool call: only the process's fixed sandbox path.
/// This is a prototype boundary, not an OAuth or network authentication layer.
fn lizhi_internal_snapshot(b: &mut dyn Backend, name: &str, args: &Value) -> Result<Value, String> {
    if lizhi_read_only() || !lizhi_geometry_only() {
        return Err("internal CAD snapshot is not enabled".into());
    }
    let expected = std::env::var("LIZHI_CAD_MCP_INTERNAL_CAPABILITY").unwrap_or_default();
    let given = args.get("capability").and_then(Value::as_str).unwrap_or_default();
    // Constant-time equality avoids leaking a token byte prefix via an auth oracle.
    let allowed = expected.len() == 64
        && given.len() == expected.len()
        && expected.bytes().zip(given.bytes()).fold(0_u8, |diff, (a, b)| diff | (a ^ b)) == 0;
    if !allowed {
        return Err("internal CAD snapshot capability denied".into());
    }
    let snapshot = std::env::var("LIZHI_CAD_MCP_INTERNAL_SNAPSHOT").map_err(|_| "no sandbox snapshot path")?;
    // The path is set by the trusted host, never by model-supplied arguments.
    if !snapshot.ends_with("/native-snapshot.dxf") {
        return Err("invalid sandbox snapshot path".into());
    }
    let method = match name {
        "lizhi_internal_snapshot_save" => "app.save",
        "lizhi_internal_snapshot_open" => "app.open",
        _ => return Err("unknown internal snapshot operation".into()),
    };
    let result = b.call(method, json!({ "path": snapshot }));
    Ok(match result {
        Ok(v) => text(&v),
        Err(e) => err_text(&e),
    })
}

/// Run a tool. `Err` is a protocol error (unknown tool, or arguments that don't fit its input
/// schema), answered with JSON-RPC invalid params; a failing tool is an `isError` result.
pub fn call_tool(b: &mut dyn Backend, name: &str, args: &Value) -> Result<Value, String> {
    if matches!(name, "lizhi_internal_snapshot_save" | "lizhi_internal_snapshot_open") {
        return lizhi_internal_snapshot(b, name, args);
    }
    let a = check_args(name, args)?;
    // Enforce at dispatch time too: hiding tools from tools/list is not enough.
    if lizhi_read_only() && !lizhi_read_tool_allowed(name, &a) {
        return Err(format!("read-only MCP denies `{name}` or its filesystem output"));
    }
    if !lizhi_read_only() && lizhi_geometry_only() && !lizhi_geometry_tool_allowed(name, &a) {
        return Err(format!("geometry-only MCP denies `{name}` or its parameters"));
    }
    let r = match name {
        "command_line" => b.call("cmdline.input", a),
        "script" => b.call("cmdline.script", a),
        "execute" => b.call(
            "engine.execute",
            json!({"command": a.get("command").cloned().unwrap_or(Value::Null), "params": a.get("params").cloned().unwrap_or(json!({}))}),
        ),
        "list_commands" => b.call("engine.commands", json!({})).map(|v| {
            let f = a.get("filter").and_then(Value::as_str).map(str::to_ascii_lowercase);
            match (v, f) {
                (Value::Array(items), Some(f)) => Value::Array(items.into_iter().filter(|c| command_matches(c, &f)).collect()),
                (v, _) => v,
            }
        }),
        "inspect_drawing" => b.call("drawing.inspect", a),
        "query_entities" => b.call("engine.execute", json!({"command": "entities", "params": a})),
        "find_text" => b.call("engine.execute", json!({"command": "texts", "params": a})),
        "new_drawing" => b.call("engine.execute", json!({"command": "new", "params": a})),
        "open" => b.call("app.open", a),
        "save" => b.call("app.save", a),
        "cancel" => b.call("cmdline.key", json!({"key": "escape"})),
        "screenshot" => b.call("ui.screenshot", a),
        "ui_inspect" => b.call("ui.inspect", json!({})),
        "ui_click" => b.call("ui.pointer", a),
        "render" => {
            return Ok(match b.call("ui.render", a) {
                Ok(v) => match v.get("pngBase64").and_then(Value::as_str) {
                    Some(data) => json!({"content": [{"type": "image", "data": data, "mimeType": "image/png"}]}),
                    None => text(&v),
                },
                Err(e) => err_text(&e),
            });
        }
        other => return Err(format!("unknown tool `{other}`")),
    };
    Ok(match r {
        Ok(v) => text(&v),
        Err(e) => err_text(&e),
    })
}
