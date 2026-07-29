'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 1)}\n`, { mode: 0o644 });
    fs.renameSync(temporary, file);
  } finally {
    try { fs.unlinkSync(temporary); } catch (_) {}
  }
}

module.exports = { writeJsonAtomic };
