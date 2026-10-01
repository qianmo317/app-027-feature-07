import { reactive, watch } from 'vue'
import {
  DEFAULT_CUT_SETTINGS,
  DEFAULT_EXPORT_CFG,
  DEFAULT_SHEET,
  type BatchCfg,
  type ContourWarning,
  type CutSettings,
  type ExportCfg,
  type MaterialPreset,
  type Project,
  type Shape,
  type Sheet,
} from './types'
import { computeShape, shapeSignature, type ComputedShape } from './pipeline'
import { buildBatchShape, buildJob, type Job } from './job'
import { uid } from './geometry'
import { importSvgText, type ImportResult } from './importer'
import { defaultMaterials } from '@/data/materials'
import { validateMaterial, type ImportPlan, type MaterialErrors } from './material-io'

const LS_KEY = 'papercut-plotter-studio/v1'

type Persisted = {
  version: number
  projects: Project[]
  materials: MaterialPreset[]
}

type StoreState = {
  projects: Project[]
  materials: MaterialPreset[]
  ready: boolean
  lastError: string | null
  /** 从本地存储读出的越界 / 不完整预设（id → 字段问题），界面提示修订 */
  materialIssues: Record<string, MaterialErrors>
}

export const state = reactive<StoreState>({
  projects: [],
  materials: [],
  ready: false,
  lastError: null,
  materialIssues: {},
})

/** 派生计算结果缓存（按几何签名失效，不持久化） */
const computedCache = reactive<Record<string, ComputedShape>>({})
const batchCache = new Map<string, ComputedShape>()

function canUseStorage(): boolean {
  try {
    return typeof localStorage !== 'undefined'
  } catch {
    return false
  }
}

export function loadState(): void {
  state.materials = defaultMaterials()
  if (!canUseStorage()) {
    state.ready = true
    return
  }
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Persisted
      if (parsed && Array.isArray(parsed.projects)) {
        state.projects = parsed.projects.map(normalizeProject)
      }
      if (parsed && Array.isArray(parsed.materials) && parsed.materials.length > 0) {
        const loaded = parsed.materials.map((m) => ({ ...m, backing: m.backing ?? '常规垫板' }))
        state.materials = loaded
        state.materialIssues = detectMaterialIssues(loaded)
      }
    }
  } catch (e) {
    state.lastError = `本地数据读取失败：${(e as Error).message}`
  }
  state.ready = true
  recomputeAll()
}

/** 旧数据体检：只做区间校验（不查重名，避免互相报错），供界面标红提示修订 */
function detectMaterialIssues(materials: MaterialPreset[]): Record<string, MaterialErrors> {
  const issues: Record<string, MaterialErrors> = {}
  for (const m of materials) {
    const r = validateMaterial(m)
    if (Object.keys(r.errors).length > 0) issues[m.id] = r.errors
  }
  return issues
}

export function refreshMaterialIssues(): void {
  state.materialIssues = detectMaterialIssues(state.materials)
}

export function saveNow(): void {
  if (!canUseStorage()) return
  try {
    const data: Persisted = { version: 1, projects: state.projects, materials: state.materials }
    localStorage.setItem(LS_KEY, JSON.stringify(data))
  } catch (e) {
    state.lastError = `本地保存失败：${(e as Error).message}`
  }
}

let saveTimer: number | null = null
export function scheduleSave(): void {
  if (saveTimer !== null) return
  saveTimer = window.setTimeout(() => {
    saveTimer = null
    saveNow()
  }, 250)
}

function normalizeProject(p: Project): Project {
  return {
    ...p,
    settings: { ...DEFAULT_CUT_SETTINGS, ...(p.settings ?? {}) },
    export: { ...DEFAULT_EXPORT_CFG, ...(p.export ?? {}) },
    sheet: p.sheet ?? { ...DEFAULT_SHEET },
    shapes: (p.shapes ?? []).map((s) => ({
      ...s,
      contours: (s.contours ?? []).map((c) => ({ ...c, holes: c.holes ?? [], bridges: c.bridges ?? [], warnings: c.warnings ?? [] })),
    })),
    layerNames: p.layerNames ?? ['图层 1'],
  }
}

