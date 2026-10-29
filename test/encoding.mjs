/**
 * Verify that a PowerShell script's non-ASCII paths survive the encoding rules of
 * Windows PowerShell 5.1.
 *
 * This check exists because it happened: a script saved as UTF-8 *without* a BOM
 * is decoded as the system ANSI code page (GBK on a Chinese Windows), so
 * `D:\大D老师\...` becomes `D:\澶鑰佸笀\...` and the script writes into a directory
 * that does not exist. Node is used to read the bytes precisely, because running
 * the check through PowerShell 5.1 would subject the checker to the same bug it
 * is meant to catch.
 *
 * Usage: node test/encoding.mjs [script.ps1 ...]
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

const DEFAULT_TARGET = 'D:\\大D老师\\猫咪喝鲜奶呕吐原因分析\\_restart_dsh.ps1'
const targets = process.argv.slice(2).length > 0 ? process.argv.slice(2) : [DEFAULT_TARGET]

const failures = []
const check = (label, condition, detail) => {
  if (condition) console.log(`  ok   ${label}`)
  else { failures.push(label); console.log(`  FAIL ${label}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`) }
}

for (const file of targets) {
  console.log(`\n${file}`)
  if (!existsSync(file)) { check('the file exists', false); continue }

  const bytes = readFileSync(file)
  const hasBom = bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF
  const text = bytes.toString('utf8')

  check('it is valid UTF-8', !text.includes('\uFFFD'))

  // Only matters when the script actually contains non-ASCII characters: a pure
  // ASCII script is decoded identically under every code page.
  const hasNonAscii = /[^\x00-\x7F]/.test(text)
  if (hasNonAscii) {
    check('a script with non-ASCII text carries a UTF-8 BOM', hasBom,
      'without a BOM, PowerShell 5.1 decodes it as the ANSI code page and the paths turn to mojibake')
  } else {
    console.log('  --   ASCII only, the BOM question does not apply')
  }

  // Byte-for-byte: the decoded text is what the author meant, and every quoted
  // absolute path in it names a directory that exists.
  const paths = [...text.matchAll(/'([A-Za-z]:\\[^'\r\n]+)'/g)].map(match => match[1])
  const unique = [...new Set(paths)]
  check('the script names at least one absolute path', unique.length > 0, unique.length)
  for (const path of unique) {
    const parent = dirname(path)
    check(`parent exists: ${parent}`, existsSync(parent))
  }

  // Mojibake written by a previous broken run is a directory nobody can find
  // again, so it is worth reporting rather than silently leaving it.
  const roots = new Set(unique.map(path => dirname(dirname(path))))
  for (const root of roots) {
    if (!existsSync(root)) continue
    let entries = []
    try { entries = readdirSync(root) } catch { continue }
    const stray = entries.filter(name => /[\uE000-\uF8FF]|澶|鑰佸笀|鐚|鍠濋矞/.test(name))
    check(`no mojibake directory under ${root}`, stray.length === 0, stray)
  }

  const size = statSync(file).size
  console.log(`  --   ${size} bytes, BOM ${hasBom ? 'present' : 'absent'}`)
}

console.log(failures.length === 0 ? '\nALL PASS' : `\n${failures.length} FAILED`)
process.exit(failures.length === 0 ? 0 : 1)
