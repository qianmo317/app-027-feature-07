<script setup lang="ts">
import { computed, ref } from 'vue'
import { store, state } from '@/logic/store'
import { PAPER_KINDS, type MaterialPreset, type Project } from '@/logic/types'
import { uid } from '@/logic/geometry'
import { downloadText, sanitizeFilename } from '@/logic/download'
import {
  NAME_MAX,
  NUM_LIMITS,
  rangeText,
  validateMaterial,
  serializeMaterials,
  parseMaterialFile,
  analyzeImport,
  buildImportPlan,
  entryParamsSummary,
  type ConflictAction,
  type ImportEntry,
  type MaterialErrors,
  type MaterialField,
  type ValidationResult,
} from '@/logic/material-io'

const editing = ref<MaterialPreset | null>(null)
const isNew = ref(false)
const notice = ref('')
const noticeKind = ref<'ok' | 'err'>('ok')
const printTarget = ref<MaterialPreset | null>(null)

const materials = computed(() => state.materials)

const projectsByMaterial = computed(() => {
  const map = new Map<string, Project[]>()
  for (const p of state.projects) {
    const arr = map.get(p.materialId) ?? []
    arr.push(p)
    map.set(p.materialId, arr)
  }
  return map
})

function usedProjectsOf(m: MaterialPreset): Project[] {
  return projectsByMaterial.value.get(m.id) ?? []
}

function paperNote(paper: string): string {
  return PAPER_KINDS.find((p) => p.paper === paper)?.note ?? ''
}

function paperLabel(paper: string): string {
  return PAPER_KINDS.find((p) => p.paper === paper)?.label ?? paper
}

// ---------------- 新建 / 编辑（行内校验） ----------------

function startNew(): void {
  isNew.value = true
  notice.value = ''
  editing.value = {
    id: uid('mat'),
    name: '新材料',
    paper: 'cardstock',
    force: 120,
    speedMmS: 40,
    passes: 1,
    bladeOffsetMm: 0.25,
    backing: '蓝色中硬垫板',
  }
}

function startEdit(m: MaterialPreset): void {
  isNew.value = false
  notice.value = ''
  editing.value = { ...m }
}

function onPaperChange(paper: string): void {
  const k = PAPER_KINDS.find((p) => p.paper === paper)
  if (!editing.value) return
  editing.value.paper = paper
  if (k) {
    editing.value.force = k.force
    editing.value.speedMmS = k.speedMmS
    editing.value.passes = k.passes
    editing.value.backing = k.backing
  }
}

const editValidation = computed<ValidationResult>(() => {
  if (!editing.value) return { errors: {}, warnings: {} }
  return validateMaterial(editing.value, {
    selfId: editing.value.id,
    materials: state.materials,
  })
})

function editErr(field: MaterialField): string {
  return editValidation.value.errors[field] ?? ''
}

function save(): void {
  if (!editing.value) return
  const result = editValidation.value
  if (Object.keys(result.errors).length > 0) return
  const m = editing.value
  const usedCount = usedProjectsOf(m).length
  store.upsertMaterial(m)
  noticeKind.value = 'ok'
  notice.value =
    `已保存预设「${m.name}」` +
    (!isNew.value && usedCount > 0 ? `，${usedCount} 个使用该预设的项目将按新参数重算刀路` : '')
  editing.value = null
  isNew.value = false
}

// ---------------- 删除（先说清影响） ----------------

const deleteTarget = ref<MaterialPreset | null>(null)
const deleteFallbackId = ref('')

const deleteUsedProjects = computed(() => (deleteTarget.value ? usedProjectsOf(deleteTarget.value) : []))
const deleteCandidates = computed(() =>
  state.materials.filter((m) => m.id !== deleteTarget.value?.id),
)
const deleteFallback = computed(
  () => state.materials.find((m) => m.id === deleteFallbackId.value) ?? deleteCandidates.value[0] ?? null,
)

function startRemove(m: MaterialPreset): void {
  if (state.materials.length <= 1) {
    noticeKind.value = 'err'
    notice.value = '至少保留一个材料预设'
    return
  }
  deleteTarget.value = m
  deleteFallbackId.value = state.materials.find((x) => x.id !== m.id)?.id ?? ''
}