export function materialOf(p: Project): MaterialPreset | null {
  return state.materials.find((m) => m.id === p.materialId) ?? state.materials[0] ?? null
}

/** 重算派生数据（清理结果 → 连刀点 → 刀补 → 包含树 → 切割顺序） */
export function recomputeProject(p: Project, force = false): void {
  const material = materialOf(p)
  for (const shape of p.shapes) {
    const sig = shapeSignature(shape, p.settings, material)
    const cached = computedCache[shape.id]
    if (!force && cached && cached.signature === sig) continue
    const res = computeShape(shape, p.settings, material)
    applyComputed(shape, res)
    computedCache[shape.id] = res
  }
}

export function recomputeAll(force = false): void {
  for (const p of state.projects) recomputeProject(p, force)
}

/** 回写清理/派生警告（连刀点中只有手工放置的保存在数据模型里） */
function applyComputed(shape: Shape, res: ComputedShape): void {
  for (const c of shape.contours) {
    const base = c.warnings.filter(
      (w) => w === 'not_closed' || w === 'self_intersect' || w === 'duplicate' || w === 'too_short',
    ) as ContourWarning[]
    const extra = res.warningUpdates.get(c.id) ?? []
    c.warnings = [...base, ...extra.filter((w) => !base.includes(w))]
  }
}

export function computedOf(shapeId: string): ComputedShape | null {
  return computedCache[shapeId] ?? null
}

/** 排版任务：批量排版开启时只排所选纹样，否则排全部形状 */
export function jobOf(p: Project): { job: Job; shape: Shape | null; isBatch: boolean; computed: Map<string, ComputedShape> } {
  const material = materialOf(p)
  const start = { x: 0, y: 0 }
  const batch = p.batch
  if (batch && batch.enabled) {
    const src = p.shapes.find((s) => s.id === p.batchShapeId) ?? p.shapes[0]
    if (src) {
      const tiled = buildBatchShape(src, batch)
      const sig = `batch|${shapeSignature(src, p.settings, material)}|${batch.rows}|${batch.cols}|${batch.gapXMm}|${batch.gapYMm}|${batch.mode}`
      let comp = batchCache.get(sig)
      if (!comp) {
        comp = computeShape(tiled, p.settings, material, start)
        batchCache.set(sig, comp)
        if (batchCache.size > 24) {
          const firstKey = batchCache.keys().next().value
          if (firstKey !== undefined) batchCache.delete(firstKey)
        }
      }
      const map = new Map<string, ComputedShape>([[tiled.id, comp]])
      const job = buildJob([tiled], map, layerOrderOf(p), { sharedEdge: batch.sharedEdge, start })
      return { job, shape: tiled, isBatch: true, computed: map }
    }
  }
  recomputeProject(p)
  const map = new Map<string, ComputedShape>()
  for (const s of p.shapes) {
    const c = computedCache[s.id]
    if (c) map.set(s.id, c)
  }
  const job = buildJob(p.shapes, map, layerOrderOf(p), { sharedEdge: false, start })
  return { job, shape: null, isBatch: false, computed: map }
}

export function layerOrderOf(p: Project): number[] {
  const set = new Set(p.shapes.map((s) => s.layer))
  return Array.from(set).sort((a, b) => a - b)
}

// ---------------- 项目与形状操作 ----------------

function newProject(name: string, shapes: Shape[]): Project {
  const now = Date.now()
  return {
    id: uid('p'),
    name,
    createdAt: now,
    updatedAt: now,
    shapes,
    settings: { ...DEFAULT_CUT_SETTINGS },
    export: { ...DEFAULT_EXPORT_CFG },
    sheet: { ...DEFAULT_SHEET },
    materialId: state.materials[0]?.id ?? '',
    layerNames: ['图层 1'],
    batch: { enabled: false, rows: 2, cols: 2, gapXMm: 5, gapYMm: 5, sharedEdge: false, mode: 'repeat' },
  }
}

export function createProjectFromShapes(name: string, shapes: Shape[]): Project {
  const p = newProject(name, shapes)
  state.projects.unshift(p)
  recomputeProject(p, true)
  scheduleSave()
  return p
}

