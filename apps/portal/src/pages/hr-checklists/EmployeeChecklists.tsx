import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { FileDown, Plus } from 'lucide-react'
import { Button, Card, Field, Input, Modal, PageTitle } from '../../components/ui'
import { errMsg } from '../../lib/utils'
import { SearchableCombobox } from './SearchableCombobox'
import { CreateEmployeeDialog, AddChecklistDialog } from './HrDialogs'
import { AssignedChecklistSection } from './AssignedChecklistSection'
import { generateEmployeeChecklistPdf } from './ChecklistPDF'
import {
  assignChecklist,
  listChecklists,
  listEmployeeChecklists,
  listEmployees,
  listProgress,
} from '../../services/hr-checklists'
import { fullName } from '../../domain/hr-checklists'

export function EmployeeChecklistsPage() {
  const qc = useQueryClient()
  const nav = useNavigate()
  const [selectedEmployeeId, setSelectedEmployeeId] = useState<string | null>(null)
  const [showAddEmployee, setShowAddEmployee] = useState(false)
  const [showAddChecklist, setShowAddChecklist] = useState(false)
  const [showPdf, setShowPdf] = useState(false)

  const employeesQ = useQuery({ queryKey: ['hr-employees'], queryFn: listEmployees })
  const checklistsQ = useQuery({ queryKey: ['hr-checklists'], queryFn: listChecklists })

  const assignmentsQ = useQuery({
    queryKey: ['hr-employee-checklists', selectedEmployeeId],
    queryFn: () => listEmployeeChecklists(selectedEmployeeId!),
    enabled: !!selectedEmployeeId,
  })
  const progressQ = useQuery({
    queryKey: ['hr-progress', selectedEmployeeId],
    queryFn: () => listProgress(selectedEmployeeId!),
    enabled: !!selectedEmployeeId,
  })

  const employee = employeesQ.data?.find((e) => e.id === selectedEmployeeId) ?? null
  const checklistById = useMemo(
    () => new Map((checklistsQ.data ?? []).map((c) => [c.id, c])),
    [checklistsQ.data],
  )

  const assignM = useMutation({
    mutationFn: (checklistId: string) => assignChecklist(selectedEmployeeId!, checklistId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['hr-employee-checklists', selectedEmployeeId] }),
  })

  return (
    <div className="mx-auto max-w-4xl px-6 py-10">
      <PageTitle title="HR Checklists" subtitle="Onboarding & offboarding checklists per employee" />

      {/* Employees */}
      <Card className="mb-5 p-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold text-gray-900">Employees</h2>
          <Button variant="blue" onClick={() => setShowAddEmployee(true)}>
            <Plus size={16} /> Add Employee
          </Button>
        </div>
        <div className="flex items-center gap-3">
          <span className="shrink-0 text-sm text-gray-600">Select Employee</span>
          <SearchableCombobox
            className="max-w-md flex-1"
            value={selectedEmployeeId}
            onChange={setSelectedEmployeeId}
            placeholder="Select employee…"
            searchPlaceholder="Search employees…"
            options={(employeesQ.data ?? []).map((e) => ({ value: e.id, label: fullName(e), sub: e.employee_type }))}
          />
        </div>
      </Card>

      {/* Checklists (assign to selected employee) */}
      <Card className="mb-6 p-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold text-gray-900">Checklists</h2>
          <Button variant="blue" onClick={() => setShowAddChecklist(true)}>
            <Plus size={16} /> Add Checklist
          </Button>
        </div>
        <div className="flex items-center gap-3">
          <span className="shrink-0 text-sm text-gray-600">Select Checklist</span>
          <SearchableCombobox
            className="max-w-md flex-1"
            value={null}
            onChange={(id) => (selectedEmployeeId ? assignM.mutate(id) : nav(`/checklist/${id}`))}
            placeholder="Select checklist…"
            searchPlaceholder="Search checklists…"
            options={(checklistsQ.data ?? []).map((c) => ({ value: c.id, label: c.name }))}
          />
          <span className="text-xs text-gray-400">
            {selectedEmployeeId ? 'Assigns to selected employee' : 'Opens the checklist to edit'}
          </span>
        </div>
        {assignM.error && <p className="mt-2 text-sm text-red-600">{errMsg(assignM.error)}</p>}
      </Card>

      {/* Assigned checklists for the selected employee */}
      {selectedEmployeeId && employee && (
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-lg font-bold text-gray-900">{fullName(employee)} — assigned checklists</h2>
            {(assignmentsQ.data ?? []).length > 0 && (
              <Button variant="subtle" onClick={() => setShowPdf(true)}>
                <FileDown size={16} /> Generate PDF
              </Button>
            )}
          </div>
          {assignmentsQ.isLoading ? (
            <div className="py-8 text-center text-gray-400">Loading…</div>
          ) : (assignmentsQ.data ?? []).length === 0 ? (
            <Card className="px-6 py-10 text-center text-sm text-gray-400">
              No checklists assigned. Pick one above to assign.
            </Card>
          ) : (
            (assignmentsQ.data ?? []).map((a) => (
              <AssignedChecklistSection
                key={a.id}
                employeeId={selectedEmployeeId}
                assignment={a}
                checklist={checklistById.get(a.checklist_id) ?? null}
                allProgress={progressQ.data ?? []}
                onProgressChanged={() => qc.invalidateQueries({ queryKey: ['hr-progress', selectedEmployeeId] })}
                onUnassigned={() => qc.invalidateQueries({ queryKey: ['hr-employee-checklists', selectedEmployeeId] })}
              />
            ))
          )}
        </div>
      )}

      {showAddEmployee && (
        <CreateEmployeeDialog
          onClose={() => setShowAddEmployee(false)}
          onCreated={(id) => {
            qc.invalidateQueries({ queryKey: ['hr-employees'] })
            setSelectedEmployeeId(id)
            setShowAddEmployee(false)
          }}
        />
      )}
      {showAddChecklist && (
        <AddChecklistDialog
          onClose={() => setShowAddChecklist(false)}
          onCreated={() => {
            qc.invalidateQueries({ queryKey: ['hr-checklists'] })
            setShowAddChecklist(false)
          }}
        />
      )}
      {showPdf && employee && (
        <PdfDialog
          onClose={() => setShowPdf(false)}
          onGenerate={async (completedBy) => {
            await generateEmployeeChecklistPdf({
              employee,
              assignments: assignmentsQ.data ?? [],
              checklistById,
              progress: progressQ.data ?? [],
              completedBy,
              dateStr: new Date().toLocaleDateString(),
            })
            setShowPdf(false)
          }}
        />
      )}
    </div>
  )
}

function PdfDialog({ onClose, onGenerate }: { onClose: () => void; onGenerate: (completedBy: string) => Promise<void> }) {
  const [completedBy, setCompletedBy] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  return (
    <Modal
      open
      title="Generate PDF"
      subtitle="Employee checklist report"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              setErr(null)
              try {
                await onGenerate(completedBy.trim())
              } catch (e) {
                setErr(errMsg(e))
                setBusy(false)
              }
            }}
          >
            {busy ? 'Generating…' : 'Generate'}
          </Button>
        </>
      }
    >
      <Field label="Completed By">
        <Input value={completedBy} onChange={(e) => setCompletedBy(e.target.value)} placeholder="Your name" autoFocus />
      </Field>
      {err && <p className="mt-2 text-sm text-red-600">{err}</p>}
    </Modal>
  )
}
