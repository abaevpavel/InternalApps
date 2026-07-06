import { Document, Page, StyleSheet, Text, View, pdf } from '@react-pdf/renderer'
import { listItems } from '../../services/hr-checklists'
import {
  buildTree,
  fullName,
  type Checklist,
  type Employee,
  type ItemNode,
  type ProgressRow,
} from '../../domain/hr-checklists'

/**
 * PDF-отчёт по сотруднику (как в оригинале): назначенные чек-листы с деревом пунктов,
 * статусом [ ]/[x]/[N/A], датой и «Completed By». Фото/ссылки/ответы в PDF не идут.
 */

const styles = StyleSheet.create({
  page: { padding: 36, fontSize: 10, fontFamily: 'Helvetica', color: '#111827' },
  title: { fontSize: 16, fontFamily: 'Helvetica-Bold', marginBottom: 4 },
  meta: { fontSize: 9, color: '#6b7280', marginBottom: 14 },
  section: { marginBottom: 14 },
  h2: { fontSize: 12, fontFamily: 'Helvetica-Bold', marginBottom: 6, borderBottom: '1 solid #e5e7eb', paddingBottom: 3 },
  row: { flexDirection: 'row', marginBottom: 3 },
  mark: { width: 34, fontFamily: 'Helvetica-Bold' },
  label: { flex: 1 },
  group: { fontFamily: 'Helvetica-Bold' },
  footer: { position: 'absolute', bottom: 24, left: 36, right: 36, fontSize: 8, color: '#9ca3af', textAlign: 'center' },
})

type Status = 'unchecked' | 'checked' | 'not_applicable'

function mark(s: Status): string {
  return s === 'checked' ? '[x]' : s === 'not_applicable' ? '[N/A]' : '[  ]'
}

interface Section {
  name: string
  tree: ItemNode[]
  statusByTask: Record<string, Status>
}

function Nodes({ nodes, statusByTask, depth }: { nodes: ItemNode[]; statusByTask: Record<string, Status>; depth: number }) {
  return (
    <>
      {nodes.map((n) => {
        const isLeaf = n.children.length === 0
        return (
          <View key={n.id}>
            <View style={[styles.row, { marginLeft: depth * 14 }]}>
              <Text style={styles.mark}>{isLeaf ? mark(statusByTask[n.task_id] ?? 'unchecked') : ''}</Text>
              <Text style={[styles.label, ...(isLeaf ? [] : [styles.group])]}>{n.label}</Text>
            </View>
            {n.children.length > 0 && <Nodes nodes={n.children} statusByTask={statusByTask} depth={depth + 1} />}
          </View>
        )
      })}
    </>
  )
}

function ReportDoc({
  employee,
  sections,
  completedBy,
  dateStr,
}: {
  employee: Employee
  sections: Section[]
  completedBy: string
  dateStr: string
}) {
  return (
    <Document>
      <Page style={styles.page}>
        <Text style={styles.title}>{fullName(employee)} — Checklist Report</Text>
        <Text style={styles.meta}>
          {employee.employee_type} · Completed by: {completedBy || '—'} · {dateStr}
        </Text>
        {sections.length === 0 && <Text>No checklists assigned.</Text>}
        {sections.map((s, i) => (
          <View key={i} style={styles.section} wrap={false}>
            <Text style={styles.h2}>{s.name}</Text>
            <Nodes nodes={s.tree} statusByTask={s.statusByTask} depth={0} />
          </View>
        ))}
        <Text style={styles.footer} render={({ pageNumber, totalPages }) => `Page ${pageNumber} / ${totalPages}`} fixed />
      </Page>
    </Document>
  )
}

/** Собирает данные, рендерит PDF и скачивает файл. */
export async function generateEmployeeChecklistPdf(args: {
  employee: Employee
  assignments: { checklist_id: string }[]
  checklistById: Map<string, Checklist>
  progress: ProgressRow[]
  completedBy: string
  dateStr: string
}): Promise<void> {
  const sections: Section[] = []
  for (const a of args.assignments) {
    const items = await listItems(a.checklist_id)
    const tree = buildTree(items)
    const statusByTask: Record<string, Status> = {}
    for (const p of args.progress) {
      if (p.phase !== a.checklist_id) continue
      statusByTask[p.task_id] = p.is_not_applicable ? 'not_applicable' : p.completed ? 'checked' : 'unchecked'
    }
    sections.push({ name: args.checklistById.get(a.checklist_id)?.name ?? 'Checklist', tree, statusByTask })
  }

  const blob = await pdf(
    <ReportDoc employee={args.employee} sections={sections} completedBy={args.completedBy} dateStr={args.dateStr} />,
  ).toBlob()

  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `${fullName(args.employee).replace(/\s+/g, '_')}_checklists.pdf`
  link.click()
  URL.revokeObjectURL(url)
}