export function createBlankProject(name: string): Project {
  return createProjectFromShapes(name, [{ id: uid('s'), name: '新建形状', contours: [], layer: 0 }])
}

export function getProject(id: string): Project | undefined {
  return state.projects.find((p) => p.id === id)
}

export function deleteProject(id: string): void {
  const i = state.projects.findIndex((p) => p.id === id)
  if (i >= 0) {
    state.projects.splice(i, 1)
    scheduleSave()
  }
}

export function duplicateProject(id: string): Project | null {
  const src = getProject(id)
  if (!src) return null
  const copy: Project = JSON.parse(JSON.stringify(src))
  copy.id = uid('p')
  copy.name = `${src.name} 副本`
  copy.createdAt = Date.now()
  copy.updatedAt = Date.now()
  // 重新分配 id，避免缓存串用
  for (const s of copy.shapes) {
    s.id = uid('s')
    for (const c of s.contours) c.id = uid('c')
    for (const c of s.contours) {
      c.holes = []
      c.bridges = []
    }
  }
  state.projects.unshift(copy)
  recomputeProject(copy, true)
  scheduleSave()
  return copy
}

export function touch(p: Project): void {
  p.updatedAt = Date.now()
  scheduleSave()
}

export function addShape(p: Project, shape: Shape): void {
  p.shapes.push(shape)
  recomputeProject(p, true)
  touch(p)
}

export function removeShape(p: Project, shapeId: string): void {
  const i = p.shapes.findIndex((s) => s.id === shapeId)
  if (i >= 0) {
    p.shapes.splice(i, 1)
    delete computedCache[shapeId]
    touch(p)
  }
}

export function updateSettings(p: Project, patch: Partial<CutSettings>): void {
  Object.assign(p.settings, patch)
  recomputeProject(p, true)
  touch(p)
}

export function updateExport(p: Project, patch: Partial<ExportCfg>): void {
  Object.assign(p.export, patch)
  touch(p)
}

export function updateSheet(p: Project, sheet: Sheet): void {
  p.sheet = { ...sheet }
  touch(p)
}

export function updateBatch(p: Project, patch: Partial<BatchCfg>): void {
  if (!p.batch) p.batch = { enabled: false, rows: 2, cols: 2, gapXMm: 5, gapYMm: 5, sharedEdge: false, mode: 'repeat' }
  Object.assign(p.batch, patch)
  touch(p)
}

export function setMaterial(p: Project, materialId: string): void {
  p.materialId = materialId
  recomputeProject(p, true)
  touch(p)
}

/** 一键闭合所有未闭合轮廓 */
export function closeAllOpen(p: Project): number {
  let n = 0
  for (const shape of p.shapes) {
    for (const c of shape.contours) {
      if (!c.closed && c.points.length >= 3) {
        c.closed = true
        c.warnings = c.warnings.filter((w) => w !== 'not_closed')
        n += 1
      }
    }
  }
  if (n > 0) {
    recomputeProject(p, true)
    touch(p)
  }
  return n
}

export function closeContour(p: Project, contourId: string): boolean {
  for (const shape of p.shapes) {
    for (const c of shape.contours) {
      if (c.id === contourId && !c.closed && c.points.length >= 3) {
        c.closed = true
        c.warnings = c.warnings.filter((w) => w !== 'not_closed')
        recomputeProject(p, true)
        touch(p)
        return true
      }
    }
  }
  return false
}

export function removeContour(p: Project, contourId: string): void {
  for (const shape of p.shapes) {
    const i = shape.contours.findIndex((c) => c.id === contourId)
    if (i >= 0) {
      shape.contours.splice(i, 1)
      recomputeProject(p, true)
      touch(p)
      return
    }
  }
}

/** 手工放置连刀点：在指定轮廓上离 p 最近的顶点处 */
export function placeManualBridge(p: Project, contourId: string, atIndex: number): void {
  for (const shape of p.shapes) {
    for (const c of shape.contours) {
      if (c.id !== contourId) continue
      if (!c.bridges.some((b) => b.atIndex === atIndex)) {
        c.bridges.push({ atIndex, widthMm: p.settings.bridgeWidthMm })
      }
      recomputeProject(p, true)
      touch(p)
      return
    }
  }
}

