<script setup lang="ts">
import { computed, ref } from 'vue'
import { store, state } from '@/logic/store'
import { PAPER_KINDS, type MaterialPreset } from '@/logic/types'
import { uid } from '@/logic/geometry'
import { downloadText } from '@/logic/download'
import {
  MATERIAL_LIMITS,
  materialsFilename,
  parseMaterialFile,
  planFinalNames,
  rangeText,
  serializeMaterials,
  validateMaterial,
  type ImportAction,
  type ImportRow,
} from '@/logic/materialTransfer'

const editing = ref<MaterialPreset | null>(null)
const isNew = ref(false)
const notice = ref('')
const noticeKind = ref<'ok' | 'err'>('ok')
const printTarget = ref<MaterialPreset | null>(null)
const touched = ref<Set<string>>(new Set())
const submitted = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)

// 「应用到全部项目」的撤销快照
const applySnapshot = ref<{ name: string; changed: number; snapshot: ReturnType<typeof store.applyMaterialToAll> } | null>(null)

const materials = computed(() => state.materials)

const projectsByMaterial = computed(() => {
  const map = new Map<string, typeof state.projects>()
  for (const p of state.projects) {
    const list = map.get(p.materialId)
    if (list) list.push(p)
    else map.set(p.materialId, [p])
  }
  return map
})

function usedProjects(m: MaterialPreset) {
  return projectsByMaterial.value.get(m.id) ?? []
}

function projectNamesByMaterial(id: string): string[] {
  return (projectsByMaterial.value.get(id) ?? []).map((p) => p.name)
}

function paperNote(paper: string): string {
  return PAPER_KINDS.find((p) => p.paper === paper)?.note ?? ''
}

function paperLabel(paper: string): string {
  return PAPER_KINDS.find((p) => p.paper === paper)?.label ?? paper
}

function setNotice(msg: string, kind: 'ok' | 'err' = 'ok'): void {
  notice.value = msg
  noticeKind.value = kind
}

function startNew(): void {
  isNew.value = true
  notice.value = ''
  applySnapshot.value = null
  touched.value = new Set()
  submitted.value = false
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
  applySnapshot.value = null
  touched.value = new Set()
  submitted.value = false
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
  // 切换纸张后按新值重新提示
  for (const key of ['force', 'speedMmS', 'passes']) touched.value.add(key)
}

function markTouched(field: string): void {
  touched.value.add(field)
}

const fieldErrors = computed(() => (editing.value ? validateMaterial(editing.value) : {}))

function showError(field: string): boolean {
  return submitted.value || touched.value.has(field)
}

function save(): void {
  if (!editing.value) return
  submitted.value = true
  const errors = validateMaterial(editing.value)
  const keys = Object.keys(errors)
  if (keys.length > 0) {
    setNotice(`有 ${keys.length} 项需要修改：${keys.map((k) => errors[k as keyof typeof errors]).join('；')}`, 'err')
    return
  }
  const m = { ...editing.value, name: editing.value.name.trim() }
  store.upsertMaterial(m)
  setNotice(`已保存预设「${m.name}」`)
  editing.value = null
  isNew.value = false
}

function cancelEdit(): void {
  editing.value = null
  isNew.value = false
}

function remove(m: MaterialPreset): void {
  if (materials.value.length <= 1) {
    setNotice('至少保留一个材料预设', 'err')
    return
  }
  const used = usedProjects(m)
  const fallback = materials.value.find((x) => x.id !== m.id)!
  const lines = [
    `删除材料预设「${m.name}」？`,
    used.length > 0
      ? `当前有 ${used.length} 个项目正在使用它（${used.map((p) => p.name).join('、')}），删除后这些项目会改用「${fallback.name}」，刀路参数随之变化。`
      : '当前没有项目使用这条预设。',
    '此操作不可撤销。',
  ]
  if (!confirm(lines.join('\n'))) return
  store.deleteMaterial(m.id)
  if (editing.value?.id === m.id) cancelEdit()
  setNotice(`已删除「${m.name}」${used.length > 0 ? `，${used.length} 个项目已改用「${fallback.name}」` : ''}`)
}

