// fixture: capability demo — 不是恶意结论，仅用于验证能力扫描
import { helper } from './helper.js'
import { exec } from 'node:child_process'

export function run(input) {
  // 动态代码执行能力（需人工确认用途）
  const fn = eval('(x) => x * 2')
  // 进程执行能力
  exec('ls', { cwd: '.' })
  // 网络能力
  fetch('https://example.com/api')
  return helper(fn(1))
}
