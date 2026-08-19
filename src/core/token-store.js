// ============================================================
// 凭证安全本地存储模块（双凭证：Gateway Token + 管理 API Token）
// ============================================================
// 目标：解决「每次启动 TUI 都要重输 Token」的痛点，
//       同时避免「环境变量 / 明文文件」被任意进程读取的风险。
//
// 按平台选择存储方式：
//   - Windows : DPAPI 加密（系统 ProtectedData，仅当前用户可解密）
//   - macOS   : Keychain（security 命令，系统钥匙串）
//   - Linux   : 明文文件 + chmod 0600（降级方案，仅当前用户可读）
//
// 凭证永不写入项目目录，统一存到用户主目录 ~/.ai-gateway-desk/
//
// 双凭证槽位（2026-08-07 任务 12 改造）：
//   - gateway   : cfut_xxx（绑定单个 gateway）→ 文件 token（路径不变，兼容旧数据）
//   - management: 管理 API Token（账户级）    → 文件 token.management
//   macOS Keychain 场景用不同的 account 名区分两个槽位。
// ============================================================

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 存储目录：默认 ~/.ai-gateway-desk（真实凭证）。
// 测试隔离：设置 AI_GW_TEST_DIR 时重定向到指定目录（通常是临时目录），
// 测试进程的读写完全不会触碰真实凭证存储；同时该模式强制使用文件存储
// （跳过 macOS Keychain），保证任何平台下测试都不污染真实凭证。
const STORE_DIR = process.env.AI_GW_TEST_DIR || path.join(os.homedir(), '.ai-gateway-desk')

// 测试模式：AI_GW_TEST_DIR 被设置即视为测试隔离模式（Keychain 不可用）
const IS_TEST_MODE = !!process.env.AI_GW_TEST_DIR

// 槽位定义：file 为文件槽位文件名（Windows / Linux），macAccount 为 Keychain account（macOS）
const SLOTS = {
  gateway: {
    file: 'token',
    macAccount: 'gateway-token',
  },
  management: {
    file: 'token.management',
    macAccount: 'management-token',
  },
}

const MAC_SERVICE = 'ai-gateway-desk'

// ─── Windows: DPAPI 加密 ─────────────────────────────────

function winScript(action) {
  const body =
    action === 'read'
      ? '$enc = [System.IO.File]::ReadAllBytes($env:AI_GW_TOKEN_PATH); ' +
        '$data = [System.Security.Cryptography.ProtectedData]::Unprotect(' +
        '$enc, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser); ' +
        '[Console]::Write([System.Text.Encoding]::UTF8.GetString($data))'
      : '$data = [System.Text.Encoding]::UTF8.GetBytes($env:AI_GW_TOKEN); ' +
        '$enc = [System.Security.Cryptography.ProtectedData]::Protect(' +
        '$data, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser); ' +
        '[System.IO.File]::WriteAllBytes($env:AI_GW_TOKEN_PATH, $enc)'
  return `Add-Type -AssemblyName System.Security; ${body}`
}