function confirmDelete(): void {
  const m = deleteTarget.value
  if (!m) return
  const affected = store.deleteMaterial(m.id, deleteFallbackId.value)
  if (editing.value?.id === m.id) editing.value = null
  noticeKind.value = 'ok'
  notice.value =
    affected.length > 0
      ? `已删除「${m.name}」，${affected.length} 个项目（${affected.map((p) => p.name).join('、')}）已改用「${deleteFallback.value?.name}」`
      : `已删除「${m.name}」（没有项目使用它）`
  deleteTarget.value = null
}

// ---------------- 应用到全部项目（先预览、可撤销） ----------------

const applyTarget = ref<MaterialPreset | null>(null)

const applyPreview = computed(() => {
  if (!applyTarget.value) return { willChange: [] as Project[], unchanged: [] as Project[] }
  const willChange: Project[] = []
  const unchanged: Project[] = []
  for (const p of state.projects) {
    if (p.materialId === applyTarget.value.id) unchanged.push(p)
    else willChange.push(p)
  }
  return { willChange, unchanged }
})

type ApplyUndo = {
  snapshot: NonNullable<ReturnType<typeof store.applyMaterialToAll>>
  name: string
  changedCount: number
}
const lastApply = ref<ApplyUndo | null>(null)

function startApplyToAll(m: MaterialPreset): void {
  if (state.projects.length === 0) {
    noticeKind.value = 'err'
    notice.value = '当前还没有项目，无需应用'
    return
  }
  applyTarget.value = m
}

function confirmApply(): void {
  const m = applyTarget.value
  if (!m) return
  const snapshot = store.applyMaterialToAll(m.id)
  if (snapshot) {
    lastApply.value = { snapshot, name: m.name, changedCount: snapshot.changed.length }
    noticeKind.value = 'ok'
    notice.value = `已把「${m.name}」应用到全部 ${state.projects.length} 个项目`
  }
  applyTarget.value = null
}

function undoApply(): void {
  const u = lastApply.value
  if (!u) return
  store.undoApplyMaterialToAll(u.snapshot)
  noticeKind.value = 'ok'
  notice.value = `已撤销，${u.changedCount} 个项目恢复为各自原来的材料选择`
  lastApply.value = null
}

// ---------------- 导出 ----------------

function exportAll(): void {
  const stamp = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const date = `${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}`
  const filename = sanitizeFilename(`材料预设_${date}_${state.materials.length}条.json`)
  downloadText(filename, serializeMaterials(state.materials), 'application/json;charset=utf-8')
  noticeKind.value = 'ok'
  notice.value = `已导出 ${state.materials.length} 条材料预设到「${filename}」，可把该文件发给同事或拷到另一台电脑导入`
}

// ---------------- 导入 ----------------

const fileInput = ref<HTMLInputElement | null>(null)
const importModal = ref<{ entries: ImportEntry[]; exportedAt?: string; sourceName: string } | null>(null)

function triggerImport(): void {
  fileInput.value?.click()
}

async function onImportFile(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  let text: string
  try {
    text = await file.text()
  } catch {
    noticeKind.value = 'err'
    notice.value = '读取文件失败，请重试'
    return
  }
  const parsed = parseMaterialFile(text)
  if (!parsed.ok) {
    noticeKind.value = 'err'
    notice.value = `导入失败：${parsed.error}`
    return
  }
  const entries = analyzeImport(parsed.items, state.materials)
  importModal.value = { entries, exportedAt: parsed.exportedAt, sourceName: file.name }
}

const importPlan = computed(() =>
  importModal.value ? buildImportPlan(importModal.value.entries, state.materials) : null,
)

const importAffectedProjects = computed(() => {
  if (!importPlan.value) return []
  const ids = new Set(importPlan.value.overwriteLocalIds)
  return state.projects.filter((p) => ids.has(p.materialId))
})

function setAction(entry: ImportEntry, action: string): void {
  entry.action = action as ConflictAction
}

function statusText(entry: ImportEntry): { label: string; cls: string } {
  if (Object.keys(entry.result.errors).length > 0) return { label: '数据无效', cls: 'err' }
  if (entry.status === 'conflict') return { label: '本机同名', cls: 'warn' }
  if (entry.status === 'duplicate') return { label: '文件内重名', cls: 'warn' }
  return { label: '新预设', cls: 'ok' }
}

function entryLocal(entry: ImportEntry): MaterialPreset | null {
  return state.materials.find((m) => m.id === entry.localId) ?? null
}

