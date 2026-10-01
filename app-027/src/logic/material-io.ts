import { PAPER_KINDS, type MaterialPreset } from './types'
import { uid } from './geometry'

// ---------------- 合理区间与校验 ----------------

export const NAME_MAX = 30

export type NumField = 'force' | 'speedMmS' | 'passes' | 'bladeOffsetMm'
export type MaterialField = 'name' | 'paper' | NumField

export type NumLimit = {
  key: NumField
  label: string
  unit: string
  min: number
  max: number
  integer?: boolean
}

/** 数值字段的合理区间（保存 / 导入时强校验，越界当场指出） */
export const NUM_LIMITS: NumLimit[] = [
  { key: 'force', label: '刀压', unit: '', min: 1, max: 500, integer: true },
  { key: 'speedMmS', label: '速度', unit: 'mm/s', min: 1, max: 500 },
  { key: 'passes', label: '重复次数', unit: '次', min: 1, max: 10, integer: true },
  { key: 'bladeOffsetMm', label: '刀补偏置', unit: 'mm', min: 0, max: 2 },
]

export const NUM_LIMIT_MAP: Record<NumField, NumLimit> = Object.fromEntries(
  NUM_LIMITS.map((l) => [l.key, l]),
) as Record<NumField, NumLimit>

export const rangeText = (l: NumLimit): string =>
  `${l.min} ~ ${l.max}${l.unit ? ' ' + l.unit : ''}`

export type MaterialErrors = Partial<Record<MaterialField, string>>

export type ValidationResult = {
  /** 阻断保存 / 导入的问题 */
  errors: MaterialErrors
  /** 可导入但建议处理的问题（如纸张类型不在内置列表） */
  warnings: MaterialErrors
}

export function hasErrors(r: ValidationResult): boolean {
  return Object.keys(r.errors).length > 0
}

type LoosePresetFields = {
  name?: unknown
  paper?: unknown
  force?: unknown
  speedMmS?: unknown
  passes?: unknown
  bladeOffsetMm?: unknown
}

function asNumber(v: unknown): number {
  if (typeof v === 'number') return v
  if (typeof v === 'string' && v.trim() !== '') return Number(v)
  return NaN
}

/**
 * 校验一条材料预设。
 * opts.materials 存在时顺带检查同名（排除 selfId 自身）。
 */
export function validateMaterial(
  m: LoosePresetFields,
  opts: { selfId?: string; materials?: MaterialPreset[] } = {},
): ValidationResult {
  const errors: MaterialErrors = {}
  const warnings: MaterialErrors = {}

  const rawName = typeof m.name === 'string' ? m.name.trim() : ''
  if (!rawName) {
    errors.name = '预设名称不能为空'
  } else if (rawName.length > NAME_MAX) {
    errors.name = `预设名称不能超过 ${NAME_MAX} 个字（当前 ${rawName.length} 个字）`
  } else if (opts.materials?.some((x) => x.id !== opts.selfId && x.name.trim() === rawName)) {
    errors.name = '已存在同名预设，请换一个名字'
  }

  if (typeof m.paper !== 'string' || !m.paper) {
    errors.paper = '请选择纸张类型'
  } else if (!PAPER_KINDS.some((k) => k.paper === m.paper)) {
    warnings.paper = '纸张类型不在内置列表中，保存后建议重新选择'
  }

  for (const lim of NUM_LIMITS) {
    const v = asNumber(m[lim.key])
    if (!Number.isFinite(v)) {
      errors[lim.key] = `${lim.label}请填写数字`
    } else if (lim.integer && !Number.isInteger(v)) {
      errors[lim.key] = `${lim.label}必须是整数（允许范围 ${rangeText(lim)}）`
    } else if (v < lim.min || v > lim.max) {
      errors[lim.key] = `${lim.label}超出合理范围：允许 ${rangeText(lim)}，当前为 ${formatNumber(v)}`
    }
  }

  return { errors, warnings }
}

export function formatNumber(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')
}

/** 字段值的展示文本（差异对比用） */
export function formatFieldValue(field: MaterialField, value: unknown): string {
  if (field === 'name') return typeof value === 'string' ? value : String(value ?? '')
  if (field === 'paper') {
    const key = typeof value === 'string' ? value : ''
    return PAPER_KINDS.find((k) => k.paper === key)?.label ?? (key || '（未知）')
  }
  const v = asNumber(value)
  if (!Number.isFinite(v)) return String(value ?? '—')
  const lim = NUM_LIMIT_MAP[field]
  return `${formatNumber(v)}${lim.unit ? ' ' + lim.unit : ''}`
}

// ---------------- 导出 / 导入文件 ----------------

export const MATERIAL_FILE_TYPE = 'papercut-materials'
export const MATERIAL_FILE_VERSION = 1

export type MaterialExportFile = {
  type: typeof MATERIAL_FILE_TYPE
  version: number
  app: string
  exportedAt: string
  materials: MaterialPreset[]
}