export function clearManualBridges(p: Project, contourId?: string): void {
  for (const shape of p.shapes) {
    for (const c of shape.contours) {
      if (contourId && c.id !== contourId) continue
      c.bridges = []
    }
  }
  recomputeProject(p, true)
  touch(p)
}

/** 纹样对称生成：镜像 / 旋转 / 四方连续 */
export function applySymmetry(p: Project, shapeId: string, op: 'mirror_x' | 'mirror_y' | 'rotate_90' | 'rotate_180' | 'four_way'): void {
  const shape = p.shapes.find((s) => s.id === shapeId)
  if (!shape) return
  const all = shape.contours.flatMap((c) => c.points)
  if (all.length === 0) return
  const minX = Math.min(...all.map((q) => q.x))
  const maxX = Math.max(...all.map((q) => q.x))
  const minY = Math.min(...all.map((q) => q.y))
  const maxY = Math.max(...all.map((q) => q.y))

  const makeCopy = (fn: (x: number, y: number) => { x: number; y: number }): Shape => {
    const contours = shape.contours.map((c) => {
      const pts = c.points.map((q) => {
        const r = fn(q.x, q.y)
        return { x: Math.round(r.x * 1000) / 1000, y: Math.round(r.y * 1000) / 1000 }
      })
      return { ...c, id: uid('c'), points: pts, holes: [], bridges: [], warnings: [] }
    })
    return { id: uid('s'), name: `${shape.name} 对称`, contours, layer: shape.layer }
  }

  const cx = (minX + maxX) / 2
  const cy = (minY + maxY) / 2
  const ops: Array<(x: number, y: number) => { x: number; y: number }> = []
  if (op === 'mirror_x') ops.push((x, y) => ({ x: minX + maxX - x, y }))
  if (op === 'mirror_y') ops.push((x, y) => ({ x, y: minY + maxY - y }))
  if (op === 'rotate_90') ops.push((x, y) => ({ x: cx - (y - cy), y: cy + (x - cx) }))
  if (op === 'rotate_180') ops.push((x, y) => ({ x: 2 * cx - x, y: 2 * cy - y }))
  if (op === 'four_way') {
    ops.push((x, y) => ({ x: minX + maxX - x, y }))
    ops.push((x, y) => ({ x, y: minY + maxY - y }))
    ops.push((x, y) => ({ x: minX + maxX - x, y: minY + maxY - y }))
  }
  for (const fn of ops) p.shapes.push(makeCopy(fn))
  recomputeProject(p, true)
  touch(p)
}

// ---------------- 材料预设 ----------------

export function upsertMaterial(m: MaterialPreset): void {
  const i = state.materials.findIndex((x) => x.id === m.id)
  if (i >= 0) state.materials[i] = { ...m }
  else state.materials.push({ ...m })
  delete state.materialIssues[m.id]
  scheduleSave()
}

/** 正在使用某条预设的项目（删除 / 覆盖 / 应用到全部前的影响范围提示） */
export function projectsUsingMaterial(materialId: string): Project[] {
  return state.projects.filter((p) => p.materialId === materialId)
}

/**
 * 删除材料预设。
 * 使用该预设的项目会切换到 fallbackId（默认保留列表里的第一条），并返回受影响的项目。
 */
export function deleteMaterial(id: string, fallbackId?: string): Project[] {
  const i = state.materials.findIndex((x) => x.id === id)
  if (i < 0 || state.materials.length <= 1) return []
  const rest = state.materials.filter((m) => m.id !== id)
  const fallback = rest.find((m) => m.id === fallbackId) ?? rest[0]
  const affected: Project[] = []
  state.materials.splice(i, 1)
  for (const p of state.projects) {
    if (p.materialId === id) {
      p.materialId = fallback.id
      affected.push(p)
      recomputeProject(p, true)
    }
  }
  delete state.materialIssues[id]
  scheduleSave()
  return affected
}

// ---------------- 应用到全部项目（可撤销） ----------------