function diffsFor(entry: ImportEntry) {
  const op = importPlan.value?.ops.find((o) => o.kind === 'overwrite' && o.localId === entry.localId)
  return op && op.kind === 'overwrite' ? op.diffs : []
}

const entryFieldErrors = (entry: ImportEntry): MaterialErrors => entry.result.errors
const entryFieldWarnings = (entry: ImportEntry): MaterialErrors => entry.result.warnings

function confirmImport(): void {
  const plan = importPlan.value
  const modal = importModal.value
  if (!plan || !modal) return
  const res = store.importMaterials(plan)
  const parts: string[] = []
  if (res.addCount) parts.push(`新增 ${res.addCount} 条`)
  if (res.renameCount) parts.push(`另存为新增 ${res.renameCount} 条`)
  if (res.overwriteCount) parts.push(`覆盖 ${res.overwriteCount} 条`)
  if (plan.skipCount) parts.push(`跳过 ${plan.skipCount} 条`)
  noticeKind.value = 'ok'
  notice.value =
    `导入完成：${parts.join('、')}` +
    (res.affectedProjects.length
      ? `；覆盖影响 ${res.affectedProjects.length} 个项目（${res.affectedProjects.map((p) => p.name).join('、')}），刀路已按新参数重算`
      : '')
  importModal.value = null
}

function closeImport(): void {
  importModal.value = null
}

// ---------------- 旧数据体检提示 ----------------

const issueIds = computed(() =>
  state.materials.filter((m) => state.materialIssues[m.id]).map((m) => m.id),
)

function issueText(id: string): string {
  return Object.values(state.materialIssues[id] ?? {}).join('；')
}

// ---------------- 打印 ----------------

function print(m: MaterialPreset): void {
  printTarget.value = m
  requestAnimationFrame(() => window.print())
}

const printLines = computed(() => {
  const m = printTarget.value
  if (!m) return []
  const speed = Math.max(1, m.speedMmS)
  return [
    ['材料预设', m.name],
    ['纸张类型', `${paperLabel(m.paper)}（${m.paper}）`],
    ['刀压 force', String(m.force)],
    ['速度 speed', `${m.speedMmS} mm/s`],
    ['重复次数 passes', String(m.passes)],
    ['垫板', m.backing],
    ['刀补 blade offset', `${m.bladeOffsetMm} mm`],
    ['建议连刀点宽', '0.3 ~ 0.8 mm'],
    ['每 100mm 刀路耗时', `${((100 / speed) * m.passes).toFixed(1)} s`],
    ['备注', paperNote(m.paper)],
  ]
})