export function serializeMaterials(materials: MaterialPreset[]): string {
  const data: MaterialExportFile = {
    type: MATERIAL_FILE_TYPE,
    version: MATERIAL_FILE_VERSION,
    app: 'Paper-cut Plotter Studio',
    exportedAt: new Date().toISOString(),
    materials: materials.map((m) => ({ ...m })),
  }
  return JSON.stringify(data, null, 2)
}

export type ParseOk = { ok: true; items: InspectedPreset[]; exportedAt?: string }
export type ParseFail = { ok: false; error: string }

/** 单条原始数据规范化 + 校验的结果（尚未与本机数据比对） */
export type InspectedPreset = {
  preset: MaterialPreset
  result: ValidationResult
}

/** 解析并逐条检查导入文件；文件整体不对时返回错误说明 */
export function parseMaterialFile(text: string): ParseOk | ParseFail {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return { ok: false, error: '文件不是有效的 JSON，请确认选择的是材料预设导出文件' }
  }
  if (typeof data !== 'object' || data === null) {
    return { ok: false, error: '文件内容结构不正确' }
  }
  const obj = data as Record<string, unknown>
  if (obj.type !== MATERIAL_FILE_TYPE) {
    return { ok: false, error: `文件类型标识为「${String(obj.type ?? '缺失')}」，不是材料预设导出文件` }
  }
  if (obj.version !== MATERIAL_FILE_VERSION) {
    return { ok: false, error: `文件版本（${String(obj.version)}）不受支持，请用新版应用导出` }
  }
  if (!Array.isArray(obj.materials) || obj.materials.length === 0) {
    return { ok: false, error: '文件里没有任何材料预设' }
  }
  const items = obj.materials.map((raw, i) => inspectPreset(raw, i))
  return { ok: true, items, exportedAt: typeof obj.exportedAt === 'string' ? obj.exportedAt : undefined }
}

function inspectPreset(raw: unknown, index: number): InspectedPreset {
  const fallback: MaterialPreset = {
    id: uid('mat'),
    name: '',
    paper: '',
    force: NaN,
    speedMmS: NaN,
    passes: NaN,
    bladeOffsetMm: NaN,
    backing: '',
  }
  if (typeof raw !== 'object' || raw === null) {
    return {
      preset: { ...fallback, name: `第 ${index + 1} 条（损坏）` },
      result: { errors: { name: '该条目不是有效对象，无法导入' }, warnings: {} },
    }
  }
  const r = raw as Record<string, unknown>
  const preset: MaterialPreset = {
    id: typeof r.id === 'string' && r.id ? r.id : uid('mat'),
    name: typeof r.name === 'string' ? r.name : '',
    paper: typeof r.paper === 'string' ? r.paper : '',
    force: asNumber(r.force),
    speedMmS: asNumber(r.speedMmS),
    passes: asNumber(r.passes),
    bladeOffsetMm: asNumber(r.bladeOffsetMm),
    backing: typeof r.backing === 'string' && r.backing.trim() ? r.backing : '常规垫板',
  }
  return { preset, result: validateMaterial(preset) }
}

// ---------------- 导入预检 ----------------

export type ConflictAction = 'overwrite' | 'skip' | 'rename'

export type ImportStatus = 'new' | 'conflict' | 'duplicate'

/** 预检后的单条导入项（界面可改 action / renameTo） */
export type ImportEntry = {
  key: string
  preset: MaterialPreset
  result: ValidationResult
  status: ImportStatus
  /** 本机同名预设 id（status=conflict 时存在） */
  localId?: string
  /** conflict / duplicate / 校验失败时为 skip；new 固定 add */
  action: 'add' | ConflictAction
  renameTo: string
  /** 计划构建时该条被跳过的具体原因（名字冲突等） */
  skipReason?: string
}

/**
 * 把文件内预设与本机比对：
 * - 按去空格后的名字匹配本机同名预设
 * - 文件内部重名的后一条标记 duplicate（默认跳过）
 * - 字段校验失败的条目只能跳过
 */
export function analyzeImport(items: InspectedPreset[], locals: MaterialPreset[]): ImportEntry[] {
  const seenNames = new Set<string>()
  return items.map((item, i) => {
    const name = item.preset.name.trim()
    const local = locals.find((m) => m.name.trim() === name)
    const invalid = hasErrors(item.result)
    let status: ImportStatus
    if (seenNames.has(name)) status = 'duplicate'
    else if (local) status = 'conflict'
    else status = 'new'
    seenNames.add(name)

    const key = `${item.preset.id}-${i}`
    if (invalid) {
      return { key, preset: item.preset, result: item.result, status, localId: local?.id, action: 'skip', renameTo: '' }
    }
    if (status === 'duplicate') {
      return {
        key,
        preset: item.preset,
        result: item.result,
        status,
        localId: local?.id,
        action: 'skip',
        renameTo: '',
      }
    }
    if (status === 'conflict') {
      return {
        key,
        preset: item.preset,
        result: item.result,
        status,
        localId: local?.id,
        action: 'overwrite',
        renameTo: `${name}（导入）`,
      }
    }
    return { key, preset: item.preset, result: item.result, status, action: 'add', renameTo: '' }
  })
}

