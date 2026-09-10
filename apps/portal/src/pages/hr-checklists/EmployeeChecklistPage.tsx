import { useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { FileDown, Plus, SquarePen, UserRound } from 'lucide-react'
import { Button, Card } from '../../components/ui'
import { errMsg } from '../../lib/utils'
import { AssignedChecklistSection } from './AssignedChecklistSection'
import { generateEmployeeChecklistPdf } from './ChecklistPDF'
import { PdfDialog } from './EmployeeChecklists'
import { CreateEmployeeDialog } from './HrDialogs'
import { SearchableCombobox } from './SearchableCombobox'
import {
  assignChecklist,
  listChecklists,
  listEmployeeChecklists,
  listEmployees,
  listProgress,
} from '../../services/hr-checklists'
import { fullName } from '../../domain/hr-checklists'

/**
 * Все чек-листы одного сотрудника на собственной странице.
 *
 * Раньше назначенные чек-листы жили аккордеонами в общем списке: чтобы дойти до пунктов,
 * нужно было раскрыть строку, а прогресс читался мелким текстом сбоку. Здесь каждый
 * чек-лист развёрнут, со своей шапкой, процентом и переключателями — как в исходной версии.
 */
export function EmployeeChecklistPage() {
  const { employeeId = '' } = useParams()
  const nav = useNavigate()
  const qc = useQueryClient()
  const [showPdf, setShowPdf] = useState(false)
  const [editEmployee, setEditEmployee] = useState(false)
  const [addEmployee, setAddEmployee] = useState(false)

  const employeesQ = useQuery({ queryKey: ['hr-employees'], queryFn: listEmployees })
  const checklistsQ = useQuery({ queryKey: ['hr-checklists'], queryFn: listChecklists })
  const assignmentsQ = useQuery({
    queryKey: ['hr-employee-checklists', employeeId],
    queryFn: () => listEmployeeChecklists(employeeId),
    enabled: !!employeeId,
  })
  const progressQ = useQuery({
    queryKey: ['hr-progress', employeeId],
    queryFn: () => listProgress(employeeId),
    enabled: !!employeeId,
  })

  const employee = employeesQ.data?.find((e) => e.id === employeeId) ?? null
  const checklistById = useMemo(
    () => new Map((checklistsQ.data ?? []).map((c) => [c.id, c])),
    [checklistsQ.data],
  )
  /**
   * Порядок — по названию чек-листа (01a, 01b, 02a, 02b, 09…), как в исходной версии.
   * `listEmployeeChecklists` идёт без `order`, то есть Postgres волен отдать строки
   * в любом порядке, и на экране они каждый раз перемешивались.
   * `numeric` в сравнении нужен, чтобы «09» не оказалось перед «10».
   */
  const assignments = useMemo(
    () =>
      [...(assignmentsQ.data ?? [])].sort((a, b) =>
        (checklistById.get(a.checklist_id)?.name ?? '').localeCompare(
          checklistById.get(b.checklist_id)?.name ?? '',
          undefined,
          { numeric: true, sensitivity: 'base' },
        ),
      ),
    [assignmentsQ.data, checklistById],
  )

  // Назначение переехало сюда со списка: выбор сотрудника теперь сразу открывает его
  // страницу, и «выбранного сотрудника» на прошлом экране больше нет.
  const assignM = useMutation({
    mutationFn: (checklistId: string) => assignChecklist(employeeId, checklistId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['hr-employee-checklists', employeeId] }),
  })

  return (
    <div className="mx-auto w-full max-w-[1200px] px-4 py-8 sm:px-6">
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <span className="inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-800">
          <UserRound size={16} className="text-gray-400" />
          {employee ? fullName(employee) : '…'}
        </span>
        <div className="flex-1" />
        {assignments.length > 0 && (
          <Button variant="subtle" onClick={() => setShowPdf(true)} title="All checklists in one PDF">
            <FileDown size={16} /> PDF — all
          </Button>
        )}
        <Button variant="blue" disabled={!employee} onClick={() => setEditEmployee(true)}>
          <SquarePen size={16} /> Edit Employee
        </Button>
        <Button variant="blue" onClick={() => setAddEmployee(true)}>
          <Plus size={16} /> Add Employee
        </Button>
      </div>

      <Card className="mb-6 p-5">
        <div className="flex flex-wrap items-center gap-3">
          <span className="shrink-0 text-sm text-gray-600">Assign checklist</span>
          <SearchableCombobox
            className="max-w-md flex-1"
            value={null}
            onChange={(id) => assignM.mutate(id)}
            placeholder="Select checklist…"
            searchPlaceholder="Search checklists…"
            options={(checklistsQ.data ?? []).map((c) => ({ value: c.id, label: c.name }))}
          />
          {assignM.isPending && <span className="text-xs text-gray-400">Assigning…</span>}
        </div>
        {assignM.error && <p className="mt-2 text-sm text-red-600">{errMsg(assignM.error)}</p>}
      </Card>

      {assignmentsQ.isLoading ? (
        <div className="py-10 text-center text-gray-400">Loading…</div>
      ) : assignments.length === 0 ? (
        <Card className="px-6 py-12 text-center text-sm text-gray-400">
          No checklists assigned yet. Assign one on the previous screen.
        </Card>
      ) : (
        <div className="space-y-8">
          {assignments.map((a) => (
            <AssignedChecklistSection
              key={a.id}
              standalone
              employee={employee ?? undefined}
              employeeId={employeeId}
              assignment={a}
              checklist={checklistById.get(a.checklist_id) ?? null}
              allProgress={progressQ.data ?? []}
              onProgressChanged={() => qc.invalidateQueries({ queryKey: ['hr-progress', employeeId] })}
              onUnassigned={() => qc.invalidateQueries({ queryKey: ['hr-employee-checklists', employeeId] })}
            />
          ))}
        </div>
      )}

      {editEmployee && employee && (
        <CreateEmployeeDialog
          employee={employee}
          onClose={() => setEditEmployee(false)}
          onCreated={() => {
            setEditEmployee(false)
            qc.invalidateQueries({ queryKey: ['hr-employees'] })
          }}
        />
      )}

      {/* Новый сотрудник заводится здесь же — и мы сразу уходим на его страницу. */}
      {addEmployee && (
        <CreateEmployeeDialog
          onClose={() => setAddEmployee(false)}
          onCreated={(id) => {
            setAddEmployee(false)
            qc.invalidateQueries({ queryKey: ['hr-employees'] })
            nav(`/checklists/${id}`)
          }}
        />
      )}

      {showPdf && employee && (
        <PdfDialog
          onClose={() => setShowPdf(false)}
          onGenerate={async (completedBy) => {
            await generateEmployeeChecklistPdf({
              employee,
              assignments,
              checklistById,
              progress: progressQ.data ?? [],
              completedBy,
              dateStr: new Date().toLocaleDateString('en-US'),
            })
            setShowPdf(false)
          }}
        />
      )}
    </div>
  )
}
