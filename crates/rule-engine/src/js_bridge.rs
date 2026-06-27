pub(crate) const SCRIPT_HOST_BRIDGE: &str = r#"
globalThis.__aiproxyScriptExports = globalThis.__aiproxyScriptExports || {};

function __aiproxyClone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function __aiproxyNormalizeHeaders(headers) {
  if (!Array.isArray(headers)) return [];
  return headers
    .filter((item) => item && typeof item.name === "string" && typeof item.value === "string")
    .map((item) => ({ name: item.name, value: item.value }));
}

function __aiproxyDecodeBase64(value) {
  if (typeof value !== "string" || value.length === 0) return "";
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let str = value.replace(/=+$/, "");
  let output = "";
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < str.length; i += 1) {
    const index = chars.indexOf(str[i]);
    if (index < 0) continue;
    buffer = (buffer << 6) | index;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      output += String.fromCharCode((buffer >> bits) & 0xff);
    }
  }
  try {
    return decodeURIComponent(output.split("").map((char) => "%" + char.charCodeAt(0).toString(16).padStart(2, "0")).join(""));
  } catch (_error) {
    return output;
  }
}

function __aiproxyEncodeUtf8(value) {
  const normalized = typeof value === "string" ? value : JSON.stringify(value);
  try {
    return unescape(encodeURIComponent(normalized));
  } catch (_error) {
    return normalized;
  }
}

function __aiproxyEncodeBase64(value) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const input = __aiproxyEncodeUtf8(value);
  let output = "";
  let i = 0;
  while (i < input.length) {
    const a = input.charCodeAt(i++);
    const b = input.charCodeAt(i++);
    const c = input.charCodeAt(i++);
    const triplet = (a << 16) | ((b || 0) << 8) | (c || 0);
    output += chars[(triplet >> 18) & 63];
    output += chars[(triplet >> 12) & 63];
    output += Number.isNaN(b) ? "=" : chars[(triplet >> 6) & 63];
    output += Number.isNaN(c) ? "=" : chars[triplet & 63];
  }
  return output;
}

function __aiproxySetHeader(headers, name, value) {
  const normalized = Array.isArray(headers) ? headers : [];
  const next = normalized.filter((entry) => String(entry.name || "").toLowerCase() !== String(name || "").toLowerCase());
  if (typeof value === "string") {
    next.push({ name, value });
  }
  return next;
}

function __aiproxyAttachBodyHelpers(target) {
  if (!target || typeof target !== "object") return target;

  target.getText = function getText() {
    if (typeof target.bodyText === "string") return target.bodyText;
    if (typeof target.bodyBase64 === "string") return __aiproxyDecodeBase64(target.bodyBase64);
    return "";
  };

  target.setText = function setText(text, mimeType) {
    target.bodyText = String(text ?? "");
    target.bodyBase64 = null;
    if (typeof mimeType === "string" && mimeType.length > 0) {
      target.mimeType = mimeType;
      target.headers = __aiproxySetHeader(target.headers, "content-type", mimeType);
    }
  };

  target.getJson = function getJson() {
    const text = target.getText();
    return text ? JSON.parse(text) : null;
  };

  target.setJson = function setJson(value, mimeType) {
    const contentType = typeof mimeType === "string" && mimeType.length > 0
      ? mimeType
      : "application/json";
    target.setText(JSON.stringify(value, null, 2), contentType);
  };

  target.getBase64 = function getBase64() {
    if (typeof target.bodyBase64 === "string") return target.bodyBase64;
    if (typeof target.bodyText === "string") return __aiproxyEncodeBase64(target.bodyText);
    return "";
  };

  target.setBase64 = function setBase64(value, mimeType) {
    target.bodyBase64 = String(value ?? "");
    target.bodyText = null;
    if (typeof mimeType === "string" && mimeType.length > 0) {
      target.mimeType = mimeType;
      target.headers = __aiproxySetHeader(target.headers, "content-type", mimeType);
    }
  };

  target.setHeader = function setHeader(name, value) {
    target.headers = __aiproxySetHeader(target.headers, name, value);
  };

  target.removeHeader = function removeHeader(name) {
    target.headers = __aiproxySetHeader(target.headers, name, undefined);
  };

  return target;
}