function formatExportedAt(iso?: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
</script>

<template>
  <div class="page">
    <div class="page narrow">
      <h1>材料预设库</h1>
      <p class="hint">
        每个预设包含纸张类型、刀压、速度、重复次数、垫板与刀补偏置。预设可导出为文件发给同事、在另一台电脑导入；材料参数卡可
        1:1 打印贴在机器旁。
      </p>

      <div v-if="notice" class="banner" :class="noticeKind">{{ notice }}</div>

      <div v-if="lastApply" class="banner undo">
        <span>「{{ lastApply.name }}」已应用到全部项目，{{ lastApply.changedCount }} 个项目的原选择被改变。</span>
        <button class="tiny primary" @click="undoApply">撤销这次应用</button>
      </div>

      <div v-if="issueIds.length" class="banner err">
        检测到 {{ issueIds.length }} 条历史预设的数值超出合理区间（保存时没有卡校验的旧数据）：
        请逐条编辑修正后保存，否则刀路计算仍按这些数值进行。
      </div>

      <div class="btn-row page-actions">
        <button class="primary" @click="startNew">＋ 新建材料预设</button>
        <button @click="exportAll">导出全部（{{ materials.length }} 条）为文件</button>
        <button @click="triggerImport">从文件导入</button>
        <input
          ref="fileInput"
          type="file"
          accept=".json,application/json"
          style="display: none"
          @change="onImportFile"
        />
      </div>

      <div class="card-grid">
        <div v-for="m in materials" :key="m.id" class="card mat-card" :class="{ active: editing?.id === m.id }">
          <div class="mat-head">
            <strong>{{ m.name }}</strong>
            <span v-if="usedProjectsOf(m).length" class="tag accent">{{ usedProjectsOf(m).length }} 个项目在用</span>
            <span v-else class="tag">未被使用</span>
          </div>
          <table class="grid">
            <tbody>
              <tr><th>纸张</th><td>{{ paperLabel(m.paper) }}</td></tr>
              <tr><th>刀压</th><td class="num">{{ m.force }}</td></tr>
              <tr><th>速度</th><td class="num">{{ m.speedMmS }} mm/s</td></tr>
              <tr><th>重复</th><td class="num">{{ m.passes }} 次</td></tr>
              <tr><th>垫板</th><td>{{ m.backing }}</td></tr>
              <tr><th>刀补</th><td class="num">{{ m.bladeOffsetMm }} mm</td></tr>
            </tbody>
          </table>
          <div v-if="state.materialIssues[m.id]" class="issue-line">⚠ {{ issueText(m.id) }}</div>
          <div class="used-line">
            <template v-if="usedProjectsOf(m).length">
              使用中：{{ usedProjectsOf(m).map((p) => p.name).join('、') }}
            </template>
            <template v-else>当前没有项目使用</template>
          </div>
          <div class="hint">{{ paperNote(m.paper) }}</div>
          <div class="btn-row">
            <button class="tiny" @click="startEdit(m)">编辑</button>
            <button class="tiny" @click="print(m)">打印工艺卡</button>
            <button class="tiny" @click="startApplyToAll(m)">应用到全部项目</button>
            <button class="tiny danger" @click="startRemove(m)">删除</button>
          </div>
        </div>
      </div>

      <div v-if="editing" class="card edit-card">
        <h3>{{ isNew ? '新建材料预设' : '编辑材料预设' }}</h3>
        <div class="edit-grid">
          <div class="field">
            <label>预设名称（{{ editing.name.trim().length }}/{{ NAME_MAX }}）</label>
            <input
              type="text"
              :maxlength="NAME_MAX"
              v-model="editing.name"
              :class="{ bad: editErr('name') }"
            />
            <div v-if="editErr('name')" class="field-err">{{ editErr('name') }}</div>
          </div>
          <div class="field">
            <label>纸张类型</label>
            <select
              :value="editing.paper"
              :class="{ bad: editErr('paper') }"
              @change="onPaperChange(($event.target as HTMLSelectElement).value)"
            >
              <option v-for="k in PAPER_KINDS" :key="k.paper" :value="k.paper">{{ k.label }}</option>
            </select>
            <div v-if="editErr('paper')" class="field-err">{{ editErr('paper') }}</div>
            <div v-else-if="editValidation.warnings.paper" class="field-warn">{{ editValidation.warnings.paper }}</div>
          </div>
          <div class="field" v-for="lim in NUM_LIMITS" :key="lim.key">
            <label>{{ lim.label }}（允许 {{ rangeText(lim) }}）</label>
            <input
              type="number"
              :min="lim.min"
              :max="lim.max"
              :step="lim.key === 'bladeOffsetMm' ? 0.05 : 1"
              v-model.number="editing[lim.key]"
              :class="{ bad: editErr(lim.key) }"
            />
            <div v-if="editErr(lim.key)" class="field-err">{{ editErr(lim.key) }}</div>
          </div>
          <div class="field">
            <label>垫板</label>
            <input type="text" v-model="editing.backing" />
          </div>
        </div>
        <div class="hint">{{ paperNote(editing.paper) }}</div>
        <div v-if="!isNew && usedProjectsOf(editing).length" class="impact-hint">
          改动保存后，{{ usedProjectsOf(editing).length }} 个使用该预设的项目（{{
            usedProjectsOf(editing).map((p) => p.name).join('、')
          }}）会按新参数重算刀路。
        </div>
        <div class="btn-row" style="margin-top: 8px">
          <button class="primary" :disabled="Object.keys(editValidation.errors).length > 0" @click="save">保存</button>
          <button @click="editing = null">取消</button>
        </div>
      </div>
    </div>

    <!-- 删除确认：影响哪些项目、替补预设 -->
    <div v-if="deleteTarget" class="modal-mask" @click.self="deleteTarget = null">
      <div class="modal">
        <h3>删除材料预设</h3>
        <p>
          确定删除「<strong>{{ deleteTarget.name }}</strong>」？此操作不可撤销，但项目本身不会被删，只会改用下面选择的预设。
        </p>
        <div v-if="deleteUsedProjects.length" class="modal-section">
          <div class="modal-section-title">
            <span class="tag err">{{ deleteUsedProjects.length }} 个项目正在使用它，删除后将被改动：</span>
          </div>
          <ul class="impact-list">
            <li v-for="p in deleteUsedProjects" :key="p.id">
              {{ p.name }}：<s>{{ deleteTarget.name }}</s> → <strong>{{ deleteFallback?.name }}</strong>
            </li>
          </ul>
        </div>
        <div v-else class="modal-section">
          <span class="tag ok">没有项目使用这条预设，删除不影响任何项目。</span>
        </div>
        <div v-if="deleteUsedProjects.length" class="field" style="margin-top: 8px">
          <label>这些项目删除后改用</label>
          <select v-model="deleteFallbackId">
            <option v-for="m in deleteCandidates" :key="m.id" :value="m.id">{{ m.name }}</option>
          </select>
        </div>
        <div class="modal-actions">
          <button class="danger" @click="confirmDelete">确认删除</button>
          <button @click="deleteTarget = null">取消</button>
        </div>
      </div>
    </div>

    <!-- 应用到全部：先列出会改动哪些项目 -->
    <div v-if="applyTarget" class="modal-mask" @click.self="applyTarget = null">
      <div class="modal">
        <h3>应用到全部项目</h3>
        <p>
          将把「<strong>{{ applyTarget.name }}</strong>」应用到全部 {{ state.projects.length }} 个项目。应用后可以立刻撤销。
        </p>
        <div class="modal-section">
          <div class="modal-section-title">
            <span class="tag warn">{{ applyPreview.willChange.length }} 个项目的当前选择会被盖掉：</span>
          </div>
          <ul v-if="applyPreview.willChange.length" class="impact-list">
            <li v-for="p in applyPreview.willChange" :key="p.id">
              {{ p.name }}：<s>{{ state.materials.find((m) => m.id === p.materialId)?.name ?? '（预设缺失）' }}</s>
              → <strong>{{ applyTarget.name }}</strong>
            </li>
          </ul>
        </div>
        <div v-if="applyPreview.unchanged.length" class="modal-section">
          <div class="modal-section-title">
            <span class="tag ok">{{ applyPreview.unchanged.length }} 个项目已经在用它，不受影响：</span>
          </div>
          <div class="impact-flat">{{ applyPreview.unchanged.map((p) => p.name).join('、') }}</div>
        </div>
        <div class="modal-actions">
          <button class="primary" @click="confirmApply">应用到全部</button>
          <button @click="applyTarget = null">取消</button>
        </div>
      </div>
    </div>

    <!-- 导入预检：列出文件内容、同名处理、改动差异 -->
    <div v-if="importModal && importPlan" class="modal-mask wide" @click.self="closeImport">
      <div class="modal wide">
        <h3>导入材料预设</h3>
        <p class="hint">
          来自文件「{{ importModal.sourceName }}」<template v-if="formatExportedAt(importModal.exportedAt)">
            （导出于 {{ formatExportedAt(importModal.exportedAt) }}）</template
          >，共 {{ importModal.entries.length }} 条。逐条确认处理方式后再点导入。
        </p>

        <div class="import-list">
          <div v-for="entry in importModal.entries" :key="entry.key" class="import-entry">
            <div class="import-entry-head">
              <span class="import-name">{{ entry.preset.name || '（未命名）' }}</span>
              <span class="tag" :class="statusText(entry).cls">{{ statusText(entry).label }}</span>
              <span class="import-params">{{ entryParamsSummary(entry) }}</span>
              <span class="grow"></span>
              <select
                v-if="!Object.keys(entryFieldErrors(entry)).length && entry.status !== 'new'"
                :value="entry.action"
                class="import-action"
                @change="setAction(entry, ($event.target as HTMLSelectElement).value)"
              >
                <option v-if="entry.status === 'conflict'" value="overwrite">覆盖本机同名</option>
                <option value="rename">另存为新预设</option>
                <option value="skip">跳过，不导入</option>
              </select>
              <span v-else-if="!Object.keys(entryFieldErrors(entry)).length" class="tag info">将新增到本机</span>
            </div>

            <div v-for="(msg, f) in entryFieldErrors(entry)" :key="f" class="field-err">
              ✗ {{ msg }}（本条只能跳过）
            </div>
            <div v-for="(msg, f) in entryFieldWarnings(entry)" :key="'w' + f" class="field-warn">⚠ {{ msg }}</div>

            <div v-if="entry.action === 'rename'" class="rename-row">
              <label>另存为名称</label>
              <input type="text" :maxlength="NAME_MAX" v-model="entry.renameTo" />
            </div>

            <div v-if="entry.action === 'overwrite' && entryLocal(entry)">
              <div v-if="diffsFor(entry).length === 0" class="field-ok">
                内容完全一致，覆盖不会改动任何参数。
              </div>
              <table v-else class="diff-table">
                <tbody>
                  <tr v-for="d in diffsFor(entry)" :key="d.field + d.label">
                    <th>{{ d.label }}</th>
                    <td class="from">{{ d.from }}</td>
                    <td class="arrow">→</td>
                    <td class="to">{{ d.to }}</td>
                  </tr>
                </tbody>
              </table>
              <div v-if="usedProjectsOf(entryLocal(entry)!).length" class="impact-flat warn-flat">
                覆盖后会影响 {{ usedProjectsOf(entryLocal(entry)!).length }} 个项目：{{
                  usedProjectsOf(entryLocal(entry)!).map((p) => p.name).join('、')
                }}
              </div>
            </div>
            <div v-if="entry.skipReason" class="field-err">将跳过：{{ entry.skipReason }}</div>
          </div>
        </div>

        <div class="import-summary">
          <span class="tag ok">新增 {{ importPlan.addCount }}</span>
          <span class="tag info">另存 {{ importPlan.renameCount }}</span>
          <span class="tag warn">覆盖 {{ importPlan.overwriteCount }}</span>
          <span class="tag">跳过 {{ importPlan.skipCount }}</span>
          <span v-if="importAffectedProjects.length" class="tag err">
            覆盖影响 {{ importAffectedProjects.length }} 个项目：{{ importAffectedProjects.map((p) => p.name).join('、') }}
          </span>
        </div>

        <div class="modal-actions">
          <button
            class="primary"
            :disabled="importPlan.addCount + importPlan.renameCount + importPlan.overwriteCount === 0"
            @click="confirmImport"
          >
            确认导入
          </button>
          <button @click="closeImport">取消</button>
        </div>
      </div>
    </div>

    <div class="print-area">
      <div class="sheet">
        <div class="card-sheet">
          <h1>剪纸刻绘 · 材料参数卡</h1>
          <div class="card-sub">Paper-cut Plotter Studio｜1:1 打印（请选择「实际大小 / 100%」）</div>
          <table>
            <tbody>
              <tr v-for="row in printLines" :key="row[0]">
                <th>{{ row[0] }}</th>
                <td>{{ row[1] }}</td>
              </tr>
            </tbody>
          </table>
          <div class="card-note">
            上机顺序：装刀 → 调刀压 → 试切边角料 → 确认切穿不伤垫板 → 正式切割。切不透加刀压或加一遍；切穿垫板则减刀压。
          </div>
          <div class="ruler">
            <div class="ruler-line"></div>
            <div class="ruler-labels">
              <span>0</span><span>50</span><span>100 mm</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.page-actions {
  margin: 10px 0;
}

.banner {
  background: rgba(71, 192, 122, 0.12);
  border: 1px solid rgba(71, 192, 122, 0.35);
  color: #9fe0b8;
  padding: 7px 10px;
  border-radius: 6px;
  font-size: 12.5px;
  margin-bottom: 8px;
}

.banner.err {
  background: rgba(255, 107, 107, 0.1);
  border-color: rgba(255, 107, 107, 0.4);
  color: #ff9b9b;
}

.banner.undo {
  display: flex;
  align-items: center;
  gap: 10px;
  justify-content: space-between;
  background: rgba(255, 200, 87, 0.1);
  border-color: rgba(255, 200, 87, 0.4);
  color: var(--warn);
}

.mat-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.mat-card.active {
  border-color: var(--accent);
}

.mat-head {
  display: flex;
  align-items: center;
  gap: 6px;
  justify-content: space-between;
}

.mat-head strong {
  font-size: 13px;
}

.mat-card table.grid th {
  width: 52px;
  border: 0;
  padding: 1px 0;
}

.mat-card table.grid td {
  border: 0;
  padding: 1px 0;
}

.used-line {
  font-size: 11px;
  color: var(--text-dim);
  background: var(--panel-2);
  border-radius: 4px;
  padding: 4px 6px;
}

.issue-line {
  font-size: 11px;
  color: var(--err);
  background: rgba(255, 107, 107, 0.08);
  border: 1px solid rgba(255, 107, 107, 0.3);
  border-radius: 4px;
  padding: 3px 6px;
}

.edit-card {
  margin-top: 14px;
}

.edit-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
  gap: 8px;
}