function applyToAll(m: MaterialPreset): void {
  const others = state.projects.filter((p) => p.materialId !== m.id)
  if (state.projects.length === 0) {
    setNotice('当前还没有项目', 'err')
    return
  }
  if (others.length === 0) {
    setNotice(`全部 ${state.projects.length} 个项目本来就用「${m.name}」，没有改动`)
    return
  }
  if (!confirm(`把「${m.name}」应用到全部 ${state.projects.length} 个项目？\n其中 ${others.length} 个项目当前选择会被覆盖（${others.map((p) => p.name).join('、')}），应用后可在顶部提示条撤销。`)) {
    return
  }
  const snapshot = store.applyMaterialToAll(m.id)
  applySnapshot.value = { name: m.name, changed: others.length, snapshot }
  setNotice(`已把「${m.name}」应用到全部 ${state.projects.length} 个项目（覆盖 ${others.length} 个）`)
}

function undoApply(): void {
  if (!applySnapshot.value) return
  store.undoApplyMaterialToAll(applySnapshot.value.snapshot)
  setNotice(`已撤销，${applySnapshot.value.changed} 个项目恢复为原来的材料预设`)
  applySnapshot.value = null
}

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

// ---------------- 导出 / 导入 ----------------

const invalidLocals = computed(() => materials.value.filter((m) => Object.keys(validateMaterial(m)).length > 0))

function exportAll(): void {
  if (materials.value.length === 0) {
    setNotice('没有可导出的预设', 'err')
    return
  }
  if (invalidLocals.value.length > 0) {
    setNotice(`有 ${invalidLocals.value.length} 条预设数值不在合理区间（${invalidLocals.value.map((m) => m.name).join('、')}），请先编辑修正再导出`, 'err')
    return
  }
  downloadText(materialsFilename(materials.value), serializeMaterials(materials.value), 'application/json;charset=utf-8')
  setNotice(`已导出 ${materials.value.length} 条材料预设，可把该文件发给同事或拷到其他电脑`)
}

function exportOne(m: MaterialPreset): void {
  const errors = validateMaterial(m)
  if (Object.keys(errors).length > 0) {
    setNotice(`「${m.name}」有数值不在合理区间，请先编辑修正再导出`, 'err')
    return
  }
  downloadText(materialsFilename([m]), serializeMaterials([m]), 'application/json;charset=utf-8')
  setNotice(`已导出预设「${m.name}」`)
}

function pickImportFile(): void {
  notice.value = ''
  fileInput.value?.click()
}

async function onImportFile(files: FileList | null): Promise<void> {
  if (!files || files.length === 0) return
  const file = files[0]
  if (fileInput.value) fileInput.value.value = ''
  try {
    const text = await file.text()
    const parsed = parseMaterialFile(text, state.materials, projectNamesByMaterial)
    if (!parsed.ok) {
      setNotice(`导入失败：${parsed.error}`, 'err')
      return
    }
    importRows.value = parsed.rows
    importFileName.value = file.name
    importExportedAt.value = parsed.exportedAt
  } catch (e) {
    setNotice(`读取文件失败：${(e as Error).message}`, 'err')
  }
}

const importRows = ref<ImportRow[]>([])
const importFileName = ref('')
const importExportedAt = ref<string | null>(null)
const showImport = computed(() => importRows.value.length > 0)

const finalNames = computed(() =>
  planFinalNames(
    importRows.value,
    materials.value.map((m) => m.name),
  ),
)

const importCounts = computed(() => {
  let add = 0
  let replace = 0
  let skip = 0
  let invalid = 0
  for (const row of importRows.value) {
    if (row.errors.length > 0) invalid += 1
    if (row.action === 'replace') replace += 1
    else if (row.action === 'copy') add += 1
    else skip += 1
  }
  return { add, replace, skip, invalid }
})

function setAction(row: ImportRow, action: ImportAction): void {
  if (row.errors.length > 0) return
  row.action = action
}

/** 某条复制新增的预设最终会叫什么名字（文件内同名或与本机同名时加序号） */
function finalNameOf(row: ImportRow): string {
  return finalNames.value.get(row.index) ?? row.preset.name.trim()
}