function psRun(script, env) {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function winWrite(token, tokenPath) {
  fs.mkdirSync(STORE_DIR, { recursive: true })
  psRun(winScript('write'), { AI_GW_TOKEN: token, AI_GW_TOKEN_PATH: tokenPath })
}

function winRead(tokenPath) {
  if (!fs.existsSync(tokenPath)) return null
  const out = psRun(winScript('read'), { AI_GW_TOKEN_PATH: tokenPath })
  return out.trim() || null
}

function winClear(tokenPath) {
  try {
    fs.unlinkSync(tokenPath)
  } catch {
    // 文件不存在，忽略
  }
}

// ─── macOS: Keychain ─────────────────────────────────────

function macWrite(token, macAccount) {
  execFileSync('security', ['add-generic-password', '-a', macAccount, '-s', MAC_SERVICE, '-w', token, '-U'], {
    stdio: 'ignore',
  })
}

function macRead(macAccount) {
  try {
    const out = execFileSync('security', ['find-generic-password', '-a', macAccount, '-s', MAC_SERVICE, '-w'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return out.trim() || null
  } catch {
    return null
  }
}

function macClear(macAccount) {
  try {
    execFileSync('security', ['delete-generic-password', '-a', macAccount, '-s', MAC_SERVICE], {
      stdio: 'ignore',
    })
  } catch {
    // 不存在，忽略
  }
}

// ─── Linux / 其他: 明文 + 0600 权限 ──────────────────────

function linuxWrite(token, tokenPath) {
  fs.mkdirSync(STORE_DIR, { recursive: true })
  fs.writeFileSync(tokenPath, token, { mode: 0o600 })
}

function linuxRead(tokenPath) {
  try {
    if (!fs.existsSync(tokenPath)) return null
    return fs.readFileSync(tokenPath, 'utf8').trim() || null
  } catch {
    return null
  }
}

function linuxClear(tokenPath) {
  try {
    fs.unlinkSync(tokenPath)
  } catch {
    // 文件不存在，忽略
  }
}

// ─── 统一内部入口（按槽位读写） ──────────────────────────

function getPlatform() {
  // 测试隔离模式：强制文件存储（避免 macOS Keychain 无法重定向，污染真实钥匙串）
  if (IS_TEST_MODE) return 'linux'
  if (process.platform === 'win32') return 'win32'
  if (process.platform === 'darwin') return 'darwin'
  return 'linux'
}

/** 读取指定槽位，失败 / 未保存返回 null */
function readSlot(slot) {
  const { file, macAccount } = SLOTS[slot]
  const tokenPath = path.join(STORE_DIR, file)
  try {
    const p = getPlatform()
    if (p === 'win32') return winRead(tokenPath)
    if (p === 'darwin') return macRead(macAccount)
    return linuxRead(tokenPath)
  } catch {
    return null
  }
}

/** 写入指定槽位，失败时抛出（调用方应捕获并提示） */
function writeSlot(slot, token) {
  const { file, macAccount } = SLOTS[slot]
  const tokenPath = path.join(STORE_DIR, file)
  const p = getPlatform()
  if (p === 'win32') return winWrite(token, tokenPath)
  if (p === 'darwin') return macWrite(token, macAccount)
  return linuxWrite(token, tokenPath)
}

/** 清除指定槽位 */
function clearSlot(slot) {
  const { file, macAccount } = SLOTS[slot]
  const tokenPath = path.join(STORE_DIR, file)
  const p = getPlatform()
  if (p === 'win32') return winClear(tokenPath)
  if (p === 'darwin') return macClear(macAccount)
  return linuxClear(tokenPath)
}

// ─── 导出接口：Gateway 槽位（cfut_xxx，绑定单 gateway）───
// 与改造前行为完全一致（文件路径 token 不变，兼容旧数据）

/**
 * 读取本地保存的 Gateway Token
 * @returns {string|null} token 或 null（未保存 / 读取失败）
 */
export function readToken() {
  return readSlot('gateway')
}

/**
 * 安全写入 Gateway Token 到本地
 * @param {string} token
 * @throws 写入失败时抛出错误（调用方应捕获并提示）
 */
export function writeToken(token) {
  return writeSlot('gateway', token)
}

/**
 * 清除本地保存的 Gateway Token
 */
export function clearToken() {
  return clearSlot('gateway')
}

// ─── 导出接口：管理槽位（管理 API Token，账户级，新增）────

/**
 * 读取本地保存的管理 API Token
 * @returns {string|null} token 或 null（未保存 / 读取失败）
 */
export function readManagementToken() {
  return readSlot('management')
}

/**
 * 安全写入管理 API Token 到本地
 * @param {string} token
 * @throws 写入失败时抛出错误（调用方应捕获并提示）
 */
export function writeManagementToken(token) {
  return writeSlot('management', token)
}

/**
 * 清除本地保存的管理 API Token
 */
export function clearManagementToken() {
  return clearSlot('management')
}

// ─── 槽位状态（新增） ────────────────────────────────────

/**
 * 返回两个凭证槽位的保存状态
 * @returns {{ management: '本地'|'未保存', gateway: '本地'|'未保存' }}
 */
export function getSlotStatus() {
  return {
    management: readManagementToken() ? '本地' : '未保存',
    gateway: readToken() ? '本地' : '未保存',
  }
}

// ─── 存储方式描述（保持签名与返回值不变） ────────────────

/**
 * 当前平台使用的存储方式描述（用于 UI 提示）
 * @returns {{ platform: string, storage: string, secure: boolean }}
 */
export function getTokenStoreInfo() {
  const p = getPlatform()
  if (p === 'win32') {
    return { platform: 'Windows', storage: 'DPAPI 加密（仅当前用户可解密）', secure: true }
  }
  if (p === 'darwin') {
    return { platform: 'macOS', storage: 'Keychain 钥匙串', secure: true }
  }
  return { platform: 'Linux', storage: '明文文件 + 0600 权限（降级方案）', secure: false }
}