input.bad,
select.bad {
  border-color: var(--err);
}

.field-err {
  font-size: 11px;
  color: var(--err);
  margin-top: 3px;
  line-height: 1.4;
}

.field-warn {
  font-size: 11px;
  color: var(--warn);
  margin-top: 3px;
  line-height: 1.4;
}

.field-ok {
  font-size: 11px;
  color: var(--ok);
  margin-top: 3px;
}

.impact-hint {
  font-size: 11.5px;
  color: var(--warn);
  margin-top: 6px;
}

/* ---------- 模态框 ---------- */
.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(8, 11, 14, 0.66);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 50;
  padding: 20px;
}

.modal {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 16px;
  width: min(520px, 100%);
  max-height: 86vh;
  overflow: auto;
}

.modal.wide {
  width: min(760px, 100%);
}

.modal-section {
  margin-top: 8px;
}

.modal-section-title {
  margin-bottom: 5px;
}

.impact-list {
  margin: 4px 0 0;
  padding-left: 18px;
  font-size: 12.5px;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.impact-list s {
  color: var(--text-mute);
}

.impact-flat {
  font-size: 12px;
  color: var(--text-dim);
}

.warn-flat {
  color: var(--warn);
  margin-top: 4px;
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 14px;
}

/* ---------- 导入预检 ---------- */
.import-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 10px;
}