export type FieldDiff = {
  field: MaterialField | 'backing'
  label: string
  from: string
  to: string
}

const DIFF_FIELDS: Array<{ field: MaterialField; label: string }> = [
  { field: 'name', label: '名称' },
  { field: 'paper', label: '纸张类型' },
  { field: 'force', label: '刀压' },
  { field: 'speedMmS', label: '速度' },
  { field: 'passes', label: '重复次数' },
  { field: 'bladeOffsetMm', label: '刀补偏置' },
]

/** 列出覆盖时实际会变化的字段（垫板单独比较） */
export function diffPresets(from: MaterialPreset, to: MaterialPreset): FieldDiff[] {
  const diffs: FieldDiff[] = []
  for (const { field, label } of DIFF_FIELDS) {
    const a = from[field]
    const b = to[field]
    if (field === 'name' || field === 'paper') {
      if ((a as string) !== (b as string)) {
        diffs.push({ field, label, from: formatFieldValue(field, a), to: formatFieldValue(field, b) })
      }
    } else if (Number(a) !== Number(b)) {
      diffs.push({ field, label, from: formatFieldValue(field, a), to: formatFieldValue(field, b) })
    }
  }
  if (from.backing !== to.backing) {
    diffs.push({ field: 'backing', label: '垫板', from: from.backing, to: to.backing })
  }
  return diffs
}

export type ImportOp =
  | { kind: 'add'; preset: MaterialPreset }
  | { kind: 'rename'; preset: MaterialPreset }
  | { kind: 'overwrite'; localId: string; preset: MaterialPreset; diffs: FieldDiff[] }

export type ImportPlan = {
  ops: ImportOp[]
  addCount: number
  renameCount: number
  overwriteCount: number
  /** 覆盖会改动的本机预设 id（供查影响项目） */
  overwriteLocalIds: string[]
  skipCount: number
}

/**
 * 根据当前每条的选择生成最终执行计划。
 * 另存为名字为空 / 越界 / 与本机或同批其他条撞名时，该条退回跳过并写明原因。
 */
export function buildImportPlan(entries: ImportEntry[], locals: MaterialPreset[]): ImportPlan {
  const ops: ImportOp[] = []
  const usedNames = new Set(locals.map((m) => m.name.trim()))
  const skipReasons = new Map<string, string>()
  let addCount = 0
  let renameCount = 0
  let overwriteCount = 0
  let skipCount = 0
  const overwriteLocalIds: string[] = []

  for (const e of entries) {
    if (hasErrors(e.result)) {
      skipCount += 1
      continue
    }
    if (e.status === 'new') {
      ops.push({ kind: 'add', preset: { ...e.preset, id: uid('mat') } })
      usedNames.add(e.preset.name.trim())
      addCount += 1
      continue
    }
    if (e.action === 'skip') {
      skipCount += 1
      continue
    }
    if (e.action === 'overwrite') {
      const local = locals.find((m) => m.id === e.localId)
      if (!local) {
        skipCount += 1
        skipReasons.set(e.key, '本机同名预设已不存在')
        continue
      }
      const diffs = diffPresets(local, e.preset)
      ops.push({ kind: 'overwrite', localId: local.id, preset: { ...e.preset, id: local.id }, diffs })
      overwriteLocalIds.push(local.id)
      overwriteCount += 1
      continue
    }
    // rename
    const newName = e.renameTo.trim()
    if (!newName) {
      skipCount += 1
      skipReasons.set(e.key, '另存为的名称不能为空')
      continue
    }
    if (newName.length > NAME_MAX) {
      skipCount += 1
      skipReasons.set(e.key, `另存为的名称不能超过 ${NAME_MAX} 个字`)
      continue
    }
    if (usedNames.has(newName)) {
      skipCount += 1
      skipReasons.set(e.key, '另存为的名称与本机或本批其他预设重名')
      continue
    }
    ops.push({ kind: 'rename', preset: { ...e.preset, id: uid('mat'), name: newName } })
    usedNames.add(newName)
    renameCount += 1
  }

  for (const e of entries) e.skipReason = skipReasons.get(e.key)

  return { ops, addCount, renameCount, overwriteCount, overwriteLocalIds, skipCount }
}

export function entryParamsSummary(e: ImportEntry): string {
  const m = e.preset
  const paper = formatFieldValue('paper', m.paper)
  const f = (v: number) => (Number.isFinite(v) ? formatNumber(v) : '—')
  return `${paper}｜刀压 ${f(m.force)}｜速度 ${f(m.speedMmS)} mm/s｜重复 ${f(m.passes)} 次｜刀补 ${f(m.bladeOffsetMm)} mm`
}
