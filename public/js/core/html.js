/**
 * Safe HTML templating.
 *
 * Replaces six hand-rolled copies of `escapeHtml()` that used
 * `div.textContent -> div.innerHTML`. That idiom does NOT escape `"` or `'`,
 * because a text node containing a quote needs no escaping — but the result
 * was being interpolated into attribute values (e.g. `data-id="${…}"`),
 * where quotes break out. Escaping here is context-independent and applied
 * by default, so a caller cannot forget it.
 */

const ENTITIES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Escape a value for interpolation into markup (text OR attribute). */
export function esc(value) {
  if (value === null || value === undefined) return "";
  return String(value).replace(/[&<>"']/g, (c) => ENTITIES[c]);
}

/** Marks an already-safe HTML string so the `html` tag won't re-escape it. */
class Safe {
  constructor(value) { this.value = value; }
  toString() { return this.value; }
}

/**
 * Opt out of escaping. Only for markup this code produced — never for
 * anything that came off the network.
 */
export function raw(value) { return new Safe(value == null ? "" : String(value)); }

function resolve(v) {
  if (v instanceof Safe) return v.value;
  if (Array.isArray(v)) return v.map(resolve).join("");
  return esc(v);
}

/** html`<p>${untrusted}</p>` — every interpolation escaped unless raw(). */
export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += resolve(values[i]) + strings[i + 1];
  return new Safe(out);
}

/** Render into a container. Accepts a Safe from html`` or a plain string. */
export function render(el, content) {
  el.innerHTML = content instanceof Safe ? content.value : esc(content);
  return el;
}