.import-entry {
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 8px 10px;
  background: var(--panel-2);
}

.import-entry-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.import-name {
  font-weight: 600;
  font-size: 13px;
}

.import-params {
  font-size: 11px;
  color: var(--text-mute);
  font-family: var(--mono);
}

.grow {
  flex: 1 1 auto;
}

.import-action {
  width: auto;
}

.rename-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
}

.rename-row label {
  font-size: 11.5px;
  color: var(--text-dim);
  flex: 0 0 auto;
}

.rename-row input {
  flex: 1 1 auto;
}

.diff-table {
  width: 100%;
  margin-top: 6px;
  font-size: 11.5px;
  border-collapse: collapse;
}

.diff-table th {
  text-align: left;
  color: var(--text-mute);
  font-weight: 500;
  width: 86px;
  padding: 2px 6px 2px 0;
}

.diff-table td {
  padding: 2px 6px;
}

.diff-table td.from {
  color: var(--text-mute);
  font-family: var(--mono);
}

.diff-table td.arrow {
  color: var(--text-dim);
  width: 20px;
}

.diff-table td.to {
  color: var(--accent-2);
  font-family: var(--mono);
}

.import-summary {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 12px;
  align-items: center;
}

/* ---------- 打印 ---------- */
.card-sheet {
  width: 150mm;
  margin: 12mm auto;
  border: 1px solid #000;
  padding: 8mm;
  color: #111;
  background: #fff;
  font-family: sans-serif;
}

.card-sheet h1 {
  font-size: 16pt;
  margin: 0 0 2mm;
}

.card-sub {
  font-size: 9pt;
  color: #444;
  margin-bottom: 5mm;
}

.card-sheet table {
  width: 100%;
  border-collapse: collapse;
  font-size: 10pt;
}

.card-sheet th,
.card-sheet td {
  border: 1px solid #666;
  padding: 1.6mm 2mm;
  text-align: left;
}

.card-sheet th {
  width: 45mm;
  background: #f0f0f0;
}

.card-note {
  margin-top: 5mm;
  font-size: 9pt;
  color: #333;
}

.ruler {
  margin-top: 8mm;
}

.ruler-line {
  width: 100mm;
  height: 0;
  border-top: 0.3mm solid #000;
}

.ruler-labels {
  display: flex;
  justify-content: space-between;
  font-size: 8pt;
  margin-top: 1mm;
  width: 100mm;
}

@media print {
  .modal-mask {
    display: none !important;
  }
}
</style>
