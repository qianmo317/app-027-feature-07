import { PAPER_KINDS, type MaterialPreset } from './types'
import { sanitizeFilename } from './download'

// ---------------- 合理区间校验 ----------------

export type MaterialField = 'name' | 'paper' | 'force' | 'speedMmS' | 'passes' | 'bladeOffsetMm'

export type FieldLimit = {
  min: number
  max: number
  integer?: boolean
  label: string
  unit?: string
}

/** 保存前的数值合理区间（界面 min/max 与此一致） */
export const MATERIAL_LIMITS: Record<Exclude<MaterialField, 'name' | 'paper'>, FieldLimit> = {
  force: { min: 1, max: 500, integer: true, label: '刀压' },
  speedMmS: { min: 1, max: 500, integer: true, label: '速度', unit: 'mm/s' },
  passes: { min: 1, max: 10, integer: true, label: '重复次数', unit: '次' },
  bladeOffsetMm: { min: 0, max: 2, label: '刀补偏置', unit: 'mm' },
}

export function rangeText(lim: FieldLimit): string {
  return `${lim.min}${lim.unit ? ' ' + lim.unit : ''} ~ ${lim.max}${lim.unit ? ' ' + lim.unit : ''}`
}

/** 校验单条预设；返回字段 -> 问题说明（空对象表示全部通过） */
export function validateMaterial(m: Partial<MaterialPreset>): Partial<Record<MaterialField, string>> {
  const errors: Partial<Record<MaterialField, string>> = {}
  const name = typeof m.name === 'string' ? m.name.trim() : ''
  if (!name) errors.name = '预设名称不能为空'

  if (!m.paper || !PAPER_KINDS.some((k) => k.paper === m.paper)) {
    errors.paper = `纸张类型无效（支持：${PAPER_KINDS.map((k) => k.label).join('、')}）`
  }

  for (const key of ['force', 'speedMmS', 'passes', 'bladeOffsetMm'] as const) {
    const lim = MATERIAL_LIMITS[key]
    const v = m[key]
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      errors[key] = `${lim.label}必须填数字，允许范围 ${rangeText(lim)}`
      continue
    }
    if (v < lim.min || v > lim.max) {
      errors[key] = `${lim.label} ${formatNum(v)} 超出合理区间（${rangeText(lim)}），请修改后再保存`
      continue
    }
    if (lim.integer && !Number.isInteger(v)) {
      errors[key] = `${lim.label}必须是整数（${rangeText(lim)}）`
    }
  }
  return errors
}

function formatNum(v: number): string {
  return Number.isInteger(v) ? String(v) : String(Math.round(v * 1000) / 1000)
}

// ---------------- 导出文件 ----------------

export const MATERIAL_FILE_KIND = 'papercut-material-presets'

export type MaterialFile = {
  kind: typeof MATERIAL_FILE_KIND
  version: 1
  exportedAt: string
  app: string
  presets: MaterialPreset[]
}

export function serializeMaterials(presets: MaterialPreset[]): string {
  const file: MaterialFile = {
    kind: MATERIAL_FILE_KIND,
    version: 1,
    exportedAt: new Date().toISOString(),
    app: 'Paper-cut Plotter Studio',
    presets: presets.map((m) => ({ ...m })),
  }
  return JSON.stringify(file, null, 2)
}

export function materialsFilename(presets: MaterialPreset[]): string {
  if (presets.length === 1) return `材料预设-${sanitizeFilename(presets[0].name)}.json`
  return `材料预设库-${presets.length}条-${new Date().toISOString().slice(0, 10)}.json`
}

// ---------------- 导入解析与预览 ----------------

export type ImportAction = 'replace' | 'copy' | 'skip'

export type ImportRow = {
  /** 文件里的原始序号（0 起） */
  index: number
  preset: MaterialPreset
  /** 本机是否存在同名预设 */
  localSameName: MaterialPreset | null
  /** 同名预设正在被哪些项目使用（项目名） */
  localUsedBy: string[]
  /** 文件内部同名是否重复出现（第一条之后均标记） */
  dupInFile: boolean
  errors: string[]
  action: ImportAction
}