export type ApplyAllSnapshot = {
  materialId: string
  /** 应用前每个项目的材料选择 */
  prev: Array<{ projectId: string; materialId: string }>
  changed: Project[]
}

/** 把某条预设应用到全部项目，返回快照用于撤销；没有项目返回 null */
export function applyMaterialToAll(materialId: string): ApplyAllSnapshot | null {
  if (!state.materials.some((m) => m.id === materialId) || state.projects.length === 0) return null
  const snapshot: ApplyAllSnapshot = {
    materialId,
    prev: state.projects.map((p) => ({ projectId: p.id, materialId: p.materialId })),
    changed: [],
  }
  for (const p of state.projects) {
    if (p.materialId !== materialId) {
      p.materialId = materialId
      snapshot.changed.push(p)
      recomputeProject(p, true)
    }
  }
  scheduleSave()
  return snapshot
}

/** 撤销应用到全部：按快照恢复各项目原来的材料选择 */
export function undoApplyMaterialToAll(snapshot: ApplyAllSnapshot): void {
  for (const entry of snapshot.prev) {
    const p = state.projects.find((x) => x.id === entry.projectId)
    if (p && state.materials.some((m) => m.id === entry.materialId)) {
      if (p.materialId !== entry.materialId) recomputeProject(p, true)
      p.materialId = entry.materialId
    }
  }
  scheduleSave()
}

export type ImportMaterialsResult = {
  addCount: number
  renameCount: number
  overwriteCount: number
  affectedProjects: Project[]
}

/** 执行导入计划：新增 / 另存为新增、覆盖时保留本机 id 并对引用项目重算刀路 */
export function importMaterials(plan: ImportPlan): ImportMaterialsResult {
  const affectedIds = new Set<string>()
  for (const op of plan.ops) {
    if (op.kind === 'overwrite') {
      const i = state.materials.findIndex((m) => m.id === op.localId)
      if (i >= 0) state.materials[i] = { ...op.preset }
      for (const p of state.projects) {
        if (p.materialId === op.localId) {
          affectedIds.add(p.id)
          recomputeProject(p, true)
        }
      }
      delete state.materialIssues[op.localId]
    } else {
      state.materials.push({ ...op.preset })
    }
  }
  refreshMaterialIssues()
  scheduleSave()
  return {
    addCount: plan.addCount,
    renameCount: plan.renameCount,
    overwriteCount: plan.overwriteCount,
    affectedProjects: state.projects.filter((p) => affectedIds.has(p.id)),
  }
}

// ---------------- 导入 ----------------

export function importSvgToShapes(
  text: string,
  name: string,
  settings: CutSettings,
): { result: ImportResult; shape: Shape } {
  const result = importSvgText(text, { toleranceMm: settings.toleranceMm, closeToleranceMm: settings.closeToleranceMm })
  const shape: Shape = { id: uid('s'), name, contours: result.contours, layer: 0 }
  return { result, shape }
}

export function addImportedShapes(p: Project, shapes: Shape[]): void {
  for (const s of shapes) p.shapes.push(s)
  recomputeProject(p, true)
  touch(p)
}

watch(
  () => [state.projects, state.materials],
  () => {
    if (state.ready) scheduleSave()
  },
  { deep: true },
)

export const store = {
  state,
  loadState,
  saveNow,
  scheduleSave,
  materialOf,
  getProject,
  computedOf,
  jobOf,
  layerOrderOf,
  createProjectFromShapes,
  createBlankProject,
  deleteProject,
  duplicateProject,
  addShape,
  addImportedShapes,
  removeShape,
  updateSettings,
  updateExport,
  updateSheet,
  updateBatch,
  setMaterial,
  closeAllOpen,
  closeContour,
  removeContour,
  placeManualBridge,
  clearManualBridges,
  applySymmetry,
  upsertMaterial,
  deleteMaterial,
  projectsUsingMaterial,
  applyMaterialToAll,
  undoApplyMaterialToAll,
  importMaterials,
  refreshMaterialIssues,
  recomputeProject,
  recomputeAll,
  importSvgToShapes,
  touch,
}