/** 预设参数一行摘要（预览/对比用） */
function presetDigest(m: MaterialPreset): string {
  return `${paperLabel(m.paper)}｜刀压 ${m.force}｜速度 ${m.speedMmS}mm/s｜重复 ${m.passes}｜刀补 ${m.bladeOffsetMm}mm`
}

function closeImport(): void {
  importRows.value = []
  importFileName.value = ''
  importExportedAt.value = null
}

function confirmImport(): void {
  const result = store.commitMaterialImport(importRows.value, finalNames.value)
  const parts = [`导入完成：新增 ${result.added} 条，覆盖 ${result.replaced} 条，跳过 ${result.skipped} 条`]
  if (result.affectedProjectNames.length > 0) {
    parts.push(`覆盖导致 ${result.affectedProjectNames.length} 个项目刀路已重算（${result.affectedProjectNames.join('、')}）`)
  }
  setNotice(parts.join('；'))
  closeImport()
}

function fmtExportedAt(iso: string | null): string {
  if (!iso) return '未知'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
</script>

<template>
  <div class="page">
    <div class="page narrow">
      <h1>材料预设库</h1>
      <p class="hint">
        每个预设包含纸张类型、刀压、速度、重复次数、垫板与刀补偏置。可导出成文件拷给同事或在另一台电脑导入；材料参数卡可 1:1 打印贴在机器旁。
      </p>

      <div v-if="notice" class="banner" :class="noticeKind">{{ notice }}</div>

      <div v-if="applySnapshot" class="banner undo-bar">
        <span>「{{ applySnapshot.name }}」已覆盖 {{ applySnapshot.changed }} 个项目的选择。</span>
        <button class="tiny" @click="undoApply">撤销本次覆盖</button>
      </div>

      <div class="btn-row" style="margin: 10px 0">
        <button class="primary" @click="startNew">＋ 新建材料预设</button>
        <button @click="exportAll">导出全部（{{ materials.length }} 条）</button>
        <button @click="pickImportFile">从文件导入</button>
        <input
          ref="fileInput"
          type="file"
          accept=".json,application/json"
          style="display: none"
          @change="onImportFile(($event.target as HTMLInputElement).files)"
        />
      </div>
      <div v-if="invalidLocals.length > 0" class="hint err-hint">
        ⚠ {{ invalidLocals.length }} 条本机预设数值超出合理区间（{{ invalidLocals.map((m) => m.name).join('、') }}），编辑修正后才能导出。
      </div>

      <div class="card-grid">
        <div v-for="m in materials" :key="m.id" class="card mat-card" :class="{ active: editing?.id === m.id }">
          <div class="mat-head">
            <strong>{{ m.name }}</strong>
            <span v-if="usedProjects(m).length" class="tag accent">{{ usedProjects(m).length }} 个项目在用</span>
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
          <div class="hint">{{ paperNote(m.paper) }}</div>
          <div v-if="usedProjects(m).length" class="used-list">
            正在使用：<span v-for="(p, i) in usedProjects(m)" :key="p.id">「{{ p.name }}」<span v-if="i < usedProjects(m).length - 1">、</span></span>
          </div>
          <div class="btn-row">
            <button class="tiny" @click="startEdit(m)">编辑</button>
            <button class="tiny" @click="print(m)">打印工艺卡</button>
            <button class="tiny" @click="exportOne(m)">导出</button>
            <button class="tiny" @click="applyToAll(m)">应用到全部项目</button>
            <button class="tiny danger" @click="remove(m)">删除</button>
          </div>
        </div>
      </div>

      <div v-if="editing" class="card edit-card">
        <h3>{{ isNew ? '新建材料预设' : '编辑材料预设' }}</h3>
        <div class="edit-grid">
          <div class="field">
            <label>预设名称</label>
            <input
              type="text"
              v-model="editing.name"
              :class="{ bad: showError('name') && fieldErrors.name }"
              @input="markTouched('name')"
            />
            <div v-if="showError('name') && fieldErrors.name" class="field-err">{{ fieldErrors.name }}</div>
          </div>
          <div class="field">
            <label>纸张类型</label>
            <select :value="editing.paper" @change="onPaperChange(($event.target as HTMLSelectElement).value)">
              <option v-for="k in PAPER_KINDS" :key="k.paper" :value="k.paper">{{ k.label }}</option>
            </select>
            <div v-if="showError('paper') && fieldErrors.paper" class="field-err">{{ fieldErrors.paper }}</div>
          </div>
          <div class="field">
            <label>刀压 force（{{ rangeText(MATERIAL_LIMITS.force) }}）</label>
            <input
              type="number"
              :min="MATERIAL_LIMITS.force.min"
              :max="MATERIAL_LIMITS.force.max"
              v-model.number="editing.force"
              :class="{ bad: showError('force') && fieldErrors.force }"
              @input="markTouched('force')"
            />
            <div v-if="showError('force') && fieldErrors.force" class="field-err">{{ fieldErrors.force }}</div>
          </div>
          <div class="field">
            <label>速度 speed（{{ rangeText(MATERIAL_LIMITS.speedMmS) }}）</label>
            <input
              type="number"
              :min="MATERIAL_LIMITS.speedMmS.min"
              :max="MATERIAL_LIMITS.speedMmS.max"
              v-model.number="editing.speedMmS"
              :class="{ bad: showError('speedMmS') && fieldErrors.speedMmS }"
              @input="markTouched('speedMmS')"
            />
            <div v-if="showError('speedMmS') && fieldErrors.speedMmS" class="field-err">{{ fieldErrors.speedMmS }}</div>
          </div>
          <div class="field">
            <label>重复次数 passes（{{ rangeText(MATERIAL_LIMITS.passes) }}）</label>
            <input
              type="number"
              :min="MATERIAL_LIMITS.passes.min"
              :max="MATERIAL_LIMITS.passes.max"
              v-model.number="editing.passes"
              :class="{ bad: showError('passes') && fieldErrors.passes }"
              @input="markTouched('passes')"
            />
            <div v-if="showError('passes') && fieldErrors.passes" class="field-err">{{ fieldErrors.passes }}</div>
          </div>
          <div class="field">
            <label>刀补 blade offset（{{ rangeText(MATERIAL_LIMITS.bladeOffsetMm) }}）</label>
            <input
              type="number"
              :min="MATERIAL_LIMITS.bladeOffsetMm.min"
              :max="MATERIAL_LIMITS.bladeOffsetMm.max"
              step="0.05"
              v-model.number="editing.bladeOffsetMm"
              :class="{ bad: showError('bladeOffsetMm') && fieldErrors.bladeOffsetMm }"
              @input="markTouched('bladeOffsetMm')"
            />
            <div v-if="showError('bladeOffsetMm') && fieldErrors.bladeOffsetMm" class="field-err">{{ fieldErrors.bladeOffsetMm }}</div>
          </div>
          <div class="field">
            <label>垫板</label>
            <input type="text" v-model="editing.backing" />
          </div>
        </div>
        <div class="hint">{{ paperNote(editing.paper) }}</div>
        <div class="btn-row" style="margin-top: 8px">
          <button class="primary" @click="save">保存</button>
          <button @click="cancelEdit">取消</button>
        </div>
      </div>
    </div>

    <!-- 导入预览对话框 -->
    <div v-if="showImport" class="modal-overlay" @click.self="closeImport">
      <div class="modal">
        <div class="modal-head">
          <h3>导入材料预设</h3>
          <button class="tiny" @click="closeImport">✕</button>
        </div>
        <div class="hint">
          文件：{{ importFileName }}<template v-if="importExportedAt">｜导出时间 {{ fmtExportedAt(importExportedAt) }}</template>
          ｜共 {{ importRows.length }} 条
        </div>

        <table class="grid import-table">
          <thead>
            <tr>
              <th style="width: 130px">文件中的预设</th>
              <th>参数</th>
              <th style="width: 210px">与本机同名预设 / 处理方式</th>
              <th style="width: 240px">会改动什么</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in importRows" :key="row.index" :class="{ 'row-invalid': row.errors.length > 0 }">
              <td>
                <strong>{{ row.preset.name }}</strong>
                <span v-if="row.dupInFile" class="tag warn" title="这份文件里有多条同名预设">文件内重名</span>
              </td>
              <td class="digest">{{ presetDigest(row.preset) }}</td>
              <td>
                <template v-if="row.errors.length > 0">
                  <div v-for="(e, i) in row.errors" :key="i" class="field-err">{{ e }}</div>
                  <span class="tag err">无法导入，只能跳过</span>
                </template>
                <template v-else-if="row.localSameName">
                  <div class="hint">本机已有同名「{{ row.localSameName.name }}」，当前参数：{{ presetDigest(row.localSameName) }}</div>
                  <div class="radio-row">
                    <label><input type="radio" :checked="row.action === 'replace'" @change="setAction(row, 'replace')" /> 覆盖本机</label>
                    <label><input type="radio" :checked="row.action === 'copy'" @change="setAction(row, 'copy')" /> 另存为新预设</label>
                    <label><input type="radio" :checked="row.action === 'skip'" @change="setAction(row, 'skip')" /> 跳过</label>
                  </div>
                </template>
                <template v-else>
                  <div class="hint">本机没有同名预设</div>
                  <div class="radio-row">
                    <label><input type="radio" :checked="row.action === 'copy'" @change="setAction(row, 'copy')" /> 新增</label>
                    <label><input type="radio" :checked="row.action === 'skip'" @change="setAction(row, 'skip')" /> 跳过</label>
                  </div>
                </template>
              </td>
              <td class="impact">
                <template v-if="row.errors.length > 0">
                  <span class="hint">不改动本机任何数据</span>
                </template>
                <template v-else-if="row.action === 'skip'">
                  <span class="hint">不改动</span>
                </template>
                <template v-else-if="row.action === 'replace'">
                  <span v-if="row.localUsedBy.length">
                    覆盖本机「{{ row.localSameName?.name }}」，<strong>{{ row.localUsedBy.length }} 个项目</strong>（{{ row.localUsedBy.join('、') }}）的刀路将按新参数重算
                  </span>
                  <span v-else>覆盖本机「{{ row.localSameName?.name }}」；当前没有项目使用它</span>
                </template>
                <template v-else>
                  新增预设「{{ finalNameOf(row) }}」，不影响任何现有项目
                </template>
              </td>
            </tr>
          </tbody>
        </table>

        <div class="modal-summary">
          本次将：新增 <strong>{{ importCounts.add }}</strong> 条、覆盖 <strong>{{ importCounts.replace }}</strong> 条、跳过
          <strong>{{ importCounts.skip }}</strong> 条<template v-if="importCounts.invalid > 0">（其中 {{ importCounts.invalid }} 条数值越界/损坏）</template>。
        </div>
        <div class="btn-row" style="margin-top: 10px">
          <button class="primary" @click="confirmImport">按上述方式导入</button>
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
  color: #ff9f9f;
}

