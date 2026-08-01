'use strict';

function decodePointerToken(token) {
  if (/~(?![01])/u.test(token)) throw new Error('invalid RFC 6901 escape');
  return token.replace(/~1/g, '/').replace(/~0/g, '~');
}

function selectJsonPointer(value, pointer) {
  if (pointer == null || pointer === '') return { ok: true, value };
  if (typeof pointer !== 'string' || !pointer.startsWith('/')) {
    return { ok: false, error: 'pointer must be empty or an RFC 6901 JSON Pointer beginning with /' };
  }
  let current = value;
  for (const rawToken of pointer.slice(1).split('/')) {
    let token;
    try { token = decodePointerToken(rawToken); } catch (error) {
      return { ok: false, error: `${error.message}: ${rawToken}` };
    }
    if (current == null || (typeof current !== 'object' && !Array.isArray(current))
      || !Object.prototype.hasOwnProperty.call(current, token)) {
      // Describe the container the failing token was applied to, so one failed guess is enough:
      // the model kept probing `/data` on the achievements endpoint (a root ARRAY) and `/data/4`
      // on buildings across wakes because the error alone said nothing about the actual shape.
      return {
        ok: false,
        error: `pointer segment not found: ${token}`,
        shapeHint: describeContainerShape(current),
      };
    }
    current = current[token];
  }
  return { ok: true, value: current };
}

function describeContainerShape(value) {
  if (Array.isArray(value)) {
    return {
      containerType: 'array',
      length: value.length,
      hint: 'this level is an ARRAY — address items by index (e.g. /0) or omit the pointer',
    };
  }
  if (value != null && typeof value === 'object') {
    const keys = Object.keys(value);
    return {
      containerType: 'object',
      keys: keys.slice(0, 25),
      totalKeys: keys.length,
    };
  }
  return { containerType: value === null ? 'null' : typeof value };
}

function jsonBytes(value) {
  const raw = JSON.stringify(value);
  return raw === undefined ? 0 : Buffer.byteLength(raw, 'utf8');
}

function compactObjectSummary(value) {
  const keys = Object.keys(value || {});
  const scalars = {};
  for (const key of keys.slice(0, 20)) {
    const item = value[key];
    if (item == null || ['number', 'boolean'].includes(typeof item)) scalars[key] = item;
    else if (typeof item === 'string') scalars[key] = item.length <= 120
      ? item
      : { preview: item.slice(0, 120), valueTruncated: true, totalChars: item.length };
  }
  return {
    keys: keys.slice(0, 80),
    totalKeys: keys.length,
    keysTruncated: keys.length > 80,
    scalars,
  };
}

function formatApiResponse(envelope, options = {}, maxBytes = 7000) {
  const base = {
    ok: envelope?.ok === true,
    path: envelope?.path || String(options.path || ''),
    status: envelope?.status ?? null,
    fetchedAt: envelope?.fetchedAt || new Date().toISOString(),
  };
  if (!base.ok) return { ...base, error: envelope?.error || 'API request failed', truncated: false };

  const selected = selectJsonPointer(envelope.data, options.pointer);
  if (!selected.ok) {
    const failure = {
      ...base, ok: false, error: selected.error, pointer: options.pointer || '', truncated: false,
    };
    if (selected.shapeHint) failure.shapeHint = selected.shapeHint;
    return failure;
  }

  const value = selected.value;
  const pointer = options.pointer || '';
  if (value === undefined) {
    return { ...base, ok: false, pointer, error: 'selected API value is undefined', truncated: false };
  }
  const totalBytes = jsonBytes(value);
  if (Array.isArray(value)) {
    const offset = Math.max(0, Number.isSafeInteger(options.offset) ? options.offset : 0);
    const requestedLimit = Math.min(100, Math.max(1, Number.isSafeInteger(options.limit) ? options.limit : 50));
    let rows = value.slice(offset, offset + requestedLimit);
    let response = {
      ...base,
      pointer,
      offset,
      limit: requestedLimit,
      totalItems: value.length,
      returnedItems: rows.length,
      totalBytes,
      truncated: offset > 0 || offset + rows.length < value.length,
      data: rows,
    };
    while (rows.length > 1 && jsonBytes(response) > maxBytes) {
      rows = rows.slice(0, Math.ceil(rows.length / 2));
      response = { ...response, returnedItems: rows.length, truncated: true, data: rows };
    }
    if (jsonBytes(response) <= maxBytes) return response;
    return {
      ...base,
      pointer,
      offset,
      limit: requestedLimit,
      totalItems: value.length,
      returnedItems: 0,
      totalBytes,
      truncated: true,
      data: null,
      itemSummary: rows.length ? (rows[0] && typeof rows[0] === 'object'
        ? compactObjectSummary(rows[0])
        : { type: typeof rows[0] }) : null,
      next: 'Use a smaller limit or a more specific pointer.',
    };
  }

  const full = { ...base, pointer, totalBytes, truncated: false, data: value };
  if (jsonBytes(full) <= maxBytes) return full;
  if (value && typeof value === 'object') {
    return {
      ...base,
      pointer,
      totalBytes,
      truncated: true,
      data: null,
      objectSummary: compactObjectSummary(value),
      next: 'Call read_api again with a JSON Pointer for the needed field.',
    };
  }
  return {
    ...base,
    pointer,
    totalBytes,
    truncated: true,
    data: null,
    valueSummary: { type: typeof value, totalChars: String(value).length },
    next: 'The selected scalar is too large; use a more specific endpoint.',
  };
}

module.exports = { formatApiResponse, selectJsonPointer };