globalThis.__aiproxyInvoke = function __aiproxyInvoke(hookName, payloadJson) {
  const payload = JSON.parse(payloadJson);
  const entries = [];
  let responseOverride = null;

  const pushEntry = (entry) => {
    if (entries.length >= 50) return;
    entries.push({
      sequence: entries.length,
      ...entry,
    });
  };

  const request = __aiproxyAttachBodyHelpers(__aiproxyClone(payload.request));
  const response = payload.response ? __aiproxyAttachBodyHelpers(__aiproxyClone(payload.response)) : null;
  const session = __aiproxyClone(payload.session);

  const ctx = {
    request,
    response,
    session,
    log: {
      debug(message, data) {
        pushEntry({ kind: "log", level: "debug", message: String(message ?? ""), payloadJson: data === undefined ? null : JSON.stringify(data), key: null });
      },
      info(message, data) {
        pushEntry({ kind: "log", level: "info", message: String(message ?? ""), payloadJson: data === undefined ? null : JSON.stringify(data), key: null });
      },
      warn(message, data) {
        pushEntry({ kind: "log", level: "warn", message: String(message ?? ""), payloadJson: data === undefined ? null : JSON.stringify(data), key: null });
      },
      error(message, data) {
        pushEntry({ kind: "log", level: "error", message: String(message ?? ""), payloadJson: data === undefined ? null : JSON.stringify(data), key: null });
      },
    },
    extract(key, value) {
      pushEntry({
        kind: "extraction",
        level: null,
        key: String(key ?? ""),
        message: null,
        payloadJson: value === undefined ? null : JSON.stringify(value),
      });
    },
    respond(init) {
      if (!init || typeof init !== "object") {
        throw new Error("respond() requires a response object");
      }
      const status = Number(init.status ?? 200);
      if (!Number.isInteger(status) || status < 100 || status > 599) {
        throw new Error("respond status must be an integer in 100..599, got: " + init.status);
      }
      responseOverride = {
        status: status,
        headers: __aiproxyNormalizeHeaders(init.headers),
        bodyText: typeof init.bodyText === "string" ? init.bodyText : null,
        bodyBase64: typeof init.bodyBase64 === "string" ? init.bodyBase64 : null,
        mimeType: typeof init.mimeType === "string" ? init.mimeType : null,
      };
      if (responseOverride.mimeType) {
        responseOverride.headers = __aiproxySetHeader(responseOverride.headers, "content-type", responseOverride.mimeType);
      }
    },
  };

  const fn = globalThis.__aiproxyScriptExports[hookName];
  if (typeof fn !== "function") {
    return JSON.stringify({
      skipped: true,
      runtimeError: false,
      request,
      response,
      responseOverride,
      entries,
    });
  }

  // Invoke the hook and capture its return value, then serialize the result.
  //
  // IMPORTANT (async hook semantics): an `export async function onRequest`
  // returns a Promise. If we serialized the result synchronously right after
  // calling `fn(ctx)`, everything after the first `await` in the hook body
  // (including a trailing `ctx.respond(...)`) would be silently dropped,
  // because the microtask queue is not drained here.
  //
  // To make `await` inside async hooks actually take effect, we wrap the
  // serialization in a `Promise.resolve(...).then(...)` chain. The Rust invoke
  // path drives the QuickJS microtask queue (rquickjs `Promise::finish`) until
  // this returned Promise settles, so the hook body runs to completion before
  // we serialize `ctx.request` / `response` / `responseOverride` / `entries`.
  // For sync hooks the wrapper resolves on the first microtask tick with no
  // observable behavior change. The Rust side decodes the settled value as a
  // JSON string.
  //
  // EXCEPTION PRESERVATION (M3): if the hook throws (sync) or its returned
  // Promise rejects (async), the `serializeResult` step below would be skipped
  // and the whole chain would reject, causing the Rust side to discard every
  // entry the script collected before failing (it only saw a generic
  // "Exception generated by QuickJS"). The trailing `.catch` records the
  // failure as an error entry — capturing the original message where rquickjs
  // surfaces it — and then resolves the chain with `runtimeError: true` so
  // the Rust side still marks the outcome as RuntimeError while keeping the
  // pre-throw entries intact.
  return Promise.resolve()
    .then(function runHook() {
      return fn(ctx);
    })
    .then(function serializeResult() {
      return JSON.stringify({
        skipped: false,
        runtimeError: false,
        request: ctx.request,
        response: ctx.response,
        responseOverride: responseOverride,
        entries: entries,
      });
    })
    .catch(function captureHookError(error) {
      // rquickjs collapses a thrown/rejected message into a generic
      // "Exception generated by QuickJS" by the time it reaches Rust, but the
      // thrown value is still reachable here in JS — surface its `.message`
      // (or stringified form) so the user sees something actionable.
      var message = "script threw an exception";
      if (error != null) {
        if (typeof error.message === "string" && error.message.length > 0) {
          message = error.message;
        } else if (typeof error === "string" && error.length > 0) {
          message = error;
        } else if (typeof error.toString === "function") {
          var text = String(error.toString());
          if (text.length > 0 && text !== "[object Object]") {
            message = text;
          }
        }
      }
      pushEntry({ kind: "error", level: "error", message: message, payloadJson: null, key: null });
      return JSON.stringify({
        skipped: false,
        runtimeError: true,
        request: ctx.request,
        response: ctx.response,
        responseOverride: responseOverride,
        entries: entries,
      });
    });
};
"#;