.undo-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  background: rgba(255, 200, 87, 0.1);
  border-color: rgba(255, 200, 87, 0.4);
  color: var(--warn);
}

.err-hint {
  color: var(--warn);
  margin-bottom: 8px;
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

.used-list {
  font-size: 11.5px;
  color: var(--text-dim);
  background: var(--panel-2);
  border: 1px solid var(--line-soft);
  border-radius: 5px;
  padding: 4px 7px;
}

.edit-card {
  margin-top: 14px;
}

.edit-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
  gap: 8px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.field label {
  font-size: 11.5px;
  color: var(--text-dim);
}

input.bad {
  border-color: var(--err);
}

.field-err {
  font-size: 11px;
  color: var(--err);
  line-height: 1.35;
}

/* ---------- 导入对话框 ---------- */
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(8, 11, 15, 0.72);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 5vh 16px;
  z-index: 100;
  overflow-y: auto;
}

.modal {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 14px 16px;
  width: min(960px, 100%);
}

.modal-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.import-table td,
.import-table th {
  vertical-align: top;
  font-size: 12px;
}

.import-table .digest {
  color: var(--text-dim);
  white-space: normal;
}

.import-table tr.row-invalid td {
  background: rgba(255, 107, 107, 0.06);
}

.radio-row {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  margin-top: 3px;
  font-size: 12px;
}

.radio-row label {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  white-space: nowrap;
}

.impact {
  color: var(--text-dim);
}

.modal-summary {
  margin-top: 10px;
  font-size: 12.5px;
  color: var(--text-dim);
  padding: 7px 10px;
  background: var(--panel-2);
  border: 1px solid var(--line-soft);
  border-radius: 6px;
}

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
</style>