export type ParsedMaterialFile =
  | { ok: true; rows: ImportRow[]; exportedAt: string | null }
  | { ok: false; error: string }

function toNumber(v: unknown): number {
  if (typeof v === 'number') return v
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    if (Number.isFinite(n)) return n
  }
  return NaN
}

function asPreset(raw: unknown, seq: number): { preset: MaterialPreset; errors: string[] } {
  const errors: string[] = []
  if (typeof raw !== 'object' || raw === null) {
    return {
      preset: { id: `mat-bad-${seq}`, name: '（损坏的记录）', paper: '', force: NaN, speedMmS: NaN, passes: NaN, bladeOffsetMm: NaN, backing: '' },
      errors: ['不是有效的预设对象'],
    }
  }
  const r = raw as Record<string, unknown>
  const preset: MaterialPreset = {
    id: typeof r.id === 'string' && r.id ? r.id : `mat-imported-${seq}-${Math.random().toString(36).slice(2, 8)}`,
    name: typeof r.name === 'string' ? r.name : '',
    paper: typeof r.paper === 'string' ? r.paper : '',
    force: toNumber(r.force),
    speedMmS: toNumber(r.speedMmS),
    passes: toNumber(r.passes),
    bladeOffsetMm: toNumber(r.bladeOffsetMm),
    backing: typeof r.backing === 'string' && r.backing.trim() ? r.backing : '常规垫板',
  }
  const fieldErrors = validateMaterial(preset)
  for (const key of ['name', 'paper', 'force', 'speedMmS', 'passes', 'bladeOffsetMm'] as const) {
    const msg = fieldErrors[key]
    if (msg) errors.push(msg)
  }
  if (!preset.name.trim()) preset.name = '（未命名）'
  return { preset, errors }
}

/** 解析材料预设文件并与本机预设比对，生成导入预览行 */
export function parseMaterialFile(
  text: string,
  locals: MaterialPreset[],
  projectNamesByMaterial: (id: string) => string[],
): ParsedMaterialFile {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch (e) {
    return { ok: false, error: `文件不是合法 JSON：${(e as Error).message}` }
  }
  if (typeof data !== 'object' || data === null) return { ok: false, error: '文件内容不是材料预设文件（结构不匹配）' }
  const obj = data as Record<string, unknown>
  if (obj.kind !== MATERIAL_FILE_KIND) {
    return { ok: false, error: '文件类型不符：不是剪纸刻绘导出的材料预设文件' }
  }
  if (!Array.isArray(obj.presets) || obj.presets.length === 0) {
    return { ok: false, error: '文件里没有任何预设' }
  }

  const seenNames = new Set<string>()
  const rows: ImportRow[] = obj.presets.map((raw, index) => {
    const { preset, errors } = asPreset(raw, index)
    const nameKey = preset.name.trim()
    const localSameName = locals.find((m) => m.name.trim() === nameKey && nameKey !== '（未命名）') ?? null
    const dupInFile = seenNames.has(nameKey)
    seenNames.add(nameKey)
    const action: ImportAction = errors.length > 0 ? 'skip' : localSameName ? 'replace' : 'copy'
    return {
      index,
      preset,
      localSameName,
      localUsedBy: localSameName ? projectNamesByMaterial(localSameName.id) : [],
      dupInFile,
      errors,
      action,
    }
  })
  return {
    ok: true,
    rows,
    exportedAt: typeof obj.exportedAt === 'string' ? obj.exportedAt : null,
  }
}

/** 逐条求新增（copy）时的最终名字：文件内同名复制、或与本机同名时自动加序号 */
export function planFinalNames(rows: ImportRow[], localNames: string[]): Map<number, string> {
  const used = new Set(localNames.map((n) => n.trim()))
  const result = new Map<number, string>()
  for (const row of rows) {
    if (row.action !== 'copy') continue
    const name = uniqueName(row.preset.name.trim(), used)
    used.add(name)
    result.set(row.index, name)
  }
  return result
}

export function uniqueName(base: string, used: Set<string>): string {
  if (!used.has(base)) return base
  let n = 2
  while (used.has(`${base} ${n}`)) n += 1
  return `${base} ${n}`
}
